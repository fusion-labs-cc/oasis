"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  coverUrl,
  downloadVideo,
  cancelDownload,
  openInPlayer,
  safeExternalHref,
  getVideoCategory,
  getSiteName,
  type VideoRecord,
} from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useVideos } from "@/context/VideoContext";
import { useTasks } from "@/context/TasksContext";

interface VideoCardProps {
  video: VideoRecord;
  selectedTags?: string[];
  onTagClick?: (tag: string) => void;
  onSeriesClick?: (seriesId: number, seriesName: string) => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
}

export default function VideoCard({
  video,
  selectedTags = [],
  onTagClick,
  onSeriesClick,
  selectMode = false,
  selected = false,
  onToggleSelect,
}: VideoCardProps) {
  const toast = useToast();
  const { updateVideo } = useVideos();
  const { addDownloadTask, markDownloadCanceled } = useTasks();
  const [downloading, setDownloading] = useState(false);
  const [playCount, setPlayCount] = useState(video.play_count ?? 0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

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
            onClick={() => video.id != null && onToggleSelect?.(video.id)}
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
        {mounted && coverUrl(video) ? (
          /* eslint-disable-next-line @next/next/no-img-element */
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

        {/* Site / Category Badge */}
        {(() => {
          const category = getVideoCategory(video.url);
          const siteName = getSiteName(video.url);
          return (
            <div
              className={`absolute right-2 top-2 z-10 rounded-md px-1.5 py-0.5 text-[10px] font-mono font-bold tracking-wider shadow-sm backdrop-blur-md border ${
                category === "general"
                  ? "bg-emerald-950/80 text-emerald-300 border-emerald-500/30"
                  : "bg-purple-950/80 text-purple-300 border-purple-500/30"
              }`}
            >
              {siteName || (category === "general" ? "一般" : "AV")}
            </div>
          );
        })()}

        {/* Download progress overlay: a filled bar once the backend reports a
            percent, an indeterminate pulse while queued or before the first
            percent arrives. */}
        {isDownloading && (
          <div className="absolute inset-x-0 bottom-0 z-10 h-1.5 bg-neutral-950/50 overflow-hidden">
            {!video.download_queued && typeof video.download_progress === "number" ? (
              <div
                className="h-full bg-accent transition-all duration-700 ease-out shadow-[0_0_6px_rgba(16,185,129,0.6)]"
                style={{ width: `${video.download_progress}%` }}
              />
            ) : (
              <div className="h-full w-full bg-accent/60 animate-pulse" />
            )}
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
          <div className="flex items-center gap-1.5 min-w-0 max-w-[65%] justify-end text-xs font-semibold text-text-secondary">
            {video.actress && (
              <Link
                href={`/video/${video.id}`}
                className="truncate hover:text-accent transition"
              >
                {video.actress}
              </Link>
            )}
            {video.actress && video.series && (
              <span className="text-text-tertiary font-normal shrink-0">/</span>
            )}
            {video.series && (
              video.series_id != null ? (
                <Link
                  href={`/series/${video.series_id}`}
                  onClick={(e) => {
                    if (onSeriesClick) {
                      e.preventDefault();
                      onSeriesClick(video.series_id!, video.series!);
                    }
                  }}
                  title={`查看系列「${video.series}」`}
                  className="truncate hover:text-accent transition"
                >
                  {video.series}
                </Link>
              ) : (
                <span className="truncate" title={`系列「${video.series}」`}>
                  {video.series}
                </span>
              )
            )}
          </div>
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

        {video.tags && video.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1">
            {[...video.tags].reverse().map((t) => {
              const active = selectedTags.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => onTagClick?.(t)}
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
