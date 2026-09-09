import { z } from "zod";
import { updateOrderStatus, OrderValidationError, type OrderStatus } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

const bodySchema = z.object({
  status: z.enum(["new", "accepted", "preparing", "ready", "completed", "cancelled"]),
});

export const POST = guarded(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid status" }, { status: 400 });
  try {
    const order = await updateOrderStatus(db(), id, parsed.data.status as OrderStatus, user.email);
    return Response.json({ order });
  } catch (err) {
    if (err instanceof OrderValidationError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
});
