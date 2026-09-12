import { guarded, requireUser } from "@/lib/session";
import { fetchGovNews } from "@/lib/gov-news";

export const GET = guarded(async () => {
  await requireUser();
  return Response.json(await fetchGovNews());
});
