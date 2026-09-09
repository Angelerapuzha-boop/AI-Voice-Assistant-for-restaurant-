import Link from "next/link";
import { formatCents, getDefaultRestaurant } from "@meatbox/core";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  const restaurant = await getDefaultRestaurant(db());
  const tz = restaurant.timezone;

  const stats = await db().query(
    `SELECT
       COUNT(*) FILTER (WHERE status NOT IN ('draft','cancelled')
         AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date) AS today_orders,
       COALESCE(SUM(total_cents) FILTER (WHERE status NOT IN ('draft','cancelled')
         AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date), 0) AS today_revenue,
       COUNT(*) FILTER (WHERE status = 'new') AS new_orders,
       COUNT(*) FILTER (WHERE status = 'needs_review') AS needs_review,
       COUNT(*) FILTER (WHERE owner_sms_alert) AS sms_alerts
     FROM orders WHERE restaurant_id = $1`,
    [restaurant.id, tz],
  );
  const row = stats.rows[0] as Record<string, string>;
  const callsRes = await db().query(
    `SELECT COUNT(*) AS n FROM calls WHERE restaurant_id = $1
       AND (started_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
    [restaurant.id, tz],
  );

  const cards = [
    { label: "Orders today", value: row.today_orders },
    { label: "Revenue today", value: formatCents(Number(row.today_revenue)) },
    { label: "Calls today", value: (callsRes.rows[0] as { n: string }).n },
    { label: "New orders waiting", value: row.new_orders, alert: Number(row.new_orders) > 0 },
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Dashboard</h1>

      {Number(row.sms_alerts) > 0 && (
        <Link
          href="/admin/orders?alert=1"
          className="mb-4 block rounded-xl border-2 border-red-500 bg-red-50 p-4 font-semibold text-red-700"
        >
          ⚠ {row.sms_alerts} order(s) where the owner SMS could not be delivered — open Orders to
          resend.
        </Link>
      )}
      {Number(row.needs_review) > 0 && (
        <Link
          href="/kitchen"
          className="mb-4 block rounded-xl border-2 border-purple-500 bg-purple-50 p-4 font-semibold text-purple-700"
        >
          {row.needs_review} call(s) ended mid-order and need review — see the kitchen view.
        </Link>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className={`rounded-2xl bg-white p-5 shadow ${c.alert ? "ring-2 ring-red-500" : ""}`}
          >
            <p className="text-sm text-stone-500">{c.label}</p>
            <p className="mt-1 text-3xl font-extrabold">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Link href="/kitchen" className="rounded-2xl bg-stone-900 p-6 text-white shadow hover:bg-stone-800">
          <p className="text-lg font-bold">🍳 Open kitchen view</p>
          <p className="text-sm text-stone-400">Live orders, big buttons, notification sound.</p>
        </Link>
        <Link href="/admin/simulator" className="rounded-2xl bg-orange-600 p-6 text-white shadow hover:bg-orange-700">
          <p className="text-lg font-bold">🧪 Test the AI</p>
          <p className="text-sm text-orange-100">Type as a caller — no phone call needed.</p>
        </Link>
      </div>
    </div>
  );
}
