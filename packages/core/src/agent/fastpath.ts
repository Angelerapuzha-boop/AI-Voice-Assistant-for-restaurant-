import { getModifierGroups } from "../domain/menu";
import { getOrderWithItems } from "../domain/orders";
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

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const YES_PHRASES = new Set([
  "yes", "yep", "yeah", "yup", "correct", "that's right", "thats right",
  "that's correct", "thats correct", "all good", "sounds good", "sweet",
  "sure", "go ahead", "confirm", "yes please", "yeah that's right",
  "yep that's right", "yeah correct", "yep correct", "righto", "right",
  "yes that's right", "yes correct", "perfect", "spot on", "done", "good",
]);

const FINISH_PHRASES = new Set([
  "no", "nah", "nope", "nothing", "nothing else", "no that's it",
  "that's it", "thats it", "that's all", "thats all", "that's the lot",
  "thats the lot", "that's me", "thats me", "all good", "that'll do",
  "that will do", "that's everything", "thats everything", "no that's all",
  "nah that's it", "nah thats it", "no thats it", "im good", "i'm good",
  "we're good", "were good", "that is it", "that is all",
]);

const WAIT_REGEX =
  /\b(hang on|hold on|one sec|one second|give us a sec|give me a sec|just a sec|just a second|just a minute|one minute|hold up|wait)\b/;

function stripPoliteness(text: string): string {
  return text
    .replace(/\b(please|mate|thanks|thank you|cheers|ta)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isYes(text: string): boolean {
  return YES_PHRASES.has(stripPoliteness(normalise(text)));
}

export function isFinished(text: string): boolean {
  return FINISH_PHRASES.has(stripPoliteness(normalise(text)));
}

// ---------------------------------------------------------------- stages

function lastLine(state: AgentState): string {
  return normalise(state.lastAssistantText);
}

function atConfirmStage(state: AgentState): boolean {
  return /correct\s*$/.test(lastLine(state));
}

function atAnythingElseStage(state: AgentState): boolean {
  return /anything else\s*$/.test(lastLine(state));
}

function atNameStage(state: AgentState): boolean {
  return /name shall i put it under\s*$/.test(lastLine(state));
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

export async function tryFastPath(
  ctx: AgentContext,
  state: AgentState,
  utterance: string,
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

  // ---- final YES at read-back -> confirm + close + hang up
  if (atConfirmStage(state) && state.draftOrderId && isYes(text)) {
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
  if (atAnythingElseStage(state) && state.draftOrderId && isFinished(text)) {
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
    state.summarySeq = state.mutationSeq; // spoken read-back = summary read
    return { handled: true, say: terseReadback(order), toolCalls: calls, kind: "readback" };
  }

  // ---- name answer after our deterministic name question
  if (atNameStage(state) && state.draftOrderId) {
    const cleaned = text
      .replace(/\b(it's|its|it is|the name is|name is|under|for|put it under)\b/gi, " ")
      .replace(/[^a-zA-Z\s'-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = cleaned.split(" ").filter(Boolean);
    if (words.length >= 1 && words.length <= 3 && cleaned.length >= 2 && cleaned.length <= 40) {
      const name = words
        .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
      await run("set_order_details", { customerName: name });
      const order = await getOrderWithItems(ctx.db, state.draftOrderId);
      if (!order) return NOT_HANDLED;
      state.summarySeq = state.mutationSeq;
      return { handled: true, say: terseReadback(order), toolCalls: calls, kind: "name_readback" };
    }
    return NOT_HANDLED;
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
    const applyTo = match.scopeAll || targets.length === 1 ? targets : [targets[0]!];
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

