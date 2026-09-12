import { z } from "zod";
import { respondReplenishment } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded } from "@/lib/session";

/**
 * Supplier's answer from the public confirm page. No login — the
 * unguessable token IS the authorisation, same pattern as order
 * tracking/review links.
 */
const schema = z.object({
  token: z.string().min(10).max(200),
  action: z.enum(["confirmed", "declined"]),
});

export const POST = guarded(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  const result = await respondReplenishment(db(), parsed.data.token, parsed.data.action);
  if (!result) return Response.json({ error: "This order was already answered or has expired." }, { status: 409 });
  return Response.json({ ok: true, status: result.status });
});
