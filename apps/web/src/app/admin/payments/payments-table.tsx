"use client";

import { useCallback, useEffect, useState } from "react";

interface RefundRow {
  id: string;
  amountCents: number;
  status: string;
  reason: string;
  createdBy: string;
}

interface PaymentRow {
  id: string;
  orderNumber: string | null;
  customerName: string;
  provider: string;
  method: string;
  amountCents: number;
  status: string;
  failureReason: string;
  authorisedBy: string;
  createdAt: string;
  settledAt: string | null;
  refunds: RefundRow[];
}

const STATUS_BADGE: Record<string, string> = {
  succeeded: "bg-green-100 text-green-800",
  pending: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-stone-200 text-stone-600",
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function PaymentsTable() {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/payments", { cache: "no-store" });
    if (res.ok) setPayments(((await res.json()) as { payments: PaymentRow[] }).payments);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function doRefund(payment: PaymentRow) {
    setError("");
    const cents = Math.round(Number(amount) * 100);
    const res = await fetch(`/api/payments/${payment.id}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: cents, reason }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(json.error ?? "Refund failed");
      return;
    }
    setRefunding(null);
    setAmount("");
    setReason("");
    void load();
  }

  return (
    <div className="mt-6 overflow-x-auto rounded-2xl bg-white shadow">
      <table className="w-full text-sm">
        <thead className="bg-stone-100 text-left text-xs uppercase text-stone-500">
          <tr>
            <th className="p-3">Order</th>
            <th className="p-3">When</th>
            <th className="p-3">Method</th>
            <th className="p-3">Amount</th>
            <th className="p-3">Status</th>
            <th className="p-3">By</th>
            <th className="p-3" />
          </tr>
        </thead>
        <tbody>
          {payments.length === 0 && (
            <tr>
              <td colSpan={7} className="p-6 text-center text-stone-400">
                No payments yet.
              </td>
            </tr>
          )}
          {payments.map((p) => {
            const refunded = p.refunds
              .filter((r) => r.status !== "failed")
              .reduce((s, r) => s + r.amountCents, 0);
            return (
              <tr key={p.id} className="border-t align-top">
                <td className="p-3 font-bold">{p.orderNumber ?? "—"}
                  <p className="text-xs font-normal text-stone-500">{p.customerName}</p>
                </td>
                <td className="p-3 text-stone-500">
                  {new Date(p.createdAt).toLocaleString("en-AU", {
                    timeZone: "Australia/Perth",
                    day: "2-digit",
                    month: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </td>
                <td className="p-3">
                  {p.method.toUpperCase()}
                  <p className="text-xs text-stone-400">{p.provider.replace("_", " ")}</p>
                </td>
                <td className="p-3 font-bold">
                  {money(p.amountCents)}
                  {refunded > 0 && (
                    <p className="text-xs font-semibold text-red-600">−{money(refunded)} refunded</p>
                  )}
                </td>
                <td className="p-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_BADGE[p.status] ?? ""}`}>
                    {p.status}
                  </span>
                  {p.failureReason && <p className="mt-1 text-xs text-red-600">{p.failureReason}</p>}
                </td>
                <td className="p-3 text-stone-500">{p.authorisedBy || "—"}</td>
                <td className="p-3">
                  {p.status === "succeeded" && refunded < p.amountCents && (
                    refunding === p.id ? (
                      <div className="w-52">
                        <input
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          placeholder={`$ up to ${money(p.amountCents - refunded)}`}
                          inputMode="decimal"
                          className="w-full rounded border p-2 text-sm"
                        />
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Reason (required)"
                          className="mt-1 w-full rounded border p-2 text-sm"
                        />
                        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
                        <div className="mt-1 flex gap-2">
                          <button
                            onClick={() => void doRefund(p)}
                            disabled={!amount || !reason}
                            className="rounded bg-red-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40"
                          >
                            Refund
                          </button>
                          <button
                            onClick={() => {
                              setRefunding(null);
                              setError("");
                            }}
                            className="px-2 text-xs text-stone-500"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setRefunding(p.id);
                          setAmount("");
                          setReason("");
                          setError("");
                        }}
                        className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50"
                      >
                        Refund…
                      </button>
                    )
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t p-3 text-xs text-stone-400">
        Refunds are owner-only and audited. Terminal refunds go back through the payment provider;
        cash refunds are recorded here for reconciliation.
      </p>
    </div>
  );
}
