import { getDefaultRestaurant, type TranscriptTurn } from "@meatbox/core";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Per-call latency + conversation quality diagnostics (spec §36).
 * Built from calls.transcript and the permanent turn_metrics /
 * slow_turn / interrupt / tool_call events the voice service records.
 */

interface TurnMetric {
  at: Date;
  turnMs: number;
  firstTokenMs: number | null;
  fillerSent: boolean;
  toolCalls: number;
  fastPath: string | null;
  assistantWords: number;
  slow: boolean;
}

function ms(v: number | null): string {
  if (v === null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
}

function latencyClass(v: number | null): string {
  if (v === null) return "";
  if (v < 1000) return "text-green-700";
  if (v < 2000) return "text-amber-600";
  return "text-red-600 font-bold";
}

export default async function VoiceQualityPage() {
  const restaurant = await getDefaultRestaurant(db());
  const callsRes = await db().query(
    `SELECT id, caller_number, started_at, duration_seconds, outcome, status, transcript,
            twilio_call_sid
     FROM calls
     WHERE restaurant_id = $1
     ORDER BY started_at DESC LIMIT 20`,
    [restaurant.id],
  );

  const calls = [] as {
    id: string;
    caller: string;
    startedAt: Date;
    duration: number | null;
    outcome: string;
    isSim: boolean;
    transcript: TranscriptTurn[];
    metrics: TurnMetric[];
    interrupts: number;
  }[];

  for (const r of callsRes.rows) {
    const row = r as {
      id: string;
      caller_number: string;
      started_at: Date;
      duration_seconds: number | null;
      outcome: string | null;
      status: string;
      transcript: TranscriptTurn[];
      twilio_call_sid: string | null;
    };
    const eventsRes = await db().query(
      `SELECT event_type, payload, created_at FROM call_events
       WHERE call_id = $1 AND event_type IN ('turn_metrics', 'slow_turn', 'interrupt')
       ORDER BY created_at`,
      [row.id],
    );
    const metrics: TurnMetric[] = [];
    let interrupts = 0;
    for (const e of eventsRes.rows) {
      const ev = e as { event_type: string; payload: Record<string, unknown>; created_at: Date };
      if (ev.event_type === "interrupt") {
        interrupts++;
        continue;
      }
      metrics.push({
        at: ev.created_at,
        turnMs: Number(ev.payload.turnMs ?? 0),
        firstTokenMs: ev.payload.firstTokenMs === null ? null : Number(ev.payload.firstTokenMs),
        fillerSent: Boolean(ev.payload.fillerSent),
        toolCalls: Number(ev.payload.toolCalls ?? 0),
        fastPath: (ev.payload.fastPath as string | null) ?? null,
        assistantWords: Number(ev.payload.assistantWords ?? 0),
        slow: ev.event_type === "slow_turn",
      });
    }
    calls.push({
      id: row.id,
      caller: row.caller_number || "unknown",
      startedAt: row.started_at,
      duration: row.duration_seconds,
      outcome: row.outcome ?? row.status,
      isSim: (row.twilio_call_sid ?? "").startsWith("SIM-"),
      transcript: row.transcript ?? [],
      metrics,
      interrupts,
    });
  }

  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

  return (
    <div className="max-w-4xl">
      <h1 className="mb-2 text-2xl font-bold">Voice quality</h1>
      <p className="mb-6 text-sm text-stone-500">
        Per-call latency and conversation diagnostics. First audio = time from the caller
        finishing speaking to the AI&apos;s first spoken word (target: under 1 second on
        deterministic turns; LLM turns are covered by the &quot;Righto&quot; filler at 0.9s).
        ⚡ marks turns answered by the deterministic fast path without the AI model.
      </p>

      {calls.length === 0 && <p className="text-stone-400">No calls recorded yet.</p>}

      <div className="space-y-4">
        {calls.map((call) => {
          const firstTokens = call.metrics
            .map((m) => m.firstTokenMs)
            .filter((v): v is number => v !== null);
          const turnTimes = call.metrics.map((m) => m.turnMs);
          const words = call.metrics.map((m) => m.assistantWords).filter((w) => w > 0);
          const fastCount = call.metrics.filter((m) => m.fastPath).length;
          return (
            <details key={call.id} className="rounded-2xl bg-white p-4 shadow">
              <summary className="cursor-pointer">
                <span className="font-bold">
                  {call.isSim ? "🧪 simulator" : `📞 ${call.caller}`}
                </span>{" "}
                <span className="text-sm text-stone-500">
                  {new Date(call.startedAt).toLocaleString("en-AU", {
                    timeZone: "Australia/Perth",
                    day: "2-digit",
                    month: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  {call.duration !== null && ` · ${call.duration}s`}
                  {" · "}
                  {call.outcome}
                </span>
                <span className="ml-2 text-sm">
                  {call.metrics.length > 0 && (
                    <>
                      first audio avg{" "}
                      <span className={latencyClass(avg(firstTokens))}>{ms(avg(firstTokens))}</span>
                      {" · turn avg "}
                      <span className={latencyClass(avg(turnTimes))}>{ms(avg(turnTimes))}</span>
                      {" · max "}
                      <span className={latencyClass(Math.max(0, ...turnTimes))}>
                        {ms(turnTimes.length ? Math.max(...turnTimes) : null)}
                      </span>
                      {` · ${avg(words) ?? "—"} words/turn`}
                      {fastCount > 0 && ` · ⚡×${fastCount}`}
                      {call.interrupts > 0 && ` · ${call.interrupts} barge-in`}
                    </>
                  )}
                </span>
              </summary>

              <div className="mt-3 border-t pt-3">
                <table className="w-full text-sm">
                  <thead className="text-left text-stone-500">
                    <tr>
                      <th className="py-1 pr-3">Turn</th>
                      <th className="py-1 pr-3">First audio</th>
                      <th className="py-1 pr-3">Full turn</th>
                      <th className="py-1 pr-3">Tools</th>
                      <th className="py-1">Words</th>
                    </tr>
                  </thead>
                  <tbody>
                    {call.metrics.map((m, i) => (
                      <tr key={i} className={m.slow ? "bg-red-50" : ""}>
                        <td className="py-1 pr-3">
                          {i + 1} {m.fastPath ? <span title={m.fastPath}>⚡</span> : ""}
                          {m.fillerSent ? " 🔈" : ""}
                        </td>
                        <td className={`py-1 pr-3 ${latencyClass(m.firstTokenMs)}`}>
                          {ms(m.firstTokenMs)}
                        </td>
                        <td className={`py-1 pr-3 ${latencyClass(m.turnMs)}`}>{ms(m.turnMs)}</td>
                        <td className="py-1 pr-3">{m.toolCalls}</td>
                        <td className="py-1">{m.assistantWords}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="mt-3 space-y-1 border-t pt-3 text-sm">
                  {call.transcript.map((turn, i) => (
                    <p key={i}>
                      <span className="font-bold">{turn.role === "caller" ? "Caller" : "AI"}:</span>{" "}
                      {turn.text}
                    </p>
                  ))}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
