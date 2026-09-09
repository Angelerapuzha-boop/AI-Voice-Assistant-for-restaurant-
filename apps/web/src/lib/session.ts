import { cookies } from "next/headers";
import { getSessionUser, type User } from "@meatbox/core";
import { db } from "./db";

export const SESSION_COOKIE = "mb_session";

export async function currentUser(): Promise<User | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? "";
  if (!token) return null;
  return getSessionUser(db(), token);
}

/** For API route handlers. Throws a Response on failure. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) {
    throw Response.json({ error: "unauthorised" }, { status: 401 });
  }
  return user;
}

export async function requireOwner(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "owner") {
    throw Response.json({ error: "owner role required" }, { status: 403 });
  }
  return user;
}

/** Wrap a route handler so thrown Responses become responses. */
export function guarded<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof Response) return err;
      console.error("[api] unhandled error:", err);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  };
}
