import { getDb, type Db } from "@meatbox/core";

// Next dev re-evaluates modules on recompile; keep one pool per process.
const globalForDb = globalThis as unknown as { __meatboxDb?: Db };

export function db(): Db {
  if (!globalForDb.__meatboxDb) {
    globalForDb.__meatboxDb = getDb();
  }
  return globalForDb.__meatboxDb;
}
