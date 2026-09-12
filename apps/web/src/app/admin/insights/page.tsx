"use client";
import { useCallback, useEffect, useState } from "react";

/* Daily insights: live trade + stock + Australian government supply-watch.
   Charts are hand-built SVG/CSS — colourful, dependency-free, robust. */

interface Insights {
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

const AUD = (cents: number | string) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(cents) / 100);
const PIE_COLOURS = ["#10b981", "#f59e0b", "#8b5cf6", "#0ea5e9", "#f43f5e", "#f97316"];
const SOURCE_LABEL: Record<string, string> = { phone: "📞 AI phone", pos: "🧾 Counter (POS)", web: "🌐 Web" };

export default function InsightsPage() {
  const [data, setData] = useState<Insights | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
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
    <div className="max-w-5xl">
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
                  <span className="text-[10px] text-stone-400">{hour % 12 === 0 ? 12 : hour % 12}{hour < 12 ? "a" : "p"}</span>
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
