import { z } from "zod";
import { auditLog, getDefaultRestaurant } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

export const GET = guarded(async (req: Request) => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const res = await db().query(
    `SELECT c.id, c.phone_e164, c.display_name, c.history_enabled, c.last_order_at,
            COUNT(o.id) FILTER (WHERE o.status NOT IN ('draft', 'cancelled'))::int AS order_count,
            COALESCE(SUM(o.total_cents) FILTER (WHERE o.status NOT IN ('draft', 'cancelled')), 0)::bigint AS total_spent_cents
     FROM customers c
     LEFT JOIN orders o ON o.customer_id = c.id
     WHERE c.restaurant_id = $1
       AND ($2 = '' OR c.display_name ILIKE '%' || $2 || '%' OR c.phone_e164 LIKE '%' || $2 || '%')
     GROUP BY c.id ORDER BY c.last_order_at DESC NULLS LAST LIMIT 100`,
    [restaurant.id, q],
  );
  return Response.json({ customers: res.rows });
});

const patchSchema = z.object({
  customerId: z.string().uuid(),
  historyEnabled: z.boolean(),
});

export const PATCH = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  const res = await db().query(
    `UPDATE customers SET history_enabled = $2 WHERE id = $1 RETURNING id`,
    [parsed.data.customerId, parsed.data.historyEnabled],
  );
  if (!res.rows[0]) return Response.json({ error: "not found" }, { status: 404 });
  await auditLog(db(), {
    actor: user.email,
    action: "customer.history_toggle",
    entityType: "customer",
    entityId: parsed.data.customerId,
    changes: { historyEnabled: parsed.data.historyEnabled },
  });
  return Response.json({ ok: true });
});
