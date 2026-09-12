import { z } from "zod";
import {
  adjustInventory,
  auditLog,
  getDefaultRestaurant,
  listInventory,
  restockInventory,
  stockStatus,
} from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  const items = await listInventory(db(), restaurant.id);
  return Response.json({
    items: items.map((i) => ({ ...i, status: stockStatus(i) })),
  });
});

const postSchema = z.object({
  action: z.enum(["restock", "adjust"]),
  itemId: z.string().uuid(),
  qty: z.number().min(0).max(100000).optional(),
  newQty: z.number().min(0).max(100000).optional(),
  reorderLevel: z.number().min(0).max(100000).optional(),
  parLevel: z.number().min(0).max(100000).optional(),
  note: z.string().max(300).optional(),
});

export const POST = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "invalid" }, { status: 400 });
  }
  const body = parsed.data;
  const restaurant = await getDefaultRestaurant(db());
  const item =
    body.action === "restock"
      ? await restockInventory(db(), { itemId: body.itemId, qty: body.qty, actor: user.email, note: body.note })
      : await adjustInventory(db(), {
          itemId: body.itemId,
          newQty: body.newQty,
          reorderLevel: body.reorderLevel,
          parLevel: body.parLevel,
          actor: user.email,
          note: body.note,
        });
  if (!item) return Response.json({ error: "item not found" }, { status: 404 });
  await auditLog(db(), {
    restaurantId: restaurant.id,
    actor: user.email,
    action: `inventory.${body.action}`,
    entityType: "inventory_item",
    entityId: body.itemId,
    changes: body,
  });
  return Response.json({ item: { ...item, status: stockStatus(item) } });
});
