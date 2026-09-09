import { z } from "zod";
import { authenticate, createSession, env } from "@meatbox/core";
import { db } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/session";

const bodySchema = z.object({
  email: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
});

// Simple in-memory rate limit: 10 attempts / 5 min per IP.
const attempts = new Map<string, { count: number; resetAt: number }>();

export async function POST(req: Request): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  const now = Date.now();
  const entry = attempts.get(ip);
  if (entry && entry.resetAt > now && entry.count >= 10) {
    return Response.json({ error: "Too many attempts. Try again shortly." }, { status: 429 });
  }
  if (!entry || entry.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 });
  } else {
    entry.count++;
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Email and password are required." }, { status: 400 });
  }
  const user = await authenticate(db(), parsed.data.email, parsed.data.password);
  if (!user) {
    return Response.json({ error: "Incorrect email or password." }, { status: 401 });
  }
  const session = await createSession(db(), user.id);
  const res = Response.json({ ok: true, role: user.role });
  const secure = env.APP_URL.startsWith("https") ? "; Secure" : "";
  res.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${session.expiresAt.toUTCString()}`,
  );
  return res;
}
