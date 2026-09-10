import {
  collectionCode,
  findOrderByTrackingToken,
  formatCents,
  formatLocalTime,
  getDefaultRestaurant,
} from "@meatbox/core";
import { db } from "@/lib/db";
import TrackRefresher from "./refresher";

export const dynamic = "force-dynamic";

const STATUS_STEPS = [
  { key: "new", label: "Received" },
  { key: "accepted", label: "Accepted" },
  { key: "preparing", label: "Preparing" },
  { key: "ready", label: "Ready for collection" },
  { key: "completed", label: "Collected" },
];

export default async function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const order = await findOrderByTrackingToken(db(), token);

  if (!order) {
    return (
      <main className="mx-auto max-w-md p-6 text-center">
        <p className="mt-20 text-lg font-semibold">This tracking link isn&apos;t valid.</p>
        <p className="mt-2 text-sm text-stone-500">
          Check the link in your SMS, or call the restaurant.
        </p>
      </main>
    );
  }

  const restaurant = await getDefaultRestaurant(db());
  const reachedIndex = STATUS_STEPS.findIndex((s) => s.key === order.status);
  const cancelled = order.status === "cancelled";

  return (
    <main className="mx-auto max-w-md p-4 pb-16">
      <TrackRefresher active={!cancelled && order.status !== "completed"} />
      <header className="rounded-2xl bg-stone-900 p-5 text-center text-white">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo.jpg" alt={restaurant.name} className="mx-auto w-48 rounded-xl" />
        <p className="mt-3 text-2xl font-extrabold">{order.publicOrderNumber}</p>
        {order.currentEstimatedReadyAt && !cancelled && order.status !== "completed" && (
          <p className="mt-1 text-stone-300">
            Ready about {formatLocalTime(order.currentEstimatedReadyAt, restaurant.timezone)}
          </p>
        )}
        <p className="mt-1 text-sm font-semibold text-orange-400">
          {order.paidAt ? "Paid" : "Pay on collection"}
        </p>
        {!cancelled && order.status !== "completed" && (
          <p className="mt-2 rounded-lg bg-stone-800 px-3 py-2 text-sm text-stone-300">
            Pickup code for the in-store screen:{" "}
            <span className="text-lg font-extrabold tracking-[0.3em] text-white">
              {collectionCode(order.id)}
            </span>
          </p>
        )}
      </header>

      {cancelled ? (
        <p className="mt-6 rounded-xl bg-red-50 p-4 text-center font-semibold text-red-700">
          This order was cancelled. Call {restaurant.phoneDisplay} if that&apos;s unexpected.
        </p>
      ) : (
        <ol className="mt-6 space-y-2">
          {STATUS_STEPS.map((step, i) => (
            <li
              key={step.key}
              className={`flex items-center gap-3 rounded-xl p-3 ${
                i <= reachedIndex ? "bg-green-50 text-green-900" : "bg-white text-stone-400"
              }`}
            >
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${
                  i <= reachedIndex ? "bg-green-600 text-white" : "bg-stone-200"
                }`}
              >
                {i <= reachedIndex ? "✓" : i + 1}
              </span>
              <span className="font-semibold">{step.label}</span>
              {i === reachedIndex && (
                <span className="ml-auto rounded-full bg-green-600 px-2 py-0.5 text-xs font-bold text-white">
                  NOW
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      <section className="mt-6 rounded-2xl bg-white p-4 shadow">
        <ul className="space-y-2">
          {order.items.map((item) => (
            <li key={item.id} className="border-b pb-2 text-sm last:border-b-0">
              <p className="font-bold">
                {item.quantity} × {item.nameSnapshot}
                <span className="float-right">{formatCents(item.lineTotalCents)}</span>
              </p>
              {item.modifiers.length > 0 && (
                <p className="text-stone-500">{item.modifiers.map((m) => m.nameSnapshot).join(" · ")}</p>
              )}
              {item.removals.length > 0 && (
                <p className="text-red-600">no {item.removals.join(", no ")}</p>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-right text-lg font-extrabold">
          Total {formatCents(order.totalCents)}
        </p>
      </section>

      <p className="mt-6 text-center text-sm text-stone-500">
        {restaurant.address} · {restaurant.phoneDisplay}
      </p>
    </main>
  );
}
