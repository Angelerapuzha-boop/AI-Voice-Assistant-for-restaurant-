"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { OrderWithItems } from "@meatbox/core";

interface Notification {
  id: string;
  kind: string;
  toNumber: string;
  status: string;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  body: string;
}

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const [order, setOrder] = useState<OrderWithItems | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/orders/${params.id}`, { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as { order: OrderWithItems; notifications: Notification[] };
      setOrder(body.order);
      setNotifications(body.notifications);
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!order) return <p>Loading…</p>;

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold">
        {order.publicOrderNumber ?? "Draft order"}{" "}
        <span className="text-base font-normal uppercase text-stone-500">
          · {order.status.replace("_", " ")}
        </span>
      </h1>
      <p className="mb-6 text-sm text-stone-500">
        {order.orderType === "takeaway" ? "Takeaway" : "Dine-in"} · {order.customerName || "no name"} ·{" "}
        {order.customerPhone || "no phone"} · pickup{" "}
        {order.requestedAsap || !order.requestedTime
          ? "ASAP"
          : new Date(order.requestedTime).toLocaleString("en-AU", { timeZone: "Australia/Perth" })}
      </p>

      {order.allergyNotes && (
        <p className="mb-4 rounded-xl bg-purple-100 p-3 font-bold text-purple-800">
          ⚠ ALLERGY: {order.allergyNotes}
        </p>
      )}

      <div className="rounded-2xl bg-white p-5 shadow">
        <ul className="space-y-3">
          {order.items.map((item) => (
            <li key={item.id} className="border-b pb-2 last:border-b-0">
              <p className="font-bold">
                {item.quantity} × {item.nameSnapshot}
                <span className="float-right">${(item.lineTotalCents / 100).toFixed(2)}</span>
              </p>
              {item.modifiers.length > 0 && (
                <p className="text-sm text-stone-600">
                  {item.modifiers.map((m) => m.nameSnapshot).join(" · ")}
                </p>
              )}
              {item.removals.length > 0 && (
                <p className="text-sm font-semibold text-red-600">NO {item.removals.join(", NO ")}</p>
              )}
              {item.specialInstructions && (
                <p className="text-sm italic">“{item.specialInstructions}”</p>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-right text-xl font-extrabold">
          Total ${(order.totalCents / 100).toFixed(2)}
        </p>
      </div>

      {order.customerNotes && <p className="mt-4 text-sm">Notes: {order.customerNotes}</p>}
      {order.internalNotes && (
        <p className="mt-2 whitespace-pre-wrap rounded-lg bg-stone-200 p-3 text-sm">
          {order.internalNotes}
        </p>
      )}

      <h2 className="mb-2 mt-8 font-bold">Notifications</h2>
      {order.ownerSmsAlert && (
        <p className="mb-2 rounded-lg bg-red-50 p-3 text-sm font-semibold text-red-700">
          The owner SMS for this order could not be delivered.
        </p>
      )}
      <div className="rounded-2xl bg-white p-4 shadow">
        {notifications.length === 0 && (
          <p className="text-sm text-stone-400">No notifications for this order.</p>
        )}
        <ul className="space-y-2 text-sm">
          {notifications.map((n) => (
            <li key={n.id} className="flex items-center gap-2 border-b pb-2 last:border-b-0">
              <span className="font-semibold">{n.kind.replace("_", " ")}</span>
              <span>→ {n.toNumber}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                  n.status === "sent"
                    ? "bg-green-100 text-green-800"
                    : n.status === "pending"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-red-100 text-red-700"
                }`}
              >
                {n.status} ({n.attempts} attempts)
              </span>
              {n.lastError && <span className="text-xs text-red-600">{n.lastError}</span>}
            </li>
          ))}
        </ul>
        {order.publicOrderNumber && (
          <button
            onClick={async () => {
              const res = await fetch(`/api/orders/${order.id}/resend-sms`, { method: "POST" });
              if (res.ok) void load();
              else alert("Resend failed");
            }}
            className="mt-3 rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white"
          >
            Resend owner SMS
          </button>
        )}
      </div>
    </div>
  );
}
