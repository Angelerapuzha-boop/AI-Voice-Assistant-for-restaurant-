import { z } from "zod";
import { auditLog, getDefaultRestaurant } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
});

export const POST = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  const restaurant = await getDefaultRestaurant(db());
  const slug = parsed.data.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const res = await db().query(
    `INSERT INTO menu_categories (restaurant_id, name, slug, description,
       sort_order)
     VALUES ($1, $2, $3, $4,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM menu_categories WHERE restaurant_id = $1))
     ON CONFLICT (restaurant_id, slug) DO NOTHING
     RETURNING id`,
    [restaurant.id, parsed.data.name, slug, parsed.data.description],
  );
  if (!res.rows[0]) return Response.json({ error: "category already exists" }, { status: 409 });
  await auditLog(db(), {
    restaurantId: restaurant.id,
    actor: user.email,
    action: "menu_category.created",
    entityType: "menu_category",
    entityId: (res.rows[0] as { id: string }).id,
    changes: parsed.data,
  });
  return Response.json({ id: (res.rows[0] as { id: string }).id });
});
