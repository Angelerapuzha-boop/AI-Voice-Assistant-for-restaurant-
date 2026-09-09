import {
  describeDay,
  formatCents,
  getActiveSpecials,
  getDefaultRestaurant,
  getHours,
  listCategories,
  listItems,
  localClock,
  openStateAt,
} from "@meatbox/core";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function PublicMenuPage() {
  const restaurant = await getDefaultRestaurant(db());
  const [categories, items, specials, hours] = await Promise.all([
    listCategories(db(), restaurant.id),
    listItems(db(), restaurant.id),
    getActiveSpecials(db(), restaurant.id),
    getHours(db(), restaurant.id),
  ]);
  const state = openStateAt(hours, new Date(), restaurant.timezone);
  const clock = localClock(new Date(), restaurant.timezone);
  const phoneHref = `tel:${restaurant.phoneDisplay.replace(/[^0-9+]/g, "")}`;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-24">
      <header className="bg-stone-900 -mx-4 mb-6 px-6 py-10 text-center text-white">
        <h1 className="text-4xl font-extrabold tracking-tight">MEATBOX WA</h1>
        <p className="mt-2 text-stone-300">
          Charcoal chicken · kebabs · grill — {restaurant.address}
        </p>
        <p className="mt-2 text-sm">
          <span
            className={`inline-block rounded-full px-3 py-1 font-semibold ${state.open ? "bg-green-600" : "bg-stone-600"}`}
          >
            {state.open ? "Open now" : "Closed"} · Today {describeDay(hours, clock.dayOfWeek)}
          </span>
        </p>
        <a
          href={phoneHref}
          className="mt-5 inline-block rounded-xl bg-orange-600 px-8 py-4 text-xl font-bold shadow-lg hover:bg-orange-700"
        >
          📞 CALL TO ORDER · {restaurant.phoneDisplay}
        </a>
        <p className="mt-3 text-xs text-stone-400">
          Our AI assistant answers, takes your order and the kitchen starts straight away.
        </p>
      </header>

      {specials.length > 0 && (
        <section className="mb-8 rounded-2xl border-2 border-orange-500 bg-orange-50 p-5">
          <h2 className="text-lg font-bold text-orange-700">Today&apos;s Specials</h2>
          {specials.map((s) => (
            <div key={s.id} className="mt-3 flex items-baseline justify-between gap-4">
              <div>
                <p className="font-semibold">{s.name}</p>
                {s.description && (
                  <p className="text-sm text-stone-600">{s.description.replace(/\[.*?\]/g, "")}</p>
                )}
              </div>
              <p className="text-lg font-bold text-orange-700">{formatCents(s.priceCents)}</p>
            </div>
          ))}
        </section>
      )}

      {categories.map((category) => {
        const catItems = items.filter((i) => i.categoryId === category.id);
        if (catItems.length === 0) return null;
        return (
          <section key={category.id} className="mb-8">
            <h2 className="mb-3 border-b-2 border-stone-900 pb-1 text-xl font-bold uppercase tracking-wide">
              {category.name}
            </h2>
            <ul className="space-y-3">
              {catItems.map((item) => (
                <li key={item.id} className="flex items-baseline justify-between gap-4">
                  <div>
                    <p className="font-semibold">
                      {item.name}
                      {item.isVegetarian && (
                        <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">
                          V
                        </span>
                      )}
                      {(item.isSoldOut || !item.isAvailable) && (
                        <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-xs font-medium text-stone-600">
                          Sold out
                        </span>
                      )}
                    </p>
                    {item.description && (
                      <p className="text-sm text-stone-500">
                        {item.description.replace(/\[.*?\]/g, "")}
                      </p>
                    )}
                  </div>
                  <p className="whitespace-nowrap font-bold">{formatCents(item.priceCents)}</p>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <footer className="mt-12 border-t pt-6 text-center text-sm text-stone-500">
        <p>{restaurant.address}</p>
        <p className="mt-1">Open 7 days · {describeDay(hours, clock.dayOfWeek)}</p>
        <a href={phoneHref} className="mt-3 inline-block font-semibold text-orange-700">
          Call {restaurant.phoneDisplay} to order
        </a>
      </footer>
    </main>
  );
}
