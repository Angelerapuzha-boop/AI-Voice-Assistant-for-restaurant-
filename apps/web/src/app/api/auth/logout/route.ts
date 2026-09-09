import { cookies } from "next/headers";
import { destroySession } from "@meatbox/core";
import { db } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/session";

export async function POST(): Promise<Response> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await destroySession(db(), token);
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
}
