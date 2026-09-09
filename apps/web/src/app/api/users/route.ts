import { z } from "zod";
import { auditLog, camelRows, getDefaultRestaurant, hashPassword, type User } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireOwner } from "@/lib/session";

export const GET = guarded(async () => {
  await requireOwner();
  const restaurant = await getDefaultRestaurant(db());
  const res = await db().query(
    `SELECT id, restaurant_id, email, name, role, active FROM users WHERE restaurant_id = $1 ORDER BY created_at`,
    [restaurant.id],
  );
  return Response.json({ users: camelRows<User>(res.rows) });
});

const createSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().max(200).default(""),
  password: z.string().min(10).max(200),
  role: z.enum(["owner", "staff"]).default("staff"),
});

export const POST = guarded(async (req: Request) => {
  const actor = await requireOwner();
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "invalid (password must be 10+ chars)" },
      { status: 400 },
    );
  }
  const restaurant = await getDefaultRestaurant(db());
  const hash = await hashPassword(parsed.data.password);
  try {
    const res = await db().query(
      `INSERT INTO users (restaurant_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [restaurant.id, parsed.data.email, parsed.data.name, hash, parsed.data.role],
    );
    await auditLog(db(), {
      restaurantId: restaurant.id,
      actor: actor.email,
      action: "user.created",
      entityType: "user",
      entityId: (res.rows[0] as { id: string }).id,
      changes: { email: parsed.data.email, role: parsed.data.role },
    });
    return Response.json({ id: (res.rows[0] as { id: string }).id });
  } catch {
    return Response.json({ error: "email already in use" }, { status: 409 });
  }
});
