import PaymentsTable from "./payments-table";

export const dynamic = "force-dynamic";

export default function PaymentsPage() {
  return (
    <div>
      <h1 className="text-2xl font-extrabold">Payments</h1>
      <p className="mt-1 text-sm text-stone-500">
        The reconciled ledger — every terminal, cash and counter payment, with refunds. Paid
        status always derives from these rows, never from a button click.
      </p>
      <PaymentsTable />
    </div>
  );
}
