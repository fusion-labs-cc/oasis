"use client";

import { useEffect, useState } from "react";
import { fetchSupportedSites, SupportedSite } from "@/lib/api";
import { useBackend } from "@/context/BackendContext";

// Module-level cache so the several places that render this list (main-page
// hero, add-video modal) share a single backend request and later mounts paint
// instantly. A failed fetch clears the in-flight promise so a later mount retries.
let cache: SupportedSite[] | null = null;
let inflight: Promise<SupportedSite[]> | null = null;

function loadOnce(): Promise<SupportedSite[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetchSupportedSites()
      .then((sites) => {
        cache = sites;
        return sites;
      })
      .catch((e) => {
        inflight = null;
        throw e;
      });
  }
  return inflight;
}

/**
 * The list of sites Oasis can analyse/download, rendered as small chips.
 * Self-fetching and cached; renders nothing until (and unless) the list loads,
 * so it degrades quietly when the backend is unreachable.
 */
export default function SupportedSites({
  label = "目前支援",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  const { status } = useBackend();
  const [sites, setSites] = useState<SupportedSite[]>(cache ?? []);

  // Only reach the backend once it's actually connected. This component renders
  // in the home hero, which mounts *beneath* the OasisGate overlay — without this
  // guard it would hit /api/supported-sites while the user is still at the gate,
  // before they've connected. Gate the fetch on "up" like VideoContext does.
  useEffect(() => {
    if (status !== "up") return;
    let alive = true;
    loadOnce()
      .then((s) => {
        if (alive) setSites(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [status]);

  if (sites.length === 0) return null;

  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 text-[11px] text-text-tertiary font-sans ${className}`}
    >
      <span>{label}：</span>
      {sites.map((s) => (
        <a
          key={s.id}
          href={`https://${s.domain}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`前往 ${s.domain}`}
          className="rounded-md border border-border-hairline bg-surface-highest px-2 py-0.5 text-text-secondary transition hover:border-accent/40 hover:text-accent cursor-pointer"
        >
          {s.name}
        </a>
      ))}
    </div>
  );
}
