"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Real voice call to the AI from the browser — mic + speakers, no SIM,
 * no phone network, callable from anywhere (uses the Twilio Voice JS SDK
 * over the internet; pennies per minute on the Twilio balance).
 */

declare global {
  interface Window {
    Twilio?: {
      Device: new (
        token: string,
        options?: Record<string, unknown>,
      ) => {
        connect(options?: Record<string, unknown>): Promise<TwilioCall>;
        register(): Promise<void>;
        destroy(): void;
        on(event: string, handler: (...args: unknown[]) => void): void;
      };
    };
  }
}

interface TwilioCall {
  disconnect(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

const SDK_URL = "https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.12.3/dist/twilio.min.js";

export default function BrowserCallPage() {
  const [status, setStatus] = useState<string>("Loading calling engine…");
  const [inCall, setInCall] = useState(false);
  const [ready, setReady] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const deviceRef = useRef<InstanceType<NonNullable<Window["Twilio"]>["Device"]> | null>(null);
  const callRef = useRef<TwilioCall | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.onload = () => {
      if (!cancelled) setup().catch((err: Error) => setStatus(`Setup failed: ${err.message}`));
    };
    script.onerror = () => setStatus("Couldn't load the Twilio calling SDK (network?).");
    document.head.appendChild(script);

    async function setup() {
      const res = await fetch("/api/voice-token", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus(body.error ?? "Couldn't get a calling token.");
        return;
      }
      const { token } = (await res.json()) as { token: string };
      if (!window.Twilio) {
        setStatus("Calling SDK didn't initialise.");
        return;
      }
      const device = new window.Twilio.Device(token, { logLevel: "error" });
      device.on("error", (err) => {
        const e = err as { message?: string };
        setStatus(`Call error: ${e?.message ?? "unknown"}`);
        setInCall(false);
      });
      deviceRef.current = device;
      setReady(true);
      setStatus("Ready. Put your headphones on and press Call.");
    }

    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
      deviceRef.current?.destroy();
    };
  }, []);

  async function startCall() {
    const device = deviceRef.current;
    if (!device) return;
    setStatus("Requesting microphone…");
    try {
      const call = await device.connect({});
      callRef.current = call;
      call.on("accept", () => {
        setInCall(true);
        setSeconds(0);
        timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
        setStatus("Connected — talk normally, you can interrupt her any time.");
      });
      call.on("disconnect", () => {
        setInCall(false);
        if (timerRef.current) clearInterval(timerRef.current);
        setStatus("Call ended. Check the kitchen board and Voice quality page.");
      });
      call.on("error", (err) => {
        const e = err as { message?: string };
        setStatus(`Call error: ${e?.message ?? "unknown"}`);
        setInCall(false);
      });
    } catch (err) {
      setStatus(`Couldn't start the call: ${(err as Error).message} (allow the microphone?)`);
    }
  }

  function hangUp() {
    callRef.current?.disconnect();
  }

  return (
    <div className="max-w-xl">
      <h1 className="mb-2 text-2xl font-bold">Call from browser</h1>
      <p className="mb-6 text-sm text-stone-500">
        A real voice call to the Meatbox AI using your computer&apos;s mic and speakers — no
        SIM, no phone network, works from anywhere. Costs under a cent a minute on the
        Twilio balance. Headphones recommended (stops the AI hearing itself). Orders you
        confirm land on the kitchen board — cancel them there afterwards.
      </p>

      <div className="rounded-2xl bg-white p-8 text-center shadow">
        <p className="mb-6 min-h-12 text-lg">{status}</p>
        {inCall && (
          <p className="mb-6 font-mono text-3xl">
            {Math.floor(seconds / 60)}:{(seconds % 60).toString().padStart(2, "0")}
          </p>
        )}
        {!inCall ? (
          <button
            onClick={() => void startCall()}
            disabled={!ready}
            className="rounded-full bg-green-600 px-12 py-6 text-2xl font-extrabold text-white shadow-lg hover:bg-green-700 disabled:opacity-40"
          >
            📞 Call Meat Box
          </button>
        ) : (
          <button
            onClick={hangUp}
            className="rounded-full bg-red-600 px-12 py-6 text-2xl font-extrabold text-white shadow-lg hover:bg-red-700"
          >
            ⏹ Hang up
          </button>
        )}
      </div>

      <p className="mt-4 text-xs text-stone-400">
        Tip: try the acceptance script — &quot;two chicken meat boxes&quot; → &quot;chips and
        salad&quot; → &quot;garlic on both&quot; → &quot;nah that&apos;s it&quot; → your name →
        &quot;yep&quot;. Then open Voice quality to see the per-turn latency of your call.
      </p>
    </div>
  );
}
