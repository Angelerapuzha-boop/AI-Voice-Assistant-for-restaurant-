import { z } from "zod";
import { auditLog, getDefaultRestaurant, getSettings } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireOwner, requireUser } from "@/lib/session";

export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  const settings = await getSettings(db(), restaurant.id);
  return Response.json({ restaurant, settings });
});

const patchSchema = z
  .object({
    // restaurant
    name: z.string().min(1).max(200),
    phoneDisplay: z.string().max(50),
    address: z.string().max(300),
    timezone: z.string().max(60),
    // settings
    ownerSmsNumber: z.string().max(20),
    customerSmsEnabled: z.boolean(),
    futureOrdersEnabled: z.boolean(),
    minPrepMinutes: z.number().int().min(0).max(240),
    maxFutureHours: z.number().int().min(1).max(72),
    kitchenCapacity: z.number().int().min(1).max(12),
    simpleBaselineSeconds: z.number().int().min(60).max(7200),
    complexBaselineSeconds: z.number().int().min(60).max(7200),
    orderNumberPrefix: z.string().min(1).max(6),
    aiGreeting: z.string().min(5).max(500),
    aiModel: z.string().max(100),
    fallbackBehaviour: z.enum(["take_message", "end_politely"]),
    ttsProvider: z.string().max(50),
    ttsVoice: z.string().max(100),
    ttsLanguage: z.string().max(20),
    sttProvider: z.string().max(50),
    sttModel: z.string().max(100),
    speechHints: z.string().max(2000),
  })
  .partial();

const RESTAURANT_COLS: Record<string, string> = {
  name: "name",
  phoneDisplay: "phone_display",
  address: "address",
  timezone: "timezone",
};

const SETTINGS_COLS: Record<string, string> = {
  ownerSmsNumber: "owner_sms_number",
  customerSmsEnabled: "customer_sms_enabled",
  futureOrdersEnabled: "future_orders_enabled",
  minPrepMinutes: "min_prep_minutes",
  maxFutureHours: "max_future_hours",
  kitchenCapacity: "kitchen_capacity",
  simpleBaselineSeconds: "simple_baseline_seconds",
  complexBaselineSeconds: "complex_baseline_seconds",
  orderNumberPrefix: "order_number_prefix",
  aiGreeting: "ai_greeting",
  aiModel: "ai_model",
  fallbackBehaviour: "fallback_behaviour",
  ttsProvider: "tts_provider",
  ttsVoice: "tts_voice",
  ttsLanguage: "tts_language",
  sttProvider: "stt_provider",
  sttModel: "stt_model",
  speechHints: "speech_hints",
};

export const PATCH = guarded(async (req: Request) => {
  const user = await requireOwner();
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return Response.json(
      { error: parsed.success ? "empty patch" : (parsed.error.issues[0]?.message ?? "invalid") },
      { status: 400 },
    );
  }
  const restaurant = await getDefaultRestaurant(db());

  const restSets: string[] = [];
  const restValues: unknown[] = [restaurant.id];
  const settingsSets: string[] = ["updated_at = now()"];
  const settingsValues: unknown[] = [restaurant.id];

  for (const [key, value] of Object.entries(parsed.data)) {
    if (RESTAURANT_COLS[key]) {
      restValues.push(value);
      restSets.push(`${RESTAURANT_COLS[key]} = $${restValues.length}`);
    } else if (SETTINGS_COLS[key]) {
      settingsValues.push(value);
      settingsSets.push(`${SETTINGS_COLS[key]} = $${settingsValues.length}`);
    }
  }
  if (restSets.length > 0) {
    await db().query(`UPDATE restaurants SET ${restSets.join(", ")} WHERE id = $1`, restValues);
  }
  if (settingsSets.length > 1) {
    await db().query(
      `UPDATE restaurant_settings SET ${settingsSets.join(", ")} WHERE restaurant_id = $1`,
      settingsValues,
    );
  }
  await auditLog(db(), {
    restaurantId: restaurant.id,
    actor: user.email,
    action: "settings.updated",
    entityType: "restaurant_settings",
    changes: parsed.data,
  });
  return Response.json({ ok: true });
});
