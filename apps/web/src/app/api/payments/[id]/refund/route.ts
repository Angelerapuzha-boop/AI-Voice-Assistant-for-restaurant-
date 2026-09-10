import { z } from "zod";
import { OrderValidationError, refundPayment } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireOwner } from "@/lib/session";

const bodySchema = z.object({
  amountCents: z.number().int().min(1),
  reason: z.string().min(1).max(300),
});

/** Owner-only, audited; provider-backed for terminal payments. */
export const POST = guarded(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "amountCents and reason are required" }, { status: 400 });
  }
  try {
    const refund = await refundPayment(db(), {
      paymentId: id,
      amountCents: parsed.data.amountCents,
      reason: parsed.data.reason,
      actor: user.email,
    });
    return Response.json({ refund });
  } catch (err) {
    if (err instanceof OrderValidationError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
});
