"use client";

import { useCallback, useEffect, useState } from "react";

interface Special {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  startsAt: string;
  endsAt: string;
  active: boolean;
  quantityLimit: number | null;
  quantityUsed: number;
}

function localInput(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function SpecialsPage() {
  const [specials, setSpecials] = useState<Special[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [startsAt, setStartsAt] = useState(localInput(new Date()));
  const [endsAt, setEndsAt] = useState(
    localInput(new Date(Date.now() + 24 * 3600 * 1000)),
  );

  const load = useCallback(async () => {
    const res = await fetch("/api/specials", { cache: "no-store" });
    if (res.ok) setSpecials(((await res.json()) as { specials: Special[] }).specials);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();

  return (
    <div className="max-w-3xl">
      <h1 className="mb-2 text-2xl font-bold">Daily specials</h1>
      <p className="mb-6 text-sm text-stone-500">
        Active specials are offered by the AI, shown on the website, and orderable by phone. The
        AI never invents a special — only what&apos;s listed here.
      </p>

      <div className="mb-8 rounded-2xl bg-white p-5 shadow">
        <h2 className="mb-3 font-bold">Add a special</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name, e.g. Half Charcoal Chicken Meal"
            className="rounded-lg border border-stone-300 p-2"
          />
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Price, e.g. 19.95"
            className="rounded-lg border border-stone-300 p-2"
          />
          <label className="text-sm">
            From
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 p-2"
            />
          </label>
          <label className="text-sm">
            Until
            <input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 p-2"
            />
          </label>
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description the AI reads to callers"
          className="mt-3 w-full rounded-lg border border-stone-300 p-2"
          rows={2}
        />
        <button
          onClick={async () => {
            const cents = Math.round(Number.parseFloat(price) * 100);
            if (!name.trim() || Number.isNaN(cents)) {
              alert("Name and a valid price are required.");
              return;
            }
            const res = await fetch("/api/specials", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: name.trim(),
                description,
                priceCents: cents,
                startsAt: new Date(startsAt).toISOString(),
                endsAt: new Date(endsAt).toISOString(),
              }),
            });
            if (res.ok) {
              setName("");
              setPrice("");
              setDescription("");
              void load();
            } else {
              alert(((await res.json()) as { error?: string }).error ?? "Failed");
            }
          }}
          className="mt-3 rounded-lg bg-orange-600 px-5 py-2 font-semibold text-white"
        >
          Add special
        </button>
      </div>

      <ul className="space-y-3">
        {specials.map((s) => {
          const live =
            s.active && new Date(s.startsAt).getTime() <= now && new Date(s.endsAt).getTime() > now;
          return (
            <li key={s.id} className="rounded-2xl bg-white p-4 shadow">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex-1">
                  <p className="font-bold">
                    {s.name}{" "}
                    <span
                      className={`ml-1 rounded-full px-2 py-0.5 text-xs font-bold ${
                        live ? "bg-green-100 text-green-800" : "bg-stone-200 text-stone-600"
                      }`}
                    >
                      {live ? "LIVE NOW" : s.active ? "scheduled/ended" : "inactive"}
                    </span>
                  </p>
                  <p className="text-sm text-stone-500">
                    {new Date(s.startsAt).toLocaleString("en-AU")} →{" "}
                    {new Date(s.endsAt).toLocaleString("en-AU")}
                    {s.quantityLimit !== null && ` · ${s.quantityUsed}/${s.quantityLimit} used`}
                  </p>
                </div>
                <span className="text-lg font-extrabold">${(s.priceCents / 100).toFixed(2)}</span>
                <button
                  onClick={async () => {
                    await fetch(`/api/specials/${s.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ active: !s.active }),
                    });
                    void load();
                  }}
                  className={`rounded-lg px-3 py-2 text-sm font-bold ${
                    s.active ? "bg-stone-200" : "bg-green-600 text-white"
                  }`}
                >
                  {s.active ? "Deactivate" : "Activate"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
