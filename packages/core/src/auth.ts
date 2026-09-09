import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Queryable } from "./db/client";
import { camelRow, type User } from "./types";

const SESSION_TTL_DAYS = 14;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  db: Queryable,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000);
  await db.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
    userId,
    hashToken(token),
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function getSessionUser(db: Queryable, token: string): Promise<User | null> {
  if (!token) return null;
  const res = await db.query(
    `SELECT u.id, u.restaurant_id, u.email, u.name, u.role, u.active
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [hashToken(token)],
  );
  return res.rows[0] ? camelRow<User>(res.rows[0]) : null;
}

export async function destroySession(db: Queryable, token: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

export async function authenticate(
  db: Queryable,
  email: string,
  password: string,
): Promise<User | null> {
  const res = await db.query(
    `SELECT * FROM users WHERE lower(email) = lower($1) AND active`,
    [email],
  );
  const row = res.rows[0] as (Record<string, unknown> & { password_hash: string }) | undefined;
  if (!row) {
    // Constant-ish time: still burn a hash comparison for unknown emails.
    await bcrypt.compare(password, "$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpQvVFVLmU4mCzyPQ0mQxyzYyzGCa");
    return null;
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;
  return camelRow<User>({
    id: row.id,
    restaurant_id: row.restaurant_id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.active,
  });
}
