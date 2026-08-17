"use client";

import { useEffect, useState } from "react";
import { fetchSupportedSites, SupportedSite } from "@/lib/api";
import { useBackend } from "@/context/BackendContext";
import { useMode } from "@/context/ModeContext";

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
  category: propCategory,
  label = "目前支援",
  className = "",
}: {
  category?: "general" | "av";
  label?: string;
  className?: string;
}) {
  const { status } = useBackend();
  const { mode } = useMode();
  const [sites, setSites] = useState<SupportedSite[]>(cache ?? []);

  // Without an explicit prop, follow the mode the user is browsing. The
  // add-video dialog is mounted from the global header, so on a video or
  // settings page the pathname says nothing about which half they are in.
  const activeCategory = propCategory || mode;

  // Only reach the backend once it's actually connected.
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

  const filteredSites = sites.filter((s) => {
    const isGeneral = s.category === "general" || s.id === "youtube" || s.id === "anime1";
    return activeCategory === "general" ? isGeneral : !isGeneral;
  });

  if (filteredSites.length === 0) return null;

  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-[11px] text-text-tertiary font-sans ${className}`}>
      {label && <span>{label}：</span>}
      {filteredSites.map((s) => (
        <a
          key={s.id}
          href={`https://${s.domain}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`前往 ${s.domain}`}
          className="rounded-md border border-emerald-500/20 bg-emerald-950/30 px-2 py-0.5 text-emerald-300 transition cursor-pointer hover:border-emerald-500/50 hover:text-emerald-200"
        >
          {s.name}
        </a>
      ))}
    </div>
  );
}
