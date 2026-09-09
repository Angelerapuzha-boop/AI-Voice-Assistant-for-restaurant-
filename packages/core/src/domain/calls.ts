import type { Queryable } from "../db/client";
import { camelRow, camelRows, type CallOutcome, type CallRecord, type TranscriptTurn } from "../types";

export async function startCall(
  db: Queryable,
  params: { restaurantId: string; twilioCallSid?: string; callerNumber?: string },
): Promise<CallRecord> {
  const res = await db.query(
    `INSERT INTO calls (restaurant_id, twilio_call_sid, caller_number)
     VALUES ($1, $2, $3)
     ON CONFLICT (twilio_call_sid) DO UPDATE SET caller_number = EXCLUDED.caller_number
     RETURNING *`,
    [params.restaurantId, params.twilioCallSid ?? null, params.callerNumber ?? ""],
  );
  return camelRow<CallRecord>(res.rows[0] as Record<string, unknown>);
}

export async function appendTranscript(
  db: Queryable,
  callId: string,
  turn: TranscriptTurn,
): Promise<void> {
  await db.query(`UPDATE calls SET transcript = transcript || $2::jsonb WHERE id = $1`, [
    callId,
    JSON.stringify([turn]),
  ]);
}

export async function recordCallEvent(
  db: Queryable,
  callId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.query(`INSERT INTO call_events (call_id, event_type, payload) VALUES ($1, $2, $3)`, [
    callId,
    eventType,
    JSON.stringify(payload),
  ]);
}

export async function endCall(
  db: Queryable,
  callId: string,
  params: { status?: "completed" | "failed"; outcome?: CallOutcome; orderId?: string | null },
): Promise<void> {
  await db.query(
    `UPDATE calls SET
       ended_at = now(),
       duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))::int,
       status = COALESCE($2, 'completed'),
       outcome = COALESCE($3, outcome),
       order_id = COALESCE($4, order_id)
     WHERE id = $1 AND ended_at IS NULL`,
    [callId, params.status ?? null, params.outcome ?? null, params.orderId ?? null],
  );
}

export async function linkCallOrder(db: Queryable, callId: string, orderId: string): Promise<void> {
  await db.query(`UPDATE calls SET order_id = $2 WHERE id = $1`, [callId, orderId]);
}

export async function listCalls(
  db: Queryable,
  restaurantId: string,
  limit = 50,
): Promise<CallRecord[]> {
  const res = await db.query(
    `SELECT * FROM calls WHERE restaurant_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [restaurantId, limit],
  );
  return camelRows<CallRecord>(res.rows);
}

export async function getCall(db: Queryable, callId: string): Promise<CallRecord | null> {
  const res = await db.query(`SELECT * FROM calls WHERE id = $1`, [callId]);
  return res.rows[0] ? camelRow<CallRecord>(res.rows[0]) : null;
}
