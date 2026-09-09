import { z } from "zod";
import { auditLog } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

const patchSchema = z
  .object({
    name: z.string().min(1).max(100),
    priceCents: z.number().int().min(0).max(100_000),
    isAvailable: z.boolean(),
  })
  .partial();

const COLUMN: Record<string, string> = {
  name: "name",
  priceCents: "price_cents",
  isAvailable: "is_available",
};

export const PATCH = guarded(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [key, value] of Object.entries(parsed.data)) {
    values.push(value);
    sets.push(`${COLUMN[key]} = $${values.length}`);
  }
  const res = await db().query(
    `UPDATE menu_item_modifiers SET ${sets.join(", ")} WHERE id = $1 RETURNING id`,
    values,
  );
  if (!res.rows[0]) return Response.json({ error: "not found" }, { status: 404 });
  await auditLog(db(), {
    actor: user.email,
    action: "modifier.updated",
    entityType: "modifier",
    entityId: id,
    changes: parsed.data,
  });
  return Response.json({ ok: true });
});

export const DELETE = guarded(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  await db().query(`DELETE FROM menu_item_modifiers WHERE id = $1`, [id]);
  await auditLog(db(), {
    actor: user.email,
    action: "modifier.deleted",
    entityType: "modifier",
    entityId: id,
  });
  return Response.json({ ok: true });
});
