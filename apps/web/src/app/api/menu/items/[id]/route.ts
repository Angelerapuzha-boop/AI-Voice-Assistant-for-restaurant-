import { z } from "zod";
import { auditLog, getItem } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

const patchSchema = z
  .object({
    categoryId: z.string().uuid(),
    name: z.string().min(1).max(200),
    description: z.string().max(2000),
    priceCents: z.number().int().min(0).max(1_000_000),
    imageUrl: z.string().max(500),
    isVegetarian: z.boolean(),
    isAvailable: z.boolean(),
    isSoldOut: z.boolean(),
    isPopular: z.boolean(),
    prepNotes: z.string().max(2000),
    aliases: z.array(z.string().max(100)).max(20),
    sortOrder: z.number().int(),
    active: z.boolean(),
  })
  .partial();

const COLUMN: Record<string, string> = {
  categoryId: "category_id",
  name: "name",
  description: "description",
  priceCents: "price_cents",
  imageUrl: "image_url",
  isVegetarian: "is_vegetarian",
  isAvailable: "is_available",
  isSoldOut: "is_sold_out",
  isPopular: "is_popular",
  prepNotes: "prep_notes",
  aliases: "aliases",
  sortOrder: "sort_order",
  active: "active",
};

export const PATCH = guarded(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return Response.json({ error: "invalid patch" }, { status: 400 });
  }
  const before = await getItem(db(), id);
  if (!before) return Response.json({ error: "not found" }, { status: 404 });

  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [id];
  for (const [key, value] of Object.entries(parsed.data)) {
    values.push(value);
    sets.push(`${COLUMN[key]} = $${values.length}`);
  }
  await db().query(`UPDATE menu_items SET ${sets.join(", ")} WHERE id = $1`, values);
  await auditLog(db(), {
    restaurantId: before.restaurantId,
    actor: user.email,
    action: "menu_item.updated",
    entityType: "menu_item",
    entityId: id,
    changes: parsed.data,
  });
  return Response.json({ ok: true });
});

export const DELETE = guarded(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const before = await getItem(db(), id);
  if (!before) return Response.json({ error: "not found" }, { status: 404 });
  // Soft delete: order history keeps its snapshots.
  await db().query(`UPDATE menu_items SET active = false, updated_at = now() WHERE id = $1`, [id]);
  await auditLog(db(), {
    restaurantId: before.restaurantId,
    actor: user.email,
    action: "menu_item.deactivated",
    entityType: "menu_item",
    entityId: id,
  });
  return Response.json({ ok: true });
});
