"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface SquareStatus {
  configured: boolean;
  connected: boolean;
  merchantId: string | null;
  locationId: string | null;
  environment: string | null;
  pushOrders: boolean;
  connectedAt: string | null;
}

export default function IntegrationsClient() {
  const params = useSearchParams();
  const [status, setStatus] = useState<SquareStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/square", { cache: "no-store" });
    if (res.ok) setStatus((await res.json()) as SquareStatus);
  }, []);

  useEffect(() => {
    void load();
    const flag = params.get("square");
    if (flag === "connected") setMessage("âœ… Square connected!");
    else if (flag === "denied") setMessage("Square connection was cancelled.");
    else if (flag === "failed" || flag === "invalid") setMessage("Square connection failed â€” try again.");
  }, [load, params]);

  async function action(body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    const res = await fetch("/api/square", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      result?: { categories: number; items: number; modifierGroups: number; skipped: string[] };
    };
    setBusy(false);
    if (!res.ok) {
      setMessage(`âš  ${data.error ?? "Action failed"}`);
    } else if (data.result) {
      setMessage(
        `âœ… Imported ${data.result.items} items, ${data.result.categories} categories, ${data.result.modifierGroups} option groups from Square.` +
          (data.result.skipped.length ? ` Skipped: ${data.result.skipped.join(", ")}` : ""),
      );
    }
    void load();
  }

  return (
    <div className="max-w-2xl">
      <h1 className="mb-2 text-2xl font-bold">Integrations</h1>
      <p className="mb-6 text-sm text-stone-500">
        Connect Meatbox&apos;s existing platforms. Owner login required for changes.
      </p>

      {message && <p className="mb-4 rounded-xl bg-white p-3 shadow">{message}</p>}

      <div className="rounded-2xl bg-white p-6 shadow">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-stone-900 text-2xl text-white">
            â¬›
          </span>
          <div className="flex-1">
            <h2 className="text-lg font-bold">Square</h2>
            <p className="text-sm text-stone-500">
              Point of Sale, catalog and sales reporting â€” meatboxwa.com.au already runs on Square.
            </p>
          </div>
          {status?.connected && (
            <span className="rounded-full bg-green-100 px-3 py-1 text-sm font-bold text-green-800">
              CONNECTED
            </span>
          )}
        </div>

        {!status && <p className="mt-4 text-stone-400">Loadingâ€¦</p>}

        {status && !status.configured && (
          <div className="mt-4 rounded-xl bg-stone-100 p-4 text-sm">
            <p className="font-semibold">One-time developer setup needed first:</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-stone-600">
              <li>
                Create a (free) app at <b>developer.squareup.com</b> â†’ Applications
              </li>
              <li>
                In the app&apos;s OAuth settings, add redirect URL:{" "}
                <code className="rounded bg-white px-1">
                  {typeof window !== "undefined" ? window.location.origin : ""}/api/square/callback
                </code>
              </li>
              <li>
                Put its <b>Application ID</b> and <b>Application Secret</b> into <code>.env</code> as{" "}
                <code>SQUARE_APP_ID</code> / <code>SQUARE_APP_SECRET</code> and restart
              </li>
            </ol>
            <p className="mt-2 text-stone-500">
              After that, connecting is one click on this page.
            </p>
          </div>
        )}

        {status && status.configured && !status.connected && (
          <a
            href="/api/square/connect"
            className="mt-4 inline-block rounded-xl bg-stone-900 px-6 py-3 font-bold text-white hover:bg-stone-700"
          >
            ðŸ”— Connect Square â€” one click
          </a>
        )}

        {status?.connected && (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-stone-500">
              Merchant <b>{status.merchantId}</b> Â· location <b>{status.locationId || "â€”"}</b> Â·{" "}
              {status.environment} Â· since{" "}
              {status.connectedAt && new Date(status.connectedAt).toLocaleDateString("en-AU")}
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => void action({ action: "import" })}
                disabled={busy}
                className="rounded-xl bg-orange-600 px-5 py-3 font-bold text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {busy ? "Workingâ€¦" : "â¬‡ Import menu from Square"}
              </button>
              <button
                onClick={() => void action({ action: "push_orders", enabled: !status.pushOrders })}
                disabled={busy}
                className={`rounded-xl px-5 py-3 font-bold ${
                  status.pushOrders ? "bg-green-600 text-white" : "bg-stone-200"
                }`}
              >
                {status.pushOrders ? "âœ“ Pushing orders to Square" : "Push orders to Square: off"}
              </button>
              <button
                onClick={() => {
                  if (confirm("Disconnect Square? Order pushes stop; the menu keeps its imported items.")) {
                    void action({ action: "disconnect" });
                  }
                }}
                disabled={busy}
                className="rounded-xl px-5 py-3 text-red-600 hover:bg-red-50"
              >
                Disconnect
              </button>
            </div>
            <p className="text-xs text-stone-400">
              Import pulls categories, items, prices and options into the menu (editable afterwards,
              synced by Square ID on re-import). Pushing sends every confirmed phone/POS order into
              Square as an order, so Square Dashboard reporting and inventory stay accurate.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
