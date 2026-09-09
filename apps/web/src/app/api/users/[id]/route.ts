import { z } from "zod";
import { auditLog, hashPassword } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireOwner } from "@/lib/session";

const patchSchema = z
  .object({
    name: z.string().max(200),
    role: z.enum(["owner", "staff"]),
    active: z.boolean(),
    password: z.string().min(10).max(200),
  })
  .partial();

export const PATCH = guarded(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requireOwner();
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  if (id === actor.id && parsed.data.active === false) {
    return Response.json({ error: "you can't deactivate your own account" }, { status: 400 });
  }
  const sets: string[] = [];
  const values: unknown[] = [id];
  const { password, ...rest } = parsed.data;
  for (const [key, value] of Object.entries(rest)) {
    values.push(value);
    sets.push(`${key === "active" ? "active" : key} = $${values.length}`);
  }
  if (password) {
    values.push(await hashPassword(password));
    sets.push(`password_hash = $${values.length}`);
  }
  const res = await db().query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1 RETURNING id`, values);
  if (!res.rows[0]) return Response.json({ error: "not found" }, { status: 404 });
  await auditLog(db(), {
    actor: actor.email,
    action: "user.updated",
    entityType: "user",
    entityId: id,
    changes: { ...rest, passwordChanged: Boolean(password) },
  });
  return Response.json({ ok: true });
});
