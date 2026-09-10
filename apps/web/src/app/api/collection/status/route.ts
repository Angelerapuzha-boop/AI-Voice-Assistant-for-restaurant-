import { z } from "zod";
import {
  getOrder,
  getPayment,
  paymentSummaryForOrder,
  pollTerminalPayment,
  verifyKioskSessionToken,
  formatCents,
} from "@meatbox/core";
import { db } from "@/lib/db";

const bodySchema = z.object({
  kioskToken: z.string().min(10).max(300),
  paymentId: z.string().uuid().optional(),
});

/**
 * Kiosk polling: server asks the PROVIDER and settles idempotently — the
 * browser never asserts payment success itself.
 */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  const session = parsed.success ? verifyKioskSessionToken(parsed.data.kioskToken) : null;
  if (!session) {
    return Response.json({ error: "Session expired — start again." }, { status: 401 });
  }
  const order = await getOrder(db(), session.orderId);
  if (!order) return Response.json({ error: "Order not found." }, { status: 404 });

  let payment = null;
  if (parsed.success && parsed.data.paymentId) {
    const existing = await getPayment(db(), parsed.data.paymentId);
    if (existing && existing.orderId === order.id) {
      payment = await pollTerminalPayment(db(), existing.id);
    }
  }
  const summary = await paymentSummaryForOrder(db(), order.id, order.totalCents);
  return Response.json({
    orderStatus: order.status,
    paymentState: summary.state,
    outstanding: formatCents(summary.outstandingCents),
    payment: payment
      ? { paymentId: payment.id, status: payment.status, failureReason: payment.failureReason }
      : null,
  });
}
