"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { computeFacets, coverUrl, deleteVideo, downloadVideo, cancelDownload, openInPlayer, safeExternalHref, toExportedVideo, ExportedVideo, Facets, VideoRecord } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useVideos } from "@/context/VideoContext";
import { useTasks } from "@/context/TasksContext";
import SupportedSites from "@/components/SupportedSites";
import ImportExportModal from "@/components/ImportExportModal";

export default function Home() {
  // Full catalog lives in the shared VideoContext so it survives navigation.
  // Filtering below is all client-side.
  const { videos: allVideos, loading: loadingList, error, updateVideo, removeVideo } = useVideos();

  // Filters
  const [selectedActress, setSelectedActress] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [match, setMatch] = useState<"all" | "any">("all");
  // Mobile-only collapsible for the filter panel — the sidebar is xl-only.
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Multi-select. Selection is keyed by video id and lives *above* the filter,
  // so a video stays selected even after the filter hides it from the grid —
  // switching filters lets the user gather a selection across many views.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [exportSelectionOpen, setExportSelectionOpen] = useState(false);

  const toast = useToast();
  const [lastWatched, setLastWatched] = useState<{
    video: VideoRecord;
    progress: number;
    duration: number | null;
    type: "play" | "original_site" | null;
  } | null>(null);

  const loadLastWatched = useCallback(() => {
    if (allVideos.length === 0) {
      setLastWatched(null);
      return;
    }
    const lastIdStr = localStorage.getItem("oasis:last_watched_id");
    if (!lastIdStr) {
      setLastWatched(null);
      return;
    }
    const lastId = Number(lastIdStr);
    const found = allVideos.find((v) => v.id === lastId);
    if (found) {
      const progressStr = localStorage.getItem(`oasis:progress:${lastId}`);
      const durationStr = localStorage.getItem(`oasis:duration:${lastId}`);
      const typeStr = localStorage.getItem("oasis:last_watched_type") as "play" | "original_site" | null;
      const progress = progressStr ? Number(progressStr) : 0;
      const duration = durationStr ? Number(durationStr) : null;
      setLastWatched({
        video: found,
        progress,
        duration,
        type: typeStr || "play",
      });
    } else {
      setLastWatched(null);
    }
  }, [allVideos]);

  useEffect(() => {
    loadLastWatched();
  }, [loadLastWatched]);

  useEffect(() => {
    const handleLastWatchedChanged = () => {
      loadLastWatched();
    };
    window.addEventListener("oasis:last_watched_changed", handleLastWatchedChanged);
    return () => window.removeEventListener("oasis:last_watched_changed", handleLastWatchedChanged);
  }, [loadLastWatched]);

  async function handleOpenHero(e: React.MouseEvent, id: number) {
    e.preventDefault();
    try {
      const res = await openInPlayer(id);
      if (typeof res.play_count === "number") {
        updateVideo(id, { play_count: res.play_count });
      }
      localStorage.setItem("oasis:last_watched_id", String(id));
      localStorage.setItem("oasis:last_watched_type", "play");
      loadLastWatched();
      toast("已用電腦播放器開啟", { type: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
    }
  }

  useEffect(() => {
    document.title = "OASIS";
  }, []);

  // The catalog (initial load + download reconciliation) is owned by
  // VideoContext, so there is no fetching or polling here anymore.

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const tag = params.get("tag");
      if (tag && !selectedTags.includes(tag)) {
        setSelectedTags([tag]);
      }
      
      const actress = params.get("actress");
      if (actress) {
        setSelectedActress(actress);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const facets = useMemo(() => computeFacets(allVideos), [allVideos]);

  const videos = useMemo(() => {
    return allVideos.filter((v) => {
      if (selectedActress && v.actress !== selectedActress) return false;
      if (selectedTags.length) {
        const tags = new Set(v.tags ?? []);
        const ok =
          match === "any"
            ? selectedTags.some((t) => tags.has(t))
            : selectedTags.every((t) => tags.has(t));
        if (!ok) return false;
      }
      return true;
    });
  }, [allVideos, selectedActress, selectedTags, match]);

  function toggleTag(tag: string) {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  function toggleActress(name: string) {
    setSelectedActress((prev) => (prev === name ? null : name));
  }

  function clearFilters() {
    setSelectedActress(null);
    setSelectedTags([]);
  }

  const hasFilters = selectedActress !== null || selectedTags.length > 0;

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Add every currently *visible* (filtered-in) video to the selection, leaving
  // any already-selected-but-hidden ones untouched.
  const selectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const v of videos) if (v.id != null) next.add(v.id);
      return next;
    });
  }, [videos]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setConfirmingDelete(false);
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    clearSelection();
  }, [clearSelection]);

  // Drop ids that no longer exist (e.g. after a delete or catalog refresh) so
  // the selection count never counts phantom videos.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(allVideos.map((v) => v.id));
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allVideos]);

  // The actual selected records, in catalog order. Used for both export and
  // delete. Pulled from the *unfiltered* list so hidden selections are included.
  const selectedVideos = useMemo(
    () => allVideos.filter((v) => v.id != null && selectedIds.has(v.id)),
    [allVideos, selectedIds],
  );
  const selectedExportData = useMemo<ExportedVideo[]>(
    () => selectedVideos.map(toExportedVideo),
    [selectedVideos],
  );
  // How many selected videos are currently hidden by the filter — surfaced in
  // the toolbar so it's clear the selection spans more than what's on screen.
  const hiddenSelectedCount = useMemo(() => {
    const visible = new Set(videos.map((v) => v.id));
    let n = 0;
    for (const id of selectedIds) if (!visible.has(id)) n++;
    return n;
  }, [videos, selectedIds]);

  async function handleBulkDelete() {
    if (bulkBusy || selectedIds.size === 0) return;
    setBulkBusy(true);
    const ids = [...selectedIds];
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await deleteVideo(id);
        removeVideo(id);
        ok++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    setConfirmingDelete(false);
    setSelectedIds(new Set());
    if (failed === 0) {
      toast(`已刪除 ${ok} 部影片`, { type: "success" });
    } else {
      toast(`已刪除 ${ok} 部，${failed} 部刪除失敗`, { type: failed === ids.length ? "error" : "info" });
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1680px] justify-between gap-8 px-4 py-6 sm:px-6 md:px-8 md:py-10">
      <main className="flex-1 min-w-0">
        {/* Dynamic Hero Section */}
        {lastWatched ? (
          <div className="mb-8 overflow-hidden rounded-2xl border border-border-hairline bg-gradient-to-br from-surface-elevated/90 via-surface-elevated/70 to-surface-base/30 p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 relative shadow-lg group/hero hover:border-accent/20 transition duration-300">
            {/* Ambient Background Glow */}
            <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/5 blur-3xl pointer-events-none transition-opacity duration-500 group-hover/hero:bg-accent/10" />
            
            <div className="flex-1 min-w-0 z-10">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-accent border border-accent/20">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                  繼續觀看
                </span>
                {lastWatched.video.local_file_exists && lastWatched.video.video_path && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-highest px-2.5 py-1 text-[10px] font-bold text-text-secondary border border-border-hairline">
                    🖥 已下載至本機
                  </span>
                )}
              </div>
              
              <Link 
                href={`/video/${lastWatched.video.id}`}
                className="block group/hero-title mt-3"
              >
                <h1 className="text-xl font-bold tracking-tight text-text-primary group-hover/hero-title:text-accent transition duration-150 line-clamp-1 leading-snug">
                  {lastWatched.video.title_zh_tw || lastWatched.video.title}
                </h1>
              </Link>
              
              <div className="flex items-center gap-3 mt-2 text-xs font-semibold text-text-secondary">
                <Link 
                  href={`/video/${lastWatched.video.id}`}
                  className="font-mono text-accent hover:underline"
                >
                  {lastWatched.video.code}
                </Link>
                {lastWatched.video.actress && (
                  <>
                    <span className="text-text-tertiary/40">•</span>
                    <button 
                      onClick={() => toggleActress(lastWatched.video.actress!)}
                      className="hover:text-accent transition cursor-pointer"
                    >
                      {lastWatched.video.actress}
                    </button>
                  </>
                )}
              </div>

              {/* Progress indicator */}
              {lastWatched.duration && lastWatched.progress > 0 ? (
                <div className="mt-4 max-w-md">
                  <div className="flex items-center justify-between text-[11px] text-text-tertiary font-mono mb-1.5">
                    <span>已觀看 {formatTime(lastWatched.progress)} / {formatTime(lastWatched.duration)}</span>
                    <span className="font-semibold text-accent">{Math.floor((lastWatched.progress / lastWatched.duration) * 100)}%</span>
                  </div>
                  <div className="h-1 w-full bg-surface-highest rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-accent rounded-full transition-all duration-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" 
                      style={{ width: `${Math.min(100, Math.max(0, (lastWatched.progress / lastWatched.duration) * 100))}%` }}
                    />
                  </div>
                </div>
              ) : lastWatched.progress > 0 ? (
                <p className="mt-4 text-[11px] text-text-tertiary font-mono">
                  上次播放至 {formatTime(lastWatched.progress)}
                </p>
              ) : (
                <p className="mt-4 text-[11px] text-text-tertiary font-mono">
                  尚未開始播放
                </p>
              )}

              {/* Action Buttons */}
              <div className="mt-6 flex flex-wrap items-center gap-3">
                {lastWatched.type === "original_site" ? (
                  <a
                    href={safeExternalHref(lastWatched.video.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-xl bg-accent text-neutral-950 px-5 py-2.5 text-xs font-bold transition hover:bg-accent-hover shadow-[0_4px_20px_rgba(16,185,129,0.25)] hover:scale-[1.02] active:scale-98 cursor-pointer"
                  >
                    <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                    前往原始網站
                  </a>
                ) : (
                  <Link
                    href={`/video/${lastWatched.video.id}`}
                    className="inline-flex items-center gap-2 rounded-xl bg-accent text-neutral-950 px-5 py-2.5 text-xs font-bold transition hover:bg-accent-hover shadow-[0_4px_20px_rgba(16,185,129,0.25)] hover:scale-[1.02] active:scale-98 cursor-pointer"
                  >
                    <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    繼續播放
                  </Link>
                )}
                
                {lastWatched.video.video_path && lastWatched.video.local_file_exists && (
                  <button
                    onClick={(e) => handleOpenHero(e, lastWatched.video.id!)}
                    className="inline-flex items-center gap-2 rounded-xl border border-border-hairline bg-surface-highest hover:bg-border-hairline hover:text-text-primary px-5 py-2.5 text-xs font-bold text-text-secondary transition hover:scale-[1.02] active:scale-98 cursor-pointer"
                  >
                    🖥 電腦播放
                  </button>
                )}
              </div>
            </div>

            {/* Right side: Cover Preview */}
            {coverUrl(lastWatched.video) && (
              <div className="relative h-28 md:h-36 aspect-video rounded-xl overflow-hidden border border-border-hairline group/hero-cover shrink-0 shadow-lg">
                <Link href={`/video/${lastWatched.video.id}`} className="block w-full h-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={coverUrl(lastWatched.video)!}
                    alt={lastWatched.video.code}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover/hero-cover:scale-105"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-neutral-950/40 via-transparent to-transparent pointer-events-none" />
                </Link>
              </div>
            )}
          </div>
        ) : (
          /* Default Welcome Hero */
          <div className="mb-8 overflow-hidden rounded-2xl border border-border-hairline bg-gradient-to-br from-surface-elevated/70 to-surface-base/10 p-6 relative shadow-md">
            <div className="absolute -right-24 -top-24 h-64 w-64 rounded-full bg-accent/2 blur-3xl pointer-events-none" />
            <div className="z-10 relative max-w-2xl">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-highest px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-text-tertiary border border-border-hairline">
                💡 開始觀看
              </span>
              <h1 className="text-xl font-bold tracking-tight text-text-primary mt-3">
                歡迎來到 OASIS
              </h1>
              <p className="mt-2 text-xs text-text-tertiary leading-relaxed font-sans">
                私有媒體目錄，已解析本機播放與背景下載管理。當您開始觀看影片或有最近播放進度時，此處將會顯示您的「繼續觀看」卡片，方便您隨時接續播放。
              </p>
              <SupportedSites label="支援解析下載的網站" className="mt-4" />
            </div>
          </div>
        )}

        {/* The welcome hero above already lists the sites; once a lastWatched
            hero replaces it, keep the list visible as a slim strip below. */}
        {lastWatched && (
          <SupportedSites label="支援解析下載的網站" className="-mt-4 mb-8 px-1" />
        )}

        {error && (
          <div className="mb-6 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-400 font-sans">
            載入資料庫出錯：{error}
          </div>
        )}

        <section>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-text-secondary">
              資料庫{" "}
              <span className="text-text-tertiary text-xs font-mono ml-1">
                ({hasFilters ? `${videos.length} / ${allVideos.length}` : allVideos.length})
              </span>
            </h2>
            <div className="flex items-center gap-3">
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-xs text-accent hover:text-accent-hover font-semibold transition cursor-pointer"
                >
                  清除篩選
                </button>
              )}
              {/* Mobile filter toggle — the sidebar only exists at xl and up */}
              {facets.actresses.length + facets.tags.length > 0 && (
                <button
                  type="button"
                  onClick={() => setFiltersOpen((prev) => !prev)}
                  className={`xl:hidden rounded-lg border px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                    filtersOpen || hasFilters
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-border-hairline bg-surface-elevated text-text-secondary hover:bg-surface-highest hover:text-text-primary"
                  }`}
                >
                  篩選
                  {selectedTags.length + (selectedActress ? 1 : 0) > 0 && (
                    <span className="ml-1 font-mono font-bold">
                      {selectedTags.length + (selectedActress ? 1 : 0)}
                    </span>
                  )}
                </button>
              )}
              {allVideos.length > 0 && (
                <button
                  type="button"
                  onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                    selectMode
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-border-hairline bg-surface-elevated text-text-secondary hover:bg-surface-highest hover:text-text-primary"
                  }`}
                >
                  {selectMode ? "完成選取" : "選取"}
                </button>
              )}
            </div>
          </div>

          {/* Collapsible filter panel for below-xl screens */}
          {filtersOpen && (
            <div className="mb-4 space-y-4 xl:hidden">
              <FilterPanel
                facets={facets}
                selectedActress={selectedActress}
                toggleActress={toggleActress}
                selectedTags={selectedTags}
                toggleTag={toggleTag}
                match={match}
                setMatch={setMatch}
              />
            </div>
          )}

          {/* Selection toolbar — appears in select mode. Selection is kept by id
              above the filter, so counts include videos hidden by the filter. */}
          {selectMode && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/20 bg-accent/5 px-4 py-3">
              <div className="text-xs font-semibold text-text-secondary">
                已選取{" "}
                <span className="font-mono font-bold text-accent">{selectedIds.size}</span> 部
                {hiddenSelectedCount > 0 && (
                  <span className="ml-1 text-text-tertiary font-sans">
                    （其中 {hiddenSelectedCount} 部因篩選未顯示）
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={selectAllVisible}
                  disabled={videos.length === 0}
                  className="rounded-lg border border-border-hairline bg-surface-elevated px-3 py-1.5 text-xs font-semibold text-text-secondary transition hover:bg-surface-highest hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  全選（目前顯示 {videos.length}）
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={selectedIds.size === 0}
                  className="rounded-lg border border-border-hairline bg-surface-elevated px-3 py-1.5 text-xs font-semibold text-text-secondary transition hover:bg-surface-highest hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  清除選取
                </button>
                <button
                  type="button"
                  onClick={() => setExportSelectionOpen(true)}
                  disabled={selectedIds.size === 0}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-neutral-950 transition hover:bg-accent-hover shadow-[0_2px_10px_rgba(16,185,129,0.2)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  匯出所選
                </button>
                {confirmingDelete ? (
                  <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-2 py-1">
                    <span className="text-xs font-semibold text-red-400">
                      刪除 {selectedIds.size} 部？
                    </span>
                    <button
                      type="button"
                      onClick={handleBulkDelete}
                      disabled={bulkBusy}
                      className="rounded-md bg-red-500 px-2.5 py-1 text-xs font-bold text-white transition hover:bg-red-400 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {bulkBusy ? "刪除中…" : "確定"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={bulkBusy}
                      className="rounded-md px-2 py-1 text-xs font-semibold text-text-tertiary transition hover:text-text-primary disabled:opacity-50 cursor-pointer"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={selectedIds.size === 0}
                    className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-bold text-red-400 transition hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    刪除所選
                  </button>
                )}
              </div>
            </div>
          )}

          {loadingList ? (
            /* Animated Skeletons matching the responsive grid structure */
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 2xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="animate-pulse flex flex-col rounded-xl border border-border-hairline bg-surface-elevated overflow-hidden"
                >
                  <div className="aspect-video w-full bg-surface-highest" />
                  <div className="p-4 flex-1 space-y-4">
                    <div className="flex justify-between items-center">
                      <div className="h-3 w-16 bg-surface-highest rounded" />
                      <div className="h-3 w-12 bg-surface-highest rounded" />
                    </div>
                    <div className="space-y-2">
                      <div className="h-4.5 w-full bg-surface-highest rounded" />
                      <div className="h-4.5 w-2/3 bg-surface-highest rounded" />
                    </div>
                    <div className="flex justify-between items-center pt-2">
                      <div className="h-7 w-20 bg-surface-highest rounded-lg" />
                      <div className="h-3 w-8 bg-surface-highest rounded" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : videos.length === 0 ? (
            /* Premium Zero State */
            <div className="flex flex-col items-center justify-center border border-border-hairline rounded-2xl bg-surface-elevated/20 py-20 text-center">
              <div className="h-12 w-12 rounded-full bg-surface-elevated border border-border-hairline flex items-center justify-center text-text-tertiary mb-4">
                <svg className="h-6 w-6 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <p className="text-sm font-bold text-text-secondary font-sans">
                {hasFilters ? "沒有符合篩選條件的影片" : "尚無影片資料"}
              </p>
              <p className="text-xs text-text-tertiary mt-1 max-w-xs font-sans leading-relaxed">
                {hasFilters 
                  ? "請嘗試調整女優或標籤篩選條件，或點擊右上角清除篩選。" 
                  : "點擊右上角「新增影片」按鈕，或按下 / 鍵，開始解析並下載影片！"}
              </p>
              {hasFilters && (
                <button
                  onClick={clearFilters}
                  className="mt-4 rounded-lg bg-surface-elevated hover:bg-surface-highest border border-border-hairline px-4 py-2 text-xs font-bold text-text-primary transition cursor-pointer"
                >
                  清除所有篩選
                </button>
              )}
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 2xl:grid-cols-4">
              {videos.map((v) => (
                <VideoCard
                  key={v.id ?? v.code}
                  video={v}
                  selectedTags={selectedTags}
                  onTagClick={toggleTag}
                  selectMode={selectMode}
                  selected={v.id != null && selectedIds.has(v.id)}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </ul>
          )}
        </section>
      </main>

      {/* Filter Sidebar (xl and up; smaller screens use the collapsible above the grid) */}
      <aside className="hidden w-64 shrink-0 xl:block">
        <div className="sticky top-24 space-y-6">
          <FilterPanel
            facets={facets}
            selectedActress={selectedActress}
            toggleActress={toggleActress}
            selectedTags={selectedTags}
            toggleTag={toggleTag}
            match={match}
            setMatch={setMatch}
          />
        </div>
      </aside>

      {/* Export the current selection (copy or download) — reuses the shared
          dialog locked to export with the selection as its fixed data. */}
      <ImportExportModal
        isOpen={exportSelectionOpen}
        tab="export"
        exportOnly
        exportData={selectedExportData}
        subtitle={`匯出所選 ${selectedExportData.length} 部影片（僅中繼資料，不含影片檔）`}
        onClose={() => setExportSelectionOpen(false)}
      />
    </div>
  );
}

// The actress/tag facet panels, shared between the xl sidebar and the
// below-xl collapsible block above the grid.
function FilterPanel({
  facets,
  selectedActress,
  toggleActress,
  selectedTags,
  toggleTag,
  match,
  setMatch,
}: {
  facets: Facets;
  selectedActress: string | null;
  toggleActress: (name: string) => void;
  selectedTags: string[];
  toggleTag: (tag: string) => void;
  match: "all" | "any";
  setMatch: (m: "all" | "any") => void;
}) {
  return (
    <>
      {/* Actress Filters */}
      {facets.actresses.length > 0 && (
        <div className="rounded-xl border border-border-hairline bg-surface-elevated/40 p-4">
          <span className="mb-3 block text-xs font-bold uppercase tracking-wider text-text-tertiary font-sans">
            依女優篩選
          </span>
          <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
            {facets.actresses.map((a) => {
              const active = selectedActress === a.name;
              return (
                <button
                  key={a.name}
                  type="button"
                  onClick={() => toggleActress(a.name)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition font-semibold cursor-pointer ${
                    active
                      ? "bg-accent text-neutral-950 font-bold"
                      : "text-text-secondary hover:bg-surface-highest hover:text-text-primary"
                  }`}
                >
                  <span className="truncate">{a.name}</span>
                  <span
                    className={`font-mono text-[10px] ${
                      active
                        ? "text-neutral-950/70"
                        : "text-text-tertiary"
                    }`}
                  >
                    {a.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tag Filters */}
      {facets.tags.length > 0 && (
        <div className="rounded-xl border border-border-hairline bg-surface-elevated/40 p-4">
          <div className="mb-3 flex flex-col gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-text-tertiary font-sans">
              依標籤篩選
            </span>
            {selectedTags.length > 1 && (
              <div className="flex overflow-hidden rounded-lg border border-border-hairline text-[11px] bg-surface-elevated">
                {(["all", "any"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMatch(m)}
                    className={`px-2 py-1 flex-1 text-center font-medium transition cursor-pointer ${
                      match === m
                        ? "bg-accent text-neutral-950 font-bold"
                        : "text-text-secondary hover:bg-surface-highest"
                    }`}
                  >
                    {m === "all" ? "全部符合" : "任一符合"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex max-h-96 flex-wrap gap-1.5 overflow-y-auto pr-1">
            {facets.tags.map((t) => {
              const active = selectedTags.includes(t.name);
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => toggleTag(t.name)}
                  className={`rounded-full px-2.5 py-1 text-xs transition cursor-pointer border ${
                    active
                      ? "bg-accent text-neutral-950 border-accent font-bold"
                      : "bg-surface-highest/60 text-text-secondary border-border-hairline hover:border-accent/30 hover:text-text-primary"
                  }`}
                >
                  {t.name}
                  <span
                    className={`ml-1 font-mono text-[10px] ${
                      active
                        ? "text-neutral-950/70"
                        : "text-text-tertiary"
                    }`}
                  >
                    {t.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  const parts = [];
  if (h > 0) {
    parts.push(h);
    parts.push(String(m).padStart(2, "0"));
  } else {
    parts.push(m);
  }
  parts.push(String(s).padStart(2, "0"));
  return parts.join(":");
}

function VideoCard({
  video,
  selectedTags,
  onTagClick,
  selectMode,
  selected,
  onToggleSelect,
}: {
  video: VideoRecord;
  selectedTags: string[];
  onTagClick: (tag: string) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: number) => void;
}) {
  const toast = useToast();
  const { updateVideo } = useVideos();
  const { addDownloadTask, markDownloadCanceled } = useTasks();
  const [downloading, setDownloading] = useState(false);
  const [playCount, setPlayCount] = useState(video.play_count ?? 0);

  const isDownloading = downloading || video.is_downloading;

  // Drop the optimistic flag once the server's view of this video is
  // authoritative — either it confirms the download or the file has landed.
  useEffect(() => {
    if (video.is_downloading || video.video_path) setDownloading(false);
  }, [video.is_downloading, video.video_path]);

  // Keep the displayed count in sync with server refreshes.
  useEffect(() => {
    setPlayCount(video.play_count ?? 0);
  }, [video.play_count]);

  async function handleOpen(e: React.MouseEvent) {
    e.preventDefault();
    try {
      const res = await openInPlayer(video.id!);
      if (typeof res.play_count === "number") {
        setPlayCount(res.play_count);
        updateVideo(video.id!, { play_count: res.play_count });
      }
      localStorage.setItem("oasis:last_watched_id", String(video.id));
      localStorage.setItem("oasis:last_watched_type", "play");
      window.dispatchEvent(new Event("oasis:last_watched_changed"));
      toast("已用電腦播放器開啟", { type: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
    }
  }

  async function handleDownload(e: React.MouseEvent) {
    e.preventDefault();
    if (isDownloading) return;
    setDownloading(true);
    try {
      await downloadVideo(video.id!);
      updateVideo(video.id!, { is_downloading: true });
      addDownloadTask(video);
      toast("已開始在背景下載影片！", { type: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
      setDownloading(false);
    }
  }

  async function handleCancelDownload(e: React.MouseEvent) {
    e.preventDefault();
    if (!video.id) return;
    try {
      await cancelDownload(video.id);
      setDownloading(false);
      updateVideo(video.id, { is_downloading: false });
      markDownloadCanceled(video.id);
      toast("已取消下載影片！", { type: "info" });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
    }
  }

  const handleOriginalSiteClick = () => {
    localStorage.setItem("oasis:last_watched_id", String(video.id));
    localStorage.setItem("oasis:last_watched_type", "original_site");
    window.dispatchEvent(new Event("oasis:last_watched_changed"));
  };

  return (
    <li
      className={`group relative flex flex-col overflow-hidden rounded-xl border bg-surface-elevated tactile-card h-full transition ${
        selected
          ? "border-accent ring-2 ring-accent/60"
          : "border-border-hairline"
      }`}
    >
      {/* Selection overlay: in select mode the whole card toggles selection and
          the underlying links/buttons are covered so they don't fire. */}
      {selectMode && (
        <>
          <button
            type="button"
            onClick={() => video.id != null && onToggleSelect(video.id)}
            aria-pressed={selected}
            aria-label={selected ? "取消選取此影片" : "選取此影片"}
            className="absolute inset-0 z-20 cursor-pointer bg-accent/0 hover:bg-accent/5 transition"
          />
          <div
            className={`pointer-events-none absolute left-3 top-3 z-30 flex h-6 w-6 items-center justify-center rounded-md border text-[13px] font-bold shadow-sm ${
              selected
                ? "border-accent bg-accent text-neutral-950"
                : "border-white/70 bg-neutral-900/60 text-transparent"
            }`}
          >
            ✓
          </div>
        </>
      )}
      <Link href={`/video/${video.id}`} className="block relative aspect-video w-full overflow-hidden bg-surface-highest">
        {coverUrl(video) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl(video)!}
            alt={video.code}
            className="aspect-video w-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-highest to-surface-elevated text-xs font-mono font-bold text-text-tertiary">
            NO COVER
          </div>
        )}
      </Link>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Link href={`/video/${video.id}`} className="font-mono text-xs font-bold text-accent hover:underline">
              {video.code}
            </Link>
          </div>
          {video.actress && (
            <Link
              href={`/video/${video.id}`}
              className="truncate text-xs font-semibold text-text-secondary hover:text-accent transition"
            >
              {video.actress}
            </Link>
          )}
        </div>
        <Link href={`/video/${video.id}`} className="block group/title mt-2">
          <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold text-text-primary group-hover/title:text-accent transition duration-150 leading-relaxed">
            {video.title_zh_tw || video.title}
          </h3>
        </Link>

        <div className="mt-auto flex items-center justify-between border-t border-border-hairline pt-3">
          {video.video_path && video.local_file_exists ? (
            <div className="flex items-center gap-2">
              <button
                onClick={handleOpen}
                title="用電腦播放器開啟"
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent/10 px-2.5 py-1.5 text-[11px] font-bold text-accent transition hover:bg-accent/20 cursor-pointer"
              >
                🖥 電腦播放
              </button>
              <a
                href={safeExternalHref(video.url)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleOriginalSiteClick}
                title="前往原始網站"
                className="inline-flex items-center justify-center rounded-lg bg-surface-highest hover:bg-border-hairline px-2.5 py-1.5 text-[11px] font-bold text-text-secondary hover:text-text-primary transition cursor-pointer border border-border-hairline gap-1"
              >
                🌐 原始網站 ↗
              </a>
            </div>
          ) : isDownloading ? (
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent animate-pulse">
                <span className="h-1.5 w-1.5 rounded-full bg-accent animate-ping" />
                {video.download_queued
                  ? "排隊中..."
                  : typeof video.download_progress === "number"
                    ? `下載中 ${video.download_progress}%`
                    : "正在下載中..."}
              </span>
              <button
                onClick={handleCancelDownload}
                title="取消下載"
                className="text-[10px] font-bold text-red-400 hover:text-red-300 transition duration-150 cursor-pointer ml-1"
              >
                取消
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={handleDownload}
                className="rounded-lg bg-surface-highest hover:bg-border-hairline px-2.5 py-1.5 text-[11px] font-bold text-text-secondary hover:text-text-primary transition cursor-pointer border border-border-hairline"
              >
                ↓ 下載影片
              </button>
              <a
                href={safeExternalHref(video.url)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleOriginalSiteClick}
                title="前往原始網站"
                className="inline-flex items-center justify-center rounded-lg bg-surface-highest hover:bg-border-hairline px-2.5 py-1.5 text-[11px] font-bold text-text-secondary hover:text-text-primary transition cursor-pointer border border-border-hairline gap-1"
              >
                🌐 原始網站 ↗
              </a>
            </div>
          )}
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-text-tertiary font-mono">
            ▶ {playCount}
          </span>
        </div>

        {video.tags?.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1">
            {[...video.tags].reverse().map((t) => {
              const active = selectedTags.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => onTagClick(t)}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold transition cursor-pointer border ${
                    active
                      ? "bg-accent text-neutral-950 border-accent font-bold"
                      : "bg-surface-highest/40 text-text-secondary border-border-hairline hover:border-accent/20 hover:text-text-primary"
                  }`}
                >
                  {t}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </li>
  );
}

