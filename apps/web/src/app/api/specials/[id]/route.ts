import { z } from "zod";
import { auditLog } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

const patchSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(1000),
    priceCents: z.number().int().min(0).max(1_000_000),
    startsAt: z.string(),
    endsAt: z.string(),
    active: z.boolean(),
    quantityLimit: z.number().int().min(1).nullable(),
  })
  .partial();

const COLUMN: Record<string, string> = {
  name: "name",
  description: "description",
  priceCents: "price_cents",
  startsAt: "starts_at",
  endsAt: "ends_at",
  active: "active",
  quantityLimit: "quantity_limit",
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
    values.push(key === "startsAt" || key === "endsAt" ? new Date(value as string) : value);
    sets.push(`${COLUMN[key]} = $${values.length}`);
  }
  const res = await db().query(
    `UPDATE daily_specials SET ${sets.join(", ")} WHERE id = $1 RETURNING id`,
    values,
  );
  if (!res.rows[0]) return Response.json({ error: "not found" }, { status: 404 });
  await auditLog(db(), {
    actor: user.email,
    action: "special.updated",
    entityType: "daily_special",
    entityId: id,
    changes: parsed.data,
  });
  return Response.json({ ok: true });
});
