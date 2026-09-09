import { z } from "zod";
import { auditLog, camelRows, getDefaultRestaurant, type DailySpecial } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  const res = await db().query(
    `SELECT * FROM daily_specials WHERE restaurant_id = $1 ORDER BY starts_at DESC LIMIT 100`,
    [restaurant.id],
  );
  return Response.json({ specials: camelRows<DailySpecial>(res.rows) });
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).default(""),
  priceCents: z.number().int().min(0).max(1_000_000),
  startsAt: z.string(),
  endsAt: z.string(),
  quantityLimit: z.number().int().min(1).nullable().default(null),
});

export const POST = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid special" }, { status: 400 });
  const starts = new Date(parsed.data.startsAt);
  const ends = new Date(parsed.data.endsAt);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) {
    return Response.json({ error: "end must be after start" }, { status: 400 });
  }
  const restaurant = await getDefaultRestaurant(db());
  const res = await db().query(
    `INSERT INTO daily_specials (restaurant_id, name, description, price_cents, starts_at, ends_at, quantity_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      restaurant.id,
      parsed.data.name,
      parsed.data.description,
      parsed.data.priceCents,
      starts,
      ends,
      parsed.data.quantityLimit,
    ],
  );
  await auditLog(db(), {
    restaurantId: restaurant.id,
    actor: user.email,
    action: "special.created",
    entityType: "daily_special",
    entityId: (res.rows[0] as { id: string }).id,
    changes: parsed.data,
  });
  return Response.json({ id: (res.rows[0] as { id: string }).id });
});
