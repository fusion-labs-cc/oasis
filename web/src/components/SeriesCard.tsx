"use client";

import Link from "next/link";
import { coverUrl, seriesCoverUrl, isDownloaded, type SeriesRecord, type VideoRecord } from "@/lib/api";

interface SeriesCardProps {
  id: number;
  name: string;
  episodes: VideoRecord[];
  seriesObj?: SeriesRecord;
  onEditCover?: (name: string) => void;
}

export default function SeriesCard({
  id,
  name,
  episodes,
  seriesObj,
  onEditCover,
}: SeriesCardProps) {
  const seriesCover = seriesObj
    ? seriesCoverUrl(seriesObj)
    : episodes.find((e) => e.series_cover || e.series_has_cover)
    ? seriesCoverUrl({
        id,
        cover: episodes.find((e) => e.series_cover)?.series_cover,
        has_cover: episodes.some((e) => e.series_has_cover),
      })
    : null;

  const hasSeriesCover = Boolean(
    seriesCover ||
      seriesObj?.cover ||
      seriesObj?.has_cover ||
      episodes.some((e) => e.series_cover || e.series_has_cover)
  );

  const cover = seriesCover || (episodes.map(coverUrl).find(Boolean) ?? null);
  const downloaded = episodes.filter(isDownloaded).length;
  const active = episodes.filter((e) => e.is_downloading).length;
  const overall = Math.round(
    episodes.reduce(
      (sum, e) => sum + (isDownloaded(e) ? 100 : e.download_progress ?? 0),
      0,
    ) / (episodes.length || 1),
  );

  return (
    <li className="group relative flex flex-col overflow-hidden rounded-xl border border-border-hairline bg-surface-elevated tactile-card h-full transition">
      <div className="relative aspect-video w-full overflow-hidden bg-surface-highest">
        <Link href={`/series/${id}`} className="block h-full w-full cursor-pointer text-left">
          {cover ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={cover}
              alt={name}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-highest to-surface-elevated text-xs font-mono font-bold text-text-tertiary">
              NO COVER
            </div>
          )}
        </Link>

        <div className="absolute right-2 top-2 flex items-center gap-1.5 z-10">
          {onEditCover && !hasSeriesCover && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEditCover(name);
              }}
              title="設定系列封面"
              className="rounded-full bg-neutral-950/80 p-1 px-1.5 text-[10px] font-bold text-text-secondary hover:text-accent backdrop-blur transition cursor-pointer"
            >
              📷
            </button>
          )}
          <div className="rounded-full bg-neutral-950/80 px-2 py-0.5 text-[10px] font-bold text-accent backdrop-blur">
            📚 {episodes.length} 集
          </div>
        </div>

        {active > 0 && (
          <div className="absolute inset-x-0 bottom-0 z-10 h-1.5 overflow-hidden bg-neutral-950/50">
            <div
              className="h-full bg-accent shadow-[0_0_6px_rgba(16,185,129,0.6)] transition-all duration-700 ease-out"
              style={{ width: `${overall}%` }}
            />
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs font-bold text-accent">系列</span>
          {onEditCover && !hasSeriesCover && (
            <button
              type="button"
              onClick={() => onEditCover(name)}
              className="text-[11px] font-semibold text-text-tertiary hover:text-accent transition cursor-pointer flex items-center gap-1"
            >
              📷 設定封面
            </button>
          )}
        </div>

        <Link
          href={`/series/${id}`}
          className="block group/title mt-2 w-full cursor-pointer text-left"
        >
          <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold text-text-primary group-hover/title:text-accent transition duration-150 leading-relaxed">
            {name}
          </h3>
        </Link>

        <div className="mt-auto flex items-center justify-between border-t border-border-hairline pt-3">
          <Link
            href={`/series/${id}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent/10 px-2.5 py-1.5 text-[11px] font-bold text-accent transition hover:bg-accent/20 cursor-pointer"
          >
            📂 查看 {episodes.length} 集
          </Link>
          <span className="text-[11px] font-semibold text-text-tertiary">
            {active > 0
              ? `下載中 ${overall}%`
              : `已下載 ${downloaded} / ${episodes.length}`}
          </span>
        </div>
      </div>
    </li>
  );
}
