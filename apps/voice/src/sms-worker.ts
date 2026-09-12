import {
  createSmsSender,
  createSquareOrderSender,
  createWebhookSender,
  expireStaleReviewDrafts,
  getDb,
  getDefaultRestaurant,
  getSettings,
  processPendingNotifications,
  recalcQueueEstimates,
  sweepAutoReplenishment,
  sweepGoogleReviewSms,
  env,
  type SmsSender,
} from "@meatbox/core";

/**
 * Automated supplier call: a short spoken order via a plain Twilio
 * outbound call (the SMS with the confirm link is the primary channel;
 * the call makes sure it's noticed). Live SMS mode gates real calls.
 */
async function placeSupplierCall(to: string, script: string, log: (msg: string) => void): Promise<void> {
  if (env.SMS_MODE !== "live" || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_PHONE_NUMBER) {
    log(`[supplier-call:log] to=${to}: ${script.slice(0, 80)}…`);
    return;
  }
  const twiml = `<Response><Pause length="1"/><Say language="en-AU">${script
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")}</Say><Pause length="1"/><Say language="en-AU">Goodbye.</Say></Response>`;
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`,
    {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: env.TWILIO_PHONE_NUMBER, To: to, Twiml: twiml }),
    },
  );
  if (!res.ok) log(`supplier call to ${to} failed: ${res.status}`);
}

/**
 * Outbox processor: polls the notification_attempts table and sends due
 * SMS with backoff. Runs inside the voice service so a single always-on
 * process owns telephone + notifications.
 */
export function startSmsWorker(log: (msg: string) => void): { stop: () => void } {
  let sender: SmsSender;
  try {
    sender = createSmsSender();
  } catch (err) {
    log(`SMS worker disabled: ${(err as Error).message}`);
    return { stop: () => undefined };
  }
  const webhookSender = createWebhookSender();
  const squareSender = createSquareOrderSender(getDb());
  let running = false;
  const interval = setInterval(() => {
    if (running) return;
    running = true;
    processPendingNotifications(getDb(), sender, webhookSender, squareSender)
      .catch((err: Error) => log(`SMS worker pass failed: ${err.message}`))
      .finally(() => {
        running = false;
      });
  }, 3000);
  return { stop: () => clearInterval(interval) };
}

/**
 * Periodic housekeeping (spec 4/10/12): cancel review-link drafts that were
 * never confirmed, and refresh queued orders' current estimates so queue
 * wait shows up even between kitchen taps — materially delayed phone orders
 * get one throttled SMS (dedup handled inside recalcQueueEstimates).
 */
export function startMaintenanceWorker(log: (msg: string) => void): { stop: () => void } {
  let running = false;
  const interval = setInterval(() => {
    if (running) return;
    running = true;
    (async () => {
      const db = getDb();
      // Zombie-call sweep: a relay leg whose WebSocket close never fired
      // leaves calls stuck in_progress forever (seen twice on 2026-09-11).
      // Real calls never exceed 15 minutes; close the strays.
      const zombies = await db.query(
        `UPDATE calls SET ended_at = now(), status = 'completed',
           outcome = COALESCE(outcome, 'CALL_DROPPED'),
           duration_seconds = LEAST(900, EXTRACT(EPOCH FROM (now() - started_at))::int)
         WHERE ended_at IS NULL AND started_at < now() - interval '15 minutes'`,
      );
      if ((zombies.rowCount ?? 0) > 0) log(`zombie-call sweep: closed ${zombies.rowCount}`);
      const expired = await expireStaleReviewDrafts(db);
      if (expired > 0) log(`review sweep: ${expired} unconfirmed review draft(s) expired`);
      const restaurant = await getDefaultRestaurant(db);
      const settings = await getSettings(db, restaurant.id);
      await recalcQueueEstimates(db, {
        restaurantId: restaurant.id,
        settings,
        delayNotify: {
          restaurant,
          customerSmsEnabled: settings.customerSmsEnabled,
          thresholdSeconds: settings.delayNotifyThresholdSeconds,
        },
      });
      // Google-review ask: 1h after completion, once per customer ever.
      const reviews = await sweepGoogleReviewSms(db, { restaurant, settings });
      if (reviews > 0) log(`google-review sweep: ${reviews} ask(s) queued`);
      // Automatic stock replacement: low auto-replenish items get one
      // open supplier request (SMS + optional automated call).
      const repl = await sweepAutoReplenishment(db, { restaurant, appUrl: env.APP_URL });
      if (repl.created > 0) log(`replenishment sweep: ${repl.created} supplier request(s) raised`);
      for (const call of repl.calls) {
        await placeSupplierCall(call.supplierPhone, call.script, log).catch((err: Error) =>
          log(`supplier call failed: ${err.message}`),
        );
      }
    })()
      .catch((err: Error) => log(`maintenance pass failed: ${err.message}`))
      .finally(() => {
        running = false;
      });
  }, 60_000);
  return { stop: () => clearInterval(interval) };
}
