"use client";

import { useEffect, useState } from "react";

interface DayHours {
  dayOfWeek: number;
  opensAt: string | null;
  closesAt: string | null;
  isClosed: boolean;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function HoursPage() {
  const [hours, setHours] = useState<DayHours[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/hours", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { hours: DayHours[] };
        setHours(
          body.hours.map((h) => ({
            ...h,
            opensAt: h.opensAt?.slice(0, 5) ?? null,
            closesAt: h.closesAt?.slice(0, 5) ?? null,
          })),
        );
      }
    })();
  }, []);

  function update(day: number, patch: Partial<DayHours>) {
    setHours((prev) => prev.map((h) => (h.dayOfWeek === day ? { ...h, ...patch } : h)));
    setSaved(false);
  }

  return (
    <div className="max-w-xl">
      <h1 className="mb-2 text-2xl font-bold">Opening hours</h1>
      <p className="mb-6 text-sm text-stone-500">
        The AI checks these before taking any order. A closing time earlier than opening (e.g.
        5:00 pm → 1:00 am) means trading past midnight.
      </p>
      <div className="rounded-2xl bg-white p-5 shadow">
        {[1, 2, 3, 4, 5, 6, 0].map((day) => {
          const h = hours.find((x) => x.dayOfWeek === day);
          if (!h) return null;
          return (
            <div key={day} className="flex items-center gap-3 border-b py-3 last:border-b-0">
              <span className="w-24 font-semibold">{DAY_NAMES[day]}</span>
              <button
                onClick={() => update(day, { isClosed: !h.isClosed })}
                className={`rounded-lg px-3 py-1 text-sm font-bold ${
                  h.isClosed ? "bg-stone-200 text-stone-500" : "bg-green-100 text-green-800"
                }`}
              >
                {h.isClosed ? "Closed" : "Open"}
              </button>
              {!h.isClosed && (
                <>
                  <input
                    type="time"
                    value={h.opensAt ?? ""}
                    onChange={(e) => update(day, { opensAt: e.target.value })}
                    className="rounded-lg border border-stone-300 p-2"
                  />
                  <span>→</span>
                  <input
                    type="time"
                    value={h.closesAt ?? ""}
                    onChange={(e) => update(day, { closesAt: e.target.value })}
                    className="rounded-lg border border-stone-300 p-2"
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
      <button
        onClick={async () => {
          const res = await fetch("/api/hours", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hours }),
          });
          if (res.ok) setSaved(true);
          else alert(((await res.json()) as { error?: string }).error ?? "Save failed");
        }}
        className="mt-4 rounded-lg bg-orange-600 px-6 py-3 font-semibold text-white"
      >
        Save hours
      </button>
      {saved && <span className="ml-3 text-green-700">Saved ✓</span>}
    </div>
  );
}
