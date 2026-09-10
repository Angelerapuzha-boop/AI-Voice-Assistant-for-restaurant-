import Kiosk from "./kiosk";

export const dynamic = "force-dynamic";

/**
 * Public collection kiosk (spec 14). Retrieval is verified (order number +
 * pickup code), responses never confirm whether a customer exists, payment
 * evidence only ever comes from the server-side provider, and the kiosk can
 * NEVER mark an order collected — handover stays a staff action.
 */
export default function CollectionPage() {
  return <Kiosk />;
}
