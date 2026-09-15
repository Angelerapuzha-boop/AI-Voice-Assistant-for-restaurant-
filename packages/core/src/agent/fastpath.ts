import { getModifierGroups, listItems } from "../domain/menu";
import { getOrderWithItems } from "../domain/orders";
import { speakCents } from "../money";
import type { OrderWithItems } from "../types";
import { executeTool, groupQuestion, type AgentContext, type AgentState } from "./tools";
import type { ToolCallRecord } from "./engine";

/**
 * Deterministic dialogue fast paths.
 *
 * The LLM does LANGUAGE UNDERSTANDING; this module does DIALOGUE CONTROL
 * for the predictable turns of an order call — single-word option answers,
 * "anything else? -> nah", the final "yep" — so those turns answer in
 * milliseconds instead of an LLM round-trip. Anything ambiguous falls
 * through to Claude untouched.
 *
 * Stage detection keys off the assistant's own previous line (which both
 * this module and the LLM produce), so no parallel state machine can drift
 * out of sync with what the caller actually heard.
 */

export interface FastPathResult {
  handled: boolean;
  say?: string;
  endCall?: boolean;
  toolCalls?: ToolCallRecord[];
  kind?: string;
}

const NOT_HANDLED: FastPathResult = { handled: false };

// ---------------------------------------------------------------- text utils

const FILLER_WORDS = new Set([
  "and", "on", "the", "a", "an", "please", "mate", "yeah", "yep", "with",
  "them", "it", "thanks", "cheers", "just", "for", "me", "um", "uh", "ah",
  "oh", "ta", "то", "of",
]);

const SCOPE_ALL_WORDS = new Set(["both", "all", "each", "everything"]);

export { isFinished, isYes, normalise, WAIT_REGEX } from "./speech";
import { isFinished, isYes, normalise, WAIT_REGEX } from "./speech";

// ---------------------------------------------------------------- stages

function lastLine(state: AgentState): string {
  return normalise(state.lastAssistantText);
}

function atConfirmStage(state: AgentState): boolean {
  // Both close styles: item read-back ends "Correct?", total-only close ends
  // "Confirm?". Either way the next "yes" is the final confirmation.
  return /(correct|confirm)\s*$/.test(lastLine(state));
}

function atAnythingElseStage(state: AgentState): boolean {
  // "Anything else?", "Anything else for you?", "Was there anything else?" —
  // the LLM varies the wording, so match the phrase anywhere in the line.
  return /anything else/.test(lastLine(state));
}

function atNameStage(state: AgentState): boolean {
  const l = lastLine(state);
  if (!/\bname\b/.test(l)) return false;
  // The assistant is asking for the customer's name — our canonical line OR
  // any LLM rephrase ("I still need a name for the order", "what was the
  // name", "what's your name"). Broad so the name answer is fast whoever
  // asked. Excludes lines that merely contain a name (the close has none).
  return /(name shall i put it under|name for the order|need a name|get a name|grab a name|your name|the name|whats? the name|what.{0,8}name)/.test(l);
}

function atGreetingStage(state: AgentState): boolean {
  // Start of call: nothing ordered yet. Keyed off state, not the greeting's
  // exact words — the LLM varies its opener ("what can I get started for
  // you?"), and the first menu item must add fast however it greeted.
  return !state.draftOrderId;
}

// Instant reply to a bare greeting at the start. Not "what can I get you?"
// (the opening line already said that) — a fresh, human hand-off to ordering.
const GREETING_ACK = "What can I get for you?";

const GREETING_WORDS = new Set([
  "hi", "hey", "hello", "heya", "hiya", "gday", "yo", "howdy", "there", "mate",
  "hows", "it", "going", "morning", "afternoon", "evening",
]);

/** The whole utterance is just a greeting — no order content. */
function isGreetingOnly(text: string): boolean {
  const toks = normalise(text)
    .split(" ")
    .filter((w) => w && !FILLER_WORDS.has(w));
  return toks.length > 0 && toks.length <= 4 && toks.every((t) => GREETING_WORDS.has(t));
}

// ---------------------------------------------------------------- item match

const QTY_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, "1": 1, "2": 2, "3": 3,
  "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
};

/** Singularise a token for menu matching ("meatboxes" -> "meatbox"). */
function singular(w: string): string {
  if (w.endsWith("es") && w.length > 3) return w.slice(0, -2);
  if (w.endsWith("s") && w.length > 2) return w.slice(0, -1);
  return w;
}

interface ItemMatch {
  menuItemName: string;
  quantity: number;
}

/**
 * Deterministically recognise ONE clear menu item + quantity from a short
 * ordering utterance ("two chicken meatboxes"). Conservative: leftover
 * content words (a second item, inline options, unknown words) => null so
 * the LLM handles anything complex. Ambiguity ("meatbox" alone) => null.
 */
function matchMenuItem(
  utterance: string,
  items: { name: string; aliases: string[] }[],
): ItemMatch | null {
  // Strip fillers, ordering verbs and greeting words so only the item
  // (and a quantity) remain.
  const STRIP = new Set([
    "grab", "get", "can", "i", "want", "would", "like", "have", "id",
    "hey", "hi", "hello", "ok", "okay", "so", "look", "see", "gimme", "give",
    "us", "could", "lemme", "let",
  ]);
  const tokens = normalise(utterance)
    .split(" ")
    .filter((w) => w && !FILLER_WORDS.has(w) && !STRIP.has(w));
  if (tokens.length === 0) return null;

  // Quantity: the first number word anywhere (menu names carry no numbers).
  let quantity = 1;
  const itemWords: string[] = [];
  let qtyTaken = false;
  for (const t of tokens) {
    if (!qtyTaken && QTY_WORDS[t] !== undefined) {
      quantity = QTY_WORDS[t]!;
      qtyTaken = true;
    } else {
      itemWords.push(t);
    }
  }
  if (itemWords.length === 0) return null;

  const itemTokens = itemWords.map(singular);
  // Space-insensitive form so "meat box" == "meatbox" (STT splits words
  // differently than the menu spells them).
  const uttSquished = itemTokens.join("");

  // Clean match: the utterance's content (minus quantity) is EXACTLY one
  // menu item's name (space-insensitive, singularised). Anything with
  // leftover words (a second item, inline options like "large"/"garlic")
  // is left to the LLM.
  const matched = new Set<string>();
  for (const item of items) {
    for (const label of [item.name, ...item.aliases]) {
      const nameSquished = normalise(label).split(" ").filter(Boolean).map(singular).join("");
      if (nameSquished && nameSquished === uttSquished) matched.add(item.name);
    }
  }
  if (matched.size !== 1) return null; // none or ambiguous -> LLM

  return { menuItemName: [...matched][0]!, quantity };
}

// ---------------------------------------------------------------- read-back

const NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve"];

function numWord(n: number): string {
  return NUM_WORDS[n] ?? String(n);
}

function pluralise(name: string, qty: number): string {
  if (qty === 1) return name;
  if (/(?:s|x|ch|sh)$/i.test(name)) return `${name}es`;
  return `${name}s`;
}

/** Terse spoken read-back: "Two Chicken Meatboxes, garlic on both. Correct?" */
export function terseReadback(order: OrderWithItems): string {
  const items = order.items;
  // Sorted: modifier row order from the DB is not deterministic. Spoken
  // text must carry no symbols ("&" etc — the TTS reads every character).
  const modsOf = (i: (typeof items)[number]) =>
    i.modifiers
      .map((m) =>
        m.nameSnapshot.replace(/\s+sauce$/i, "").replace(/\s*&\s*/g, " and ").toLowerCase(),
      )
      .sort();

  // Compression: every line shares the identical single modifier list.
  const first = items[0] ? modsOf(items[0]).join(", ") : "";
  const allShareMods =
    items.length > 1 && first !== "" && items.every((i) => modsOf(i).join(", ") === first);

  const parts = items.map((i) => {
    let line = `${numWord(i.quantity)} ${pluralise(i.nameSnapshot, i.quantity)}`;
    if (!allShareMods) {
      const mods = modsOf(i);
      if (mods.length > 0) line += ` with ${mods.join(" and ")}`;
    }
    for (const r of i.removals) line += `, no ${r}`;
    return line;
  });
  let text = parts.join(", ");
  if (allShareMods) {
    text += `, ${first} on ${items.length === 2 ? "both" : "all"}`;
  }
  return `${text}. Correct?`;
}

/**
 * Total-only close (owner rule: no item recital — state the grand total once
 * with the name and type, confirm once). "That's 42 dollars 80, takeaway for
 * Sam. Confirm?"
 */
export function spokenClose(order: OrderWithItems): string {
  const type = order.orderType === "dine_in" ? "dine-in" : "takeaway";
  const name = order.customerName.trim();
  return `That's ${speakCents(order.totalCents)}, ${type}${name ? ` for ${name}` : ""}. Confirm?`;
}

// ---------------------------------------------------------------- name capture

/**
 * Extract a spoken customer name -> title case, or null if it doesn't look
 * like a name (too long, too many words, empty after cleaning).
 */
function cleanName(text: string): string | null {
  // A finish ("no, that's it") or confirm ("yep, that's right") is NOT a name,
  // even at the name stage — let the LLM re-ask rather than name the order "No".
  if (isFinished(text) || isYes(text)) return null;
  const cleaned = text
    .replace(/\b(it's|its|it is|the name is|name is|name's|names|under|for|put it under|this is|thanks|thank you|cheers|please|mate)\b/gi, " ")
    .replace(/[^a-zA-Z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length < 1 || words.length > 3) return null;
  if (cleaned.length < 2 || cleaned.length > 40) return null;
  // Compound answer (name + order type/timing/size, e.g. "Daniel, pickup
  // ASAP") -> let the LLM set all the fields; don't guess a name from it.
  if (words.some((w) => NON_NAME_WORDS.has(w.toLowerCase()) || QTY_WORDS[w.toLowerCase()] !== undefined)) {
    return null;
  }
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

// Caller volunteers a name at "anything else?" with an explicit lead-in
// ("it's Kevin", "under Sam", "the name's Dave") — a bare unknown word stays
// with the LLM (could be a garbled item, not a name).
const NAME_LEADIN_RE =
  /^(?:it'?s|its|name'?s|names|the name is|name is|under|put it under|this is)\s+(.+)$/i;

// Words that can follow a lead-in but are NOT names (order type, party size,
// acknowledgements) — reject so "it's for here" / "it's fine" never become names.
const NON_NAME_WORDS = new Set([
  "here", "there", "now", "later", "takeaway", "pickup", "pick", "up",
  "delivery", "dine", "dinein", "in", "yes", "no", "yeah", "nah", "ok",
  "okay", "done", "that", "all", "it", "fine", "good", "cool", "one", "two",
  "three", "four", "five", "six", "couple", "people", "us", "me",
  "asap", "tonight", "today", "tomorrow", "minutes", "mins", "oclock", "pm", "am",
]);

// ---------------------------------------------------------------- missing required

interface MissingGroup {
  orderItemId: string;
  menuItemId: string;
  groupId: string;
  groupName: string;
  maxSelect: number;
  options: { id: string; name: string }[];
  /** Modifier ids already chosen on the line (all groups). */
  chosenIds: string[];
}

async function missingRequiredGroups(
  ctx: AgentContext,
  order: OrderWithItems,
): Promise<MissingGroup[]> {
  const missing: MissingGroup[] = [];
  for (const item of order.items) {
    if (!item.menuItemId) continue;
    const groups = await getModifierGroups(ctx.db, item.menuItemId);
    for (const group of groups) {
      const minimum = group.required ? Math.max(1, group.minSelect) : group.minSelect;
      if (minimum < 1) continue;
      const chosenInGroup = item.modifiers.filter(
        (m) => m.groupNameSnapshot === group.name,
      ).length;
      if (chosenInGroup >= minimum) continue;
      missing.push({
        orderItemId: item.id,
        menuItemId: item.menuItemId,
        groupId: group.id,
        groupName: group.name,
        maxSelect: group.maxSelect,
        options: group.modifiers.filter((m) => m.isAvailable).map((m) => ({ id: m.id, name: m.name })),
        chosenIds: item.modifiers.filter((m) => m.modifierId).map((m) => m.modifierId!),
      });
    }
  }
  return missing;
}

/**
 * Map utterance tokens to options of ONE group. Every non-filler,
 * non-scope token must resolve to exactly one option or the match fails.
 */
function contentTokens(text: string): string[] {
  return normalise(text)
    .split(" ")
    .filter((w) => w && !FILLER_WORDS.has(w) && w !== "sauce" && w !== "sauces");
}

function matchOptions(
  utterance: string,
  options: { id: string; name: string }[],
): { ids: string[]; scopeAll: boolean } | null {
  let scopeAll = false;
  const tokens = contentTokens(utterance).filter((t) => {
    if (SCOPE_ALL_WORDS.has(t)) {
      scopeAll = true;
      return false;
    }
    return true;
  });
  if (tokens.length === 0) return null;

  // Whole-utterance exact option name first (filler-insensitive, so
  // "chips and salad" matches "Chips & Salad").
  const joined = tokens.join(" ");
  for (const opt of options) {
    if (joined === contentTokens(opt.name).join(" ")) {
      return { ids: [opt.id], scopeAll };
    }
  }

  // token -> option (only unambiguous tokens usable)
  const tokenMap = new Map<string, Set<string>>();
  for (const opt of options) {
    for (const w of [...contentTokens(opt.name), contentTokens(opt.name).join("")]) {
      if (!tokenMap.has(w)) tokenMap.set(w, new Set());
      tokenMap.get(w)!.add(opt.id);
    }
  }
  const ids: string[] = [];
  for (const token of tokens) {
    const hit = tokenMap.get(token);
    if (!hit || hit.size !== 1) return null; // unknown or ambiguous word -> LLM
    const id = [...hit][0]!;
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return null;
  return { ids, scopeAll };
}

// ---------------------------------------------------------------- main entry

export interface FastPathOptions {
  /**
   * Probing a live STT PARTIAL (not the final transcript). The partial can be
   * a complete-looking PREFIX of a longer utterance, so skip new-item adds:
   * matching "two chicken meatboxes" off a partial could drop a trailing
   * "...and a coke". Item adds wait for the accurate committed transcript.
   * Answer turns (options, name, confirm, finish) stay eligible — they answer
   * a specific question and are inherently complete.
   */
  probe?: boolean;
}

export async function tryFastPath(
  ctx: AgentContext,
  state: AgentState,
  utterance: string,
  opts: FastPathOptions = {},
): Promise<FastPathResult> {
  const text = utterance.trim();
  if (!text || text.length > 80) return NOT_HANDLED; // long speech -> LLM
  const calls: ToolCallRecord[] = [];
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await executeTool(ctx, state, name, input);
    calls.push({ name: `fast:${name}`, input, result });
    return result;
  };
  const canText =
    ctx.settings.customerSmsEnabled && Boolean(ctx.callerNumber && ctx.callerNumber.startsWith("+"));

  // "Hang on" — acknowledge and wait, never prompt.
  if (WAIT_REGEX.test(normalise(text)) && !atConfirmStage(state)) {
    return { handled: true, say: "Yep.", toolCalls: calls, kind: "wait" };
  }

  // A bare greeting back at the start ("hey", "hi there") — answer instantly
  // like a person would, instead of a ~2s LLM pleasantry. Committed-transcript
  // only (never a probe): a partial "hey" could be the front of "hey, can I
  // grab two meatboxes" and we must not answer the greeting and drop the order.
  if (!opts.probe && atGreetingStage(state) && !state.draftOrderId && isGreetingOnly(text)) {
    return { handled: true, say: GREETING_ACK, toolCalls: calls, kind: "greeting_ack" };
  }

  // A pending (incomplete) item means the order isn't settled — finishing
  // or confirming deterministically could silently DROP that item. The LLM
  // has the conversational context to resolve it.
  const hasPending = Boolean(state.pendingItem);

  // ---- final YES at read-back -> confirm + close + hang up
  if (atConfirmStage(state) && state.draftOrderId && !hasPending && isYes(text)) {
    const result = await run("confirm_order", {});
    if (result.error) return NOT_HANDLED; // guard tripped -> let the LLM sort it out
    const eta = typeof result.readyEstimate === "string"
      ? result.readyEstimate.split(" (")[0]
      : null;
    const say = `Done. ${eta ? `${eta[0]!.toUpperCase()}${eta.slice(1)}. ` : ""}${canText ? "I'll text it through." : ""}`.trim();
    await run("end_call", { reason: "done" });
    return { handled: true, say, endCall: true, toolCalls: calls, kind: "confirm_yes" };
  }

  // ---- "anything else?" -> "nah" -> name (if needed) or read-back
  if (atAnythingElseStage(state) && state.draftOrderId && !hasPending && isFinished(text)) {
    const order = await getOrderWithItems(ctx.db, state.draftOrderId);
    if (!order || order.items.length === 0) return NOT_HANDLED;
    // Anything still missing a required option? Let the LLM ask properly.
    if ((await missingRequiredGroups(ctx, order)).length > 0) return NOT_HANDLED;
    if (!order.customerName.trim()) {
      return {
        handled: true,
        say: "What name shall I put it under?",
        toolCalls: calls,
        kind: "ask_name",
      };
    }
    state.summarySeq = state.mutationSeq; // total stated = summary read
    return { handled: true, say: spokenClose(order), toolCalls: calls, kind: "close" };
  }

  // ---- name answer after our deterministic name question
  if (atNameStage(state) && state.draftOrderId) {
    const name = cleanName(text);
    if (name) {
      await run("set_order_details", { customerName: name });
      const order = await getOrderWithItems(ctx.db, state.draftOrderId);
      if (!order) return NOT_HANDLED;
      state.summarySeq = state.mutationSeq;
      return { handled: true, say: spokenClose(order), toolCalls: calls, kind: "name_close" };
    }
    return NOT_HANDLED;
  }

  // ---- deterministic item ordering: a clear menu item at the greeting or
  // after "anything else?" is added without the LLM ("two chicken meatboxes").
  // Skipped when probing a partial (could be a prefix of a bigger order).
  if (!opts.probe && !hasPending && (atGreetingStage(state) || atAnythingElseStage(state))) {
    const items = await listItems(ctx.db, ctx.restaurant.id);
    const match = matchMenuItem(
      text,
      items.map((i) => ({ name: i.name, aliases: i.aliases })),
    );
    if (match) {
      if (!ctx.settings.acceptingOrders) return NOT_HANDLED; // paused -> LLM apologises
      if (!state.draftOrderId) {
        const draft = await run("create_order_draft", { orderType: "takeaway" });
        if (draft.error) return NOT_HANDLED;
      }
      const result = await run("add_order_item", {
        menuItemName: match.menuItemName,
        quantity: match.quantity,
      });
      // Missing a required option (base/sauce) -> executor stashed pending +
      // returned the exact question to ask.
      if (result.itemSavedAsPending && typeof result.ask === "string") {
        return { handled: true, say: result.ask, toolCalls: calls, kind: "item_pending" };
      }
      if (!result.error) {
        return { handled: true, say: "Anything else?", toolCalls: calls, kind: "item_added" };
      }
      return NOT_HANDLED; // add failed unexpectedly -> LLM
    }
    // No clean single-item match at the greeting -> LLM understands it.
    if (atGreetingStage(state)) return NOT_HANDLED;
  }

  // ---- caller volunteers a name at "anything else?" ("it's Kevin", "under
  // Sam") instead of saying "no" first: finish + set name + total-only close,
  // all deterministic. Requires an explicit name lead-in so a garbled item
  // word can't be mistaken for a name; a bare word stays with the LLM.
  const leadIn = NAME_LEADIN_RE.exec(text.trim());
  if (leadIn && atAnythingElseStage(state) && state.draftOrderId && !hasPending && !isYes(text)) {
    const captured = normalise(leadIn[1]!);
    const capTokens = captured.split(" ").filter(Boolean);
    const isName =
      capTokens.length >= 1 &&
      capTokens.length <= 2 &&
      capTokens.every((t) => !NON_NAME_WORDS.has(t) && QTY_WORDS[t] === undefined);
    const name = isName ? cleanName(leadIn[1]!) : null;
    if (name) {
      const order = await getOrderWithItems(ctx.db, state.draftOrderId);
      if (
        order &&
        order.status === "draft" &&
        order.items.length > 0 &&
        !order.customerName.trim() &&
        (await missingRequiredGroups(ctx, order)).length === 0 &&
        (await optionalGroupTargets(ctx, order, text)).length === 0
      ) {
        await run("set_order_details", { customerName: name });
        const fresh = await getOrderWithItems(ctx.db, state.draftOrderId);
        if (fresh) {
          state.summarySeq = state.mutationSeq;
          return { handled: true, say: spokenClose(fresh), toolCalls: calls, kind: "name_close" };
        }
      }
    }
  }

  // ---- completing a pending item whose required option was missing
  // ("Chicken meatbox" -> add failed on Base -> "chips" completes the add)
  if (state.pendingItem && state.draftOrderId && !atConfirmStage(state)) {
    const pending = state.pendingItem;
    const groups = await getModifierGroups(ctx.db, pending.menuItemId);
    const chosenGroupIds = new Set(
      groups
        .flatMap((g) => g.modifiers.map((m) => ({ g, id: m.id })))
        .filter((x) => pending.modifierIds.includes(x.id))
        .map((x) => x.g.id),
    );
    const missingGroups = groups.filter((g) => {
      const minimum = g.required ? Math.max(1, g.minSelect) : g.minSelect;
      return minimum > 0 && !chosenGroupIds.has(g.id);
    });
    if (missingGroups.length > 0) {
      const target = missingGroups[0]!;
      const match = matchOptions(text, target.modifiers.filter((m) => m.isAvailable));
      if (match && match.ids.length <= target.maxSelect) {
        const result = await run("add_order_item", {
          menuItemId: pending.menuItemId,
          quantity: pending.quantity,
          modifierIds: [...pending.modifierIds, ...match.ids],
          removals: pending.removals,
          ...(pending.specialInstructions
            ? { specialInstructions: pending.specialInstructions }
            : {}),
        });
        if (!result.error) {
          // Added (executor cleared pendingItem). Next question, if any.
          return { handled: true, say: "Anything else?", toolCalls: calls, kind: "pending_fill" };
        }
        // Another required group still missing: the executor re-stashed the
        // pending item WITH the options we just merged — ask the next one.
        if (result.code === "MODIFIER_REQUIRED" && state.pendingItem) {
          const nowChosen = new Set(state.pendingItem.modifierIds);
          const next = groups.find((g) => {
            const minimum = g.required ? Math.max(1, g.minSelect) : g.minSelect;
            return minimum > 0 && !g.modifiers.some((m) => nowChosen.has(m.id));
          });
          if (next) {
            return {
              handled: true,
              say: groupQuestion(next.name, next.modifiers.filter((m) => m.isAvailable).map((m) => m.name)),
              toolCalls: calls,
              kind: "pending_next_question",
            };
          }
        }
        return NOT_HANDLED;
      }
    }
    return NOT_HANDLED; // pending item but unclear answer -> LLM
  }

  // ---- bare option answers ("large", "garlic", "garlic and chilli on both")
  if (state.draftOrderId && !atConfirmStage(state)) {
    const order = await getOrderWithItems(ctx.db, state.draftOrderId);
    if (!order || order.status !== "draft" || order.items.length === 0) return NOT_HANDLED;
    const missing = await missingRequiredGroups(ctx, order);

    let targets: MissingGroup[];
    let kind: string;
    if (missing.length > 0) {
      // Answering the pending required-option question.
      const groupName = missing[0]!.groupName;
      targets = missing.filter((m) => m.groupName === groupName);
      kind = "option_fill";
    } else {
      // Nothing required is missing — a clean option answer here is the
      // caller ADDING options ("garlic on both"). Find the one optional
      // group whose options cover the utterance across all items.
      targets = await optionalGroupTargets(ctx, order, text);
      kind = "optional_fill";
      if (targets.length === 0) return NOT_HANDLED;
    }

    const match = matchOptions(text, targets[0]!.options);
    if (!match) return NOT_HANDLED;
    if (match.ids.length > targets[0]!.maxSelect) return NOT_HANDLED;
    // Default to ALL matching items: a bare "lettuce and tomato" after
    // "salad on both" means both — and the read-back surfaces it anyway.
    const applyTo = targets;
    const nameById = new Map(targets[0]!.options.map((o) => [o.id, normalise(o.name)]));
    for (const target of applyTo) {
      // Same group on another item may have different modifier ids — remap by name.
      const ids =
        target === targets[0]
          ? match.ids
          : match.ids
              .map((id) => target.options.find((o) => normalise(o.name) === nameById.get(id))?.id)
              .filter((id): id is string => Boolean(id));
      if (ids.length === 0) continue;
      const merged = [...new Set([...target.chosenIds, ...ids])];
      if (merged.length > /* whole line cap */ 12) return NOT_HANDLED;
      const result = await run("update_order_item", {
        orderItemId: target.orderItemId,
        modifierIds: merged,
      });
      if (result.error) return NOT_HANDLED; // validation said no -> LLM takes over
    }
    // What's next? The following missing required group, or "Anything else?"
    const fresh = await getOrderWithItems(ctx.db, state.draftOrderId);
    const stillMissing = fresh ? await missingRequiredGroups(ctx, fresh) : [];
    const say = stillMissing.length > 0 ? `${stillMissing[0]!.groupName}?` : "Anything else?";
    return { handled: true, say, toolCalls: calls, kind };
  }

  return NOT_HANDLED;
}

/**
 * For an "add options" utterance with nothing required missing: the single
 * optional group (by name, across items) whose options cover the utterance.
 * Groups with maxSelect 1 that are already filled are skipped (that's a
 * CHANGE, which the LLM should handle).
 */
async function optionalGroupTargets(
  ctx: AgentContext,
  order: OrderWithItems,
  utterance: string,
): Promise<MissingGroup[]> {
  const byName = new Map<string, MissingGroup[]>();
  for (const item of order.items) {
    if (!item.menuItemId) continue;
    const groups = await getModifierGroups(ctx.db, item.menuItemId);
    for (const group of groups) {
      const chosenInGroup = item.modifiers.filter(
        (m) => m.groupNameSnapshot === group.name,
      ).length;
      if (chosenInGroup >= group.maxSelect) continue; // full — a change, not an add
      const entry: MissingGroup = {
        orderItemId: item.id,
        menuItemId: item.menuItemId,
        groupId: group.id,
        groupName: group.name,
        maxSelect: group.maxSelect,
        options: group.modifiers
          .filter((m) => m.isAvailable)
          .map((m) => ({ id: m.id, name: m.name })),
        chosenIds: item.modifiers.filter((m) => m.modifierId).map((m) => m.modifierId!),
      };
      if (!byName.has(group.name)) byName.set(group.name, []);
      byName.get(group.name)!.push(entry);
    }
  }
  const covering: { entries: MissingGroup[]; strong: boolean }[] = [];
  for (const entries of byName.values()) {
    const match = matchOptions(utterance, entries[0]!.options);
    if (!match) continue;
    // Strong claim: every matched option is hit by exact phrase or by the
    // option's FIRST content word ("garlic" -> "Garlic sauce" is strong;
    // "garlic" -> "Extra garlic dip" is weak).
    const strong = match.ids.every((id) => {
      const opt = entries[0]!.options.find((o) => o.id === id)!;
      const words = contentTokens(opt.name);
      const utteranceTokens = new Set(contentTokens(utterance));
      return (
        words.length > 0 &&
        (utteranceTokens.has(words[0]!) ||
          contentTokens(utterance).join(" ") === words.join(" "))
      );
    });
    covering.push({ entries, strong });
  }
  const strongOnes = covering.filter((c) => c.strong);
  const pool = strongOnes.length > 0 ? strongOnes : covering;
  // Exactly one group may claim the utterance, or it's ambiguous -> LLM.
  return pool.length === 1 ? pool[0]!.entries : [];
}

