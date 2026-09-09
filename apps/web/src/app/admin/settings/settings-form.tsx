"use client";

import { useEffect, useState } from "react";

export interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "textarea" | "select";
  options?: { value: string; label: string }[];
  hint?: string;
  source: "restaurant" | "settings";
}

export default function SettingsForm({ fields, title, intro }: { fields: FieldDef[]; title: string; intro?: string }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as {
        restaurant: Record<string, unknown>;
        settings: Record<string, unknown>;
      };
      const initial: Record<string, unknown> = {};
      for (const f of fields) {
        initial[f.key] = (f.source === "restaurant" ? body.restaurant : body.settings)[f.key];
      }
      setValues(initial);
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!loaded) return <p>Loading…</p>;

  return (
    <div className="max-w-2xl">
      <h1 className="mb-2 text-2xl font-bold">{title}</h1>
      {intro && <p className="mb-6 text-sm text-stone-500">{intro}</p>}
      <div className="space-y-4 rounded-2xl bg-white p-6 shadow">
        {fields.map((f) => (
          <div key={f.key}>
            <label className="block text-sm font-medium">{f.label}</label>
            {f.hint && <p className="text-xs text-stone-400">{f.hint}</p>}
            {f.type === "boolean" ? (
              <button
                onClick={() => {
                  setValues((v) => ({ ...v, [f.key]: !v[f.key] }));
                  setSaved(false);
                }}
                className={`mt-1 rounded-lg px-4 py-2 font-bold ${
                  values[f.key] ? "bg-green-600 text-white" : "bg-stone-200 text-stone-600"
                }`}
              >
                {values[f.key] ? "Enabled" : "Disabled"}
              </button>
            ) : f.type === "textarea" ? (
              <textarea
                value={String(values[f.key] ?? "")}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [f.key]: e.target.value }));
                  setSaved(false);
                }}
                rows={3}
                className="mt-1 w-full rounded-lg border border-stone-300 p-2"
              />
            ) : f.type === "select" ? (
              <select
                value={String(values[f.key] ?? "")}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [f.key]: e.target.value }));
                  setSaved(false);
                }}
                className="mt-1 w-full rounded-lg border border-stone-300 p-2"
              >
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.type}
                value={String(values[f.key] ?? "")}
                onChange={(e) => {
                  setValues((v) => ({
                    ...v,
                    [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value,
                  }));
                  setSaved(false);
                }}
                className="mt-1 w-full rounded-lg border border-stone-300 p-2"
              />
            )}
          </div>
        ))}
      </div>
      <button
        onClick={async () => {
          setError("");
          const res = await fetch("/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(values),
          });
          if (res.ok) setSaved(true);
          else setError(((await res.json()) as { error?: string }).error ?? "Save failed");
        }}
        className="mt-4 rounded-lg bg-orange-600 px-6 py-3 font-semibold text-white"
      >
        Save
      </button>
      {saved && <span className="ml-3 text-green-700">Saved ✓ — applies to the next call</span>}
      {error && <span className="ml-3 text-red-600">{error}</span>}
    </div>
  );
}
