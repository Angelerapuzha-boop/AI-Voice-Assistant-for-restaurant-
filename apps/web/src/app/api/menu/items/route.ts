import { z } from "zod";
import { auditLog, getDefaultRestaurant } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

const createSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  priceCents: z.number().int().min(0).max(1_000_000),
  isVegetarian: z.boolean().default(false),
  aliases: z.array(z.string().max(100)).max(20).default([]),
});

export const POST = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "invalid" }, { status: 400 });
  }
  const restaurant = await getDefaultRestaurant(db());
  const d = parsed.data;
  const res = await db().query(
    `INSERT INTO menu_items (restaurant_id, category_id, name, description, price_cents, is_vegetarian, aliases)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [restaurant.id, d.categoryId, d.name, d.description, d.priceCents, d.isVegetarian, d.aliases],
  );
  const id = (res.rows[0] as { id: string }).id;
  await auditLog(db(), {
    restaurantId: restaurant.id,
    actor: user.email,
    action: "menu_item.created",
    entityType: "menu_item",
    entityId: id,
    changes: d,
  });
  return Response.json({ id });
});
