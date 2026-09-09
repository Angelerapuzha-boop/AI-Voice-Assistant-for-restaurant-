import { env } from "@meatbox/core";
import { guarded, requireUser } from "@/lib/session";

/** Proxy to the voice service simulator (adds the internal secret server-side). */
export const POST = guarded(async (req: Request) => {
  await requireUser();
  const body = (await req.json().catch(() => ({}))) as {
    action?: "session" | "message";
    sessionId?: string;
    text?: string;
  };
  const path = body.action === "message" ? "/simulator/message" : "/simulator/session";
  try {
    const res = await fetch(`http://${env.HOST}:${env.VOICE_PORT}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": env.INTERNAL_API_SECRET,
      },
      body: JSON.stringify(
        body.action === "message" ? { sessionId: body.sessionId, text: body.text } : {},
      ),
    });
    return Response.json(await res.json(), { status: res.status });
  } catch {
    return Response.json(
      { error: "Voice service is not running (pnpm dev:voice)." },
      { status: 502 },
    );
  }
});
