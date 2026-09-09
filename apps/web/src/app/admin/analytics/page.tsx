import { formatCents, getDefaultRestaurant } from "@meatbox/core";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const restaurant = await getDefaultRestaurant(db());
  const tz = restaurant.timezone;

  const daily = await db().query(
    `SELECT (created_at AT TIME ZONE $2)::date AS day,
            COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue
     FROM orders
     WHERE restaurant_id = $1 AND status NOT IN ('draft', 'cancelled')
       AND created_at > now() - interval '14 days'
     GROUP BY day ORDER BY day DESC`,
    [restaurant.id, tz],
  );

  const popular = await db().query(
    `SELECT oi.name_snapshot AS name, SUM(oi.quantity) AS qty,
            SUM(oi.line_total_cents) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = $1 AND o.status NOT IN ('draft', 'cancelled')
       AND o.created_at > now() - interval '30 days'
     GROUP BY oi.name_snapshot ORDER BY qty DESC LIMIT 10`,
    [restaurant.id],
  );

  const outcomes = await db().query(
    `SELECT COALESCE(outcome, status) AS outcome, COUNT(*) AS n
     FROM calls WHERE restaurant_id = $1 AND started_at > now() - interval '14 days'
     GROUP BY 1 ORDER BY n DESC`,
    [restaurant.id],
  );

  return (
    <div className="max-w-3xl">
      <h1 className="mb-6 text-2xl font-bold">Analytics</h1>

      <h2 className="mb-2 font-bold">Last 14 days</h2>
      <div className="mb-8 overflow-x-auto rounded-2xl bg-white shadow">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-left">
            <tr>
              <th className="p-3">Day</th>
              <th className="p-3">Orders</th>
              <th className="p-3">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {daily.rows.map((r) => {
              const row = r as { day: string; orders: string; revenue: string };
              return (
                <tr key={String(row.day)} className="border-t">
                  <td className="p-3">{new Date(row.day).toLocaleDateString("en-AU")}</td>
                  <td className="p-3">{row.orders}</td>
                  <td className="p-3 font-semibold">{formatCents(Number(row.revenue))}</td>
                </tr>
              );
            })}
            {daily.rows.length === 0 && (
              <tr>
                <td colSpan={3} className="p-4 text-center text-stone-400">
                  No orders yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-2 font-bold">Top items (30 days)</h2>
          <ul className="rounded-2xl bg-white p-4 text-sm shadow">
            {popular.rows.map((r) => {
              const row = r as { name: string; qty: string; revenue: string };
              return (
                <li key={row.name} className="flex justify-between border-b py-1.5 last:border-b-0">
                  <span>
                    {row.name} <span className="text-stone-400">× {row.qty}</span>
                  </span>
                  <span className="font-semibold">{formatCents(Number(row.revenue))}</span>
                </li>
              );
            })}
            {popular.rows.length === 0 && <li className="text-stone-400">No data yet.</li>}
          </ul>
        </div>
        <div>
          <h2 className="mb-2 font-bold">Call outcomes (14 days)</h2>
          <ul className="rounded-2xl bg-white p-4 text-sm shadow">
            {outcomes.rows.map((r) => {
              const row = r as { outcome: string; n: string };
              return (
                <li key={row.outcome} className="flex justify-between border-b py-1.5 last:border-b-0">
                  <span>{row.outcome}</span>
                  <span className="font-semibold">{row.n}</span>
                </li>
              );
            })}
            {outcomes.rows.length === 0 && <li className="text-stone-400">No calls yet.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
