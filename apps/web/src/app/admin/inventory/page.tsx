"use client";
import { useCallback, useEffect, useState } from "react";

interface Item {
  id: string;
  name: string;
  unit: string;
  currentQty: number;
  reorderLevel: number;
  parLevel: number;
  status: "ok" | "low" | "out";
}

const STATUS_STYLE: Record<Item["status"], string> = {
  ok: "bg-emerald-100 text-emerald-700",
  low: "bg-amber-100 text-amber-700",
  out: "bg-red-100 text-red-700",
};
const STATUS_LABEL: Record<Item["status"], string> = { ok: "OK", low: "LOW", out: "OUT" };

export default function InventoryPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/inventory");
      if (res.ok) setItems(((await res.json()) as { items: Item[] }).items);
    } catch {
      /* transient — next poll retries */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function action(body: Record<string, unknown>, itemId: string) {
    setBusy(itemId);
    setError("");
    try {
      const res = await fetch("/api/inventory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? "failed");
      await load();
    } finally {
      setBusy(null);
    }
  }

  const low = items.filter((i) => i.status !== "ok");

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">📦 Inventory</h1>
        <span className="text-xs text-stone-400">
          Stock depletes automatically with every confirmed order · refreshes live
        </span>
      </div>

      {low.length > 0 && (
        <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <p className="mb-1 font-bold text-amber-800">
            ⚠ {low.length} item{low.length > 1 ? "s" : ""} need attention
          </p>
          <p className="text-sm text-amber-700">
            {low.map((i) => `${i.name} (${i.currentQty <= 0 ? "OUT" : `${i.currentQty} ${i.unit} left`})`).join(" · ")}
          </p>
        </div>
      )}
      {error && <p className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="overflow-x-auto rounded-2xl bg-white shadow">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-left">
            <tr>
              <th className="p-3">Item</th>
              <th className="p-3 text-right">On hand</th>
              <th className="p-3 text-right">Reorder at</th>
              <th className="p-3 text-right">Restock to</th>
              <th className="p-3">Status</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t">
                <td className="p-3 font-medium">{item.name}</td>
                <td className={`p-3 text-right font-bold ${item.status === "out" ? "text-red-600" : item.status === "low" ? "text-amber-600" : ""}`}>
                  {item.currentQty} <span className="font-normal text-stone-400">{item.unit}</span>
                </td>
                <td className="p-3 text-right text-stone-500">{item.reorderLevel}</td>
                <td className="p-3 text-right text-stone-500">{item.parLevel}</td>
                <td className="p-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_STYLE[item.status]}`}>
                    {STATUS_LABEL[item.status]}
                  </span>
                </td>
                <td className="p-3 text-right">
                  <button
                    disabled={busy === item.id || item.currentQty >= item.parLevel}
                    onClick={() => void action({ action: "restock", itemId: item.id }, item.id)}
                    className="mr-2 rounded-lg bg-emerald-600 px-3 py-1 text-xs font-bold text-white disabled:opacity-30"
                  >
                    {busy === item.id ? "…" : "Restock"}
                  </button>
                  <button
                    onClick={() => setEditing(item)}
                    className="rounded-lg bg-stone-200 px-3 py-1 text-xs font-bold text-stone-700"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-stone-400">
                  Loading stock…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setEditing(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 font-bold">{editing.name}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void action(
                  {
                    action: "adjust",
                    itemId: editing.id,
                    newQty: Number(f.get("qty")),
                    reorderLevel: Number(f.get("reorder")),
                    parLevel: Number(f.get("par")),
                    note: "manual stocktake",
                  },
                  editing.id,
                );
                setEditing(null);
              }}
              className="space-y-3 text-sm"
            >
              <label className="block">
                Counted stock ({editing.unit})
                <input name="qty" type="number" step="0.5" min="0" defaultValue={editing.currentQty} className="mt-1 w-full rounded-lg border p-2" />
              </label>
              <label className="block">
                Alert when at or below
                <input name="reorder" type="number" step="1" min="0" defaultValue={editing.reorderLevel} className="mt-1 w-full rounded-lg border p-2" />
              </label>
              <label className="block">
                Restock target
                <input name="par" type="number" step="1" min="0" defaultValue={editing.parLevel} className="mt-1 w-full rounded-lg border p-2" />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-3 py-1.5 text-stone-500">
                  Cancel
                </button>
                <button type="submit" className="rounded-lg bg-stone-900 px-4 py-1.5 font-bold text-white">
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
