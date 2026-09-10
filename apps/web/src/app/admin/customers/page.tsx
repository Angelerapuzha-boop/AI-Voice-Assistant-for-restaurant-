"use client";

import { useCallback, useEffect, useState } from "react";

interface CustomerRow {
  id: string;
  phone_e164: string;
  display_name: string;
  history_enabled: boolean;
  last_order_at: string | null;
  order_count: number;
  total_spent_cents: number;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}`, { cache: "no-store" });
    if (res.ok) setCustomers(((await res.json()) as { customers: CustomerRow[] }).customers);
  }, [q]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-3xl">
      <h1 className="mb-2 text-2xl font-bold">Customers</h1>
      <p className="mb-4 text-sm text-stone-500">
        Recognised by caller ID. &quot;Repeat history&quot; controls whether the AI can offer
        &quot;same as last time&quot; for that number.
      </p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search name or phone"
        className="mb-4 rounded-lg border border-stone-300 p-2"
      />
      <div className="overflow-x-auto rounded-2xl bg-white shadow">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-left">
            <tr>
              <th className="p-3">Customer</th>
              <th className="p-3">Orders</th>
              <th className="p-3">Spent</th>
              <th className="p-3">Last order</th>
              <th className="p-3">Repeat history</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="p-3">
                  <p className="font-semibold">{c.display_name || "—"}</p>
                  <p className="text-xs text-stone-400">{c.phone_e164}</p>
                </td>
                <td className="p-3">{c.order_count}</td>
                <td className="p-3 font-semibold">${(Number(c.total_spent_cents) / 100).toFixed(2)}</td>
                <td className="p-3 text-stone-500">
                  {c.last_order_at
                    ? new Date(c.last_order_at).toLocaleDateString("en-AU")
                    : "—"}
                </td>
                <td className="p-3">
                  <button
                    onClick={async () => {
                      await fetch("/api/customers", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ customerId: c.id, historyEnabled: !c.history_enabled }),
                      });
                      void load();
                    }}
                    className={`rounded-lg px-3 py-1 text-xs font-bold ${
                      c.history_enabled ? "bg-green-100 text-green-800" : "bg-stone-200 text-stone-500"
                    }`}
                  >
                    {c.history_enabled ? "Enabled" : "Off"}
                  </button>
                </td>
              </tr>
            ))}
            {customers.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-stone-400">
                  No customers yet — they appear after their first confirmed phone order.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
