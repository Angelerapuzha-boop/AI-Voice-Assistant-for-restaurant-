import { z } from "zod";
import { auditLog, getItem } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

const createSchema = z.object({
  menuItemId: z.string().uuid(),
  name: z.string().min(1).max(100),
  required: z.boolean().default(false),
  maxSelect: z.number().int().min(1).max(20).default(1),
});

export const POST = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  const item = await getItem(db(), parsed.data.menuItemId);
  if (!item) return Response.json({ error: "item not found" }, { status: 404 });
  const res = await db().query(
    `INSERT INTO menu_item_modifier_groups (menu_item_id, name, required, max_select,
       sort_order)
     VALUES ($1, $2, $3, $4,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM menu_item_modifier_groups WHERE menu_item_id = $1))
     RETURNING id`,
    [parsed.data.menuItemId, parsed.data.name, parsed.data.required, parsed.data.maxSelect],
  );
  await auditLog(db(), {
    restaurantId: item.restaurantId,
    actor: user.email,
    action: "modifier_group.created",
    entityType: "modifier_group",
    entityId: (res.rows[0] as { id: string }).id,
    changes: parsed.data,
  });
  return Response.json({ id: (res.rows[0] as { id: string }).id });
});
