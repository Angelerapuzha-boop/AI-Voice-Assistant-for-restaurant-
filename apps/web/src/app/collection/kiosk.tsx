"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface KioskOrder {
  orderNumber: string;
  firstName: string;
  status: string;
  items: { name: string; quantity: number }[];
  total: string;
  totalCents: number;
  paymentState: string;
  outstanding: string;
}

type Step = "entry" | "order" | "paying" | "paid" | "failed";

const IDLE_RESET_MS = 60_000;

export default function Kiosk() {
  const [step, setStep] = useState<Step>("entry");
  const [orderNumber, setOrderNumber] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [order, setOrder] = useState<KioskOrder | null>(null);
  const [kioskToken, setKioskToken] = useState("");
  const [terminal, setTerminal] = useState<{ available: boolean; isTest: boolean }>({
    available: false,
    isTest: false,
  });
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const reset = useCallback(() => {
    setStep("entry");
    setOrderNumber("");
    setCode("");
    setError("");
    setOrder(null);
    setKioskToken("");
    setPaymentId(null);
    setBusy(false);
    if (pollTimer.current) clearInterval(pollTimer.current);
  }, []);

  // Between customers: any state clears itself after a minute untouched.
  const touch = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(reset, IDLE_RESET_MS);
  }, [reset]);

  useEffect(() => {
    touch();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [touch]);

  async function lookup() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/collection/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber, code }),
      });
      const json = (await res.json()) as {
        error?: string;
        kioskToken?: string;
        order?: KioskOrder;
        terminal?: { available: boolean; isTest: boolean };
      };
      if (!res.ok || !json.order) {
        setError(json.error ?? "Try again.");
        return;
      }
      setOrder(json.order);
      setKioskToken(json.kioskToken ?? "");
      setTerminal(json.terminal ?? { available: false, isTest: false });
      setStep("order");
    } catch {
      setError("Connection problem — see staff at the counter.");
    } finally {
      setBusy(false);
      touch();
    }
  }

  const pollStatus = useCallback(
    (payId: string, token: string) => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = setInterval(async () => {
        try {
          const res = await fetch("/api/collection/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kioskToken: token, paymentId: payId }),
          });
          const json = (await res.json()) as {
            paymentState?: string;
            payment?: { status: string; failureReason: string } | null;
          };
          if (json.payment?.status === "succeeded" || json.paymentState === "paid") {
            if (pollTimer.current) clearInterval(pollTimer.current);
            setStep("paid");
            touch();
          } else if (json.payment && ["failed", "cancelled"].includes(json.payment.status)) {
            if (pollTimer.current) clearInterval(pollTimer.current);
            setError(
              json.payment.status === "failed"
                ? `Payment didn't go through${json.payment.failureReason ? ` (${json.payment.failureReason})` : ""}.`
                : "Payment cancelled.",
            );
            setStep("failed");
            touch();
          }
        } catch {
          // transient — keep polling; idle reset is the backstop
        }
      }, 2000);
    },
    [touch],
  );

  async function pay() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/collection/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kioskToken }),
      });
      const json = (await res.json()) as { error?: string; paymentId?: string };
      if (!res.ok || !json.paymentId) {
        setError(json.error ?? "The terminal couldn't start — see staff.");
        return;
      }
      setPaymentId(json.paymentId);
      setStep("paying");
      pollStatus(json.paymentId, kioskToken);
    } catch {
      setError("Connection problem — see staff at the counter.");
    } finally {
      setBusy(false);
      touch();
    }
  }

  async function cancelPayment() {
    if (!paymentId) return;
    if (pollTimer.current) clearInterval(pollTimer.current);
    await fetch("/api/collection/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kioskToken, paymentId }),
    }).catch(() => undefined);
    setPaymentId(null);
    setStep("order");
    touch();
  }

  const isReady = order?.status === "ready";
  const isPaid = order?.paymentState === "paid";

  return (
    <main
      className="flex min-h-screen flex-col items-center bg-stone-900 p-6 text-white"
      onPointerDown={touch}
    >
      <header className="mb-6 text-center">
        <p className="text-3xl font-extrabold tracking-wide">🔥 MEATBOX PICKUP</p>
        {terminal.isTest && step !== "entry" && (
          <p className="mt-1 inline-block rounded bg-purple-600 px-2 py-0.5 text-xs font-bold">
            TEST PAYMENTS — no real money moves
          </p>
        )}
      </header>

      {step === "entry" && (
        <div className="w-full max-w-md">
          <p className="text-center text-lg text-stone-300">
            Enter your order number and the 4-digit pickup code from your tracking page.
          </p>
          <label className="mt-6 block text-sm font-bold text-stone-400">ORDER NUMBER</label>
          <input
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            placeholder="MB1234"
            inputMode="text"
            autoComplete="off"
            className="mt-1 w-full rounded-2xl bg-white p-5 text-center text-3xl font-extrabold text-stone-900"
          />
          <label className="mt-4 block text-sm font-bold text-stone-400">PICKUP CODE</label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="••••"
            inputMode="numeric"
            autoComplete="off"
            className="mt-1 w-full rounded-2xl bg-white p-5 text-center text-3xl font-extrabold tracking-[0.5em] text-stone-900"
          />
          <button
            onClick={lookup}
            disabled={busy || !orderNumber || code.length !== 4}
            className="mt-6 w-full rounded-2xl bg-orange-600 py-5 text-2xl font-extrabold disabled:opacity-40"
          >
            {busy ? "Checking…" : "FIND MY ORDER"}
          </button>
          {error && (
            <p className="mt-4 rounded-xl bg-red-500/20 p-4 text-center font-semibold text-red-200">
              {error}
            </p>
          )}
        </div>
      )}

      {step === "order" && order && (
        <div className="w-full max-w-md">
          <div className="rounded-2xl bg-white p-5 text-stone-900">
            <p className="text-center text-4xl font-extrabold">{order.orderNumber}</p>
            <p className="mt-1 text-center text-stone-500">
              {order.firstName && `For ${order.firstName} · `}
              {isReady ? "READY FOR COLLECTION" : "Being prepared"}
            </p>
            <ul className="mt-4 space-y-1 border-t pt-3 text-sm">
              {order.items.map((i, idx) => (
                <li key={idx} className="font-semibold">
                  {i.quantity} × {i.name}
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t pt-3 text-right text-2xl font-extrabold">{order.total}</p>
            <p className="text-right text-sm font-bold">
              {isPaid ? (
                <span className="text-green-700">PAID ✅</span>
              ) : (
                <span className="text-orange-600">TO PAY: {order.outstanding}</span>
              )}
            </p>
          </div>

          {!isPaid && terminal.available && (
            <button
              onClick={pay}
              disabled={busy}
              className="mt-5 w-full rounded-2xl bg-green-600 py-5 text-2xl font-extrabold disabled:opacity-40"
            >
              💳 PAY {order.outstanding} ON TERMINAL
            </button>
          )}
          {!isPaid && !terminal.available && (
            <p className="mt-5 rounded-xl bg-white/10 p-4 text-center text-lg">
              Please pay at the counter.
            </p>
          )}
          {isPaid && (
            <p className="mt-5 rounded-xl bg-green-500/20 p-4 text-center text-lg font-bold text-green-200">
              {isReady
                ? "All paid — show this screen at the counter to collect."
                : "All paid — we'll call your number when it's ready."}
            </p>
          )}
          {error && (
            <p className="mt-4 rounded-xl bg-red-500/20 p-4 text-center font-semibold text-red-200">
              {error}
            </p>
          )}
          <button onClick={reset} className="mt-4 w-full py-3 text-stone-400">
            Done / next customer
          </button>
        </div>
      )}

      {step === "paying" && (
        <div className="w-full max-w-md text-center">
          <p className="animate-pulse text-6xl">💳</p>
          <p className="mt-4 text-2xl font-extrabold">Follow the prompts on the card terminal…</p>
          <p className="mt-2 text-stone-400">Tap or insert your card when the terminal asks.</p>
          <button onClick={cancelPayment} className="mt-8 rounded-xl bg-stone-700 px-6 py-4 font-bold">
            Cancel payment
          </button>
        </div>
      )}

      {step === "paid" && order && (
        <div className="w-full max-w-md text-center">
          <p className="text-7xl">✅</p>
          <p className="mt-4 text-3xl font-extrabold">Paid — thank you!</p>
          <p className="mt-2 text-xl">
            Order <span className="font-extrabold">{order.orderNumber}</span>
          </p>
          <p className="mt-3 text-stone-300">
            {isReady
              ? "Show this screen at the counter and we'll hand it over."
              : "We'll call your number as soon as it's ready."}
          </p>
          <button onClick={reset} className="mt-8 w-full rounded-2xl bg-orange-600 py-4 text-xl font-extrabold">
            DONE
          </button>
        </div>
      )}

      {step === "failed" && (
        <div className="w-full max-w-md text-center">
          <p className="text-6xl">😕</p>
          <p className="mt-4 text-2xl font-extrabold">{error || "Payment didn't go through."}</p>
          <p className="mt-2 text-stone-400">No money was taken. You can try again or pay at the counter.</p>
          <div className="mt-6 flex gap-3">
            <button
              onClick={() => {
                setError("");
                setStep("order");
              }}
              className="flex-1 rounded-2xl bg-green-600 py-4 text-xl font-extrabold"
            >
              TRY AGAIN
            </button>
            <button onClick={reset} className="flex-1 rounded-2xl bg-stone-700 py-4 text-xl font-extrabold">
              START OVER
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
