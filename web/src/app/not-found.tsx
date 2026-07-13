"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Any unmatched path just bounces back to the catalog — silently, no toast.
export default function NotFound() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return null;
}
