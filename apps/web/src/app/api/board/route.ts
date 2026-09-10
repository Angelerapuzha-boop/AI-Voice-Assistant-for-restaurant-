import { getDefaultRestaurant, readyBoard } from "@meatbox/core";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Public ready board feed: order numbers only, never names or phones. */
export async function GET() {
  const restaurant = await getDefaultRestaurant(db());
  const board = await readyBoard(db(), restaurant.id);
  return Response.json(board, { headers: { "Cache-Control": "no-store" } });
}
