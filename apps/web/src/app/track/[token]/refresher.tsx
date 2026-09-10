"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refresh the tracking page every 10s while the order is still moving. */
export default function TrackRefresher({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
