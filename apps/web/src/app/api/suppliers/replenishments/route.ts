import { z } from "zod";
import { cancelReplenishment, receiveReplenishment } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

const schema = z.object({
  id: z.string().uuid(),
  action: z.enum(["received", "cancel"]),
});

export const POST = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  if (parsed.data.action === "received") {
    const ok = await receiveReplenishment(db(), parsed.data.id, user.email);
    if (!ok) return Response.json({ error: "not receivable" }, { status: 409 });
  } else {
    await cancelReplenishment(db(), parsed.data.id);
  }
  return Response.json({ ok: true });
});
