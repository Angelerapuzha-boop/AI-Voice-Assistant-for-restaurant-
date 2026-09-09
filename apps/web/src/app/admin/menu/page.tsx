"use client";

import { useCallback, useEffect, useState } from "react";
import type { MenuCategory, MenuItem, ModifierGroupWithModifiers } from "@meatbox/core";

type ItemWithGroups = MenuItem & { groups: ModifierGroupWithModifiers[] };

interface MenuData {
  categories: MenuCategory[];
  items: ItemWithGroups[];
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function toCents(value: string): number | null {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}

async function api(path: string, method: string, body?: unknown): Promise<boolean> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    alert(data.error ?? `Request failed (${res.status})`);
  }
  return res.ok;
}

export default function MenuAdminPage() {
  const [data, setData] = useState<MenuData | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/menu", { cache: "no-store" });
    if (res.ok) setData((await res.json()) as MenuData);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <p>Loading menu…</p>;

  return (
    <div className="max-w-4xl">
      <h1 className="mb-2 text-2xl font-bold">Menu</h1>
      <p className="mb-6 text-sm text-stone-500">
        The AI reads this menu live — availability and price changes apply to the next call
        immediately. Items marked [rep] in their description were seeded with representative
        prices and need review.
      </p>

      {data.categories.map((category) => (
        <CategorySection
          key={category.id}
          category={category}
          items={data.items.filter((i) => i.categoryId === category.id)}
          expanded={expanded}
          setExpanded={setExpanded}
          reload={load}
        />
      ))}

      <div className="mt-8 flex gap-2">
        <input
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value)}
          placeholder="New category name"
          className="rounded-lg border border-stone-300 p-2"
        />
        <button
          onClick={async () => {
            if (!newCategory.trim()) return;
            if (await api("/api/menu/categories", "POST", { name: newCategory.trim() })) {
              setNewCategory("");
              void load();
            }
          }}
          className="rounded-lg bg-stone-900 px-4 py-2 font-semibold text-white"
        >
          Add category
        </button>
      </div>
    </div>
  );
}

function CategorySection({
  category,
  items,
  expanded,
  setExpanded,
  reload,
}: {
  category: MenuCategory;
  items: ItemWithGroups[];
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  reload: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");

  return (
    <section className="mb-6 rounded-2xl bg-white p-4 shadow">
      <h2 className="mb-3 text-lg font-bold uppercase tracking-wide">{category.name}</h2>
      <ul className="divide-y">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            open={expanded === item.id}
            toggleOpen={() => setExpanded(expanded === item.id ? null : item.id)}
            reload={reload}
          />
        ))}
      </ul>
      {adding ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Item name"
            className="rounded-lg border border-stone-300 p-2"
          />
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Price e.g. 19.95"
            className="w-32 rounded-lg border border-stone-300 p-2"
          />
          <button
            onClick={async () => {
              const cents = toCents(price);
              if (!name.trim() || cents === null) {
                alert("Name and a valid price are required.");
                return;
              }
              if (
                await api("/api/menu/items", "POST", {
                  categoryId: category.id,
                  name: name.trim(),
                  priceCents: cents,
                })
              ) {
                setName("");
                setPrice("");
                setAdding(false);
                void reload();
              }
            }}
            className="rounded-lg bg-green-600 px-3 py-2 font-semibold text-white"
          >
            Save
          </button>
          <button onClick={() => setAdding(false)} className="px-2 text-sm text-stone-500">
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-3 text-sm font-semibold text-orange-700"
        >
          + Add item
        </button>
      )}
    </section>
  );
}

function ItemRow({
  item,
  open,
  toggleOpen,
  reload,
}: {
  item: ItemWithGroups;
  open: boolean;
  toggleOpen: () => void;
  reload: () => Promise<void>;
}) {
  const [price, setPrice] = useState(dollars(item.priceCents));
  const [description, setDescription] = useState(item.description);
  const [aliases, setAliases] = useState(item.aliases.join(", "));
  const [imageUrl, setImageUrl] = useState(item.imageUrl);

  async function patch(body: Record<string, unknown>) {
    if (await api(`/api/menu/items/${item.id}`, "PATCH", body)) void reload();
  }

  const soldOut = item.isSoldOut || !item.isAvailable;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        {item.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.imageUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
        )}
        <button onClick={toggleOpen} className="flex-1 text-left">
          <span className="font-semibold">{item.name}</span>
          {item.isVegetarian && <span className="ml-2 text-xs text-green-700">V</span>}
          {item.isPopular && <span className="ml-2 text-xs text-orange-600">★ popular</span>}
        </button>
        <span className="font-bold">${dollars(item.priceCents)}</span>
        <button
          onClick={() => patch({ isSoldOut: !item.isSoldOut })}
          className={`rounded-lg px-3 py-2 text-sm font-bold ${
            soldOut ? "bg-red-600 text-white" : "bg-green-100 text-green-800"
          }`}
        >
          {soldOut ? "SOLD OUT" : "AVAILABLE"}
        </button>
      </div>

      {open && (
        <div className="mt-3 rounded-xl bg-stone-50 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm">
              Price ($)
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                onBlur={() => {
                  const cents = toCents(price);
                  if (cents !== null && cents !== item.priceCents) void patch({ priceCents: cents });
                }}
                className="mt-1 w-full rounded-lg border border-stone-300 p-2"
              />
            </label>
            <label className="block text-sm">
              Spoken aliases (comma-separated, help the AI match speech)
              <input
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                onBlur={() =>
                  void patch({
                    aliases: aliases
                      .split(",")
                      .map((a) => a.trim())
                      .filter(Boolean),
                  })
                }
                className="mt-1 w-full rounded-lg border border-stone-300 p-2"
              />
            </label>
          </div>
          <label className="mt-3 block text-sm">
            Photo URL (shown on the website and POS; /menu/… for bundled photos)
            <input
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              onBlur={() => {
                if (imageUrl !== item.imageUrl) void patch({ imageUrl });
              }}
              className="mt-1 w-full rounded-lg border border-stone-300 p-2"
            />
          </label>
          <label className="mt-3 block text-sm">
            Description (the AI reads this to callers)
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                if (description !== item.description) void patch({ description });
              }}
              className="mt-1 w-full rounded-lg border border-stone-300 p-2"
              rows={2}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <Toggle
              label="Vegetarian"
              on={item.isVegetarian}
              onClick={() => patch({ isVegetarian: !item.isVegetarian })}
            />
            <Toggle
              label="Popular"
              on={item.isPopular}
              onClick={() => patch({ isPopular: !item.isPopular })}
            />
            <button
              onClick={() => {
                if (confirm(`Remove "${item.name}" from the menu? Order history is kept.`)) {
                  void patch({ active: false });
                }
              }}
              className="ml-auto rounded-lg px-3 py-1 text-red-600 hover:bg-red-50"
            >
              Remove from menu
            </button>
          </div>

          <GroupsEditor item={item} reload={reload} />
        </div>
      )}
    </li>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-3 py-1 font-medium ${on ? "bg-stone-900 text-white" : "bg-stone-200"}`}
    >
      {label}
    </button>
  );
}

function GroupsEditor({ item, reload }: { item: ItemWithGroups; reload: () => Promise<void> }) {
  const [groupName, setGroupName] = useState("");

  return (
    <div className="mt-4 border-t pt-3">
      <p className="mb-2 text-sm font-bold">Options</p>
      {item.groups.map((group) => (
        <div key={group.id} className="mb-3 rounded-lg border border-stone-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{group.name}</span>
            <button
              onClick={async () => {
                if (await api(`/api/menu/groups/${group.id}`, "PATCH", { required: !group.required }))
                  void reload();
              }}
              className={`rounded px-2 py-0.5 text-xs font-bold ${
                group.required ? "bg-orange-600 text-white" : "bg-stone-200"
              }`}
            >
              {group.required ? "REQUIRED" : "optional"}
            </button>
            <span className="text-xs text-stone-500">max {group.maxSelect}</span>
            <button
              onClick={async () => {
                if (confirm(`Delete option group "${group.name}"?`)) {
                  if (await api(`/api/menu/groups/${group.id}`, "DELETE")) void reload();
                }
              }}
              className="ml-auto text-xs text-red-600"
            >
              delete
            </button>
          </div>
          <ul className="mt-2 space-y-1">
            {group.modifiers.map((mod) => (
              <li key={mod.id} className="flex items-center gap-2 text-sm">
                <span>{mod.name}</span>
                {mod.priceCents > 0 && (
                  <span className="text-stone-500">+${dollars(mod.priceCents)}</span>
                )}
                <button
                  onClick={async () => {
                    if (
                      await api(`/api/menu/modifiers/${mod.id}`, "PATCH", {
                        isAvailable: !mod.isAvailable,
                      })
                    )
                      void reload();
                  }}
                  className={`rounded px-2 py-0.5 text-xs ${
                    mod.isAvailable ? "bg-green-100 text-green-800" : "bg-red-100 text-red-700"
                  }`}
                >
                  {mod.isAvailable ? "available" : "unavailable"}
                </button>
                <button
                  onClick={async () => {
                    if (await api(`/api/menu/modifiers/${mod.id}`, "DELETE")) void reload();
                  }}
                  className="text-xs text-stone-400 hover:text-red-600"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <AddModifier groupId={group.id} reload={reload} />
        </div>
      ))}
      <div className="flex gap-2">
        <input
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          placeholder="New option group (e.g. Sauces)"
          className="rounded-lg border border-stone-300 p-2 text-sm"
        />
        <button
          onClick={async () => {
            if (!groupName.trim()) return;
            if (
              await api("/api/menu/groups", "POST", {
                menuItemId: item.id,
                name: groupName.trim(),
                maxSelect: 3,
              })
            ) {
              setGroupName("");
              void reload();
            }
          }}
          className="rounded-lg bg-stone-200 px-3 py-2 text-sm font-semibold"
        >
          + Group
        </button>
      </div>
    </div>
  );
}

function AddModifier({ groupId, reload }: { groupId: string; reload: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  return (
    <div className="mt-2 flex gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Option name"
        className="rounded border border-stone-300 p-1 text-sm"
      />
      <input
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        placeholder="+$ (blank = free)"
        className="w-28 rounded border border-stone-300 p-1 text-sm"
      />
      <button
        onClick={async () => {
          if (!name.trim()) return;
          const cents = price.trim() ? toCents(price) : 0;
          if (cents === null) {
            alert("Invalid price");
            return;
          }
          if (
            await api("/api/menu/modifiers", "POST", {
              groupId,
              name: name.trim(),
              priceCents: cents,
            })
          ) {
            setName("");
            setPrice("");
            void reload();
          }
        }}
        className="rounded bg-stone-200 px-2 py-1 text-sm"
      >
        Add
      </button>
    </div>
  );
}
