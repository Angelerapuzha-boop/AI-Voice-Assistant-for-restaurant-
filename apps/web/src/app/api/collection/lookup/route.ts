import { z } from "zod";
import {
  createPaymentProvider,
  getDefaultRestaurant,
  kioskLookup,
  kioskSessionToken,
  KioskLookupError,
  KIOSK_GENERIC_ERROR,
  paymentSummaryForOrder,
  formatCents,
} from "@meatbox/core";
import { db } from "@/lib/db";

const bodySchema = z.object({
  orderNumber: z.string().min(1).max(20),
  code: z.string().min(1).max(8),
});

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local"
  );
}

/**
 * Verified kiosk retrieval (public). Every failure is the SAME generic
 * message — an order number or phone number alone never confirms anything.
 */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: KIOSK_GENERIC_ERROR }, { status: 404 });
  }
  try {
    const restaurant = await getDefaultRestaurant(db());
    const order = await kioskLookup(db(), {
      restaurantId: restaurant.id,
      orderNumber: parsed.data.orderNumber,
      code: parsed.data.code,
      ip: clientIp(req),
    });
    const summary = await paymentSummaryForOrder(db(), order.id, order.totalCents);
    let terminal: { available: boolean; isTest: boolean } = { available: false, isTest: false };
    try {
      const provider = await createPaymentProvider(db(), restaurant.id);
      terminal = { available: true, isTest: provider.isTest };
    } catch {
      // No terminal configured — kiosk shows "pay at the counter".
    }
    return Response.json({
      kioskToken: kioskSessionToken(order.id),
      terminal,
      order: {
        orderNumber: order.publicOrderNumber,
        firstName: order.customerName.split(" ")[0] ?? "",
        status: order.status,
        items: order.items.map((i) => ({ name: i.nameSnapshot, quantity: i.quantity })),
        total: formatCents(order.totalCents),
        totalCents: order.totalCents,
        paymentState: summary.state,
        outstanding: formatCents(summary.outstandingCents),
      },
    });
  } catch (err) {
    if (err instanceof KioskLookupError) {
      return Response.json({ error: KIOSK_GENERIC_ERROR }, { status: 404 });
    }
    console.error("[collection/lookup] failed:", err);
    return Response.json({ error: "The pickup screen hit a problem — see staff." }, { status: 500 });
  }
}
