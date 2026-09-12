import { z } from "zod";
import {
  auditLog,
  createSupplier,
  getDefaultRestaurant,
  listInventory,
  listReplenishments,
  listSuppliers,
  updateSupplier,
} from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  const [suppliers, inventory, replenishments] = await Promise.all([
    listSuppliers(db(), restaurant.id),
    listInventory(db(), restaurant.id),
    listReplenishments(db(), restaurant.id),
  ]);
  return Response.json({
    suppliers: suppliers.map((s) => ({
      ...s,
      items: inventory.filter((i) => i.supplierId === s.id).map((i) => ({ id: i.id, name: i.name, autoReplenish: i.autoReplenish })),
    })),
    replenishments,
  });
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  contactName: z.string().max(120).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().max(200).optional(),
  notes: z.string().max(500).optional(),
  smsEnabled: z.boolean().optional(),
  callEnabled: z.boolean().optional(),
});

export const POST = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  const restaurant = await getDefaultRestaurant(db());
  const supplier = await createSupplier(db(), { restaurantId: restaurant.id, ...parsed.data });
  await auditLog(db(), {
    restaurantId: restaurant.id,
    actor: user.email,
    action: "supplier.created",
    entityType: "supplier",
    entityId: supplier.id,
    changes: parsed.data,
  });
  return Response.json({ supplier });
});

const patchSchema = createSchema.partial().extend({
  id: z.string().uuid(),
  active: z.boolean().optional(),
});

export const PATCH = guarded(async (req: Request) => {
  const user = await requireUser();
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  const { id, ...patch } = parsed.data;
  const supplier = await updateSupplier(db(), id, patch);
  if (!supplier) return Response.json({ error: "not found" }, { status: 404 });
  const restaurant = await getDefaultRestaurant(db());
  await auditLog(db(), {
    restaurantId: restaurant.id,
    actor: user.email,
    action: "supplier.updated",
    entityType: "supplier",
    entityId: id,
    changes: patch,
  });
  return Response.json({ supplier });
});
