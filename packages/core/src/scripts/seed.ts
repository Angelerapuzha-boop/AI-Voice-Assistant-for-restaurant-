import { closeDb, getDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { seed, SEED_OWNER_EMAIL } from "../seed/seed";

const db = getDb();
await runMigrations(db);
const result = await seed(db);
console.log(
  result.created
    ? `Seeded Meatbox WA (restaurant ${result.restaurantId}). Owner login: ${SEED_OWNER_EMAIL}`
    : `Meatbox WA already present (restaurant ${result.restaurantId}); menu left untouched.`,
);
await closeDb();
