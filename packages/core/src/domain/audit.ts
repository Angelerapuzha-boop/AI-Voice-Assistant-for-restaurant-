import type { Queryable } from "../db/client";

export async function auditLog(
  db: Queryable,
  entry: {
    restaurantId?: string | null;
    actor: string; // user email, 'ai', or 'system'
    action: string;
    entityType: string;
    entityId?: string;
    changes?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (restaurant_id, actor, action, entity_type, entity_id, changes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.restaurantId ?? null,
      entry.actor,
      entry.action,
      entry.entityType,
      entry.entityId ?? "",
      JSON.stringify(entry.changes ?? {}),
    ],
  );
}
