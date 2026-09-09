import type pg from "pg";
import { formatCents } from "../money";
import { describeWeek, openStateAt, validateRequestedTime } from "../domain/hours";
import {
  getItem,
  getModifierGroups,
  listCategories,
  listItems,
  searchMenu,
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
import { linkCallOrder } from "../domain/calls";
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
}

export interface AgentState {
  draftOrderId: string | null;
  /** Monotonic counters implementing the "summary before confirm" guard. */
  mutationSeq: number;
  summarySeq: number;
  confirmedOrderNumber: string | null;
  endCallRequested: boolean;
  outcome: CallOutcome;
}

export function initialAgentState(): AgentState {
  return {
    draftOrderId: null,
    mutationSeq: 0,
    summarySeq: 0,
    confirmedOrderNumber: null,
    endCallRequested: false,
    outcome: "NO_ORDER",
  };
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
      "Add an item to the order. Pass modifierIds for every option the customer chose (required groups must be satisfied). removals lists ingredients to leave out.",
    input_schema: {
      type: "object",
      properties: {
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
      "Change a line in the order: quantity, options (modifierIds replaces ALL options for the line), removals or instructions. Get line ids from get_order_summary.",
    input_schema: {
      type: "object",
      properties: {
        orderItemId: str,
        quantity: { ...num, minimum: 1 },
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

    case "create_order_draft": {
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
      const updated = await addOrderItem(db, {
        orderId: order.id,
        menuItemId: input.menuItemId ? String(input.menuItemId) : undefined,
        specialId: input.specialId ? String(input.specialId) : undefined,
        quantity: Number(input.quantity ?? 1),
        modifierIds: Array.isArray(input.modifierIds) ? input.modifierIds.map(String) : [],
        removals: Array.isArray(input.removals) ? input.removals.map(String) : [],
        specialInstructions: input.specialInstructions ? String(input.specialInstructions) : undefined,
      });
      state.mutationSeq++;
      return orderPublic(updated);
    }

    case "update_order_item": {
      const order = await requireDraft(ctx, state);
      const updated = await updateOrderItem(db, {
        orderId: order.id,
        orderItemId: String(input.orderItemId ?? ""),
        quantity: input.quantity !== undefined ? Number(input.quantity) : undefined,
        modifierIds: Array.isArray(input.modifierIds) ? input.modifierIds.map(String) : undefined,
        removals: Array.isArray(input.removals) ? input.removals.map(String) : undefined,
        specialInstructions:
          input.specialInstructions !== undefined ? String(input.specialInstructions) : undefined,
      });
      state.mutationSeq++;
      return orderPublic(updated);
    }

    case "remove_order_item": {
      const order = await requireDraft(ctx, state);
      const updated = await removeOrderItem(db, order.id, String(input.orderItemId ?? ""));
      state.mutationSeq++;
      return orderPublic(updated);
    }

    case "set_order_details": {
      const order = await requireDraft(ctx, state);
      let requestedAsap: boolean | undefined;
      let requestedTime: Date | null | undefined;
      if (input.pickupTime !== undefined) {
        const raw = String(input.pickupTime).trim();
        if (/^asap$/i.test(raw)) {
          requestedAsap = true;
          requestedTime = null;
          const openNow = openStateAt(hours, now, restaurant.timezone).open;
          if (!openNow) {
            return { error: "The kitchen is closed right now, so ASAP isn't possible. Ask for a time when the kitchen is open." };
          }
        } else {
          const parsed = new Date(raw);
          if (Number.isNaN(parsed.getTime())) {
            return { error: "Couldn't parse that pickup time. Pass ISO 8601 like 2026-09-09T19:20:00+08:00 or 'ASAP'." };
          }
          const check = validateRequestedTime({
            rows: hours,
            timezone: restaurant.timezone,
            now,
            requested: parsed,
            minPrepMinutes: settings.minPrepMinutes,
            maxFutureHours: settings.maxFutureHours,
            futureOrdersEnabled: settings.futureOrdersEnabled,
          });
          if (!check.ok) return { error: check.reason };
          requestedAsap = false;
          requestedTime = parsed;
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
      return {
        ok: true,
        customerName: updated.customerName || null,
        orderType: updated.orderType,
        pickup: updated.requestedAsap ? "ASAP" : (updated.requestedTime?.toISOString() ?? null),
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
      if (state.summarySeq < state.mutationSeq) {
        return {
          error:
            "The order changed since you last read it back. Call get_order_summary, read it to the customer, and get an explicit yes before confirming.",
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
      return {
        confirmed: true,
        orderNumber: result.order.publicOrderNumber,
        total: formatCents(result.order.totalCents),
        note: "Order stored and kitchen notified. Give the customer the order number, say goodbye, then end_call.",
      };
    }

    case "cancel_order": {
      const order = await requireDraft(ctx, state);
      await cancelOrder(db, order.id, "ai", input.reason ? String(input.reason) : "customer changed mind");
      state.draftOrderId = null;
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
