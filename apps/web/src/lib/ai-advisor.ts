import type pg from "pg";
import { env, listInventory, stockStatus, type Restaurant } from "@meatbox/core";
import { fetchGovNews } from "./gov-news";
import { computeForecast, type ForecastRow } from "./forecast";
import { computeEfficiency } from "./efficiency";

/**
 * AI adviser: Claude reads the demand forecast, stock position and the
 * government supply-watch TOGETHER and writes concrete recommendations —
 * buy early, raise a price on a hyped item, introduce an alternative
 * when supply is threatened. Falls back to rule-based advice when the
 * model is unavailable, so the panel never comes up empty.
 */

export interface Recommendation {
  area: "supply_watch" | "demand" | "forecast" | "pricing" | "menu";
  urgency: "now" | "this_week" | "consider";
  heading: string;
  detail: string;
}

export interface Briefing {
  generatedAt: string;
  source: "ai" | "rules";
  recommendations: Recommendation[];
}

function ruleBasedAdvice(forecast: ForecastRow[]): Recommendation[] {
  const recs: Recommendation[] = [];
  for (const row of forecast.filter((f) => f.action === "restock_now").slice(0, 4)) {
    recs.push({
      area: "forecast",
      urgency: "now",
      heading: `Restock ${row.name} today (+${row.suggestedOrderQty} ${row.unit})`,
      detail: `Sold ${row.lastWeek} last week; current stock covers about ${row.coverDays} days. Order at least ${row.suggestedOrderQty} ${row.unit} to hold a 10-day buffer.`,
    });
  }
  for (const row of forecast.filter((f) => f.action === "order_this_week").slice(0, 4)) {
    recs.push({
      area: "forecast",
      urgency: "this_week",
      heading: `Add ${row.name} to this week's order (+${row.suggestedOrderQty} ${row.unit})`,
      detail: `Demand is ${row.trendPct !== null && row.trendPct > 0 ? `up ${row.trendPct}%` : "steady"}; stock covers ${row.coverDays} days — below the 10-day buffer.`,
    });
  }
  const hyped = forecast.find((f) => f.trendPct !== null && f.trendPct >= 50 && f.lastWeek >= 5);
  if (hyped) {
    recs.push({
      area: "pricing",
      urgency: "consider",
      heading: `${hyped.name} demand is surging (+${hyped.trendPct}%)`,
      detail: `Sold ${hyped.lastWeek} last week vs ${hyped.prevWeek} the week before. Consider a small price rise or a bundled special while it's hot.`,
    });
  }
  return recs;
}

async function callClaude(prompt: string): Promise<Recommendation[] | null> {
  if (!env.ANTHROPIC_API_KEY) {
    console.error("[ai-advisor] no ANTHROPIC_API_KEY in web env");
    return null;
  }
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      console.error(`[ai-advisor] anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((b) => b.type === "text")?.text ?? "";
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) {
      console.error(`[ai-advisor] no JSON in reply: ${text.slice(0, 200)}`);
      return null;
    }
    const parsed = JSON.parse(json) as { recommendations?: Recommendation[] };
    const recs = (parsed.recommendations ?? []).filter(
      (r) =>
        r &&
        typeof r.heading === "string" &&
        typeof r.detail === "string" &&
        ["supply_watch", "demand", "forecast", "pricing", "menu"].includes(r.area) &&
        ["now", "this_week", "consider"].includes(r.urgency),
    );
    return recs.length > 0 ? recs.slice(0, 10) : null;
  } catch (err) {
    console.error(`[ai-advisor] call failed: ${(err as Error).message}`);
    return null;
  }
}

export async function generateBriefing(db: pg.Pool, restaurant: Restaurant): Promise<Briefing> {
  const [forecast, news, inventory, efficiency] = await Promise.all([
    computeForecast(db, restaurant.id),
    fetchGovNews(),
    listInventory(db, restaurant.id),
    computeEfficiency(db, restaurant.id),
  ]);
  const lowRaw = inventory
    .filter((i) => i.category === "raw" && stockStatus(i) !== "ok")
    .map((i) => `${i.name}: ${i.currentQty} ${i.unit} left`);

  const demandTable = forecast
    .filter((f) => f.action !== "no_demand")
    .slice(0, 15)
    .map(
      (f) =>
        `${f.name}: sold ${f.lastWeek} last wk (prev ${f.prevWeek}${f.trendPct !== null ? `, ${f.trendPct > 0 ? "+" : ""}${f.trendPct}%` : ""}), predicted ${f.predictedNextWeek} next wk, stock ${f.currentQty} (${f.coverDays ?? "∞"} days cover), suggested order +${f.suggestedOrderQty}`,
    )
    .join("\n");
  const newsList = news.items
    .filter((n) => n.relevance >= 4)
    .slice(0, 8)
    .map((n) => `- [${n.source}] ${n.title} (tags: ${n.tags.join(", ")}) — ${n.summary.slice(0, 140)}`)
    .join("\n");

  const prompt = `You advise the owner of ${restaurant.name}, a busy Australian takeaway in Perth (meatboxes, kebabs, charcoal chicken, burgers, drinks). Write practical recommendations from TODAY's data.

DEMAND FORECAST (real order data; target = always hold a 10-day stock buffer so customers never wait, even if a shipment is blocked for 10 days):
${demandTable || "(no sales in the last 14 days)"}

RAW MATERIALS RUNNING LOW:
${lowRaw.join("\n") || "(none)"}

GOVERNMENT ANNOUNCEMENTS (live Australian government feeds):
${newsList || "(none currently)"}

EFFICIENCY THIS WEEK (real timings):
- Calls: ${efficiency.calls.total} total, ${efficiency.calls.completed} became orders, avg ${efficiency.calls.avgSecs ?? "?"}s, ${efficiency.calls.longCalls} over 3 min
- Kitchen: ${efficiency.kitchen.made} orders made, avg prep ${efficiency.kitchen.avgPrepSecs ? Math.round(efficiency.kitchen.avgPrepSecs / 60) : "?"} min, ${efficiency.kitchen.late} past promised time, food waits ${efficiency.kitchen.avgPickupWaitSecs ? Math.round(efficiency.kitchen.avgPickupWaitSecs / 60) : "?"} min after ready
- ${efficiency.process.abandonedDrafts} abandoned started-orders, ${efficiency.process.needsReview} flagged for review

Rules for your advice:
- For each relevant government item: say exactly what the owner should DO (e.g. which stock to buy early and roughly how much extra, check which supplier, watch which price).
- For surging items: recommend restock quantities first; a modest price rise ONLY when demand is clearly hot (say a % range).
- If any supply looks threatened (biosecurity, recall, shortage news): recommend an ALTERNATIVE menu item with similar appeal the shop could push or introduce (name a concrete dish idea using their existing ingredients).
- Forecast items with low cover: urgent restock with quantities.
- If the efficiency numbers show lost time (late orders, long calls, food waiting), include ONE process-improvement recommendation.
- Max 8 recommendations, most urgent first. Australian English, plain words, no fluff.

Reply with ONLY this JSON:
{"recommendations":[{"area":"supply_watch|demand|forecast|pricing|menu","urgency":"now|this_week|consider","heading":"short imperative headline","detail":"2-3 sentences of concrete advice with numbers"}]}`;

  const ai = await callClaude(prompt);
  return {
    generatedAt: new Date().toISOString(),
    source: ai ? "ai" : "rules",
    recommendations: ai ?? ruleBasedAdvice(forecast),
  };
}

const FRESH_MS = 6 * 60 * 60_000;

export async function getOrGenerateBriefing(
  db: pg.Pool,
  restaurant: Restaurant,
  force = false,
): Promise<Briefing> {
  if (!force) {
    const latest = await db.query(
      `SELECT payload, generated_at FROM ai_briefings
       WHERE restaurant_id = $1 ORDER BY generated_at DESC LIMIT 1`,
      [restaurant.id],
    );
    const row = latest.rows[0] as { payload: Briefing; generated_at: Date } | undefined;
    if (row && Date.now() - new Date(row.generated_at).getTime() < FRESH_MS) {
      return row.payload;
    }
  }
  const briefing = await generateBriefing(db, restaurant);
  await db.query(`INSERT INTO ai_briefings (restaurant_id, payload) VALUES ($1, $2)`, [
    restaurant.id,
    JSON.stringify(briefing),
  ]);
  // Keep the table tidy: only the latest few briefings matter.
  await db.query(
    `DELETE FROM ai_briefings WHERE restaurant_id = $1 AND id NOT IN (
       SELECT id FROM ai_briefings WHERE restaurant_id = $1 ORDER BY generated_at DESC LIMIT 10)`,
    [restaurant.id],
  );
  return briefing;
}
