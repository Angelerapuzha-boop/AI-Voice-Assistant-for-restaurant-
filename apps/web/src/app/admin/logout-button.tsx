"use client";

import { useRouter } from "next/navigation";

export default function LogoutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.push("/login");
        router.refresh();
      }}
      className="whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm text-stone-400 hover:bg-stone-800 hover:text-white"
    >
      Sign out
    </button>
  );
}
