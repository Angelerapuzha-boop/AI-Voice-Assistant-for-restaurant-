import {
  estimateForNewOrder,
  findOrderByReviewToken,
  formatCents,
  formatLocalTime,
  getDefaultRestaurant,
  getSettings,
} from "@meatbox/core";
import { db } from "@/lib/db";
import ConfirmButton from "./confirm-button";

export const dynamic = "force-dynamic";

/**
 * Visual confirmation page. Rendering this page (GET — including SMS link
 * previews) never creates or confirms anything; only the explicit POST
 * behind the Confirm button commits the order.
 */
export default async function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const lookup = await findOrderByReviewToken(db(), token);

  if (!lookup) {
    return (
      <main className="mx-auto max-w-md p-6 text-center">
        <p className="mt-20 text-lg font-semibold">This link isn&apos;t valid.</p>
        <p className="mt-2 text-sm text-stone-500">Check the link in your SMS, or call the restaurant.</p>
      </main>
    );
  }

  const restaurant = await getDefaultRestaurant(db());
  const { order, expired } = lookup;

  if (order.status !== "draft") {
    const confirmed = order.status !== "cancelled";
    return (
      <main className="mx-auto max-w-md p-6 text-center">
        {confirmed ? (
          <>
            <p className="mt-16 text-4xl">✅</p>
            <p className="mt-3 text-xl font-extrabold">
              Order {order.publicOrderNumber} is confirmed.
            </p>
            <p className="mt-2 text-stone-600">
              The kitchen has it. Your tracking link was texted to you.
            </p>
            {order.currentEstimatedReadyAt && (
              <p className="mt-2 font-semibold">
                Ready about {formatLocalTime(order.currentEstimatedReadyAt, restaurant.timezone)}
              </p>
            )}
            <p className="mt-2 text-sm font-semibold text-orange-600">Pay on collection.</p>
          </>
        ) : (
          <>
            <p className="mt-16 text-lg font-semibold">This order is no longer active.</p>
            <p className="mt-2 text-sm text-stone-500">
              It expired or was cancelled before it was confirmed — nothing was sent to the kitchen.
              Call {restaurant.phoneDisplay} to order again.
            </p>
          </>
        )}
      </main>
    );
  }

  if (expired) {
    return (
      <main className="mx-auto max-w-md p-6 text-center">
        <p className="mt-20 text-lg font-semibold">This order expired before it was confirmed.</p>
        <p className="mt-2 text-sm text-stone-500">
          Nothing was sent to the kitchen. Call {restaurant.phoneDisplay} to order again.
        </p>
      </main>
    );
  }

  const settings = await getSettings(db(), restaurant.id);
  const provisionalReadyAt = await estimateForNewOrder(db(), {
    restaurantId: restaurant.id,
    settings,
    lineCount: order.items.length,
    quantityTotal: order.items.reduce((sum, i) => sum + i.quantity, 0),
  });

  return (
    <main className="mx-auto max-w-md p-4 pb-16">
      <header className="rounded-2xl bg-stone-900 p-5 text-center text-white">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo.jpg" alt={restaurant.name} className="mx-auto w-48 rounded-xl" />
        <p className="mt-3 inline-block rounded-full bg-amber-500 px-3 py-1 text-sm font-extrabold text-stone-900">
          AWAITING CONFIRMATION
        </p>
        <p className="mt-2 text-sm text-stone-300">
          This order has <span className="font-bold text-white">not</span> reached the kitchen yet.
        </p>
      </header>

      <section className="mt-6 rounded-2xl bg-white p-4 shadow">
        <p className="text-sm font-semibold text-stone-500">
          {order.customerName} · {order.orderType === "takeaway" ? "Takeaway" : "Dine-in"} ·{" "}
          {order.requestedAsap || !order.requestedTime
            ? "ASAP"
            : formatLocalTime(order.requestedTime, restaurant.timezone)}
        </p>
        <ul className="mt-3 space-y-2">
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
              {item.specialInstructions && (
                <p className="text-stone-500">Note: {item.specialInstructions}</p>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-right text-lg font-extrabold">Total {formatCents(order.totalCents)}</p>
        <p className="mt-1 text-right text-sm font-semibold text-orange-600">Pay on collection</p>
      </section>

      <p className="mt-4 text-center text-sm text-stone-500">
        If you confirm now: ready about{" "}
        <span className="font-semibold text-stone-700">
          {formatLocalTime(provisionalReadyAt, restaurant.timezone)}
        </span>{" "}
        — the time isn&apos;t reserved until you confirm.
      </p>

      <ConfirmButton token={token} />

      <p className="mt-4 text-center text-sm text-stone-500">
        Something wrong? Call {restaurant.phoneDisplay} — don&apos;t confirm.
      </p>
    </main>
  );
}
