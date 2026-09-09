import { z } from "zod";
import { auditLog, getDefaultRestaurant, getHours } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  return Response.json({ hours: await getHours(db(), restaurant.id) });
});

const putSchema = z.object({
  hours: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        isClosed: z.boolean(),
        opensAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
        closesAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
      }),
    )
    .length(7),
});

export const PUT = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid hours" }, { status: 400 });
  const restaurant = await getDefaultRestaurant(db());
  for (const day of parsed.data.hours) {
    if (!day.isClosed && (!day.opensAt || !day.closesAt)) {
      return Response.json(
        { error: `Day ${day.dayOfWeek}: open days need opening and closing times` },
        { status: 400 },
      );
    }
    await db().query(
      `INSERT INTO restaurant_hours (restaurant_id, day_of_week, opens_at, closes_at, is_closed)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (restaurant_id, day_of_week)
       DO UPDATE SET opens_at = $3, closes_at = $4, is_closed = $5`,
      [restaurant.id, day.dayOfWeek, day.opensAt, day.closesAt, day.isClosed],
    );
  }
  await auditLog(db(), {
    restaurantId: restaurant.id,
    actor: user.email,
    action: "hours.updated",
    entityType: "restaurant_hours",
    changes: { hours: parsed.data.hours },
  });
  return Response.json({ ok: true });
});
