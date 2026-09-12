"use client";
import { useCallback, useEffect, useState } from "react";

/* Daily insights: live trade + stock + Australian government supply-watch.
   Charts are hand-built SVG/CSS — colourful, dependency-free, robust. */

interface Insights {
  activity: ActivityRow[];
  today: { orders: number; revenue: string; avg_order: number };
  byHour: { hour: number; orders: number; revenue: string }[];
  revenue14: { day: string; orders: number; revenue: string }[];
  sources: { source: string; orders: number; revenue: string }[];
  topItems: { name: string; qty: number; revenue: string }[];
  callsToday: { total: number; completed: number };
  soldOut: string[];
  lowStock: { id: string; name: string; unit: string; currentQty: number; status: "low" | "out" }[];
}
interface NewsItem {
  source: string;
  title: string;
  link: string;
  publishedAt: string | null;
  summary: string;
  relevance: number;
  tags: string[];
}
interface Toast {
  id: string;
  kind: "news" | "stock";
  title: string;
  body: string;
  link?: string;
}
interface ActivityRow {
  kind: "order" | "stock" | "call";
  event: string;
  ref: string;
  label: string;
  amount: string;
  at: string | null;
}
interface BriefingItem {
  ts: string;
  category: "sales" | "calls" | "stock" | "external";
  icon: string;
  heading: string;
  subheading: string;
  link?: string;
}
interface BriefingDay {
  day: string;
  items: BriefingItem[];
}
interface Recommendation {
  area: "supply_watch" | "demand" | "forecast" | "pricing" | "menu";
  urgency: "now" | "this_week" | "consider";
  heading: string;
  detail: string;
}
interface AiBriefing {
  generatedAt: string;
  source: "ai" | "rules";
  recommendations: Recommendation[];
}
interface EfficiencyReport {
  calls: { total: number; completed: number; avgSecs: number | null; longCalls: number };
  kitchen: {
    made: number;
    avgPrepSecs: number | null;
    late: number;
    avgLateSecs: number | null;
    avgPickupWaitSecs: number | null;
  };
  process: { abandonedDrafts: number; needsReview: number };
  findings: { icon: string; heading: string; detail: string }[];
}
interface ForecastRow {
  name: string;
  unit: string;
  lastWeek: number;
  prevWeek: number;
  trendPct: number | null;
  predictedNextWeek: number;
  currentQty: number;
  coverDays: number | null;
  suggestedOrderQty: number;
  action: "restock_now" | "order_this_week" | "ok" | "no_demand";
}

const AUD = (cents: number | string) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(cents) / 100);

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const secs = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

const CALL_OUTCOME: Record<string, string> = {
  ORDER_COMPLETED: "✅ order placed",
  NO_ORDER: "no order",
  MENU_ENQUIRY: "menu enquiry",
  REVIEW_LINK_SENT: "text-to-confirm sent",
  CUSTOMER_CANCELLED: "cancelled",
  NEEDS_REVIEW: "needs review",
  CALL_DROPPED: "dropped",
  "in progress": "on the line now",
};

function activityLine(a: ActivityRow): { icon: string; text: string; accent: string } {
  if (a.kind === "order") {
    return a.event === "cancelled"
      ? { icon: "✖", accent: "border-red-300", text: `Order ${a.ref} cancelled — ${a.label}` }
      : { icon: "🧾", accent: "border-emerald-300", text: `Order ${a.ref} confirmed — ${AUD(a.amount)} · ${a.label}` };
  }
  if (a.kind === "stock") {
    const d = Number(a.amount);
    return a.event === "restock"
      ? { icon: "📦", accent: "border-emerald-300", text: `${a.ref} restocked (+${d})` }
      : { icon: "📦", accent: "border-amber-300", text: `${a.ref} stocktake (${d > 0 ? "+" : ""}${d})` };
  }
  const mins = Math.round(Number(a.amount) / 60);
  return {
    icon: "📞",
    accent: "border-sky-300",
    text: `Call ${a.label.replace(/^(\+\d{4})\d+(\d{3})$/, "$1···$2")} — ${CALL_OUTCOME[a.event] ?? a.event}${Number(a.amount) > 0 ? ` (${mins < 1 ? "<1" : mins} min)` : ""}`,
  };
}
const PIE_COLOURS = ["#10b981", "#f59e0b", "#8b5cf6", "#0ea5e9", "#f43f5e", "#f97316"];
const SOURCE_LABEL: Record<string, string> = { phone: "📞 AI phone", pos: "🧾 Counter (POS)", web: "🌐 Web" };

const CATEGORY_STYLE: Record<BriefingItem["category"], string> = {
  sales: "border-emerald-400",
  calls: "border-sky-400",
  stock: "border-amber-400",
  external: "border-violet-400",
};

function dayTitle(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const label = d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "short" });
  if (day === today) return `Today · ${label}`;
  if (day === yesterday) return `Yesterday · ${label}`;
  return label;
}

export default function InsightsPage() {
  const [data, setData] = useState<Insights | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [briefing, setBriefing] = useState<BriefingDay[]>([]);
  const [advice, setAdvice] = useState<AiBriefing | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [forecast, setForecast] = useState<ForecastRow[]>([]);
  const [efficiency, setEfficiency] = useState<EfficiencyReport | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = (id: string) => setToasts((t) => t.filter((x) => x.id !== id));

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/insights");
      if (res.ok) {
        const d = (await res.json()) as Insights;
        setData(d);
        // Stock pop-outs: once per item per browser session.
        const seen = new Set<string>(JSON.parse(sessionStorage.getItem("mbx-stock-toast") ?? "[]") as string[]);
        const fresh = d.lowStock.filter((i) => !seen.has(i.id)).slice(0, 3);
        if (fresh.length > 0) {
          setToasts((t) => [
            ...t,
            ...fresh.map((i) => ({
              id: `stock-${i.id}`,
              kind: "stock" as const,
              title: i.status === "out" ? `❌ OUT OF STOCK: ${i.name}` : `⚠ Low stock: ${i.name}`,
              body: i.status === "out" ? "Restock or mark sold out in the menu." : `${i.currentQty} ${i.unit} left — restock soon.`,
            })),
          ]);
          fresh.forEach((i) => seen.add(i.id));
          sessionStorage.setItem("mbx-stock-toast", JSON.stringify([...seen]));
        }
      }
    } catch {
      /* next poll retries */
    }
    try {
      const res = await fetch("/api/insights/daily");
      if (res.ok) setBriefing(((await res.json()) as { days: BriefingDay[] }).days);
    } catch {
      /* dashboard degrades gracefully */
    }
    try {
      const res = await fetch("/api/insights/forecast");
      if (res.ok) setForecast(((await res.json()) as { rows: ForecastRow[] }).rows);
    } catch {
      /* dashboard degrades gracefully */
    }
    try {
      const res = await fetch("/api/insights/efficiency");
      if (res.ok) setEfficiency((await res.json()) as EfficiencyReport);
    } catch {
      /* dashboard degrades gracefully */
    }
    try {
      const res = await fetch("/api/insights/ai");
      if (res.ok) setAdvice((await res.json()) as AiBriefing);
    } catch {
      /* dashboard degrades gracefully */
    }
    try {
      const res = await fetch("/api/insights/news");
      if (res.ok) {
        const items = ((await res.json()) as { items: NewsItem[] }).items;
        setNews(items);
        const seen = new Set<string>(JSON.parse(localStorage.getItem("mbx-news-seen") ?? "[]") as string[]);
        const fresh = items.filter((n) => n.relevance >= 6 && !seen.has(n.link)).slice(0, 2);
        if (fresh.length > 0) {
          setToasts((t) => [
            ...t,
            ...fresh.map((n) => ({
              id: `news-${n.link}`,
              kind: "news" as const,
              title: `🇦🇺 ${n.source}`,
              body: n.title,
              link: n.link,
            })),
          ]);
          items.forEach((n) => seen.add(n.link));
          localStorage.setItem("mbx-news-seen", JSON.stringify([...seen].slice(-300)));
        }
      }
    } catch {
      /* dashboard degrades gracefully */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) return <p className="text-stone-400">Loading insights…</p>;

  const conv = data.callsToday.total > 0 ? Math.round((100 * data.callsToday.completed) / data.callsToday.total) : 0;
  const maxDayRevenue = Math.max(1, ...data.revenue14.map((d) => Number(d.revenue)));
  const maxHour = Math.max(1, ...data.byHour.map((h) => h.orders));
  const maxItemQty = Math.max(1, ...data.topItems.map((i) => i.qty));
  const totalSourceOrders = Math.max(1, data.sources.reduce((s, x) => s + x.orders, 0));
  let acc = 0;
  const pieStops = data.sources.map((s, i) => {
    const from = (360 * acc) / totalSourceOrders;
    acc += s.orders;
    const to = (360 * acc) / totalSourceOrders;
    return `${PIE_COLOURS[i % PIE_COLOURS.length]} ${from}deg ${to}deg`;
  });

  return (
    <div className="w-full">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">📊 Daily insights</h1>
        <span className="text-xs text-stone-400">Live — refreshes every minute</span>
      </div>

      {/* KPI cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 p-4 text-white shadow-lg">
          <p className="text-xs uppercase opacity-80">Revenue today</p>
          <p className="text-3xl font-extrabold">{AUD(data.today.revenue)}</p>
        </div>
        <div className="rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 p-4 text-white shadow-lg">
          <p className="text-xs uppercase opacity-80">Orders today</p>
          <p className="text-3xl font-extrabold">{data.today.orders}</p>
        </div>
        <div className="rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 p-4 text-white shadow-lg">
          <p className="text-xs uppercase opacity-80">Avg order</p>
          <p className="text-3xl font-extrabold">{AUD(data.today.avg_order)}</p>
        </div>
        <div className="rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 p-4 text-white shadow-lg">
          <p className="text-xs uppercase opacity-80">AI calls today</p>
          <p className="text-3xl font-extrabold">
            {data.callsToday.total} <span className="text-base font-bold opacity-80">· {conv}% ordered</span>
          </p>
        </div>
      </div>

      {/* Stock alerts */}
      {(data.lowStock.length > 0 || data.soldOut.length > 0) && (
        <div className="mb-6 rounded-2xl border-2 border-red-200 bg-gradient-to-r from-red-50 to-amber-50 p-4 shadow">
          <p className="mb-2 font-extrabold text-red-700">🚨 Stock watch</p>
          <div className="flex flex-wrap gap-2 text-sm">
            {data.lowStock.map((i) => (
              <span
                key={i.id}
                className={`rounded-full px-3 py-1 font-bold ${i.status === "out" ? "bg-red-600 text-white" : "bg-amber-400 text-amber-950"}`}
              >
                {i.name}: {i.status === "out" ? "OUT" : `${i.currentQty} ${i.unit} left`}
              </span>
            ))}
            {data.soldOut.map((n) => (
              <span key={n} className="rounded-full bg-stone-700 px-3 py-1 font-bold text-white">
                {n}: marked sold out
              </span>
            ))}
          </div>
          <a href="/admin/inventory" className="mt-2 inline-block text-sm font-bold text-red-700 underline">
            Open inventory →
          </a>
        </div>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        {/* Revenue 14 days */}
        <div className="rounded-2xl bg-white p-4 shadow">
          <h2 className="mb-3 font-bold">Revenue — last 14 days</h2>
          <div className="flex h-40 items-end gap-1">
            {data.revenue14.map((d) => (
              <div key={String(d.day)} className="group relative flex-1">
                <div
                  className="w-full rounded-t-md bg-gradient-to-t from-emerald-600 to-emerald-400 transition-all group-hover:from-emerald-700"
                  style={{ height: `${Math.max(3, (156 * Number(d.revenue)) / maxDayRevenue)}px` }}
                />
                <div className="pointer-events-none absolute -top-8 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-stone-900 px-2 py-0.5 text-xs text-white group-hover:block">
                  {new Date(d.day).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}: {AUD(d.revenue)} ({d.orders})
                </div>
              </div>
            ))}
            {data.revenue14.length === 0 && <p className="text-sm text-stone-400">No orders yet.</p>}
          </div>
        </div>

        {/* Orders by hour today */}
        <div className="rounded-2xl bg-white p-4 shadow">
          <h2 className="mb-3 font-bold">Orders by hour — today</h2>
          <div className="flex h-40 items-end gap-1">
            {Array.from({ length: 15 }, (_, i) => i + 10).map((hour) => {
              const row = data.byHour.find((h) => h.hour === hour);
              return (
                <div key={hour} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t-md bg-gradient-to-t from-orange-500 to-amber-300"
                    style={{ height: `${row ? Math.max(4, (130 * row.orders) / maxHour) : 2}px` }}
                  />
                  <span className="text-[10px] text-stone-400">{hour % 12 === 0 ? 12 : hour % 12}{hour < 12 || hour === 24 ? "a" : "p"}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Source split donut */}
        <div className="rounded-2xl bg-white p-4 shadow">
          <h2 className="mb-3 font-bold">Where orders come from — 7 days</h2>
          <div className="flex items-center gap-6">
            <div
              className="h-36 w-36 shrink-0 rounded-full shadow-inner"
              style={{
                background: data.sources.length ? `conic-gradient(${pieStops.join(", ")})` : "#e7e5e4",
                WebkitMask: "radial-gradient(circle 38px at center, transparent 98%, black)",
                mask: "radial-gradient(circle 38px at center, transparent 98%, black)",
              }}
            />
            <ul className="space-y-2 text-sm">
              {data.sources.map((s, i) => (
                <li key={s.source} className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ background: PIE_COLOURS[i % PIE_COLOURS.length] }} />
                  <span className="font-medium">{SOURCE_LABEL[s.source] ?? s.source}</span>
                  <span className="text-stone-400">
                    {s.orders} · {AUD(s.revenue)}
                  </span>
                </li>
              ))}
              {data.sources.length === 0 && <li className="text-stone-400">No orders this week.</li>}
            </ul>
          </div>
        </div>

        {/* Top items */}
        <div className="rounded-2xl bg-white p-4 shadow">
          <h2 className="mb-3 font-bold">Top sellers — 7 days</h2>
          <ul className="space-y-2">
            {data.topItems.map((item, i) => (
              <li key={item.name} className="text-sm">
                <div className="mb-0.5 flex justify-between">
                  <span className="font-medium">{item.name}</span>
                  <span className="text-stone-400">
                    ×{item.qty} · {AUD(item.revenue)}
                  </span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-stone-100">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(4, (100 * item.qty) / maxItemQty)}%`,
                      background: `linear-gradient(90deg, ${PIE_COLOURS[i % PIE_COLOURS.length]}, ${PIE_COLOURS[(i + 1) % PIE_COLOURS.length]})`,
                    }}
                  />
                </div>
              </li>
            ))}
            {data.topItems.length === 0 && <li className="text-sm text-stone-400">No sales yet this week.</li>}
          </ul>
        </div>
      </div>

      {/* AI adviser: recommendations across supply watch, demand, forecast */}
      <div className="mb-6 rounded-2xl border-2 border-violet-200 bg-gradient-to-br from-violet-50 to-fuchsia-50 p-5 shadow">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-extrabold">🤖 AI adviser</h2>
          <div className="flex items-center gap-2 text-xs text-stone-500">
            {advice && (
              <span>
                {advice.source === "ai" ? "AI-generated" : "auto"} ·{" "}
                {new Date(advice.generatedAt).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
            <button
              disabled={regenBusy}
              onClick={() => {
                setRegenBusy(true);
                fetch("/api/insights/ai", { method: "POST" })
                  .then(async (r) => r.ok && setAdvice((await r.json()) as AiBriefing))
                  .finally(() => setRegenBusy(false));
              }}
              className="rounded-lg bg-violet-600 px-3 py-1 font-bold text-white disabled:opacity-40"
            >
              {regenBusy ? "Thinking…" : "Regenerate"}
            </button>
          </div>
        </div>
        <p className="mb-4 text-sm text-stone-500">
          Recommendations from your demand, stock and the government supply watch — what to buy early, when to
          adjust a price, and what to introduce if supply is blocked.
        </p>
        <div className="space-y-2">
          {(advice?.recommendations ?? []).map((r, i) => (
            <div key={i} className="rounded-xl bg-white p-3 shadow-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                    r.urgency === "now"
                      ? "bg-red-600 text-white"
                      : r.urgency === "this_week"
                        ? "bg-amber-400 text-amber-950"
                        : "bg-stone-200 text-stone-600"
                  }`}
                >
                  {r.urgency === "now" ? "ACT NOW" : r.urgency === "this_week" ? "THIS WEEK" : "CONSIDER"}
                </span>
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
                  {r.area.replace("_", " ")}
                </span>
              </div>
              <p className="font-bold leading-snug">{r.heading}</p>
              <p className="mt-0.5 text-sm text-stone-600">{r.detail}</p>
            </div>
          ))}
          {!advice && <p className="text-sm text-stone-400">Generating recommendations…</p>}
          {advice && advice.recommendations.length === 0 && (
            <p className="text-sm text-stone-400">Nothing needs attention right now — all stocked and steady.</p>
          )}
        </div>
      </div>

      {/* Forecast & restock plan */}
      <div className="mb-6 rounded-2xl bg-white p-5 shadow">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-extrabold">🔮 Forecast &amp; restock plan</h2>
          <span className="text-xs text-stone-400">Predicted from your real order history · 10-day buffer target</span>
        </div>
        <p className="mb-3 text-sm text-stone-500">
          What sold, what&apos;s predicted next week, and what to order now so no customer ever waits — even if a
          shipment is blocked for 10 days.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-stone-100 text-left">
              <tr>
                <th className="p-2">Item</th>
                <th className="p-2 text-right">Last wk</th>
                <th className="p-2 text-right">Trend</th>
                <th className="p-2 text-right">Predicted next wk</th>
                <th className="p-2 text-right">Stock</th>
                <th className="p-2 text-right">Cover</th>
                <th className="p-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {forecast
                .filter((f) => f.action !== "no_demand")
                .slice(0, 12)
                .map((f) => (
                  <tr key={f.name} className="border-t">
                    <td className="p-2 font-medium">{f.name}</td>
                    <td className="p-2 text-right">{f.lastWeek}</td>
                    <td className={`p-2 text-right font-semibold ${f.trendPct !== null && f.trendPct > 0 ? "text-emerald-600" : f.trendPct !== null && f.trendPct < 0 ? "text-red-500" : "text-stone-400"}`}>
                      {f.trendPct === null ? "new" : `${f.trendPct > 0 ? "▲" : f.trendPct < 0 ? "▼" : ""}${Math.abs(f.trendPct)}%`}
                    </td>
                    <td className="p-2 text-right font-bold">{f.predictedNextWeek}</td>
                    <td className="p-2 text-right">{f.currentQty}</td>
                    <td className={`p-2 text-right ${f.coverDays !== null && f.coverDays < 3 ? "font-bold text-red-600" : f.coverDays !== null && f.coverDays < 10 ? "font-bold text-amber-600" : "text-stone-500"}`}>
                      {f.coverDays === null ? "—" : `${f.coverDays}d`}
                    </td>
                    <td className="p-2">
                      {f.action === "restock_now" && (
                        <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
                          Restock NOW +{f.suggestedOrderQty}
                        </span>
                      )}
                      {f.action === "order_this_week" && (
                        <span className="rounded-full bg-amber-400 px-2 py-0.5 text-xs font-bold text-amber-950">
                          Order +{f.suggestedOrderQty} this week
                        </span>
                      )}
                      {f.action === "ok" && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              {forecast.filter((f) => f.action !== "no_demand").length === 0 && (
                <tr>
                  <td colSpan={7} className="p-4 text-center text-stone-400">
                    Forecast appears after the first week of orders.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Efficiency report: where time is lost */}
      {efficiency && (
        <div className="mb-6 rounded-2xl bg-white p-5 shadow">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-lg font-extrabold">⚙️ Efficiency report</h2>
            <span className="text-xs text-stone-400">Last 7 days · from real timestamps</span>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3 text-center md:grid-cols-5">
            <div className="rounded-xl bg-stone-50 p-3">
              <p className="text-2xl font-extrabold">
                {efficiency.calls.avgSecs !== null ? `${Math.floor(efficiency.calls.avgSecs / 60)}:${String(efficiency.calls.avgSecs % 60).padStart(2, "0")}` : "—"}
              </p>
              <p className="text-xs text-stone-500">avg call</p>
            </div>
            <div className="rounded-xl bg-stone-50 p-3">
              <p className="text-2xl font-extrabold">
                {efficiency.calls.total > 0 ? `${Math.round((100 * efficiency.calls.completed) / efficiency.calls.total)}%` : "—"}
              </p>
              <p className="text-xs text-stone-500">calls → orders</p>
            </div>
            <div className="rounded-xl bg-stone-50 p-3">
              <p className="text-2xl font-extrabold">
                {efficiency.kitchen.avgPrepSecs !== null ? `${Math.round(efficiency.kitchen.avgPrepSecs / 60)}m` : "—"}
              </p>
              <p className="text-xs text-stone-500">avg kitchen prep</p>
            </div>
            <div className="rounded-xl bg-stone-50 p-3">
              <p className="text-2xl font-extrabold">
                {efficiency.kitchen.made > 0 ? `${Math.round((100 * (efficiency.kitchen.made - efficiency.kitchen.late)) / efficiency.kitchen.made)}%` : "—"}
              </p>
              <p className="text-xs text-stone-500">on-time vs promise</p>
            </div>
            <div className="rounded-xl bg-stone-50 p-3">
              <p className="text-2xl font-extrabold">
                {efficiency.kitchen.avgPickupWaitSecs !== null ? `${Math.round(efficiency.kitchen.avgPickupWaitSecs / 60)}m` : "—"}
              </p>
              <p className="text-xs text-stone-500">food waits for pickup</p>
            </div>
          </div>
          <div className="space-y-2">
            {efficiency.findings.map((f, i) => (
              <div key={i} className="rounded-xl border-l-4 border-stone-300 bg-stone-50 p-3">
                <p className="font-bold leading-snug">
                  <span className="mr-1.5">{f.icon}</span>
                  {f.heading}
                </p>
                <p className="mt-0.5 text-sm text-stone-600">{f.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily briefing: written insights, day by day */}
      <div className="mb-6 rounded-2xl bg-white p-5 shadow">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-extrabold">📰 Daily briefing</h2>
          <span className="text-xs text-stone-400">Written insights from your data + external factors</span>
        </div>
        <p className="mb-4 text-sm text-stone-500">
          What happened, what&apos;s running down, and what&apos;s coming — scroll back day by day.
        </p>
        <div className="max-h-[30rem] space-y-5 overflow-y-auto pr-2">
          {briefing.map((day) => (
            <div key={day.day}>
              <p className="sticky top-0 z-10 mb-2 w-fit rounded-full bg-stone-900 px-3 py-1 text-xs font-bold text-white">
                {dayTitle(day.day)}
              </p>
              <div className="space-y-2">
                {day.items.map((item, i) => {
                  const body = (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <p className="font-bold leading-snug">
                          <span className="mr-1.5">{item.icon}</span>
                          {item.heading}
                        </p>
                        <span className="shrink-0 text-[11px] text-stone-400">
                          {new Date(item.ts).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}
                        </span>
                      </div>
                      <p className="mt-0.5 text-sm text-stone-600">{item.subheading}</p>
                    </>
                  );
                  const cls = `block rounded-xl border-l-4 bg-stone-50 p-3 ${CATEGORY_STYLE[item.category]}`;
                  return item.link ? (
                    <a key={i} href={item.link} target="_blank" rel="noreferrer" className={`${cls} hover:bg-stone-100`}>
                      {body}
                    </a>
                  ) : (
                    <div key={i} className={cls}>
                      {body}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {briefing.length === 0 && <p className="text-sm text-stone-400">Building your briefing…</p>}
        </div>
      </div>

      {/* Government supply watch */}
      <div className="rounded-2xl bg-gradient-to-br from-stone-900 to-stone-800 p-5 text-white shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-extrabold">🇦🇺 Government supply watch</h2>
          <span className="text-xs text-stone-400">Live from FSANZ · DAFF · RBA · PM&apos;s office</span>
        </div>
        <p className="mb-4 text-sm text-stone-300">
          Official announcements that can affect your supply and prices — recalls, biosecurity, rates, trade. Stock up
          early when something is coming.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {news.slice(0, 8).map((n) => (
            <a
              key={n.link}
              href={n.link}
              target="_blank"
              rel="noreferrer"
              className={`block rounded-xl p-3 transition hover:bg-stone-700 ${n.relevance >= 6 ? "border border-amber-400/60 bg-stone-700/80" : "bg-stone-700/40"}`}
            >
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded bg-sky-600 px-1.5 py-0.5 font-bold">{n.source}</span>
                {n.publishedAt && (
                  <span className="text-stone-400">{new Date(n.publishedAt).toLocaleDateString("en-AU")}</span>
                )}
                {n.tags.slice(0, 3).map((t) => (
                  <span key={t} className="rounded bg-amber-500/20 px-1.5 py-0.5 font-semibold text-amber-300">
                    {t}
                  </span>
                ))}
              </div>
              <p className="text-sm font-semibold leading-snug">{n.title}</p>
            </a>
          ))}
          {news.length === 0 && <p className="text-sm text-stone-400">Fetching government feeds…</p>}
        </div>
      </div>
        </div>

        {/* Live activity rail */}
        <div className="rounded-2xl bg-white p-4 shadow">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-bold">⚡ Live activity</h2>
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> live
            </span>
          </div>
          <ul className="max-h-[52rem] space-y-2 overflow-y-auto pr-1">
            {data.activity.map((a, i) => {
              const line = activityLine(a);
              return (
                <li key={i} className={`rounded-xl border-l-4 bg-stone-50 p-2.5 ${line.accent}`}>
                  <p className="text-sm leading-snug">
                    <span className="mr-1">{line.icon}</span>
                    {line.text}
                  </p>
                  <p className="mt-0.5 text-[11px] text-stone-400">{timeAgo(a.at)}</p>
                </li>
              );
            })}
            {data.activity.length === 0 && (
              <li className="text-sm text-stone-400">Updates appear here as orders, calls and restocks happen.</li>
            )}
          </ul>
        </div>
      </div>

      {/* Pop-out toasts */}
      <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.slice(0, 4).map((t) => (
          <div
            key={t.id}
            className={`rounded-2xl p-4 shadow-2xl ${t.kind === "stock" ? "border-2 border-amber-400 bg-white" : "bg-stone-900 text-white"}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-extrabold">{t.title}</p>
              <button onClick={() => dismiss(t.id)} className="text-stone-400 hover:text-stone-600">
                ✕
              </button>
            </div>
            <p className={`mt-1 text-xs ${t.kind === "stock" ? "text-stone-600" : "text-stone-300"}`}>{t.body}</p>
            {t.link && (
              <a href={t.link} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-bold text-sky-400 underline">
                Read the announcement →
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
