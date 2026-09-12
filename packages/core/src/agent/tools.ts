import type pg from "pg";
import { formatCents } from "../money";
import { describeWeek, openStateAt, validateRequestedTime } from "../domain/hours";
import {
  getItem,
  getModifierGroups,
  listCategories,
  listItems,
  searchMenu,
  UUID_RE,
} from "../domain/menu";
import { getActiveSpecials } from "../domain/specials";
import {
  addOrderItem,
  cancelOrder,
  createDraft,
  getOrderWithItems,
  markNeedsReview,
  OrderValidationError,
  removeOrderItem,
  setOrderDetails,
  speakableSummary,
  updateOrderItem,
} from "../domain/orders";
import { confirmOrderWithNotifications } from "../domain/flow";
import { createReviewLink } from "../domain/review";
import { linkCallOrder } from "../domain/calls";
import { getLastOrderForPhone, isUsablePhone } from "../domain/customers";
import { enqueueNotification, formatLocalTime } from "../domain/notifications";
import { speakEta } from "../domain/eta";
import { resolveMenuItemByName, resolveModifierNames } from "./catalog";
import { isYes } from "./speech";
import { env } from "../env";
import type {
  CallOutcome,
  ModifierGroupWithModifiers,
  OrderWithItems,
  Restaurant,
  RestaurantHoursRow,
  RestaurantSettings,
} from "../types";
import type { LlmToolDef } from "./llm";

export interface AgentContext {
  db: pg.Pool;
  restaurant: Restaurant;
  settings: RestaurantSettings;
  hours: RestaurantHoursRow[];
  callId?: string;
  callerNumber?: string;
  now: () => Date;
  /** Per-call menu briefing (buildMenuCatalog) — lets the model order by exact name in one round. */
  menuCatalog?: string;
}

export interface AgentState {
  draftOrderId: string | null;
  /** Monotonic counters implementing the "summary before confirm" guard. */
  mutationSeq: number;
  summarySeq: number;
  confirmedOrderNumber: string | null;
  /** Visual path: a review link was texted; the draft awaits the customer's tap. */
  reviewLinkSent: boolean;
  endCallRequested: boolean;
  outcome: CallOutcome;
  /**
   * The assistant's previous spoken line (LLM- or fast-path-produced).
   * The deterministic fast paths key their stage detection off it.
   */
  lastAssistantText: string;
  /**
   * The caller's CURRENT utterance (set by the engine each turn). The
   * confirm_order hard guard requires it to be an explicit yes.
   */
  currentCallerText: string;
  /**
   * An add_order_item that failed on a missing REQUIRED option; the fast
   * path completes it from the caller's short answer without the LLM.
   */
  pendingItem: {
    menuItemId: string;
    quantity: number;
    modifierIds: string[];
    removals: string[];
    specialInstructions?: string;
  } | null;
}

export function initialAgentState(): AgentState {
  return {
    draftOrderId: null,
    mutationSeq: 0,
    summarySeq: 0,
    confirmedOrderNumber: null,
    reviewLinkSent: false,
    endCallRequested: false,
    outcome: "NO_ORDER",
    lastAssistantText: "",
    currentCallerText: "",
    pendingItem: null,
  };
}

/** "Chips and salad, or rice and salad?" for small groups, else "Base?" */
export function groupQuestion(groupName: string, optionNames: string[]): string {
  if (optionNames.length >= 2 && optionNames.length <= 3) {
    const spoken = optionNames.map((n) => n.replace(/\s*&\s*/g, " and ").toLowerCase());
    return `${spoken.slice(0, -1).join(", ")}, or ${spoken[spoken.length - 1]}?`;
  }
  return `${groupName}?`;
}

// ------------------------------------------------------------------ defs

const str = { type: "string" } as const;
const num = { type: "integer" } as const;

export const TOOL_DEFS: LlmToolDef[] = [
  {
    name: "get_restaurant_status",
    description:
      "Whether the restaurant is open right now, today's trading window and the current local time.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_restaurant_hours",
    description: "Weekly opening hours.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_menu",
    description:
      "Fuzzy search of menu items by name/keyword (handles speech like 'meat box'). Returns matches with prices and availability. If several items match what the caller wants, ask which one.",
    input_schema: {
      type: "object",
      properties: { query: { ...str, description: "What the caller asked for" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_menu_category",
    description:
      "List items in one category (e.g. meatbox, kebabs, drinks). Use list of categories returned to navigate.",
    input_schema: {
      type: "object",
      properties: { category: { ...str, description: "Category name or slug; empty lists categories" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_menu_item",
    description:
      "Full detail for one menu item: description, price, options (required and optional), availability.",
    input_schema: {
      type: "object",
      properties: { menuItemId: str },
      required: ["menuItemId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_available_modifiers",
    description: "Option groups (sauces, extras, sizes, meat choices) for a menu item.",
    input_schema: {
      type: "object",
      properties: { menuItemId: str },
      required: ["menuItemId"],
      additionalProperties: false,
    },
  },
  {
    name: "check_item_availability",
    description: "Check whether a menu item is currently available (not sold out).",
    input_schema: {
      type: "object",
      properties: { menuItemId: str },
      required: ["menuItemId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_daily_specials",
    description: "Today's active specials. Always call this before mentioning any special.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send_menu_link",
    description:
      "Text the caller a link to the menu website (their caller ID number only). Offer it instead of reciting the menu.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_current_order_status",
    description:
      "Status and ready estimate of the caller's most recent order (matched by caller ID). Use when they ask where their order is.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_repeat_candidate",
    description:
      "The caller's most recent completed order (matched by caller ID). Use when they ask for 'the usual' or 'same as last time'. Never recite their history unprompted.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "repeat_last_order",
    description:
      "Load the caller's last order into a new draft at CURRENT prices and availability. Report any items that changed or are unavailable, then read the cart back as usual.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_order_draft",
    description:
      "Start an order for this call. Call once, when the caller first wants to order something.",
    input_schema: {
      type: "object",
      properties: {
        customerName: str,
        orderType: { type: "string", enum: ["takeaway", "dine_in"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_order_item",
    description:
      "Add an item to the order. PREFERRED: pass menuItemName + modifierNames copied EXACTLY from the MENU section — no search needed. Call immediately even if a required option is missing (it saves the item as pending and returns the question to ask). removals lists ingredients to leave out.",
    input_schema: {
      type: "object",
      properties: {
        menuItemName: { ...str, description: "Exact item name from the MENU section" },
        modifierNames: {
          type: "array",
          items: str,
          description: "Exact option names from the MENU section",
        },
        menuItemId: str,
        specialId: str,
        quantity: { ...num, minimum: 1 },
        modifierIds: { type: "array", items: str },
        removals: { type: "array", items: str },
        specialInstructions: str,
      },
      required: ["quantity"],
      additionalProperties: false,
    },
  },
  {
    name: "update_order_item",
    description:
      "Change a line in the order: quantity, options (modifierNames/modifierIds replace ALL options for the line), removals or instructions. Get line ids from get_order_summary.",
    input_schema: {
      type: "object",
      properties: {
        orderItemId: str,
        quantity: { ...num, minimum: 1 },
        modifierNames: {
          type: "array",
          items: str,
          description: "Exact option names from the MENU section (full replacement)",
        },
        modifierIds: { type: "array", items: str },
        removals: { type: "array", items: str },
        specialInstructions: str,
      },
      required: ["orderItemId"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_order_item",
    description: "Remove a line from the order.",
    input_schema: {
      type: "object",
      properties: { orderItemId: str },
      required: ["orderItemId"],
      additionalProperties: false,
    },
  },
  {
    name: "set_order_details",
    description:
      "Set customer name, order type, pickup time ('ASAP' or ISO 8601 with +08:00), notes or allergy notes on the draft order.",
    input_schema: {
      type: "object",
      properties: {
        customerName: str,
        customerPhone: str,
        orderType: { type: "string", enum: ["takeaway", "dine_in"] },
        pickupTime: { ...str, description: "'ASAP' or ISO 8601 like 2026-09-09T19:20:00+08:00" },
        customerNotes: str,
        allergyNotes: str,
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_order_summary",
    description:
      "Current order contents with line ids, options and the server-calculated total. Use this to read the order back before confirming.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "calculate_order_total",
    description: "Server-calculated totals for the current order.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "confirm_order",
    description:
      "Confirm the order AFTER reading the summary back and hearing an explicit yes. Stores the order, notifies the kitchen and returns the order number.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send_review_link",
    description:
      "VISUAL confirmation: text the caller a secure link to check and confirm the order themselves (instead of a spoken read-back). Only when the caller prefers it or a long order makes read-back impractical. The order does NOT reach the kitchen until they tap Confirm — tell them that.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cancel_order",
    description: "Cancel the current draft order (customer changed their mind).",
    input_schema: {
      type: "object",
      properties: { reason: str },
      additionalProperties: false,
    },
  },
  {
    name: "flag_for_review",
    description:
      "When the call can't be completed normally (repeated misunderstanding, caller issue), save whatever exists as NEEDS REVIEW for staff follow-up.",
    input_schema: {
      type: "object",
      properties: { note: str },
      required: ["note"],
      additionalProperties: false,
    },
  },
  {
    name: "end_call",
    description: "Hang up politely AFTER your goodbye sentence has been spoken.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", enum: ["done", "no_order", "fallback"] } },
      additionalProperties: false,
    },
  },
];

// ------------------------------------------------------------------ helpers

function itemPublic(item: {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  isVegetarian: boolean;
  isAvailable: boolean;
  isSoldOut: boolean;
  isPopular: boolean;
}) {
  return {
    menuItemId: item.id,
    name: item.name,
    description: item.description,
    price: formatCents(item.priceCents),
    vegetarian: item.isVegetarian,
    available: item.isAvailable && !item.isSoldOut,
    popular: item.isPopular,
  };
}

function groupsPublic(groups: ModifierGroupWithModifiers[]) {
  return groups.map((g) => ({
    name: g.name,
    required: g.required || g.minSelect > 0,
    maxSelect: g.maxSelect,
    options: g.modifiers
      .filter((m) => m.isAvailable)
      .map((m) => ({
        modifierId: m.id,
        name: m.name,
        extraCost: m.priceCents > 0 ? formatCents(m.priceCents) : "free",
      })),
  }));
}

function orderPublic(order: OrderWithItems) {
  return {
    orderId: order.id,
    status: order.status,
    orderType: order.orderType,
    customerName: order.customerName || null,
    pickup: order.requestedAsap ? "ASAP" : (order.requestedTime?.toISOString() ?? null),
    lines: order.items.map((i) => ({
      orderItemId: i.id,
      name: i.nameSnapshot,
      quantity: i.quantity,
      options: i.modifiers.map((m) => m.nameSnapshot),
      removals: i.removals,
      instructions: i.specialInstructions || null,
      lineTotal: formatCents(i.lineTotalCents),
    })),
    subtotal: formatCents(order.subtotalCents),
    total: formatCents(order.totalCents),
    spokenSummary: speakableSummary(order),
  };
}

async function requireDraft(ctx: AgentContext, state: AgentState): Promise<OrderWithItems> {
  if (!state.draftOrderId) {
    throw new OrderValidationError("NO_DRAFT", "No order has been started yet — call create_order_draft first.");
  }
  const order = await getOrderWithItems(ctx.db, state.draftOrderId);
  if (!order) throw new OrderValidationError("ORDER_NOT_FOUND", "The order no longer exists.");
  return order;
}

// ------------------------------------------------------------------ executor

export async function executeTool(
  ctx: AgentContext,
  state: AgentState,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return await executeToolInner(ctx, state, name, input);
  } catch (err) {
    if (err instanceof OrderValidationError) {
      return { error: err.message, code: err.code };
    }
    console.error(`[agent] tool ${name} failed:`, err);
    return { error: "Something went wrong on our side with that step. Try once more or apologise to the caller." };
  }
}

async function executeToolInner(
  ctx: AgentContext,
  state: AgentState,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { db, restaurant, settings, hours } = ctx;
  const now = ctx.now();

  switch (name) {
    case "get_restaurant_status": {
      const s = openStateAt(hours, now, restaurant.timezone);
      return {
        open: s.open,
        acceptingOrders: settings.acceptingOrders,
        ...(settings.acceptingOrders
          ? {}
          : {
              pausedNote: `Ordering is paused right now${settings.pauseReason ? `: ${settings.pauseReason}` : ""} — apologise, don't take an order.`,
            }),
        todayHours: s.todayWindow,
        minutesUntilClose: s.minutesUntilClose,
        localTime: new Intl.DateTimeFormat("en-AU", {
          timeZone: restaurant.timezone,
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }).format(now),
        futureOrdersEnabled: settings.futureOrdersEnabled,
      };
    }

    case "send_menu_link": {
      if (!isUsablePhone(ctx.callerNumber)) {
        return { error: "No caller ID on this line — mention the website instead: " + env.APP_URL };
      }
      await enqueueNotification(db, {
        orderId: state.draftOrderId,
        kind: "customer_sms",
        toNumber: ctx.callerNumber,
        body: `${restaurant.name} menu: ${env.APP_URL} — call ${restaurant.phoneDisplay} to order.`,
      });
      return { ok: true, note: "Say a text with the menu is on its way (not that it has arrived)." };
    }

    case "get_current_order_status": {
      if (!isUsablePhone(ctx.callerNumber)) {
        return { error: "No caller ID — ask for their order number and tell them staff can check at the shop." };
      }
      const candidate = await getLastOrderForPhone(db, restaurant.id, ctx.callerNumber);
      if (!candidate) return { found: false, note: "No order found for this number." };
      const o = candidate.order;
      return {
        found: true,
        orderNumber: o.publicOrderNumber,
        status: o.status,
        readyEstimate:
          o.status === "ready"
            ? "ready for collection now"
            : o.currentEstimatedReadyAt
              ? `${speakEta(o.currentEstimatedReadyAt, now)} (around ${formatLocalTime(o.currentEstimatedReadyAt, restaurant.timezone)})`
              : null,
        note: "Only say it's ready if status is 'ready'.",
      };
    }

    case "get_restaurant_hours":
      return { hours: describeWeek(hours) };

    case "search_menu": {
      const results = await searchMenu(db, restaurant.id, String(input.query ?? ""));
      if (results.length === 0) return { matches: [], note: "Nothing on the menu matches that." };
      return {
        matches: results.map((r) => ({ ...itemPublic(r), category: r.categoryName })),
        note:
          results.length > 1
            ? "Multiple matches — if the caller was ambiguous, ask which one they meant."
            : undefined,
      };
    }

    case "get_menu_category": {
      const categories = await listCategories(db, restaurant.id);
      const wanted = String(input.category ?? "").toLowerCase().trim();
      if (!wanted) return { categories: categories.map((c) => ({ name: c.name, slug: c.slug })) };
      const match = categories.find(
        (c) => c.slug === wanted || c.name.toLowerCase() === wanted || c.name.toLowerCase().includes(wanted),
      );
      if (!match) {
        return { error: "No such category.", categories: categories.map((c) => c.slug) };
      }
      const items = await listItems(db, restaurant.id, { categoryId: match.id });
      return { category: match.name, items: items.map(itemPublic) };
    }

    case "get_menu_item": {
      const item = await getItem(db, String(input.menuItemId ?? ""));
      if (!item || !item.active) return { error: "That item isn't on the menu." };
      const groups = await getModifierGroups(db, item.id);
      return { ...itemPublic(item), options: groupsPublic(groups) };
    }

    case "get_available_modifiers": {
      const groups = await getModifierGroups(db, String(input.menuItemId ?? ""));
      return { options: groupsPublic(groups) };
    }

    case "check_item_availability": {
      const item = await getItem(db, String(input.menuItemId ?? ""));
      if (!item || !item.active) return { available: false, reason: "Not on the menu." };
      return {
        available: item.isAvailable && !item.isSoldOut,
        reason: item.isSoldOut ? "Sold out today." : !item.isAvailable ? "Not available." : undefined,
      };
    }

    case "get_daily_specials": {
      const specials = await getActiveSpecials(db, restaurant.id, now);
      if (specials.length === 0) {
        return {
          specials: [],
          note: "No specials today. You can suggest popular items instead — never invent a special.",
        };
      }
      return {
        specials: specials.map((s) => ({
          specialId: s.id,
          name: s.name,
          description: s.description,
          price: formatCents(s.priceCents),
        })),
      };
    }

    case "get_repeat_candidate": {
      if (!isUsablePhone(ctx.callerNumber)) {
        return { found: false, note: "No caller ID on this call — repeat orders unavailable." };
      }
      const candidate = await getLastOrderForPhone(db, restaurant.id, ctx.callerNumber);
      if (!candidate) {
        return { found: false, note: "No previous order for this number." };
      }
      return {
        found: true,
        customerName: candidate.customerName || candidate.order.customerName || null,
        previousOrderNumber: candidate.order.publicOrderNumber,
        lines: candidate.order.items.map((i) => ({
          name: i.nameSnapshot,
          quantity: i.quantity,
          options: i.modifiers.map((m) => m.nameSnapshot),
        })),
        note: "Use repeat_last_order to load it at current prices, then read it back as usual.",
      };
    }

    case "repeat_last_order": {
      if (!isUsablePhone(ctx.callerNumber)) {
        return { error: "No caller ID on this call — take the order fresh instead." };
      }
      const candidate = await getLastOrderForPhone(db, restaurant.id, ctx.callerNumber);
      if (!candidate) return { error: "No previous order found for this number." };
      if (!state.draftOrderId) {
        const draft = await createDraft(db, {
          restaurantId: restaurant.id,
          customerPhone: ctx.callerNumber,
          customerName: candidate.customerName || candidate.order.customerName || "",
          orderType: "takeaway",
          callId: ctx.callId,
          source: "phone",
        });
        state.draftOrderId = draft.id;
        state.mutationSeq++;
        if (ctx.callId) await linkCallOrder(db, ctx.callId, draft.id);
      }
      const changes: string[] = [];
      let added = 0;
      for (const line of candidate.order.items) {
        if (!line.menuItemId) {
          changes.push(`${line.nameSnapshot} was a special that has ended`);
          continue;
        }
        try {
          await addOrderItem(db, {
            orderId: state.draftOrderId!,
            menuItemId: line.menuItemId,
            quantity: line.quantity,
            modifierIds: line.modifiers.map((m) => m.modifierId).filter((id): id is string => Boolean(id)),
            removals: line.removals,
            specialInstructions: line.specialInstructions || undefined,
          });
          added++;
        } catch (err) {
          if (err instanceof OrderValidationError) {
            changes.push(`${line.nameSnapshot}: ${err.message}`);
          } else {
            throw err;
          }
        }
      }
      state.mutationSeq++;
      state.summarySeq = state.mutationSeq;
      const updated = await getOrderWithItems(db, state.draftOrderId!);
      return {
        ...(updated ? orderPublic(updated) : {}),
        repeatedLines: added,
        changes,
        note:
          changes.length > 0
            ? "Mention what changed, then read the cart back with the current total."
            : "Prices are current — read the cart back with the total.",
      };
    }

    case "create_order_draft": {
      if (!settings.acceptingOrders) {
        return {
          error: `Ordering is paused right now${settings.pauseReason ? `: ${settings.pauseReason}` : ""} — apologise and don't take an order.`,
        };
      }
      if (state.draftOrderId) {
        const existing = await getOrderWithItems(db, state.draftOrderId);
        if (existing && existing.status === "draft") {
          return { note: "An order is already in progress for this call.", ...orderPublic(existing) };
        }
      }
      const openNow = openStateAt(hours, now, restaurant.timezone).open;
      if (!openNow && !settings.futureOrdersEnabled) {
        return {
          error: "The kitchen is closed and future orders are disabled — do not take an order.",
        };
      }
      const draft = await createDraft(db, {
        restaurantId: restaurant.id,
        customerPhone: ctx.callerNumber ?? "",
        customerName: input.customerName ? String(input.customerName) : undefined,
        orderType: input.orderType === "dine_in" ? "dine_in" : "takeaway",
        callId: ctx.callId,
      });
      state.draftOrderId = draft.id;
      state.mutationSeq++;
      if (ctx.callId) await linkCallOrder(db, ctx.callId, draft.id);
      return { orderId: draft.id, note: openNow ? undefined : "Kitchen currently closed — a pickup time when open is required." };
    }

    case "add_order_item": {
      const order = await requireDraft(ctx, state);
      // Prank-order guard: absurd quantities never reach the cart.
      if (Number(input.quantity ?? 1) > 20) {
        return {
          error:
            "That quantity is unusually large (max 20 per line). Confirm the exact number with the caller; for genuine catering orders take their name and number, flag_for_review, and say staff will call back to arrange it.",
        };
      }
      // Name-based ordering (from the MENU section of the prompt) — the
      // model never needs a UUID or a search round-trip. A NAME passed in
      // the id field (models do this) is resolved, never an error
      // (2026-09-11 live incident: "Chicken Meatbox" as menuItemId).
      let menuItemId = input.menuItemId ? String(input.menuItemId) : undefined;
      let menuItemName = input.menuItemName ? String(input.menuItemName) : undefined;
      if (menuItemId && !UUID_RE.test(menuItemId)) {
        menuItemName = menuItemName ?? menuItemId;
        menuItemId = undefined;
      }
      // Models also FABRICATE well-formed ids (live incident: a made-up
      // uuid alongside the correct name broke the drink add) — an id that
      // doesn't exist falls back to the name.
      if (menuItemId && menuItemName && !(await getItem(db, menuItemId))) {
        menuItemId = undefined;
      }
      if (!menuItemId && menuItemName) {
        const resolved = await resolveMenuItemByName(db, restaurant.id, menuItemName);
        if ("error" in resolved) return { error: resolved.error };
        menuItemId = resolved.id;
      }
      // Same defence for options: non-uuid "ids" are treated as names.
      const rawModifierIds = Array.isArray(input.modifierIds) ? input.modifierIds.map(String) : [];
      let modifierIds = rawModifierIds.filter((id) => UUID_RE.test(id));
      const modifierNames = [
        ...(Array.isArray(input.modifierNames) ? input.modifierNames.map(String) : []),
        ...rawModifierIds.filter((id) => !UUID_RE.test(id)),
      ];
      if (modifierNames.length > 0 && menuItemId) {
        const groups = await getModifierGroups(db, menuItemId);
        const resolvedMods = resolveModifierNames(groups, modifierNames);
        if ("error" in resolvedMods) return { error: resolvedMods.error };
        modifierIds = [...new Set([...modifierIds, ...resolvedMods.ids])];
      }
      const addParams = {
        orderId: order.id,
        menuItemId,
        specialId: input.specialId ? String(input.specialId) : undefined,
        quantity: Number(input.quantity ?? 1),
        modifierIds,
        removals: Array.isArray(input.removals) ? input.removals.map(String) : [],
        specialInstructions: input.specialInstructions ? String(input.specialInstructions) : undefined,
      };
      let updated;
      try {
        updated = await addOrderItem(db, addParams);
      } catch (err) {
        // A required option is missing: remember the pending item so the
        // caller's short answer ("chips", "garlic") can complete the add
        // deterministically without another LLM round-trip — and hand the
        // model the exact question to relay.
        if (
          err instanceof OrderValidationError &&
          err.code === "MODIFIER_REQUIRED" &&
          addParams.menuItemId
        ) {
          state.pendingItem = {
            menuItemId: addParams.menuItemId,
            quantity: addParams.quantity,
            modifierIds: addParams.modifierIds,
            removals: addParams.removals,
            specialInstructions: addParams.specialInstructions,
          };
          const groups = await getModifierGroups(db, addParams.menuItemId);
          const chosen = new Set(addParams.modifierIds);
          const missing = groups.find((g) => {
            const minimum = g.required ? Math.max(1, g.minSelect) : g.minSelect;
            return minimum > 0 && !g.modifiers.some((m) => chosen.has(m.id));
          });
          return {
            error: err.message,
            code: err.code,
            itemSavedAsPending: true,
            ask: missing
              ? groupQuestion(
                  missing.name,
                  missing.modifiers.filter((m) => m.isAvailable).map((m) => m.name),
                )
              : undefined,
            note: "The item is saved as pending. Say ONLY the 'ask' question. The system completes the add from the caller's answer.",
          };
        }
        throw err;
      }
      // Only the pending item's own successful add clears it — an
      // unrelated item succeeding (parallel adds) must not wipe it.
      if (state.pendingItem && state.pendingItem.menuItemId === addParams.menuItemId) {
        state.pendingItem = null;
      }
      state.mutationSeq++;
      // The full cart + totals are in this response, so the model now holds
      // the current state — that satisfies the stale-state confirm guard.
      state.summarySeq = state.mutationSeq;
      return orderPublic(updated);
    }

    case "update_order_item": {
      const order = await requireDraft(ctx, state);
      if (input.quantity !== undefined && Number(input.quantity) > 20) {
        return {
          error:
            "That quantity is unusually large (max 20 per line). For genuine catering orders take a name and number, flag_for_review, and say staff will call back.",
        };
      }
      if (!UUID_RE.test(String(input.orderItemId ?? ""))) {
        return { error: "Invalid orderItemId — use the line ids returned by get_order_summary." };
      }
      const rawUpdateIds = Array.isArray(input.modifierIds) ? input.modifierIds.map(String) : undefined;
      let updateModifierIds = rawUpdateIds?.filter((id) => UUID_RE.test(id));
      const strayNames = rawUpdateIds?.filter((id) => !UUID_RE.test(id)) ?? [];
      if (Array.isArray(input.modifierNames) || strayNames.length > 0) {
        const lineRes = await db.query(`SELECT menu_item_id FROM order_items WHERE id = $1`, [
          String(input.orderItemId ?? ""),
        ]);
        const lineItemId = (lineRes.rows[0] as { menu_item_id: string | null } | undefined)
          ?.menu_item_id;
        if (lineItemId) {
          const groups = await getModifierGroups(db, lineItemId);
          const wantedNames = [
            ...(Array.isArray(input.modifierNames) ? input.modifierNames.map(String) : []),
            ...strayNames,
          ];
          const resolvedMods = resolveModifierNames(groups, wantedNames);
          if ("error" in resolvedMods) return { error: resolvedMods.error };
          updateModifierIds = [...new Set([...(updateModifierIds ?? []), ...resolvedMods.ids])];
        }
      }
      const updated = await updateOrderItem(db, {
        orderId: order.id,
        orderItemId: String(input.orderItemId ?? ""),
        quantity: input.quantity !== undefined ? Number(input.quantity) : undefined,
        modifierIds: updateModifierIds,
        removals: Array.isArray(input.removals) ? input.removals.map(String) : undefined,
        specialInstructions:
          input.specialInstructions !== undefined ? String(input.specialInstructions) : undefined,
      });
      state.mutationSeq++;
      state.summarySeq = state.mutationSeq;
      return orderPublic(updated);
    }

    case "remove_order_item": {
      const order = await requireDraft(ctx, state);
      if (!UUID_RE.test(String(input.orderItemId ?? ""))) {
        return { error: "Invalid orderItemId — use the line ids returned by get_order_summary." };
      }
      const updated = await removeOrderItem(db, order.id, String(input.orderItemId ?? ""));
      state.mutationSeq++;
      state.summarySeq = state.mutationSeq;
      return orderPublic(updated);
    }

    case "set_order_details": {
      const order = await requireDraft(ctx, state);
      let requestedAsap: boolean | undefined;
      let requestedTime: Date | null | undefined;
      let timeError: string | undefined;
      if (input.pickupTime !== undefined) {
        const raw = String(input.pickupTime).trim();
        if (/^asap$/i.test(raw)) {
          const openNow = openStateAt(hours, now, restaurant.timezone).open;
          if (openNow) {
            requestedAsap = true;
            requestedTime = null;
          } else {
            timeError =
              "The kitchen is closed right now, so ASAP isn't possible. Ask for a time when the kitchen is open.";
          }
        } else {
          const parsed = new Date(raw);
          if (Number.isNaN(parsed.getTime())) {
            timeError =
              "Couldn't parse that pickup time. Pass ISO 8601 like 2026-09-09T19:20:00+08:00 or 'ASAP'.";
          } else {
            const check = validateRequestedTime({
              rows: hours,
              timezone: restaurant.timezone,
              now,
              requested: parsed,
              minPrepMinutes: settings.minPrepMinutes,
              maxFutureHours: settings.maxFutureHours,
              futureOrdersEnabled: settings.futureOrdersEnabled,
            });
            if (check.ok) {
              requestedAsap = false;
              requestedTime = parsed;
            } else {
              timeError = check.reason;
            }
          }
        }
      }
      const updated = await setOrderDetails(db, {
        orderId: order.id,
        customerName: input.customerName !== undefined ? String(input.customerName) : undefined,
        customerPhone: input.customerPhone !== undefined ? String(input.customerPhone) : undefined,
        orderType:
          input.orderType === "dine_in" || input.orderType === "takeaway"
            ? input.orderType
            : undefined,
        requestedAsap,
        requestedTime,
        customerNotes: input.customerNotes !== undefined ? String(input.customerNotes) : undefined,
        allergyNotes: input.allergyNotes !== undefined ? String(input.allergyNotes) : undefined,
      });
      state.mutationSeq++;
      state.summarySeq = state.mutationSeq;
      const withItems = await getOrderWithItems(db, updated.id);
      return {
        ok: !timeError,
        ...(timeError ? { error: `${timeError} (other details were saved)` } : {}),
        ...(withItems ? orderPublic(withItems) : {}),
      };
    }

    case "get_order_summary":
    case "calculate_order_total": {
      const order = await requireDraft(ctx, state);
      state.summarySeq = state.mutationSeq;
      return orderPublic(order);
    }

    case "confirm_order": {
      const order = await requireDraft(ctx, state);
      // Closed kitchen + "ASAP" can never be confirmed (spec: no immediate
      // orders while closed) — a valid future pickup time is required.
      if (order.requestedAsap && !openStateAt(hours, now, restaurant.timezone).open) {
        return {
          error:
            "The kitchen is closed right now so an ASAP order can't be confirmed. Set a pickup time when the kitchen is open (set_order_details), then confirm.",
        };
      }
      if (state.summarySeq < state.mutationSeq) {
        return {
          error:
            "The order changed since you last read it back. Call get_order_summary, read it to the customer, and get an explicit yes before confirming.",
        };
      }
      // Fake-bulk-order guard: very large phone orders get a human
      // callback instead of silently hitting the kitchen.
      if (order.totalCents > 30000) {
        return {
          error:
            "Orders over $300 need staff confirmation. Make sure you have the caller's name and contact number (set_order_details), then flag_for_review and tell them staff will call back within a few minutes to confirm.",
        };
      }
      // HARD guard, model-independent: the caller's own current utterance
      // must be an explicit yes. A model can never talk itself into
      // confirming ("Correct? ... Done!") without the customer agreeing.
      if (state.currentCallerText && !isYes(state.currentCallerText)) {
        return {
          error:
            "The caller has not said yes in their latest utterance. Read the order back, then WAIT for their explicit yes before calling confirm_order.",
        };
      }
      const result = await confirmOrderWithNotifications(db, {
        orderId: order.id,
        restaurant,
        settings,
        idempotencyKey: ctx.callId ? `call-${ctx.callId}` : undefined,
        actor: "ai",
      });
      state.confirmedOrderNumber = result.order.publicOrderNumber;
      state.outcome = "ORDER_COMPLETED";
      const readyAt = result.order.currentEstimatedReadyAt;
      return {
        confirmed: true,
        orderNumber: result.order.publicOrderNumber,
        total: formatCents(result.order.totalCents),
        readyEstimate: readyAt
          ? `${speakEta(readyAt, now)} (around ${formatLocalTime(readyAt, restaurant.timezone)})`
          : null,
        note: "Order stored and kitchen notified. Give the customer the order number and the ready estimate using 'about', pay on collection, say goodbye, then end_call.",
      };
    }

    case "send_review_link": {
      const order = await requireDraft(ctx, state);
      if (!settings.customerSmsEnabled || !isUsablePhone(order.customerPhone || ctx.callerNumber)) {
        return { error: "Can't text this caller — confirm by voice read-back instead." };
      }
      if (!order.customerPhone && ctx.callerNumber) {
        await setOrderDetails(db, { orderId: order.id, customerPhone: ctx.callerNumber });
      }
      const fresh = (await getOrderWithItems(db, order.id))!;
      const { expiresAt } = await createReviewLink(db, { order: fresh, restaurant, settings });
      state.reviewLinkSent = true;
      state.outcome = "REVIEW_LINK_SENT";
      const minutes = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 60_000));
      return {
        ok: true,
        expiresInMinutes: minutes,
        note:
          "Say a text is on its way (not that it has arrived), and that the order only goes to the kitchen once they tap Confirm on the link. Then say goodbye and end_call. Do NOT call confirm_order.",
      };
    }

    case "cancel_order": {
      const order = await requireDraft(ctx, state);
      await cancelOrder(db, order.id, "ai", input.reason ? String(input.reason) : "customer changed mind");
      state.draftOrderId = null;
      state.pendingItem = null;
      state.mutationSeq++;
      if (state.outcome !== "ORDER_COMPLETED") state.outcome = "CUSTOMER_CANCELLED";
      return { cancelled: true };
    }

    case "flag_for_review": {
      const note = String(input.note ?? "Caller needs follow-up");
      if (state.draftOrderId) {
        await markNeedsReview(db, state.draftOrderId, `AI flagged: ${note}`);
      }
      state.outcome = "NEEDS_REVIEW";
      return { flagged: true };
    }

    case "end_call": {
      state.endCallRequested = true;
      if (state.outcome === "NO_ORDER" && input.reason === "done") {
        state.outcome = "MENU_ENQUIRY";
      }
      return { ending: true };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
