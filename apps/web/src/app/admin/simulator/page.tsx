"use client";

import { useRef, useState } from "react";

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}

interface Turn {
  role: "caller" | "assistant";
  text: string;
  toolCalls?: ToolCall[];
}

interface OrderLine {
  id: string;
  nameSnapshot: string;
  quantity: number;
  lineTotalCents: number;
  removals: string[];
  specialInstructions: string;
  modifiers: { nameSnapshot: string }[];
}

interface SimOrder {
  status: string;
  orderType: string;
  customerName: string;
  totalCents: number;
  publicOrderNumber: string | null;
  items: OrderLine[];
}

export default function SimulatorPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [order, setOrder] = useState<SimOrder | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  async function start() {
    setError("");
    setTurns([]);
    setOrder(null);
    setEnded(false);
    setBusy(true);
    const res = await fetch("/api/simulator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "session" }),
    });
    setBusy(false);
    const body = (await res.json()) as { sessionId?: string; greeting?: string; error?: string };
    if (!res.ok || !body.sessionId) {
      setError(body.error ?? "Could not start a session.");
      return;
    }
    setSessionId(body.sessionId);
    setTurns([{ role: "assistant", text: body.greeting ?? "Hi, thanks for calling Meatbox." }]);
  }

  async function send() {
    if (!sessionId || !input.trim() || busy) return;
    const text = input.trim();
    setInput("");
    setTurns((t) => [...t, { role: "caller", text }]);
    setBusy(true);
    const res = await fetch("/api/simulator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "message", sessionId, text }),
    });
    setBusy(false);
    const body = (await res.json()) as {
      reply?: string;
      toolCalls?: ToolCall[];
      order?: SimOrder | null;
      endCall?: boolean;
      error?: string;
    };
    if (!res.ok) {
      setError(body.error ?? "Turn failed.");
      return;
    }
    setTurns((t) => [
      ...t,
      { role: "assistant", text: body.reply ?? "", toolCalls: body.toolCalls },
    ]);
    if (body.order !== undefined) setOrder(body.order ?? null);
    if (body.endCall) {
      setEnded(true);
      setSessionId(null);
    }
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  return (
    <div className="flex max-w-5xl flex-col gap-4 lg:flex-row">
      <div className="flex-1">
        <h1 className="mb-2 text-2xl font-bold">Test AI</h1>
        <p className="mb-4 text-sm text-stone-500">
          Type what a caller would say — same brain, tools and database as the real phone line.
          Confirmed test orders appear on the kitchen dashboard (cancel them there afterwards).
        </p>

        {!sessionId && (
          <button
            onClick={start}
            disabled={busy}
            className="rounded-lg bg-orange-600 px-6 py-3 font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Starting…" : ended ? "Start a new test call" : "📞 Start test call"}
          </button>
        )}
        {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

        <div className="mt-4 space-y-3">
          {turns.map((turn, i) => (
            <div key={i}>
              <div
                className={`max-w-[85%] rounded-2xl p-3 ${
                  turn.role === "caller"
                    ? "ml-auto bg-orange-100"
                    : "bg-white shadow"
                }`}
              >
                <p className="text-xs font-bold uppercase text-stone-400">
                  {turn.role === "caller" ? "You (caller)" : "Meatbox AI"}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{turn.text || "(no speech)"}</p>
              </div>
              {turn.toolCalls && turn.toolCalls.length > 0 && (
                <details className="mt-1 max-w-[85%] rounded-lg bg-stone-200 p-2 text-xs">
                  <summary className="cursor-pointer font-semibold">
                    {turn.toolCalls.length} tool call(s)
                  </summary>
                  {turn.toolCalls.map((call, j) => (
                    <div key={j} className="mt-2 border-t border-stone-300 pt-1 font-mono">
                      <p className="font-bold">{call.name}</p>
                      <p className="break-all">in: {JSON.stringify(call.input)}</p>
                      <p className="break-all">out: {JSON.stringify(call.result).slice(0, 400)}</p>
                    </div>
                  ))}
                </details>
              )}
            </div>
          ))}
          {busy && sessionId && <p className="text-sm text-stone-400">AI is thinking…</p>}
          {ended && (
            <p className="rounded-lg bg-stone-200 p-3 text-center text-sm font-semibold">
              — Call ended —
            </p>
          )}
          <div ref={bottomRef} />
        </div>

        {sessionId && (
          <div className="mt-4 flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
              placeholder='e.g. "What are your specials?" or "I want a chicken meatbox"'
              className="flex-1 rounded-lg border border-stone-300 p-3"
              disabled={busy}
            />
            <button
              onClick={() => void send()}
              disabled={busy}
              className="rounded-lg bg-stone-900 px-5 py-3 font-semibold text-white disabled:opacity-50"
            >
              Say
            </button>
          </div>
        )}
      </div>

      <aside className="w-full lg:w-80">
        <h2 className="mb-2 font-bold">Order cart</h2>
        <div className="rounded-2xl bg-white p-4 shadow">
          {!order && <p className="text-sm text-stone-400">No order started yet.</p>}
          {order && (
            <>
              <p className="text-sm">
                <span className="font-bold uppercase">{order.status}</span> ·{" "}
                {order.orderType === "takeaway" ? "Takeaway" : "Dine-in"}
                {order.customerName && ` · ${order.customerName}`}
              </p>
              {order.publicOrderNumber && (
                <p className="mt-1 text-lg font-extrabold text-green-700">
                  ✓ {order.publicOrderNumber}
                </p>
              )}
              <ul className="mt-3 space-y-2 border-t pt-2 text-sm">
                {order.items.map((item) => (
                  <li key={item.id}>
                    <p className="font-semibold">
                      {item.quantity} × {item.nameSnapshot}{" "}
                      <span className="float-right">${(item.lineTotalCents / 100).toFixed(2)}</span>
                    </p>
                    {item.modifiers.length > 0 && (
                      <p className="text-stone-500">
                        {item.modifiers.map((m) => m.nameSnapshot).join(", ")}
                      </p>
                    )}
                    {item.removals.length > 0 && (
                      <p className="text-red-600">no {item.removals.join(", no ")}</p>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-3 border-t pt-2 text-right text-lg font-extrabold">
                ${(order.totalCents / 100).toFixed(2)}
              </p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
