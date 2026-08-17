"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  fetchSeries,
  seriesCoverUrl,
  coverUrl,
  isDownloaded,
  downloadVideo,
  cancelSeriesDownloads,
  deleteSeries,
  getVideoCategory,
  type SeriesRecord,
  type VideoRecord,
} from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useBackend } from "@/context/BackendContext";
import { useVideos } from "@/context/VideoContext";
import { useTasks } from "@/context/TasksContext";
import { useMode } from "@/context/ModeContext";
import VideoCard from "@/components/VideoCard";
import SeriesEditModal from "@/components/SeriesEditModal";

export default function SeriesDetailPage() {
  const { id } = useParams<{ id: string }>();
  const numId = Number(id);
  const router = useRouter();
  const toast = useToast();
  const { status } = useBackend();
  const { videos, loaded, syncVideo, upsertVideo, refresh } = useVideos();
  const { addDownloadTask } = useTasks();
  const { setMode } = useMode();

  const [seriesList, setSeriesList] = useState<SeriesRecord[]>([]);
  const [loadingSeries, setLoadingSeries] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingModalOpen, setEditingModalOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [cancelingAll, setCancelingAll] = useState(false);

  // Load series list on mount
  const loadSeriesData = async () => {
    try {
      const rows = await fetchSeries();
      setSeriesList(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSeries(false);
    }
  };

  useEffect(() => {
    if (status === "up") {
      loadSeriesData();
    } else if (status === "down") {
      setError("本機伺服器未連線");
      setLoadingSeries(false);
    }
  }, [status]);

  // Find episodes belonging to this series
  const episodes = useMemo(() => {
    return videos
      .filter((v) => v.series_id === numId)
      .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0) || (a.id ?? 0) - (b.id ?? 0));
  }, [videos, numId]);

  // Determine series record from series list or fallback to episode metadata
  const series = useMemo(() => {
    const found = seriesList.find((s) => s.id === numId);
    if (found) return found;
    if (episodes.length > 0 && episodes[0].series) {
      return {
        id: numId,
        name: episodes[0].series,
        count: episodes.length,
      } as SeriesRecord;
    }
    return null;
  }, [seriesList, numId, episodes]);

  // A series belongs to one half of the catalog, so — like the video detail
  // page — it is the authority on the mode: reaching it by deep link should
  // leave the header tabs and the back link pointing at its own catalog.
  useEffect(() => {
    const first = episodes[0];
    if (first?.url) setMode(getVideoCategory(first.url));
  }, [episodes, setMode]);

  // Reflect series title in tab title
  useEffect(() => {
    if (series?.name) {
      document.title = `${series.name} - OASIS`;
    } else {
      document.title = "OASIS";
    }
  }, [series?.name]);

  // Series cover URL
  const cover = useMemo(() => {
    if (!series) return null;
    const sCover = seriesCoverUrl(series);
    return sCover || (episodes.map(coverUrl).find(Boolean) ?? null);
  }, [series, episodes]);

  // Download stats
  const downloadedCount = useMemo(() => episodes.filter(isDownloaded).length, [episodes]);
  const activeCount = useMemo(() => episodes.filter((e) => e.is_downloading || e.download_queued).length, [episodes]);

  const overallProgress = useMemo(() => {
    if (episodes.length === 0) return 0;
    const sum = episodes.reduce(
      (acc, e) => acc + (isDownloaded(e) ? 100 : e.download_progress ?? 0),
      0,
    );
    return Math.round(sum / episodes.length);
  }, [episodes]);

  // Batch download all undownloaded videos in series
  async function handleDownloadAll() {
    const undownloaded = episodes.filter((e) => !isDownloaded(e) && !e.is_downloading && e.id);
    if (undownloaded.length === 0) {
      toast("全系列影片皆已下載或正在下載中", { type: "info" });
      return;
    }
    setDownloadingAll(true);
    let count = 0;
    for (const ep of undownloaded) {
      try {
        await downloadVideo(ep.id!);
        upsertVideo({ ...ep, is_downloading: true });
        addDownloadTask(ep);
        count++;
      } catch (err) {
        console.error(`Failed to trigger download for video ${ep.id}:`, err);
      }
    }
    setDownloadingAll(false);
    if (count > 0) {
      toast(`已開始在背景下載 ${count} 部影片`, { type: "success" });
    } else {
      toast("下載觸發失敗，請稍後重試", { type: "error" });
    }
  }

  // One-click cancel all downloading/queued videos in series
  async function handleCancelAll() {
    if (!numId || cancelingAll) return;
    setCancelingAll(true);
    try {
      const res = await cancelSeriesDownloads(numId);
      toast(`已停止系列下載（已取消 ${res.cancelled_count} 部影片）`, { type: "success" });
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
    } finally {
      setCancelingAll(false);
    }
  }

  // Delete series record
  async function handleDeleteSeries(deleteVideos: boolean = false) {
    if (!series || deleting) return;
    setDeleting(true);
    try {
      await deleteSeries(series.id, deleteVideos);
      toast(
        deleteVideos ? "已刪除系列及所有相關影片" : "已刪除系列（影片仍保留為未分類）",
        { type: "success" }
      );
      router.push("/");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  const isLoading = (loadingSeries || !loaded) && !series && episodes.length === 0;

  if (isLoading) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-4 sm:px-6 md:px-8 md:py-6 animate-pulse">
        <div className="h-6 w-32 bg-surface-elevated rounded mb-6" />
        <div className="h-64 w-full bg-surface-elevated rounded-2xl mb-8" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="aspect-video bg-surface-elevated rounded-xl" />
          ))}
        </div>
      </main>
    );
  }

  if (error || (!series && episodes.length === 0)) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-4 sm:px-6 md:px-8 md:py-6">
        <div className="mb-6">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-text-tertiary hover:text-accent transition"
          >
            ← 返回所有影片
          </Link>
        </div>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center text-sm text-red-400 font-sans leading-relaxed">
          <p className="font-bold mb-1">✕ 找不到此系列</p>
          <p className="text-xs text-red-400/80 mb-4">{error || "該系列不存在或已被刪除。"}</p>
          <Link
            href="/"
            className="inline-block rounded-xl bg-surface-elevated hover:bg-surface-highest border border-border-hairline px-4 py-2 text-xs font-bold text-text-primary transition"
          >
            返回首頁
          </Link>
        </div>
      </main>
    );
  }

  const seriesName = series?.name || episodes[0]?.series || "未命名系列";

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-4 sm:px-6 md:px-8 md:py-6">
      {/* Breadcrumb & Navigation */}
      <div className="mb-4 flex items-center justify-between">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-text-tertiary hover:text-accent transition cursor-pointer"
        >
          ← 返回所有影片
        </Link>
        <span className="font-mono text-xs font-bold text-accent">
          系列 ID: {numId}
        </span>
      </div>

      {/* Series Hero Banner */}
      <div className="relative overflow-hidden rounded-2xl border border-border-hairline bg-surface-elevated p-6 sm:p-8 shadow-2xl mb-8">
        {cover && (
          <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={cover}
              alt={seriesName}
              className="h-full w-full object-cover blur-2xl opacity-10 scale-110"
            />
          </div>
        )}

        <div className="relative z-10 flex flex-col md:flex-row gap-6 items-start md:items-center justify-between">
          <div className="flex flex-col sm:flex-row gap-5 items-start sm:items-center">
            {/* Cover Thumbnail */}
            <div className="relative aspect-video w-full sm:w-48 shrink-0 overflow-hidden rounded-xl bg-surface-highest border border-border-hairline shadow-lg">
              {cover ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={cover} alt={seriesName} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xs font-mono font-bold text-text-tertiary">
                  NO COVER
                </div>
              )}
            </div>

            {/* Title & Metadata */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-accent/10 border border-accent/20 px-2.5 py-0.5 text-[11px] font-bold text-accent">
                  📚 系列
                </span>
                <span className="text-xs font-semibold text-text-tertiary">
                  共 {episodes.length} 集
                </span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-black text-text-primary tracking-tight">
                {seriesName}
              </h1>
              <p className="text-xs text-text-secondary">
                已下載 {downloadedCount} / {episodes.length} 集
                {activeCount > 0 && ` （${activeCount} 集下載中 ${overallProgress}%）`}
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto">
            {activeCount > 0 && (
              <button
                type="button"
                onClick={handleCancelAll}
                disabled={cancelingAll}
                className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 px-4 py-2.5 text-xs font-bold transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5 shadow-[0_4px_20px_rgba(239,68,68,0.15)]"
              >
                ⏹ {cancelingAll ? "停止中…" : "一鍵停止整個系列下載"}
              </button>
            )}

            {downloadedCount < episodes.length && (
              <button
                type="button"
                onClick={handleDownloadAll}
                disabled={downloadingAll}
                className="rounded-xl bg-accent text-neutral-950 px-4 py-2.5 text-xs font-bold transition hover:bg-accent-hover shadow-[0_4px_20px_rgba(16,185,129,0.25)] cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                ↓ {downloadingAll ? "處理中…" : "一鍵下載全系列"}
              </button>
            )}

            <button
              type="button"
              onClick={() => setEditingModalOpen(true)}
              className="rounded-xl border border-border-hairline bg-surface-highest hover:bg-border-hairline px-4 py-2.5 text-xs font-semibold text-text-primary transition cursor-pointer flex items-center gap-1.5"
            >
              📷 編輯系列
            </button>

            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded-xl border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 px-3.5 py-2.5 text-xs font-semibold text-red-400 transition cursor-pointer"
            >
              🗑️ 刪除系列
            </button>
          </div>
        </div>


        {/* Global progress bar for series */}
        {activeCount > 0 && (
          <div className="mt-6 pt-4 border-t border-border-hairline">
            <div className="flex justify-between items-center text-xs font-semibold text-text-tertiary mb-1.5">
              <span>全系列下載進度</span>
              <span className="font-mono text-accent">{overallProgress}%</span>
            </div>
            <div className="h-2 w-full bg-neutral-950/60 rounded-full overflow-hidden border border-border-hairline">
              <div
                className="h-full bg-accent transition-all duration-500 ease-out shadow-[0_0_8px_rgba(16,185,129,0.6)]"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {confirmingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-border-hairline bg-surface-elevated p-6 shadow-2xl space-y-4">
            <h3 className="text-base font-bold text-text-primary">確定要刪除系列「{seriesName}」？</h3>
            <p className="text-xs text-text-tertiary leading-relaxed font-sans">
              請選擇刪除方式：您可以僅刪除系列分類（保留影片並轉為未分類），或是連同此系列下的所有影片及本地檔案一併刪除。
            </p>
            <div className="flex flex-col sm:flex-row justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="rounded-xl border border-border-hairline bg-surface-highest px-3.5 py-2 text-xs font-semibold text-text-secondary hover:text-text-primary transition cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleDeleteSeries(false)}
                disabled={deleting}
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 px-3.5 py-2 text-xs font-bold transition cursor-pointer disabled:opacity-50"
              >
                {deleting ? "刪除中…" : "僅刪除系列 (保留影片)"}
              </button>
              <button
                type="button"
                onClick={() => handleDeleteSeries(true)}
                disabled={deleting}
                className="rounded-xl bg-red-500/20 border border-red-500/30 text-red-400 hover:bg-red-500/30 px-3.5 py-2 text-xs font-bold transition cursor-pointer disabled:opacity-50"
              >
                {deleting ? "刪除中…" : "刪除系列與所有影片"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Episodes Header & Grid */}
      <section className="space-y-4">
        <div className="flex items-center justify-between border-b border-border-hairline pb-3">
          <h2 className="text-base font-bold text-text-primary flex items-center gap-2">
            <span>劇集列表</span>
            <span className="rounded-full bg-surface-highest border border-border-hairline px-2.5 py-0.5 text-xs font-mono font-normal text-text-tertiary">
              {episodes.length}
            </span>
          </h2>
        </div>

        {episodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center border border-border-hairline rounded-2xl bg-surface-elevated/20 py-16 text-center">
            <p className="text-sm font-bold text-text-secondary font-sans">
              此系列目前沒有影片
            </p>
            <p className="text-xs text-text-tertiary mt-1 font-sans">
              您可以在首頁將影片加入此系列
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 2xl:grid-cols-4">
            {episodes.map((ep) => (
              <VideoCard key={ep.id} video={ep} />
            ))}
          </ul>
        )}
      </section>

      {/* Edit Series Modal */}
      {series && (
        <SeriesEditModal
          isOpen={editingModalOpen}
          onClose={() => setEditingModalOpen(false)}
          series={series}
          episodes={episodes}
          onUpdated={(updatedSeries) => {
            setSeriesList((prev) => {
              const idx = prev.findIndex((s) => s.id === updatedSeries.id);
              if (idx === -1) return [...prev, updatedSeries];
              const next = [...prev];
              next[idx] = updatedSeries;
              return next;
            });
            loadSeriesData();
            refresh();
            toast("已更新系列封面與資料", { type: "success" });
          }}
        />
      )}
    </main>
  );
}
