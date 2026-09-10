"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** The only thing that commits the order is this explicit POST. */
export default function ConfirmButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/confirm/${encodeURIComponent(token)}`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string; trackUrl?: string };
      if (!res.ok) {
        setError(json.error ?? "Something went wrong. Please call the restaurant.");
        setBusy(false);
        router.refresh();
        return;
      }
      if (json.trackUrl) {
        window.location.assign(json.trackUrl);
      } else {
        router.refresh();
      }
    } catch {
      setError("Couldn't reach the restaurant. Check your connection and try again.");
      setBusy(false);
    }
  };

  return (
    <div className="mt-5">
      <button
        onClick={confirm}
        disabled={busy}
        className="w-full rounded-2xl bg-green-600 py-4 text-lg font-extrabold text-white shadow active:bg-green-700 disabled:opacity-60"
      >
        {busy ? "Sending to the kitchen…" : "Confirm order — send to kitchen"}
      </button>
      {error && (
        <p className="mt-3 rounded-xl bg-red-50 p-3 text-center text-sm font-semibold text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
