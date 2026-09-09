import { closeDb, getDb } from "../db/client";
import { runMigrations } from "../db/migrate";

const db = getDb();
const ran = await runMigrations(db);
console.log(ran.length ? `Applied: ${ran.join(", ")}` : "No pending migrations.");
await closeDb();
