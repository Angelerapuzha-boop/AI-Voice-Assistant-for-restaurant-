"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MenuCategory, MenuItem, ModifierGroupWithModifiers, Order } from "@meatbox/core";

type ItemWithGroups = MenuItem & { groups: ModifierGroupWithModifiers[] };

interface CartLine {
  key: string;
  item: ItemWithGroups;
  quantity: number;
  modifierIds: string[];
  removals: string[];
  note: string;
}

const CATEGORY_EMOJI: Record<string, string> = {
  meatbox: "🍱",
  kebabs: "🌯",
  "charcoal-chicken": "🍗",
  grill: "🍢",
  burgers: "🍔",
  "gozleme-manakish": "🫓",
  "fish-chips": "🐟",
  sides: "🍟",
  dips: "🥣",
  drinks: "🥤",
  "bubble-tea": "🧋",
};

function emoji(slug: string): string {
  return CATEGORY_EMOJI[slug] ?? "🍽️";
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function lineTotal(line: CartLine): number {
  const mods = line.item.groups
    .flatMap((g) => g.modifiers)
    .filter((m) => line.modifierIds.includes(m.id))
    .reduce((sum, m) => sum + m.priceCents, 0);
  return (line.item.priceCents + mods) * line.quantity;
}

export default function PosScreen() {
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<ItemWithGroups[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderType, setOrderType] = useState<"takeaway" | "dine_in">("takeaway");
  const [customerName, setCustomerName] = useState("");
  const [configuring, setConfiguring] = useState<ItemWithGroups | null>(null);
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ number: string; total: number } | null>(null);
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<Order[]>([]);

  const loadRecent = useCallback(async () => {
    const res = await fetch("/api/orders?today=1", { cache: "no-store" });
    if (res.ok) setRecent(((await res.json()) as { orders: Order[] }).orders.slice(0, 8));
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/menu", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { categories: MenuCategory[]; items: ItemWithGroups[] };
        setCategories(body.categories);
        setItems(body.items);
        if (body.categories[0]) setActiveCategory(body.categories[0].id);
      }
    })();
    void loadRecent();
    const poll = setInterval(() => void loadRecent(), 15000);
    return () => clearInterval(poll);
  }, [loadRecent]);

  const total = useMemo(() => cart.reduce((sum, line) => sum + lineTotal(line), 0), [cart]);
  const activeSlug = categories.find((c) => c.id === activeCategory)?.slug ?? "";

  function addLine(item: ItemWithGroups, modifierIds: string[], quantity: number, note: string) {
    setCart((prev) => [
      ...prev,
      { key: `${item.id}-${Date.now()}`, item, quantity, modifierIds, removals: [], note },
    ]);
  }

  function tapItem(item: ItemWithGroups) {
    if (!item.isAvailable || item.isSoldOut) return;
    const needsChoice = item.groups.some((g) => g.required || g.minSelect > 0);
    if (needsChoice || item.groups.length > 0) setConfiguring(item);
    else addLine(item, [], 1, "");
  }

  async function charge(paymentMethod: "cash" | "card" | "tap") {
    setBusy(true);
    setError("");
    const res = await fetch("/api/pos/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderType,
        customerName: customerName || undefined,
        paymentMethod,
        items: cart.map((line) => ({
          menuItemId: line.item.id,
          quantity: line.quantity,
          modifierIds: line.modifierIds,
          removals: line.removals,
          specialInstructions: line.note || undefined,
        })),
      }),
    });
    setBusy(false);
    const body = (await res.json().catch(() => ({}))) as {
      order?: { publicOrderNumber: string; totalCents: number };
      error?: string;
    };
    if (!res.ok || !body.order) {
      setError(body.error ?? "Order failed — nothing was charged.");
      setPaying(false);
      return;
    }
    setPaying(false);
    setCart([]);
    setCustomerName("");
    setDone({ number: body.order.publicOrderNumber, total: body.order.totalCents });
    void loadRecent();
    setTimeout(() => setDone(null), 3500);
  }

  return (
    <main className="flex h-screen bg-stone-950 text-white">
      {/* left rail: logo, categories, recent orders, nav — opposite the checkout */}
      <aside className="flex w-56 flex-none flex-col border-r border-stone-800 bg-stone-900">
        <p className="px-4 pb-2 pt-4 text-xl font-extrabold tracking-wide">
          <span className="text-orange-500">🔥</span> MEATBOX
        </p>
        <nav className="flex-1 space-y-1 overflow-y-auto px-2">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCategory(c.id)}
              className={`block w-full rounded-xl px-4 py-4 text-left text-base font-bold ${
                activeCategory === c.id
                  ? "bg-orange-600 text-white"
                  : "text-stone-300 active:bg-stone-800"
              }`}
            >
              {emoji(c.slug)} {c.name}
            </button>
          ))}
        </nav>
        {recent.length > 0 && (
          <div className="max-h-44 overflow-y-auto border-t border-stone-800 px-3 py-2">
            <p className="pb-1 text-[10px] font-bold uppercase tracking-wider text-stone-500">
              Recent orders
            </p>
            <ul className="space-y-1 text-xs">
              {recent.map((o) => (
                <li
                  key={o.id}
                  className={`flex items-center gap-1.5 rounded-lg px-2 py-1 ${
                    o.status === "new" ? "bg-red-600" : "bg-stone-800 text-stone-300"
                  }`}
                  title={`${o.customerName} · ${dollars(o.totalCents)}`}
                >
                  <span>{o.source === "pos" ? "🧾" : "📞"}</span>
                  <span className="font-bold">{o.publicOrderNumber ?? "…"}</span>
                  <span className="ml-auto">{o.status.replace("_", " ")}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 border-t border-stone-800 p-3">
          <a href="/kitchen" className="rounded-lg bg-stone-800 py-3 text-center text-sm font-bold">
            🍳 Kitchen
          </a>
          <a href="/admin" className="rounded-lg bg-stone-800 py-3 text-center text-sm font-bold">
            Admin
          </a>
        </div>
      </aside>

      {/* tiles */}
      <section className="flex flex-1 flex-col overflow-hidden">
        <div className="grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto p-3 lg:grid-cols-3 2xl:grid-cols-4">
            {items
              .filter((i) => i.categoryId === activeCategory)
              .map((item) => {
                const off = !item.isAvailable || item.isSoldOut;
                return (
                  <button
                    key={item.id}
                    onClick={() => tapItem(item)}
                    disabled={off}
                    className={`relative flex aspect-[4/3] min-h-44 flex-col justify-end overflow-hidden rounded-2xl p-4 text-left shadow-lg transition ${
                      off ? "bg-stone-900 text-stone-500" : "bg-stone-800 active:scale-95 active:ring-4 active:ring-orange-500"
                    }`}
                  >
                    {item.imageUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={item.imageUrl}
                          alt=""
                          loading="lazy"
                          className={`absolute inset-0 h-full w-full object-cover ${off ? "opacity-20 grayscale" : ""}`}
                        />
                        <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/95 via-black/60 to-transparent" />
                      </>
                    ) : (
                      <span className="absolute left-4 top-4 text-4xl">{emoji(activeSlug)}</span>
                    )}
                    <span className="relative text-base font-bold leading-tight drop-shadow">
                      {item.name}
                    </span>
                    <span
                      className={`relative text-lg font-extrabold drop-shadow ${off ? "text-red-400" : "text-orange-400"}`}
                    >
                      {off ? "SOLD OUT" : dollars(item.priceCents)}
                    </span>
                  </button>
                );
              })}
          </div>
        </section>

        {/* cart */}
        <aside className="flex w-80 flex-col border-l border-stone-800 bg-stone-900">
          <div className="flex gap-2 p-3">
            {(["takeaway", "dine_in"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setOrderType(t)}
                className={`flex-1 rounded-xl py-3 text-sm font-extrabold ${
                  orderType === t ? "bg-orange-600" : "bg-stone-800 text-stone-400"
                }`}
              >
                {t === "takeaway" ? "🥡 TAKEAWAY" : "🍽 DINE-IN"}
              </button>
            ))}
          </div>
          <input
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="Customer name (optional)"
            className="mx-3 rounded-lg bg-stone-800 p-2 text-sm placeholder-stone-500"
          />
          <ul className="flex-1 space-y-2 overflow-y-auto p-3">
            {cart.length === 0 && (
              <li className="pt-10 text-center text-stone-600">Tap items to add</li>
            )}
            {cart.map((line) => (
              <li key={line.key} className="rounded-xl bg-stone-800 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold">{line.item.name}</span>
                  <span className="text-sm font-extrabold text-orange-400">
                    {dollars(lineTotal(line))}
                  </span>
                </div>
                {line.modifierIds.length > 0 && (
                  <p className="text-xs text-stone-400">
                    {line.item.groups
                      .flatMap((g) => g.modifiers)
                      .filter((m) => line.modifierIds.includes(m.id))
                      .map((m) => m.name)
                      .join(" · ")}
                  </p>
                )}
                {line.note && <p className="text-xs italic text-stone-400">“{line.note}”</p>}
                <div className="mt-1 flex items-center gap-2">
                  <button
                    onClick={() =>
                      setCart((prev) =>
                        prev
                          .map((l) =>
                            l.key === line.key ? { ...l, quantity: l.quantity - 1 } : l,
                          )
                          .filter((l) => l.quantity > 0),
                      )
                    }
                    className="h-11 w-11 rounded-lg bg-stone-700 text-lg font-extrabold"
                  >
                    −
                  </button>
                  <span className="w-7 text-center text-lg font-bold">{line.quantity}</span>
                  <button
                    onClick={() =>
                      setCart((prev) =>
                        prev.map((l) =>
                          l.key === line.key ? { ...l, quantity: l.quantity + 1 } : l,
                        ),
                      )
                    }
                    className="h-11 w-11 rounded-lg bg-stone-700 text-lg font-extrabold"
                  >
                    +
                  </button>
                  <button
                    onClick={() => setCart((prev) => prev.filter((l) => l.key !== line.key))}
                    className="ml-auto text-xs text-stone-500 hover:text-red-400"
                  >
                    remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {error && <p className="px-3 pb-2 text-sm text-red-400">{error}</p>}
          <button
            onClick={() => cart.length > 0 && setPaying(true)}
            disabled={cart.length === 0 || busy}
            className="m-3 rounded-2xl bg-orange-600 py-5 text-xl font-extrabold shadow-lg hover:bg-orange-500 disabled:opacity-40"
          >
            CHARGE {dollars(total)}
          </button>
        </aside>

      {/* item options modal */}
      {configuring && (
        <ItemModal
          item={configuring}
          onClose={() => setConfiguring(null)}
          onAdd={(modifierIds, quantity, note) => {
            addLine(configuring, modifierIds, quantity, note);
            setConfiguring(null);
          }}
        />
      )}

      {/* payment modal */}
      {paying && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-3xl bg-stone-900 p-6">
            <p className="text-center text-3xl font-extrabold">{dollars(total)}</p>
            <p className="mb-5 text-center text-sm text-stone-400">
              {orderType === "takeaway" ? "Takeaway" : "Dine-in"}
              {customerName ? ` · ${customerName}` : ""}
            </p>
            <div className="grid grid-cols-3 gap-3">
              <button
                onClick={() => void charge("tap")}
                disabled={busy}
                className="rounded-2xl bg-green-600 py-6 text-center font-extrabold hover:bg-green-500"
              >
                📱<br />TAP
              </button>
              <button
                onClick={() => void charge("card")}
                disabled={busy}
                className="rounded-2xl bg-blue-600 py-6 text-center font-extrabold hover:bg-blue-500"
              >
                💳<br />CARD
              </button>
              <button
                onClick={() => void charge("cash")}
                disabled={busy}
                className="rounded-2xl bg-stone-700 py-6 text-center font-extrabold hover:bg-stone-600"
              >
                💵<br />CASH
              </button>
            </div>
            <p className="mt-3 text-center text-xs text-stone-500">
              Take payment on your card machine, then tap the method used.
            </p>
            <button
              onClick={() => setPaying(false)}
              disabled={busy}
              className="mt-4 w-full rounded-xl bg-stone-800 py-3 font-bold text-stone-400"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {/* success overlay */}
      {done && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
          <div className="rounded-3xl bg-green-600 px-12 py-10 text-center shadow-2xl">
            <p className="text-6xl">✓</p>
            <p className="mt-2 text-3xl font-extrabold">{done.number}</p>
            <p className="text-lg">{dollars(done.total)} — sent to kitchen</p>
          </div>
        </div>
      )}
    </main>
  );
}

function ItemModal({
  item,
  onClose,
  onAdd,
}: {
  item: ItemWithGroups;
  onClose: () => void;
  onAdd: (modifierIds: string[], quantity: number, note: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  function toggle(group: ModifierGroupWithModifiers, modId: string) {
    setError("");
    setSelected((prev) => {
      const groupModIds = group.modifiers.map((m) => m.id);
      const inGroup = prev.filter((id) => groupModIds.includes(id));
      if (prev.includes(modId)) return prev.filter((id) => id !== modId);
      if (group.maxSelect === 1) {
        return [...prev.filter((id) => !groupModIds.includes(id)), modId];
      }
      if (inGroup.length >= group.maxSelect) return prev;
      return [...prev, modId];
    });
  }

  function submit() {
    for (const group of item.groups) {
      const count = group.modifiers.filter((m) => selected.includes(m.id)).length;
      const minimum = group.required ? Math.max(1, group.minSelect) : group.minSelect;
      if (count < minimum) {
        setError(`Choose a ${group.name}`);
        return;
      }
    }
    onAdd(selected, quantity, note.trim());
  }

  const extra = item.groups
    .flatMap((g) => g.modifiers)
    .filter((m) => selected.includes(m.id))
    .reduce((sum, m) => sum + m.priceCents, 0);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-stone-900 p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-extrabold">{item.name}</h2>
          <span className="font-extrabold text-orange-400">{dollars(item.priceCents)}</span>
        </div>
        {item.groups.map((group) => (
          <div key={group.id} className="mt-4">
            <p className="mb-2 text-sm font-bold text-stone-300">
              {group.name}
              {(group.required || group.minSelect > 0) && (
                <span className="ml-2 rounded bg-orange-600 px-1.5 text-xs">REQUIRED</span>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {group.modifiers
                .filter((m) => m.isAvailable)
                .map((mod) => (
                  <button
                    key={mod.id}
                    onClick={() => toggle(group, mod.id)}
                    className={`rounded-xl px-4 py-3 text-base font-semibold ${
                      selected.includes(mod.id)
                        ? "bg-orange-600"
                        : "bg-stone-800 text-stone-300 active:bg-stone-700"
                    }`}
                  >
                    {mod.name}
                    {mod.priceCents > 0 && ` +${dollars(mod.priceCents)}`}
                  </button>
                ))}
            </div>
          </div>
        ))}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (e.g. no onion, extra crispy)"
          className="mt-4 w-full rounded-lg bg-stone-800 p-2 text-sm placeholder-stone-500"
        />
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            className="h-10 w-10 rounded-xl bg-stone-700 text-xl font-extrabold"
          >
            −
          </button>
          <span className="w-8 text-center text-xl font-extrabold">{quantity}</span>
          <button
            onClick={() => setQuantity((q) => q + 1)}
            className="h-10 w-10 rounded-xl bg-stone-700 text-xl font-extrabold"
          >
            +
          </button>
          {error && <span className="text-sm text-red-400">{error}</span>}
          <button
            onClick={submit}
            className="ml-auto rounded-xl bg-orange-600 px-5 py-3 font-extrabold hover:bg-orange-500"
          >
            ADD {dollars((item.priceCents + extra) * quantity)}
          </button>
        </div>
        <button onClick={onClose} className="mt-3 w-full rounded-xl bg-stone-800 py-2 text-stone-400">
          Cancel
        </button>
      </div>
    </div>
  );
}
