import {
  confirmByReviewToken,
  getDefaultRestaurant,
  getHours,
  getSettings,
  OrderValidationError,
} from "@meatbox/core";
import { db } from "@/lib/db";

/**
 * Public customer endpoint (the token IS the credential — high-entropy,
 * single-use, hash-stored). Explicit POST only; GET never exists here, so
 * SMS link previews can never commit an order.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  try {
    const restaurant = await getDefaultRestaurant(db());
    const settings = await getSettings(db(), restaurant.id);
    const hours = await getHours(db(), restaurant.id);
    const result = await confirmByReviewToken(db(), { token, restaurant, settings, hours });
    return Response.json({
      ok: true,
      alreadyConfirmed: result.alreadyConfirmed,
      orderNumber: result.order.publicOrderNumber,
      trackUrl: result.trackUrl ?? null,
    });
  } catch (err) {
    if (err instanceof OrderValidationError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    console.error("[confirm] failed:", err);
    return Response.json(
      { error: "Something went wrong on our side. Please call the restaurant." },
      { status: 500 },
    );
  }
}
