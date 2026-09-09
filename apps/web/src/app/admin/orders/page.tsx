"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Order } from "@meatbox/core";

const FILTERS = [
  { key: "", label: "All" },
  { key: "today", label: "Today" },
  { key: "new", label: "New" },
  { key: "preparing", label: "Preparing" },
  { key: "ready", label: "Ready" },
  { key: "completed", label: "Completed" },
  { key: "needs_review", label: "Needs review" },
  { key: "takeaway", label: "Takeaway" },
  { key: "dine_in", label: "Dine-in" },
];

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("today");

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (filter === "today") params.set("today", "1");
    else if (filter === "takeaway" || filter === "dine_in") params.set("type", filter);
    else if (filter) params.set("status", filter);
    const res = await fetch(`/api/orders?${params}`, { cache: "no-store" });
    if (res.ok) setOrders(((await res.json()) as { orders: Order[] }).orders);
  }, [q, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-4xl">
      <h1 className="mb-4 text-2xl font-bold">Orders</h1>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load();
          }}
          placeholder="Search order #, name or phone"
          className="rounded-lg border border-stone-300 p-2"
        />
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-sm font-semibold ${
              filter === f.key ? "bg-stone-900 text-white" : "bg-white shadow"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-2xl bg-white shadow">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-left">
            <tr>
              <th className="p-3">Order</th>
              <th className="p-3">Type</th>
              <th className="p-3">Customer</th>
              <th className="p-3">Status</th>
              <th className="p-3">Total</th>
              <th className="p-3">Placed</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t hover:bg-orange-50">
                <td className="p-3 font-bold">
                  <Link href={`/admin/orders/${o.id}`} className="text-orange-700">
                    {o.publicOrderNumber ?? "(draft)"}
                  </Link>
                  {o.ownerSmsAlert && <span className="ml-2 text-red-600">⚠ SMS</span>}
                </td>
                <td className="p-3">{o.orderType === "takeaway" ? "Takeaway" : "Dine-in"}</td>
                <td className="p-3">
                  {o.customerName || "—"}
                  <span className="block text-xs text-stone-400">{o.customerPhone}</span>
                </td>
                <td className="p-3 uppercase">{o.status.replace("_", " ")}</td>
                <td className="p-3 font-semibold">${(o.totalCents / 100).toFixed(2)}</td>
                <td className="p-3 text-stone-500">
                  {new Date(o.createdAt).toLocaleString("en-AU", {
                    timeZone: "Australia/Perth",
                    day: "2-digit",
                    month: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-stone-400">
                  No orders match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
