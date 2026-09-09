import pg from "pg";
import { env } from "../env";

const { Pool } = pg;

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

let pool: pg.Pool | null = null;

export function getDb(): pg.Pool {
  if (!pool) {
    pool = createPool(env.DATABASE_URL);
  }
  return pool;
}

export function createPool(connectionString: string): pg.Pool {
  const p = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client emitting 'error' must never crash the process
  // (a dying idle pg client took down arc-restaurant-ai's API once).
  p.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });
  return p;
}

/** Run fn inside a transaction; rolls back on throw. */
export async function withTransaction<T>(
  db: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection is broken; release below will destroy it
    }
    throw err;
  } finally {
    client.release();
  }
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
