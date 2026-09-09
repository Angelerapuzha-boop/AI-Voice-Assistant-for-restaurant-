import { Suspense } from "react";
import IntegrationsClient from "./integrations-client";

export const dynamic = "force-dynamic";

export default function IntegrationsPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <IntegrationsClient />
    </Suspense>
  );
}
