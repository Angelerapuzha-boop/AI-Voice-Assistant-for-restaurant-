import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import PosScreen from "./pos-screen";

export const dynamic = "force-dynamic";

export default async function PosPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return <PosScreen />;
}
