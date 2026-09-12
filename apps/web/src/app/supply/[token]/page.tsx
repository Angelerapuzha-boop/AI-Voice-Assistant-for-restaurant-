import { getReplenishmentByToken } from "@meatbox/core";
import { db } from "@/lib/db";
import SupplyActions from "./supply-actions";

export const dynamic = "force-dynamic";

/** Public supplier page: view the stock order, confirm or decline. */
export default async function SupplyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const order = await getReplenishmentByToken(db(), token);

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-100 p-4">
      <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl">
        {!order ? (
          <>
            <h1 className="mb-2 text-xl font-extrabold">Order not found</h1>
            <p className="text-stone-500">This link is invalid or has expired.</p>
          </>
        ) : (
          <>
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-stone-400">
              Stock order from
            </p>
            <h1 className="mb-4 text-2xl font-extrabold">🔥 {order.restaurantName}</h1>
            <div className="mb-4 rounded-2xl bg-stone-50 p-4">
              <p className="text-3xl font-extrabold">
                {order.qty} <span className="text-lg font-bold text-stone-500">{order.unit}</span>
              </p>
              <p className="text-lg font-semibold">{order.itemName}</p>
              <p className="mt-1 text-xs text-stone-400">
                Requested {new Date(order.requestedAt).toLocaleString("en-AU")} · for {order.supplierName}
              </p>
            </div>
            {order.status === "requested" ? (
              <SupplyActions token={token} />
            ) : (
              <p
                className={`rounded-xl p-3 text-center font-bold ${
                  order.status === "confirmed"
                    ? "bg-emerald-50 text-emerald-700"
                    : order.status === "received"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-stone-100 text-stone-500"
                }`}
              >
                {order.status === "confirmed" && "✅ Confirmed — thank you!"}
                {order.status === "received" && "📦 Delivered and received — thank you!"}
                {order.status === "declined" && "This order was declined."}
                {order.status === "cancelled" && "This order was cancelled."}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
