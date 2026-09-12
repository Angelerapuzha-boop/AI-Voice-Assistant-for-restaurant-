"use client";
import { useState } from "react";

export default function SupplyActions({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "confirmed" | "declined" | "error">("idle");

  async function respond(action: "confirmed" | "declined") {
    setState("busy");
    const res = await fetch("/api/supply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, action }),
    });
    setState(res.ok ? action : "error");
  }

  if (state === "confirmed")
    return <p className="rounded-xl bg-emerald-50 p-3 text-center font-bold text-emerald-700">✅ Confirmed — thank you!</p>;
  if (state === "declined")
    return <p className="rounded-xl bg-stone-100 p-3 text-center font-bold text-stone-500">Declined — the restaurant has been notified.</p>;
  if (state === "error")
    return <p className="rounded-xl bg-red-50 p-3 text-center font-bold text-red-600">Something went wrong — this order may already be answered.</p>;

  return (
    <div className="flex gap-3">
      <button
        disabled={state === "busy"}
        onClick={() => void respond("confirmed")}
        className="flex-1 rounded-2xl bg-emerald-600 py-3 text-lg font-extrabold text-white disabled:opacity-40"
      >
        ✅ Confirm order
      </button>
      <button
        disabled={state === "busy"}
        onClick={() => void respond("declined")}
        className="rounded-2xl bg-stone-200 px-5 py-3 font-bold text-stone-600 disabled:opacity-40"
      >
        Decline
      </button>
    </div>
  );
}
