"use client";

import { useEffect, useState } from "react";
import type { CallRecord } from "@meatbox/core";

export default function CallsPage() {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/calls", { cache: "no-store" });
      if (res.ok) setCalls(((await res.json()) as { calls: CallRecord[] }).calls);
    })();
  }, []);

  return (
    <div className="max-w-3xl">
      <h1 className="mb-4 text-2xl font-bold">Call logs</h1>
      <p className="mb-4 text-sm text-stone-500">
        Audio is never recorded — transcripts only. SIM- calls are Test AI sessions.
      </p>
      <ul className="space-y-2">
        {calls.map((call) => (
          <li key={call.id} className="rounded-2xl bg-white p-4 shadow">
            <button
              className="flex w-full flex-wrap items-center gap-3 text-left"
              onClick={() => setOpen(open === call.id ? null : call.id)}
            >
              <span className="font-semibold">{call.callerNumber || "unknown"}</span>
              <span className="text-sm text-stone-500">
                {new Date(call.startedAt).toLocaleString("en-AU", { timeZone: "Australia/Perth" })}
              </span>
              {call.durationSeconds !== null && (
                <span className="text-sm text-stone-500">{call.durationSeconds}s</span>
              )}
              <span
                className={`ml-auto rounded-full px-2 py-0.5 text-xs font-bold ${
                  call.outcome === "ORDER_COMPLETED"
                    ? "bg-green-100 text-green-800"
                    : call.outcome === "REVIEW_LINK_SENT"
                      ? "bg-amber-100 text-amber-800"
                    : call.outcome === "NEEDS_REVIEW"
                      ? "bg-purple-100 text-purple-800"
                      : "bg-stone-200 text-stone-600"
                }`}
              >
                {call.outcome ?? call.status}
              </span>
            </button>
            {open === call.id && (
              <div className="mt-3 space-y-1 border-t pt-3 text-sm">
                {call.transcript.length === 0 && (
                  <p className="text-stone-400">No transcript captured.</p>
                )}
                {call.transcript.map((turn, i) => (
                  <p key={i}>
                    <span className="font-bold">
                      {turn.role === "caller" ? "Caller" : "AI"}:
                    </span>{" "}
                    {turn.text}
                  </p>
                ))}
              </div>
            )}
          </li>
        ))}
        {calls.length === 0 && <p className="text-stone-400">No calls yet.</p>}
      </ul>
    </div>
  );
}
