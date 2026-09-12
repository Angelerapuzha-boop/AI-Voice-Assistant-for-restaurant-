import { formatCents, getDefaultRestaurant, listInventory, stockStatus } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";
import { fetchGovNews } from "@/lib/gov-news";

/**
 * Daily briefing: written insights the owner can scroll day by day.
 * Internal (sales, calls, stock pace) is derived from the database;
 * external entries come from the government supply-watch. Everything is
 * computed on request — no stored copies to drift out of date.
 */

interface Insight {
  ts: string;
  category: "sales" | "calls" | "stock" | "external";
  icon: string;
  heading: string;
  subheading: string;
  link?: string;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 || h === 24 ? "am" : "pm"}`;

export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  const tz = restaurant.timezone;
  const rid = restaurant.id;

  const [days, topPerDay, peakPerDay, callsPerDay, usagePerItem] = await Promise.all([
    db().query(
      `SELECT (created_at AT TIME ZONE $2)::date AS day, COUNT(*)::int AS orders,
              COALESCE(SUM(total_cents), 0)::bigint AS revenue
       FROM orders WHERE restaurant_id = $1 AND status NOT IN ('draft', 'cancelled')
         AND created_at > now() - interval '8 days'
       GROUP BY 1 ORDER BY 1`,
      [rid, tz],
    ),
    db().query(
      `SELECT DISTINCT ON (day) day, name, qty FROM (
         SELECT (o.created_at AT TIME ZONE $2)::date AS day, oi.name_snapshot AS name,
                SUM(oi.quantity)::int AS qty
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.restaurant_id = $1 AND o.status NOT IN ('draft', 'cancelled')
           AND o.created_at > now() - interval '8 days'
         GROUP BY 1, 2
       ) t ORDER BY day, qty DESC`,
      [rid, tz],
    ),
    db().query(
      `SELECT DISTINCT ON (day) day, hour, n FROM (
         SELECT (created_at AT TIME ZONE $2)::date AS day,
                EXTRACT(HOUR FROM created_at AT TIME ZONE $2)::int AS hour, COUNT(*)::int AS n
         FROM orders WHERE restaurant_id = $1 AND status NOT IN ('draft', 'cancelled')
           AND created_at > now() - interval '8 days'
         GROUP BY 1, 2
       ) t ORDER BY day, n DESC`,
      [rid, tz],
    ),
    db().query(
      `SELECT (started_at AT TIME ZONE $2)::date AS day, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE outcome = 'ORDER_COMPLETED')::int AS completed
       FROM calls WHERE restaurant_id = $1 AND started_at > now() - interval '8 days'
       GROUP BY 1 ORDER BY 1`,
      [rid, tz],
    ),
    db().query(
      `SELECT ii.id, SUM(-m.delta)::numeric AS used
       FROM inventory_movements m JOIN inventory_items ii ON ii.id = m.inventory_item_id
       WHERE ii.restaurant_id = $1 AND m.reason = 'order' AND m.created_at > now() - interval '7 days'
       GROUP BY ii.id`,
      [rid],
    ),
  ]);

  const dayRows = days.rows as { day: string; orders: number; revenue: string }[];
  const topRows = topPerDay.rows as { day: string; name: string; qty: number }[];
  const peakRows = peakPerDay.rows as { day: string; hour: number; n: number }[];
  const callRows = callsPerDay.rows as { day: string; total: number; completed: number }[];
  const usage = new Map(
    (usagePerItem.rows as { id: string; used: string }[]).map((r) => [r.id, Number(r.used)]),
  );

  const dayKey = (d: string | Date) => new Date(d).toISOString().slice(0, 10);
  const byDay = new Map<string, Insight[]>();
  const push = (day: string, i: Insight) => {
    const list = byDay.get(day) ?? [];
    list.push(i);
    byDay.set(day, list);
  };

  // ---- internal: one sales + one calls insight per trading day
  for (let idx = 0; idx < dayRows.length; idx++) {
    const d = dayRows[idx]!;
    const key = dayKey(d.day);
    const prev = dayRows[idx - 1];
    const change = prev ? pct(Number(d.revenue), Number(prev.revenue)) : null;
    const top = topRows.find((t) => dayKey(t.day) === key);
    const peak = peakRows.find((p) => dayKey(p.day) === key);
    const bits: string[] = [];
    if (change !== null && Math.abs(change) >= 10) {
      bits.push(`${change > 0 ? "up" : "down"} ${Math.abs(change)}% on the day before`);
    }
    if (peak) bits.push(`busiest around ${hourLabel(peak.hour)}`);
    if (top) bits.push(`top seller: ${top.name} (×${top.qty})`);
    push(key, {
      ts: `${key}T21:00:00`,
      category: "sales",
      icon: change !== null && change < -10 ? "📉" : "📈",
      heading: `${formatCents(Number(d.revenue))} from ${d.orders} order${d.orders === 1 ? "" : "s"}`,
      subheading: bits.length > 0 ? bits.join(" · ") : "Steady trading day.",
    });
    const calls = callRows.find((c) => dayKey(c.day) === key);
    if (calls && calls.total > 0) {
      const conv = Math.round((100 * calls.completed) / calls.total);
      push(key, {
        ts: `${key}T21:05:00`,
        category: "calls",
        icon: "📞",
        heading: `AI answered ${calls.total} call${calls.total === 1 ? "" : "s"}`,
        subheading:
          calls.completed > 0
            ? `${calls.completed} became orders (${conv}%). ${conv >= 60 ? "Strong conversion." : "Some callers left without ordering — worth a listen in Call logs."}`
            : "No orders from calls — check the transcripts in Call logs.",
      });
    }
  }

  // ---- internal: stock outlook (today)
  const today = dayKey(new Date());
  const inventory = await listInventory(db(), rid);
  for (const item of inventory) {
    const status = stockStatus(item);
    const dailyPace = (usage.get(item.id) ?? 0) / 7;
    if (status === "out") {
      push(today, {
        ts: new Date().toISOString(),
        category: "stock",
        icon: "🚨",
        heading: `${item.name} is OUT of stock`,
        subheading:
          item.category === "dish"
            ? "Restock it or mark the dish sold out so the AI stops offering it."
            : "Add it to today's shopping run.",
      });
    } else if (status === "low") {
      const daysLeft = dailyPace > 0 ? Math.max(1, Math.round(item.currentQty / dailyPace)) : null;
      push(today, {
        ts: new Date().toISOString(),
        category: "stock",
        icon: "⚠️",
        heading: `${item.name} running low — ${item.currentQty} ${item.unit} left`,
        subheading: daysLeft
          ? `At this week's pace it's empty in about ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Restock before then.`
          : "Below your alert level — top it up on the next run.",
      });
    } else if (item.category === "dish" && dailyPace > 0) {
      const daysLeft = item.currentQty / dailyPace;
      if (daysLeft <= 3) {
        push(today, {
          ts: new Date().toISOString(),
          category: "stock",
          icon: "⏳",
          heading: `${item.name} selling fast`,
          subheading: `About ${Math.round(dailyPace * 7)} sold this week — current stock lasts roughly ${Math.round(daysLeft)} days at that pace.`,
        });
      }
    }
  }

  // ---- external: government items on their published day
  const news = await fetchGovNews();
  for (const n of news.items.filter((x) => x.relevance >= 4 && x.publishedAt)) {
    const key = dayKey(n.publishedAt!);
    if (key < dayKey(new Date(Date.now() - 8 * 86_400_000))) continue;
    push(key, {
      ts: n.publishedAt!,
      category: "external",
      icon: "🇦🇺",
      heading: `${n.source}: ${n.title}`,
      subheading:
        (n.tags.length > 0 ? `Affects ${n.tags.slice(0, 3).join(", ")}. ` : "") +
        (n.tags.includes("meat supply") || n.tags.includes("biosecurity")
          ? "Consider stocking affected items early as a precaution."
          : n.tags.includes("recall")
            ? "Check whether any of your suppliers are affected."
            : "Worth a read for planning."),
      link: n.link,
    });
  }

  // Newest day first; inside a day newest first.
  const daysOut = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, items]) => ({
      day,
      items: items.sort((a, b) => (a.ts < b.ts ? 1 : -1)),
    }));
  return Response.json({ generatedAt: new Date().toISOString(), days: daysOut });
});
