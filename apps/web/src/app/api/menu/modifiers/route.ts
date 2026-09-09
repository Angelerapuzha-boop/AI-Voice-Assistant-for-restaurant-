import { z } from "zod";
import { auditLog } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

const createSchema = z.object({
  groupId: z.string().uuid(),
  name: z.string().min(1).max(100),
  priceCents: z.number().int().min(0).max(100_000).default(0),
});

export const POST = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  const res = await db().query(
    `INSERT INTO menu_item_modifiers (group_id, name, price_cents,
       sort_order)
     VALUES ($1, $2, $3,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM menu_item_modifiers WHERE group_id = $1))
     RETURNING id`,
    [parsed.data.groupId, parsed.data.name, parsed.data.priceCents],
  );
  await auditLog(db(), {
    actor: user.email,
    action: "modifier.created",
    entityType: "modifier",
    entityId: (res.rows[0] as { id: string }).id,
    changes: parsed.data,
  });
  return Response.json({ id: (res.rows[0] as { id: string }).id });
});
