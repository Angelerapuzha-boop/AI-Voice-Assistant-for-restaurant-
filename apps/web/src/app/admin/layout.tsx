import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import LogoutButton from "./logout-button";

const NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/pos", label: "🧾 POS / Cashier" },
  { href: "/kitchen", label: "🍳 Kitchen view" },
  { href: "/collection", label: "🖥 Pickup kiosk" },
  { href: "/board", label: "📺 Ready board" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/insights", label: "📊 Daily insights" },
  { href: "/admin/inventory", label: "📦 Inventory" },
  { href: "/admin/suppliers", label: "🚚 Suppliers" },
  { href: "/admin/payments", label: "Payments" },
  { href: "/admin/menu", label: "Menu" },
  { href: "/admin/specials", label: "Daily specials" },
  { href: "/admin/hours", label: "Hours" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/voice", label: "Voice assistant" },
  { href: "/admin/integrations", label: "Integrations" },
  { href: "/admin/simulator", label: "Test AI" },
  { href: "/admin/browser-call", label: "Call from browser" },
  { href: "/admin/calls", label: "Call logs" },
  { href: "/admin/voice-quality", label: "Voice quality" },
  { href: "/admin/analytics", label: "Analytics" },
  { href: "/admin/users", label: "Users" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-stone-200 bg-stone-900 text-white md:min-h-screen md:w-56 md:border-b-0">
        <div className="p-4">
          <p className="text-lg font-extrabold">MEATBOX WA</p>
          <p className="text-xs text-stone-400">{user.email}</p>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col md:pb-0">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap rounded-lg px-3 py-2 text-sm text-stone-300 hover:bg-stone-800 hover:text-white"
            >
              {item.label}
            </Link>
          ))}
          <LogoutButton />
        </nav>
      </aside>
      <main className="flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
