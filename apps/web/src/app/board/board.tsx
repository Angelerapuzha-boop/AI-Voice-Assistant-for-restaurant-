"use client";

import { useEffect, useState } from "react";

export default function Board() {
  const [ready, setReady] = useState<string[]>([]);
  const [preparing, setPreparing] = useState<string[]>([]);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/board", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const json = (await res.json()) as { ready: string[]; preparing: string[] };
        if (!alive) return;
        setReady(json.ready);
        setPreparing(json.preparing);
        setStale(false);
      } catch {
        if (alive) setStale(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <main className="flex min-h-screen flex-col bg-stone-950 p-8 text-white">
      <header className="flex items-center justify-between">
        <p className="text-4xl font-extrabold tracking-wide">🔥 MEATBOX</p>
        {stale && <p className="rounded bg-red-600 px-3 py-1 font-bold">RECONNECTING…</p>}
      </header>

      <div className="mt-8 grid flex-1 gap-8 md:grid-cols-2">
        <section>
          <h2 className="border-b-4 border-green-500 pb-2 text-3xl font-extrabold text-green-400">
            READY — COLLECT NOW
          </h2>
          <div className="mt-6 flex flex-wrap gap-4">
            {ready.length === 0 && <p className="text-2xl text-stone-600">—</p>}
            {ready.map((n) => (
              <p
                key={n}
                className="animate-pulse rounded-2xl bg-green-500 px-8 py-5 text-5xl font-extrabold text-stone-950"
              >
                {n}
              </p>
            ))}
          </div>
        </section>
        <section>
          <h2 className="border-b-4 border-amber-500 pb-2 text-3xl font-extrabold text-amber-400">
            PREPARING
          </h2>
          <div className="mt-6 flex flex-wrap gap-4">
            {preparing.length === 0 && <p className="text-2xl text-stone-600">—</p>}
            {preparing.map((n) => (
              <p key={n} className="rounded-2xl bg-stone-800 px-8 py-5 text-5xl font-extrabold">
                {n}
              </p>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
