import { env, exchangeSquareCode, getDefaultRestaurant, verifyOauthState } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireOwner } from "@/lib/session";

/** Square OAuth redirect target. */
export const GET = guarded(async (req: Request) => {
  await requireOwner();
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) {
    return Response.redirect(
      `${env.APP_URL}/admin/integrations?square=denied`,
      302,
    );
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  if (!code || !verifyOauthState(state)) {
    return Response.redirect(`${env.APP_URL}/admin/integrations?square=invalid`, 302);
  }
  const restaurant = await getDefaultRestaurant(db());
  try {
    await exchangeSquareCode(
      db(),
      restaurant.id,
      code,
      `${env.APP_URL.replace(/\/$/, "")}/api/square/callback`,
    );
    return Response.redirect(`${env.APP_URL}/admin/integrations?square=connected`, 302);
  } catch (err) {
    console.error("[square] oauth exchange failed:", err);
    return Response.redirect(`${env.APP_URL}/admin/integrations?square=failed`, 302);
  }
});
