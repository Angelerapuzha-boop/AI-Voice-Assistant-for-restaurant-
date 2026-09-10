import { z } from "zod";
import { cancelTerminalPayment, getPayment, verifyKioskSessionToken } from "@meatbox/core";
import { db } from "@/lib/db";

const bodySchema = z.object({
  kioskToken: z.string().min(10).max(300),
  paymentId: z.string().uuid(),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  const session = parsed.success ? verifyKioskSessionToken(parsed.data.kioskToken) : null;
  if (!session || !parsed.success) {
    return Response.json({ error: "Session expired — start again." }, { status: 401 });
  }
  const payment = await getPayment(db(), parsed.data.paymentId);
  if (!payment || payment.orderId !== session.orderId) {
    return Response.json({ error: "Not your payment." }, { status: 403 });
  }
  const cancelled = await cancelTerminalPayment(db(), {
    paymentId: payment.id,
    actor: "kiosk",
  });
  return Response.json({ status: cancelled?.status ?? "cancelled" });
}
