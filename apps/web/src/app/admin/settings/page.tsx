import SettingsForm, { type FieldDef } from "./settings-form";

const FIELDS: FieldDef[] = [
  { key: "name", label: "Restaurant name", type: "text", source: "restaurant" },
  { key: "phoneDisplay", label: "Restaurant phone (shown to customers)", type: "text", source: "restaurant" },
  { key: "address", label: "Address", type: "text", source: "restaurant" },
  { key: "timezone", label: "Timezone", type: "text", hint: "e.g. Australia/Perth", source: "restaurant" },
  {
    key: "ownerSmsNumber",
    label: "Owner SMS number",
    type: "text",
    hint: "New-order SMS goes here (E.164, e.g. +614...)",
    source: "settings",
  },
  {
    key: "googleReviewUrl",
    label: "Google review link",
    type: "text",
    hint: "1h after an order completes, the customer is texted this review link ONCE ever. Empty = off.",
    source: "settings",
  },
  {
    key: "customerSmsEnabled",
    label: "Send customers a confirmation SMS",
    type: "boolean",
    source: "settings",
  },
  {
    key: "acceptingOrders",
    label: "Accepting phone orders",
    type: "boolean",
    hint: "Turn OFF to pause the AI taking orders (it still answers and explains)",
    source: "settings",
  },
  {
    key: "pauseReason",
    label: "Pause reason (told to callers while paused)",
    type: "text",
    hint: "e.g. kitchen at capacity — try again in 30 minutes",
    source: "settings",
  },
  { key: "futureOrdersEnabled", label: "Allow orders for later", type: "boolean", source: "settings" },
  {
    key: "minPrepMinutes",
    label: "Minimum preparation time (minutes)",
    type: "number",
    source: "settings",
  },
  {
    key: "maxFutureHours",
    label: "How far ahead orders can be placed (hours)",
    type: "number",
    source: "settings",
  },
  {
    key: "kitchenCapacity",
    label: "Kitchen capacity (orders cooked in parallel)",
    type: "number",
    hint: "Used for spoken ready-time estimates",
    source: "settings",
  },
  {
    key: "simpleBaselineSeconds",
    label: "Simple order prep time (seconds)",
    type: "number",
    source: "settings",
  },
  {
    key: "complexBaselineSeconds",
    label: "Large order prep time (seconds)",
    type: "number",
    hint: "3+ lines or 4+ items counts as large",
    source: "settings",
  },
  {
    key: "reviewTtlSeconds",
    label: "Text-to-confirm link lifetime (seconds)",
    type: "number",
    hint: "Unconfirmed 'check and confirm' orders expire after this and never reach the kitchen",
    source: "settings",
  },
  {
    key: "delayNotifyThresholdSeconds",
    label: "Delay SMS threshold (seconds)",
    type: "number",
    hint: "Customers get one update text when their estimate slips by more than this",
    source: "settings",
  },
  { key: "orderNumberPrefix", label: "Order number prefix", type: "text", source: "settings" },
];

export default function SettingsPage() {
  return (
    <SettingsForm
      title="Settings"
      intro="Restaurant, SMS and ordering rules. Only the owner login can change these."
      fields={FIELDS}
    />
  );
}
