import type pg from "pg";

/**
 * Efficiency report: where time goes, from real timestamps — call
 * durations, confirm→ready kitchen time (audited status transitions),
 * promised vs actual, and ready→collected wait. Findings are plain-text
 * observations with a suggested improvement.
 */

export interface EfficiencyReport {
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

const mins = (secs: number | null) => (secs === null ? null : Math.round(secs / 60));

export async function computeEfficiency(db: pg.Pool, restaurantId: string): Promise<EfficiencyReport> {
  const [calls, kitchen, process] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE outcome = 'ORDER_COMPLETED')::int AS completed,
              AVG(duration_seconds) FILTER (WHERE duration_seconds > 0)::int AS avg_secs,
              COUNT(*) FILTER (WHERE duration_seconds > 180)::int AS long_calls
       FROM calls WHERE restaurant_id = $1 AND started_at > now() - interval '7 days'`,
      [restaurantId],
    ),
    db.query(
      `WITH t AS (
         SELECT entity_id AS order_id,
                MIN(created_at) FILTER (WHERE changes->>'to' = 'ready') AS ready_at,
                MIN(created_at) FILTER (WHERE changes->>'to' = 'completed') AS completed_at
         FROM audit_logs
         WHERE action = 'order.status' AND entity_type = 'order'
           AND created_at > now() - interval '7 days'
         GROUP BY 1)
       SELECT COUNT(*) FILTER (WHERE t.ready_at IS NOT NULL)::int AS made,
              AVG(EXTRACT(EPOCH FROM (t.ready_at - o.confirmed_at)))::int AS avg_prep_secs,
              COUNT(*) FILTER (WHERE o.first_promised_ready_at IS NOT NULL
                AND t.ready_at > o.first_promised_ready_at + interval '2 minutes')::int AS late,
              AVG(EXTRACT(EPOCH FROM (t.ready_at - o.first_promised_ready_at)))
                FILTER (WHERE t.ready_at > o.first_promised_ready_at)::int AS avg_late_secs,
              AVG(EXTRACT(EPOCH FROM (t.completed_at - t.ready_at)))
                FILTER (WHERE t.completed_at IS NOT NULL AND t.ready_at IS NOT NULL)::int AS avg_pickup_secs
       FROM t JOIN orders o ON o.id::text = t.order_id
       WHERE o.restaurant_id = $1 AND o.confirmed_at IS NOT NULL`,
      [restaurantId],
    ),
    db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'cancelled' AND public_order_number IS NULL)::int AS abandoned,
              COUNT(*) FILTER (WHERE status = 'needs_review')::int AS needs_review
       FROM orders WHERE restaurant_id = $1 AND created_at > now() - interval '7 days'`,
      [restaurantId],
    ),
  ]);

  const c = calls.rows[0] as { total: number; completed: number; avg_secs: number | null; long_calls: number };
  const k = kitchen.rows[0] as {
    made: number;
    avg_prep_secs: number | null;
    late: number;
    avg_late_secs: number | null;
    avg_pickup_secs: number | null;
  };
  const p = process.rows[0] as { abandoned: number; needs_review: number };

  const findings: EfficiencyReport["findings"] = [];
  const conv = c.total > 0 ? Math.round((100 * c.completed) / c.total) : null;
  if (conv !== null && conv < 50 && c.total >= 5) {
    findings.push({
      icon: "📞",
      heading: `Only ${conv}% of calls become orders`,
      detail: "Listen to a few non-order transcripts in Call logs — callers may be asking for something the menu prompt doesn't cover well.",
    });
  }
  if (c.long_calls > 0 && c.total > 0) {
    findings.push({
      icon: "⏱",
      heading: `${c.long_calls} call${c.long_calls === 1 ? "" : "s"} ran past 3 minutes this week`,
      detail: "Long calls usually mean menu explanations — the AI can text the menu link instead; big orders suit the text-to-confirm flow.",
    });
  }
  if (k.made >= 3 && k.late > 0) {
    const lateRate = Math.round((100 * k.late) / k.made);
    findings.push({
      icon: "🍳",
      heading: `${lateRate}% of orders went past the promised time (avg ${mins(k.avg_late_secs) ?? "?"} min over)`,
      detail: "If this repeats on busy nights, raise the prep baselines in Settings so promises stay honest — a slightly later promise beats a broken one.",
    });
  }
  if (k.avg_pickup_secs !== null && k.avg_pickup_secs > 15 * 60) {
    findings.push({
      icon: "🛎",
      heading: `Food waits ${mins(k.avg_pickup_secs)} min on average after it's ready`,
      detail: "Customers arrive late for pickups — the ready SMS helps; consider quoting slightly longer times so food is fresher at handover.",
    });
  }
  if (p.abandoned >= 3) {
    findings.push({
      icon: "🛒",
      heading: `${p.abandoned} started orders were abandoned this week`,
      detail: "Check where those calls ended in Call logs — a recurring drop point (e.g. a confusing option) is usually fixable in the menu wording.",
    });
  }
  if (p.needs_review > 0) {
    findings.push({
      icon: "🚩",
      heading: `${p.needs_review} order${p.needs_review === 1 ? "" : "s"} flagged for staff review`,
      detail: "Handle these in Orders — each one is a customer the AI couldn't finish with.",
    });
  }
  if (findings.length === 0) {
    findings.push({
      icon: "✅",
      heading: "No efficiency issues detected this week",
      detail: "Calls convert well, the kitchen is hitting its promises, and food isn't sitting. Keep the same settings.",
    });
  }

  return {
    calls: { total: c.total, completed: c.completed, avgSecs: c.avg_secs, longCalls: c.long_calls },
    kitchen: {
      made: k.made,
      avgPrepSecs: k.avg_prep_secs,
      late: k.late,
      avgLateSecs: k.avg_late_secs,
      avgPickupWaitSecs: k.avg_pickup_secs,
    },
    process: { abandonedDrafts: p.abandoned, needsReview: p.needs_review },
    findings,
  };
}
