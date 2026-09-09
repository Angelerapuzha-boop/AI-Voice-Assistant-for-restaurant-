import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import KitchenBoard from "./board";

export const dynamic = "force-dynamic";

export default async function KitchenPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return <KitchenBoard />;
}
