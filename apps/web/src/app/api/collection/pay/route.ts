import { z } from "zod";
import {
  OrderValidationError,
  startTerminalPayment,
  verifyKioskSessionToken,
} from "@meatbox/core";
import { db } from "@/lib/db";

const bodySchema = z.object({ kioskToken: z.string().min(10).max(300) });

/** Start a terminal payment for the kiosk's ONE verified order. */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  const session = parsed.success ? verifyKioskSessionToken(parsed.data.kioskToken) : null;
  if (!session) {
    return Response.json({ error: "Session expired — start again." }, { status: 401 });
  }
  try {
    const payment = await startTerminalPayment(db(), { orderId: session.orderId, actor: "kiosk" });
    return Response.json({ paymentId: payment.id, status: payment.status });
  } catch (err) {
    if (err instanceof OrderValidationError) {
      return Response.json({ error: err.message, code: err.code }, { status: 409 });
    }
    console.error("[collection/pay] failed:", err);
    return Response.json({ error: "The terminal couldn't start — see staff." }, { status: 500 });
  }
}
