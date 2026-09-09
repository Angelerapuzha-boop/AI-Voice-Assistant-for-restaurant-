import pg from "pg";
import { env } from "@meatbox/core";
import { guarded, requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events bridge over Postgres LISTEN/NOTIFY.
 * The kitchen dashboard connects here and refetches on every event.
 */
export const GET = guarded(async () => {
  await requireUser();

  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const close = () => {
        if (heartbeat) clearInterval(heartbeat);
        client.end().catch(() => undefined);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      try {
        await client.connect();
        await client.query("LISTEN order_events");
        client.on("notification", (msg) => {
          try {
            controller.enqueue(encoder.encode(`data: ${msg.payload ?? "{}"}\n\n`));
          } catch {
            close();
          }
        });
        client.on("error", close);
        controller.enqueue(encoder.encode(`data: {"connected":true}\n\n`));
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            close();
          }
        }, 25000);
      } catch (err) {
        console.error("[sse] failed to start:", err);
        close();
      }
    },
    cancel() {
      client.end().catch(() => undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
});
