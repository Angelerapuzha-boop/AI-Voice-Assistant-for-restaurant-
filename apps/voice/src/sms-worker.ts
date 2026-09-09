import {
  createSmsSender,
  getDb,
  processPendingNotifications,
  type SmsSender,
} from "@meatbox/core";

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
  let running = false;
  const interval = setInterval(() => {
    if (running) return;
    running = true;
    processPendingNotifications(getDb(), sender)
      .catch((err: Error) => log(`SMS worker pass failed: ${err.message}`))
      .finally(() => {
        running = false;
      });
  }, 3000);
  return { stop: () => clearInterval(interval) };
}
