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
    key: "customerSmsEnabled",
    label: "Send customers a confirmation SMS",
    type: "boolean",
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
