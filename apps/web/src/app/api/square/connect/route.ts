import { env, squareAuthorizeUrl, squareConfigured } from "@meatbox/core";
import { guarded, requireOwner } from "@/lib/session";

/** One-click connect: redirects the owner to Square's authorize page. */
export const GET = guarded(async () => {
  await requireOwner();
  if (!squareConfigured()) {
    return Response.json(
      { error: "SQUARE_APP_ID / SQUARE_APP_SECRET are not set in .env" },
      { status: 400 },
    );
  }
  const redirectUri = `${env.APP_URL.replace(/\/$/, "")}/api/square/callback`;
  return Response.redirect(squareAuthorizeUrl(redirectUri), 302);
});
