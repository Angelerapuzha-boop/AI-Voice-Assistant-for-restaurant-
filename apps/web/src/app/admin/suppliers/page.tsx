"use client";
import { useCallback, useEffect, useState } from "react";

interface SupplierItem {
  id: string;
  name: string;
  autoReplenish: boolean;
}
interface Supplier {
  id: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  notes: string;
  smsEnabled: boolean;
  callEnabled: boolean;
  items: SupplierItem[];
}
interface Replenishment {
  id: string;
  supplierName: string;
  itemName: string;
  qty: number;
  unit: string;
  status: "requested" | "confirmed" | "declined" | "received" | "cancelled";
  requestedAt: string;
}

const STATUS_STYLE: Record<Replenishment["status"], string> = {
  requested: "bg-sky-100 text-sky-700",
  confirmed: "bg-emerald-100 text-emerald-700",
  declined: "bg-red-100 text-red-700",
  received: "bg-emerald-600 text-white",
  cancelled: "bg-stone-200 text-stone-500",
};

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [repl, setRepl] = useState<Replenishment[]>([]);
  const [editing, setEditing] = useState<Partial<Supplier> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/suppliers");
      if (res.ok) {
        const d = (await res.json()) as { suppliers: Supplier[]; replenishments: Replenishment[] };
        setSuppliers(d.suppliers);
        setRepl(d.replenishments);
      }
    } catch {
      /* poll retries */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function save(form: FormData) {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: String(form.get("name") ?? ""),
        contactName: String(form.get("contactName") ?? ""),
        phone: String(form.get("phone") ?? ""),
        email: String(form.get("email") ?? ""),
        notes: String(form.get("notes") ?? ""),
        smsEnabled: form.get("smsEnabled") === "on",
        callEnabled: form.get("callEnabled") === "on",
      };
      if (editing?.id) body.id = editing.id;
      await fetch("/api/suppliers", {
        method: editing?.id ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setEditing(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function replAction(id: string, action: "received" | "cancel") {
    await fetch("/api/suppliers/replenishments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    await load();
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">🚚 Suppliers</h1>
        <button
          onClick={() => setEditing({})}
          className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white"
        >
          + Add supplier
        </button>
      </div>
      <p className="mb-6 text-sm text-stone-500">
        Assign a supplier to stock items in 📦 Inventory (Edit → supplier + auto-replenish). When stock runs low,
        the supplier automatically gets an SMS order with a confirm link — and an automated call if enabled.
      </p>

      <div className="mb-8 grid gap-4 md:grid-cols-2">
        {suppliers.map((s) => (
          <div key={s.id} className="rounded-2xl bg-white p-4 shadow">
            <div className="mb-1 flex items-start justify-between">
              <p className="text-lg font-extrabold">{s.name}</p>
              <button onClick={() => setEditing(s)} className="rounded-lg bg-stone-100 px-3 py-1 text-xs font-bold">
                Edit
              </button>
            </div>
            <p className="text-sm text-stone-500">
              {s.contactName && `${s.contactName} · `}
              {s.phone || "no phone"} {s.email && `· ${s.email}`}
            </p>
            <p className="mt-1 text-xs text-stone-400">
              {s.smsEnabled ? "📩 SMS orders on" : "SMS off"} · {s.callEnabled ? "📞 auto-call on" : "auto-call off"}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {s.items.map((i) => (
                <span key={i.id} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${i.autoReplenish ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-500"}`}>
                  {i.name}
                  {i.autoReplenish ? " ⚡" : ""}
                </span>
              ))}
              {s.items.length === 0 && <span className="text-xs text-stone-400">No items assigned yet.</span>}
            </div>
          </div>
        ))}
        {suppliers.length === 0 && (
          <p className="text-stone-400">No suppliers yet — add your meat, produce and packaging suppliers.</p>
        )}
      </div>

      <h2 className="mb-2 font-bold">Replenishment orders</h2>
      <div className="overflow-x-auto rounded-2xl bg-white shadow">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-left">
            <tr>
              <th className="p-3">When</th>
              <th className="p-3">Item</th>
              <th className="p-3">Supplier</th>
              <th className="p-3 text-right">Qty</th>
              <th className="p-3">Status</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {repl.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-3 text-stone-500">{new Date(r.requestedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</td>
                <td className="p-3 font-medium">{r.itemName}</td>
                <td className="p-3">{r.supplierName}</td>
                <td className="p-3 text-right">
                  {r.qty} {r.unit}
                </td>
                <td className="p-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_STYLE[r.status]}`}>{r.status.toUpperCase()}</span>
                </td>
                <td className="p-3 text-right">
                  {(r.status === "requested" || r.status === "confirmed") && (
                    <>
                      <button onClick={() => void replAction(r.id, "received")} className="mr-2 rounded-lg bg-emerald-600 px-3 py-1 text-xs font-bold text-white">
                        Received ✓
                      </button>
                      <button onClick={() => void replAction(r.id, "cancel")} className="rounded-lg bg-stone-200 px-3 py-1 text-xs font-bold text-stone-600">
                        Cancel
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {repl.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-stone-400">
                  No replenishment orders yet — they appear automatically when auto-replenish items run low.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing !== null && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setEditing(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 font-bold">{editing.id ? `Edit ${editing.name}` : "Add supplier"}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save(new FormData(e.currentTarget));
              }}
              className="space-y-3 text-sm"
            >
              <label className="block">
                Business name
                <input name="name" required defaultValue={editing.name ?? ""} className="mt-1 w-full rounded-lg border p-2" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  Contact person
                  <input name="contactName" defaultValue={editing.contactName ?? ""} className="mt-1 w-full rounded-lg border p-2" />
                </label>
                <label className="block">
                  Phone (E.164)
                  <input name="phone" placeholder="+614..." defaultValue={editing.phone ?? ""} className="mt-1 w-full rounded-lg border p-2" />
                </label>
              </div>
              <label className="block">
                Email
                <input name="email" type="email" defaultValue={editing.email ?? ""} className="mt-1 w-full rounded-lg border p-2" />
              </label>
              <label className="block">
                Notes
                <input name="notes" defaultValue={editing.notes ?? ""} className="mt-1 w-full rounded-lg border p-2" />
              </label>
              <div className="flex gap-6">
                <label className="flex items-center gap-2">
                  <input name="smsEnabled" type="checkbox" defaultChecked={editing.smsEnabled ?? true} /> SMS orders
                </label>
                <label className="flex items-center gap-2">
                  <input name="callEnabled" type="checkbox" defaultChecked={editing.callEnabled ?? false} /> Automated call
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-3 py-1.5 text-stone-500">
                  Cancel
                </button>
                <button type="submit" disabled={busy} className="rounded-lg bg-stone-900 px-4 py-1.5 font-bold text-white disabled:opacity-40">
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
