"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Order, OrderWithItems } from "@meatbox/core";

type FullOrder = OrderWithItems;

const NEXT_ACTION: Record<string, { label: string; status: string; color: string } | undefined> = {
  new: { label: "ACCEPT", status: "accepted", color: "bg-green-600 hover:bg-green-700" },
  accepted: { label: "START PREPARING", status: "preparing", color: "bg-amber-600 hover:bg-amber-700" },
  preparing: { label: "READY", status: "ready", color: "bg-blue-600 hover:bg-blue-700" },
  ready: { label: "COMPLETE", status: "completed", color: "bg-stone-700 hover:bg-stone-800" },
};

const STATUS_BADGE: Record<string, string> = {
  new: "bg-red-600 text-white animate-pulse",
  accepted: "bg-green-100 text-green-800",
  preparing: "bg-amber-100 text-amber-800",
  ready: "bg-blue-100 text-blue-800",
  needs_review: "bg-purple-600 text-white",
};

function ageMinutes(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

function pickupLabel(order: Order): string {
  if (order.requestedAsap || !order.requestedTime) return "ASAP";
  return new Date(order.requestedTime).toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Australia/Perth",
  });
}

export default function KitchenBoard() {
  const [orders, setOrders] = useState<FullOrder[]>([]);
  const [soundOn, setSoundOn] = useState(false);
  const [connected, setConnected] = useState(false);
  const knownIds = useRef<Set<string>>(new Set());
  const soundOnRef = useRef(false);
  const audioCtx = useRef<AudioContext | null>(null);
  const [, forceTick] = useState(0);

  const beep = useCallback(() => {
    if (!soundOnRef.current) return;
    try {
      audioCtx.current ??= new AudioContext();
      const ctx = audioCtx.current;
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.4, ctx.currentTime + i * 0.35);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.35 + 0.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.35);
        osc.stop(ctx.currentTime + i * 0.35 + 0.3);
      }
    } catch {
      // audio unavailable
    }
  }, []);

  const refetch = useCallback(async () => {
    const res = await fetch("/api/orders?status=active&include=items", { cache: "no-store" });
    if (!res.ok) return;
    const list = ((await res.json()) as { orders: FullOrder[] }).orders;
    const fresh = list.filter((o) => o.status === "new" && !knownIds.current.has(o.id));
    if (knownIds.current.size > 0 && fresh.length > 0) beep();
    for (const o of list) knownIds.current.add(o.id);
    setOrders(list);
  }, [beep]);

  useEffect(() => {
    void refetch();
    const es = new EventSource("/api/orders/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    // Debounce bursts (a confirm fires several DB events in a row).
    let pending: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => void refetch(), 300);
    };
    // Safety net: even if SSE silently dies (proxy idle timeouts, tablet
    // sleep), an order is never more than a few seconds late.
    const poll = setInterval(() => void refetch(), 7000);
    const tick = setInterval(() => forceTick((n) => n + 1), 15000);
    const onWake = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onWake);
    return () => {
      es.close();
      if (pending) clearTimeout(pending);
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [refetch]);

  async function setStatus(orderId: string, status: string) {
    await fetch(`/api/orders/${orderId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    void refetch();
  }

  const active = orders.filter((o) => o.status !== "needs_review");
  const review = orders.filter((o) => o.status === "needs_review");

  return (
    <main className="min-h-screen bg-stone-900 p-3 text-white">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-xl font-extrabold tracking-wide">
          MEATBOX KITCHEN
          <span
            className={`ml-3 inline-block h-3 w-3 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
            title={connected ? "Live" : "Reconnecting…"}
          />
        </h1>
        <div className="flex gap-2">
          <button
            onClick={() => {
              const next = !soundOnRef.current;
              soundOnRef.current = next;
              setSoundOn(next);
              if (next) beep();
            }}
            className={`rounded-lg px-4 py-3 text-sm font-bold ${soundOn ? "bg-green-600" : "bg-stone-700"}`}
          >
            {soundOn ? "🔔 Sound on" : "🔕 Sound off"}
          </button>
          <a href="/admin" className="rounded-lg bg-stone-700 px-4 py-3 text-sm font-bold">
            Admin
          </a>
        </div>
      </div>

      {orders.length === 0 && (
        <p className="mt-16 text-center text-2xl text-stone-500">No active orders</p>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[...active, ...review].map((order) => {
          const action = NEXT_ACTION[order.status];
          const mins = order.confirmedAt ? ageMinutes(String(order.confirmedAt)) : 0;
          return (
            <div
              key={order.id}
              className={`rounded-2xl bg-white p-4 text-stone-900 shadow-lg ${order.status === "new" ? "ring-4 ring-red-500" : ""}`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-2xl font-extrabold">{order.publicOrderNumber ?? "—"}</p>
                  <p className="text-sm font-bold uppercase tracking-wide text-stone-500">
                    {order.orderType === "takeaway" ? "🥡 Takeaway" : "🍽 Dine-in"} ·{" "}
                    {order.customerName || "No name"} ·{" "}
                    {order.source === "pos" ? "🧾 Counter" : "📞 Phone"}
                    {order.paymentMethod && (
                      <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800">
                        PAID {order.paymentMethod.toUpperCase()}
                      </span>
                    )}
                  </p>
                </div>
                <div className="text-right">
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-bold uppercase ${STATUS_BADGE[order.status] ?? "bg-stone-200"}`}
                  >
                    {order.status.replace("_", " ")}
                  </span>
                  <p className="mt-1 text-xs text-stone-500">
                    {mins} min ago · pickup {pickupLabel(order)}
                  </p>
                </div>
              </div>

              {order.ownerSmsAlert && (
                <p className="mt-2 rounded bg-red-100 px-2 py-1 text-xs font-bold text-red-700">
                  ⚠ OWNER SMS FAILED — order is only visible here
                </p>
              )}
              {order.allergyNotes && (
                <p className="mt-2 rounded bg-purple-100 px-2 py-1 text-sm font-bold text-purple-800">
                  ⚠ ALLERGY: {order.allergyNotes}
                </p>
              )}

              <ul className="mt-3 space-y-2 border-t pt-3">
                {order.items.map((item) => (
                  <li key={item.id}>
                    <p className="text-lg font-bold">
                      {item.quantity} × {item.nameSnapshot}
                    </p>
                    {item.modifiers.length > 0 && (
                      <p className="pl-5 text-sm text-stone-600">
                        {item.modifiers.map((m) => m.nameSnapshot).join(" · ")}
                      </p>
                    )}
                    {item.removals.length > 0 && (
                      <p className="pl-5 text-sm font-semibold text-red-600">
                        NO {item.removals.join(", NO ")}
                      </p>
                    )}
                    {item.specialInstructions && (
                      <p className="pl-5 text-sm italic text-stone-600">
                        “{item.specialInstructions}”
                      </p>
                    )}
                  </li>
                ))}
              </ul>

              {order.customerNotes && (
                <p className="mt-2 text-sm italic text-stone-600">Note: {order.customerNotes}</p>
              )}

              <div className="mt-3 flex items-center justify-between border-t pt-3">
                <p className="text-xl font-extrabold">
                  ${(order.totalCents / 100).toFixed(2)}
                </p>
                <div className="flex gap-2">
                  {order.status !== "new" && order.status !== "needs_review" && (
                    <button
                      onClick={() => setStatus(order.id, "cancelled")}
                      className="rounded-lg px-3 py-3 text-sm text-stone-400 hover:text-red-600"
                    >
                      Cancel
                    </button>
                  )}
                  {order.status === "needs_review" && (
                    <>
                      <button
                        onClick={() => setStatus(order.id, "new")}
                        className="rounded-lg bg-purple-600 px-4 py-3 font-bold text-white"
                      >
                        ACCEPT ANYWAY
                      </button>
                      <button
                        onClick={() => setStatus(order.id, "cancelled")}
                        className="rounded-lg bg-stone-300 px-4 py-3 font-bold"
                      >
                        DISMISS
                      </button>
                    </>
                  )}
                  {action && (
                    <button
                      onClick={() => setStatus(order.id, action.status)}
                      className={`rounded-lg px-5 py-3 text-lg font-extrabold text-white ${action.color}`}
                    >
                      {action.label}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
