import { z } from "zod";
import {
  getDefaultRestaurant,
  getSettings,
  OrderValidationError,
  placePosOrder,
} from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

const bodySchema = z.object({
  orderType: z.enum(["takeaway", "dine_in"]),
  customerName: z.string().max(120).optional(),
  customerNotes: z.string().max(500).optional(),
  paymentMethod: z.enum(["cash", "card", "tap"]),
  items: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(50),
        modifierIds: z.array(z.string().uuid()).max(20).default([]),
        removals: z.array(z.string().max(80)).max(10).default([]),
        specialInstructions: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const POST = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "invalid order" },
      { status: 400 },
    );
  }
  const restaurant = await getDefaultRestaurant(db());
  const settings = await getSettings(db(), restaurant.id);
  try {
    const order = await placePosOrder(db(), {
      restaurant,
      settings,
      actorEmail: user.email,
      ...parsed.data,
    });
    return Response.json({ order });
  } catch (err) {
    if (err instanceof OrderValidationError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
});
