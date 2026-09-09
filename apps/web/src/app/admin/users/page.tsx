"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "@meatbox/core";

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"owner" | "staff">("staff");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/users", { cache: "no-store" });
    if (res.ok) setUsers(((await res.json()) as { users: User[] }).users);
    else setError("Only the owner login can manage users.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-2xl">
      <h1 className="mb-4 text-2xl font-bold">Users</h1>
      {error && <p className="mb-4 text-red-600">{error}</p>}

      <ul className="mb-8 space-y-2">
        {users.map((u) => (
          <li key={u.id} className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow">
            <div className="flex-1">
              <p className="font-semibold">{u.name || u.email}</p>
              <p className="text-sm text-stone-500">
                {u.email} · {u.role}
              </p>
            </div>
            <button
              onClick={async () => {
                await fetch(`/api/users/${u.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ active: !u.active }),
                });
                void load();
              }}
              className={`rounded-lg px-3 py-2 text-sm font-bold ${
                u.active ? "bg-green-100 text-green-800" : "bg-stone-200 text-stone-500"
              }`}
            >
              {u.active ? "Active" : "Disabled"}
            </button>
          </li>
        ))}
      </ul>

      <div className="rounded-2xl bg-white p-5 shadow">
        <h2 className="mb-3 font-bold">Add user</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="rounded-lg border border-stone-300 p-2"
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="rounded-lg border border-stone-300 p-2"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (10+ characters)"
            type="password"
            className="rounded-lg border border-stone-300 p-2"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "owner" | "staff")}
            className="rounded-lg border border-stone-300 p-2"
          >
            <option value="staff">Staff (orders + menu)</option>
            <option value="owner">Owner (everything)</option>
          </select>
        </div>
        <button
          onClick={async () => {
            const res = await fetch("/api/users", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, name, password, role }),
            });
            if (res.ok) {
              setEmail("");
              setName("");
              setPassword("");
              void load();
            } else {
              alert(((await res.json()) as { error?: string }).error ?? "Failed");
            }
          }}
          className="mt-3 rounded-lg bg-orange-600 px-5 py-2 font-semibold text-white"
        >
          Add user
        </button>
      </div>
    </div>
  );
}
