import {
  disconnectSquare,
  getDefaultRestaurant,
  getSquareConnection,
  importSquareCatalog,
  setSquarePushOrders,
  squareConfigured,
} from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireOwner, requireUser } from "@/lib/session";

/** GET: connection status for the Integrations page. */
export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  const conn = await getSquareConnection(db(), restaurant.id);
  return Response.json({
    configured: squareConfigured(),
    connected: Boolean(conn),
    merchantId: conn?.merchantId ?? null,
    locationId: conn?.locationId ?? null,
    environment: conn?.environment ?? null,
    pushOrders: conn?.pushOrders ?? false,
    connectedAt: conn?.connectedAt ?? null,
  });
});

/** POST: actions — import catalog, toggle push, disconnect. */
export const POST = guarded(async (req: Request) => {
  await requireOwner();
  const restaurant = await getDefaultRestaurant(db());
  const body = (await req.json().catch(() => ({}))) as {
    action?: "import" | "push_orders" | "disconnect";
    enabled?: boolean;
  };
  try {
    switch (body.action) {
      case "import": {
        const result = await importSquareCatalog(db(), restaurant.id);
        return Response.json({ ok: true, result });
      }
      case "push_orders":
        await setSquarePushOrders(db(), restaurant.id, Boolean(body.enabled));
        return Response.json({ ok: true });
      case "disconnect":
        await disconnectSquare(db(), restaurant.id);
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
});
