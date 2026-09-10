export type OrderType = "takeaway" | "dine_in";

export type OrderStatus =
  | "draft"
  | "new"
  | "accepted"
  | "preparing"
  | "ready"
  | "completed"
  | "cancelled"
  | "needs_review";

export type CallOutcome =
  | "ORDER_COMPLETED"
  | "REVIEW_LINK_SENT"
  | "MENU_ENQUIRY"
  | "CALL_DROPPED"
  | "CUSTOMER_CANCELLED"
  | "NEEDS_REVIEW"
  | "NO_ORDER";

export interface Restaurant {
  id: string;
  name: string;
  phoneDisplay: string;
  address: string;
  timezone: string;
}

export interface RestaurantSettings {
  restaurantId: string;
  kitchenCapacity: number;
  simpleBaselineSeconds: number;
  complexBaselineSeconds: number;
  acceptingOrders: boolean;
  pauseReason: string;
  reviewTtlSeconds: number;
  delayNotifyThresholdSeconds: number;
  ownerSmsNumber: string;
  customerSmsEnabled: boolean;
  futureOrdersEnabled: boolean;
  minPrepMinutes: number;
  maxFutureHours: number;
  orderNumberPrefix: string;
  aiGreeting: string;
  aiModel: string;
  fallbackBehaviour: "take_message" | "end_politely";
  ttsProvider: string;
  ttsVoice: string;
  ttsLanguage: string;
  sttProvider: string;
  sttModel: string;
  speechHints: string;
  recordingEnabled: boolean;
}

export interface RestaurantHoursRow {
  id: string;
  restaurantId: string;
  dayOfWeek: number; // 0 = Sunday
  opensAt: string | null; // "17:00:00"
  closesAt: string | null;
  isClosed: boolean;
}

export interface MenuCategory {
  id: string;
  restaurantId: string;
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
  active: boolean;
}

export interface MenuItem {
  id: string;
  restaurantId: string;
  categoryId: string;
  name: string;
  description: string;
  priceCents: number;
  imageUrl: string;
  isVegetarian: boolean;
  isAvailable: boolean;
  isSoldOut: boolean;
  isPopular: boolean;
  prepNotes: string;
  aliases: string[];
  sortOrder: number;
  active: boolean;
}

export interface ModifierGroup {
  id: string;
  menuItemId: string;
  name: string;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
}

export interface Modifier {
  id: string;
  groupId: string;
  name: string;
  priceCents: number;
  isAvailable: boolean;
  sortOrder: number;
}

export interface ModifierGroupWithModifiers extends ModifierGroup {
  modifiers: Modifier[];
}

export interface DailySpecial {
  id: string;
  restaurantId: string;
  name: string;
  description: string;
  priceCents: number;
  startsAt: Date;
  endsAt: Date;
  active: boolean;
  quantityLimit: number | null;
  quantityUsed: number;
}

export interface Order {
  id: string;
  publicOrderNumber: string | null;
  restaurantId: string;
  customerName: string;
  customerPhone: string;
  orderType: OrderType;
  status: OrderStatus;
  requestedAsap: boolean;
  requestedTime: Date | null;
  confirmedAt: Date | null;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  customerNotes: string;
  allergyNotes: string;
  internalNotes: string;
  callId: string | null;
  idempotencyKey: string | null;
  ownerSmsAlert: boolean;
  source: "phone" | "pos" | "web";
  paymentMethod: "" | "cash" | "card" | "tap";
  paidAt: Date | null;
  customerId: string | null;
  firstPromisedReadyAt: Date | null;
  currentEstimatedReadyAt: Date | null;
  reviewExpiresAt: Date | null;
  delayNotifiedReadyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PaymentStatus = "pending" | "succeeded" | "failed" | "cancelled";

export interface Payment {
  id: string;
  restaurantId: string;
  orderId: string;
  provider: "mock_terminal" | "square_terminal" | "manual";
  method: "terminal" | "cash" | "card" | "tap";
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  providerPaymentId: string | null;
  idempotencyKey: string;
  failureReason: string;
  authorisedBy: string;
  createdAt: Date;
  updatedAt: Date;
  settledAt: Date | null;
}

export interface Refund {
  id: string;
  restaurantId: string;
  paymentId: string;
  providerRefundId: string | null;
  amountCents: number;
  status: "pending" | "succeeded" | "failed";
  reason: string;
  createdBy: string;
  createdAt: Date;
  settledAt: Date | null;
}

export interface OrderItemModifier {
  id: string;
  orderItemId: string;
  modifierId: string | null;
  groupNameSnapshot: string;
  nameSnapshot: string;
  priceCents: number;
}

export interface OrderItem {
  id: string;
  orderId: string;
  menuItemId: string | null;
  specialId: string | null;
  nameSnapshot: string;
  unitPriceCents: number;
  quantity: number;
  specialInstructions: string;
  removals: string[];
  lineTotalCents: number;
  sortOrder: number;
  modifiers: OrderItemModifier[];
}

export interface OrderWithItems extends Order {
  items: OrderItem[];
}

export interface CallRecord {
  id: string;
  restaurantId: string;
  twilioCallSid: string | null;
  callerNumber: string;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null;
  status: "in_progress" | "completed" | "failed";
  outcome: CallOutcome | null;
  orderId: string | null;
  transcript: TranscriptTurn[];
}

export interface TranscriptTurn {
  role: "caller" | "assistant" | "system";
  text: string;
  at: string; // ISO timestamp
}

export interface User {
  id: string;
  restaurantId: string;
  email: string;
  name: string;
  role: "owner" | "staff";
  active: boolean;
}

/** Generic snake_case DB row -> camelCase object mapper. */
export function camelRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[camel] = value;
  }
  return out as T;
}

export function camelRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => camelRow<T>(r));
}
