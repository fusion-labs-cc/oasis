"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import type Plyr from "plyr";
import "plyr/dist/plyr.css";
import { downloadVideo, cancelDownload, logPlay, updateVideoTags, updateVideoDetails, deleteVideo, openInPlayer, safeExternalHref, backendUrl } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useBackend } from "@/context/BackendContext";
import { useVideos } from "@/context/VideoContext";
import { useTasks } from "@/context/TasksContext";

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { status } = useBackend();
  const { videos, loaded, syncVideo, upsertVideo, updateVideo, removeVideo } = useVideos();
  const { addDownloadTask, markDownloadCanceled } = useTasks();
  const router = useRouter();
  const toast = useToast();
  const numId = Number(id);
  // The record is derived from the shared catalog, so context updates (e.g. the
  // download watcher flipping is_downloading / video_path) flow in reactively.
  const video = videos.find((v) => v.id === numId) ?? null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [editingTags, setEditingTags] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [savingTags, setSavingTags] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState({ code: "", title: "", actress: "", url: "", cover: "" });
  const [savingDetails, setSavingDetails] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [theater, setTheater] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const plyrRef = useRef<Plyr | null>(null);
  const theaterBtnRef = useRef<HTMLButtonElement | null>(null);
  const theaterRef = useRef(false);
  const playLogged = useRef(false);
  // Set when we intentionally navigate away (e.g. after deleting), so the
  // "video not found" effect doesn't fire a spurious toast on the way out.
  const leaving = useRef(false);

  const isDownloading = downloading || video?.is_downloading;

  function startEditingDetails() {
    if (!video) return;
    setDetailsDraft({
      code: video.code || "",
      title: video.title_zh_tw || video.title || "",
      actress: video.actress || "",
      url: video.url || "",
      cover: video.cover || "",
    });
    setEditingDetails(true);
  }

  async function saveDetails() {
    if (!video?.id) return;
    setSavingDetails(true);
    try {
      const updated = await updateVideoDetails(video.id, {
        code: detailsDraft.code.trim(),
        title: detailsDraft.title.trim(),
        actress: detailsDraft.actress.trim(),
        url: detailsDraft.url.trim(),
        cover: detailsDraft.cover.trim(),
      });
      upsertVideo(updated);
      setEditingDetails(false);
      toast("影片資訊已更新", { type: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
    } finally {
      setSavingDetails(false);
    }
  }

  // Persist a new tag list, updating the local record on success.
  async function saveTags(tags: string[]) {
    if (!video?.id) return;
    setSavingTags(true);
    try {
      const updated = await updateVideoTags(video.id, tags);
      upsertVideo(updated);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
    } finally {
      setSavingTags(false);
    }
  }

  function addTag() {
    const t = newTag.trim();
    if (!t || !video) return;
    if ((video.tags ?? []).includes(t)) {
      toast("此標籤已存在", { type: "info" });
      return;
    }
    setNewTag("");
    saveTags([...(video.tags ?? []), t]);
  }

  function removeTag(tag: string) {
    if (!video) return;
    saveTags((video.tags ?? []).filter((t) => t !== tag));
  }

  async function handleOpenInPlayer() {
    if (!video?.id) return;
    try {
      const res = await openInPlayer(video.id);
      if (typeof res.play_count === "number") {
        updateVideo(video.id, { play_count: res.play_count });
      }
      localStorage.setItem("oasis:last_watched_id", String(video.id));
      localStorage.setItem("oasis:last_watched_type", "play");
      toast("已用電腦播放器開啟", { type: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
    }
  }

  const handleOriginalSiteClick = () => {
    if (!video?.id) return;
    localStorage.setItem("oasis:last_watched_id", String(video.id));
    localStorage.setItem("oasis:last_watched_type", "original_site");
  };

  async function handleDelete(localOnly = false) {
    if (!video?.id || deleting) return;
    setDeleting(true);
    try {
      const res = await deleteVideo(video.id, localOnly);
      toast(
        localOnly
          ? "已刪除本地影片檔案，保留影片記錄"
          : (res.deleted_file ? "已刪除影片與本地檔案" : "已刪除影片記錄"),
        { type: "success" },
      );
      if (localOnly) {
        await syncVideo(video.id);
        setDeleting(false);
        setConfirmingDelete(false);
      } else {
        leaving.current = true;
        removeVideo(video.id);
        router.push("/");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  // Restore + persist the theater-mode preference (browser only).
  useEffect(() => {
    setTheater(localStorage.getItem("oasis:theater") === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem("oasis:theater", theater ? "1" : "0");
  }, [theater]);

  // Keep the player's keyboard controls predictable no matter what the user
  // last touched: Space toggles play/pause, ←/→ seek, ↑/↓ adjust volume — even
  // right after clicking a control button (fullscreen, settings…) or dragging
  // the progress/volume sliders. We claim these keys in the capture phase and
  // stop propagation so a focused control can't swallow Space to re-fire
  // itself, and so Plyr's own global handler doesn't act twice.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const player = plyrRef.current;
      if (!player) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Don't hijack typing in the page's own inputs (tags, details…). Plyr's
      // range inputs live inside `.plyr`, so those are still handled here.
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) &&
        !el.closest(".plyr")
      ) {
        return;
      }

      switch (e.key) {
        case " ":
        case "k":
        case "K":
          player.togglePlay();
          break;
        case "ArrowLeft":
          player.rewind();
          break;
        case "ArrowRight":
          player.forward();
          break;
        case "ArrowUp":
          player.increaseVolume(0.1);
          break;
        case "ArrowDown":
          player.decreaseVolume(0.1);
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // "t" toggles theater mode, YouTube-style (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        setTheater((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Log a play the first time playback starts on this page view.
  async function handlePlay() {
    if (video?.id) {
      localStorage.setItem("oasis:last_watched_id", String(video.id));
      localStorage.setItem("oasis:last_watched_type", "play");
    }
    if (playLogged.current || !video?.id) return;
    playLogged.current = true;
    try {
      const count = await logPlay(video.id);
      updateVideo(video.id, { play_count: count });
    } catch {
      playLogged.current = false; // allow a retry on the next play
    }
  }

  async function handleDownload() {
    if (isDownloading || !video?.id) return;
    setDownloading(true);
    try {
      await downloadVideo(video.id);
      updateVideo(video.id, { is_downloading: true });
      addDownloadTask(video);
      toast("已開始在背景下載影片！完成後會自動播放。", { type: "success" });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
      setDownloading(false);
    }
  }

  async function handleCancelDownload() {
    if (!video?.id) return;
    try {
      await cancelDownload(video.id);
      setDownloading(false);
      updateVideo(video.id, { is_downloading: false });
      markDownloadCanceled(video.id);
      await syncVideo(video.id);
      toast("已取消下載影片！", { type: "info" });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { type: "error" });
    }
  }

  // Initialise the Plyr player once the local <video> element is mounted, and
  // persist/restore playback progress in the browser (localStorage only).
  useEffect(() => {
    const el = videoRef.current;
    const vid = video?.id;
    if (!el || !video?.video_path || !video?.local_file_exists || vid == null) return;

    let player: Plyr | null = null;
    let cancelled = false;

    // Plyr touches `document` at module load, so import it only on the client.
    import("plyr").then(({ default: PlyrCtor }) => {
      if (cancelled || !videoRef.current) return;
      player = new PlyrCtor(el, {
        seekTime: 5,
        keyboard: { focused: true, global: true },
        settings: ["speed"],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] },
      });
      plyrRef.current = player;

      // Inject a theater-mode toggle into Plyr's control bar (before fullscreen).
      player.once("ready", () => {
        const controls = player!.elements.controls;
        if (!controls || controls.querySelector('[data-plyr="theater"]')) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "plyr__controls__item plyr__control";
        btn.setAttribute("data-plyr", "theater");
        btn.innerHTML =
          '<svg aria-hidden="true" focusable="false" viewBox="0 0 18 18">' +
          '<rect x="2" y="4.5" width="14" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
          '</svg><span class="plyr__sr-only">劇院模式</span>';
        btn.addEventListener("click", () => setTheater((v) => !v));
        btn.setAttribute("aria-pressed", theaterRef.current ? "true" : "false");
        btn.setAttribute(
          "title",
          theaterRef.current ? "標準模式 (t)" : "劇院模式 (t)",
        );
        const fsBtn = controls.querySelector('[data-plyr="fullscreen"]');
        if (fsBtn) controls.insertBefore(btn, fsBtn);
        else controls.appendChild(btn);
        theaterBtnRef.current = btn;
      });
    });

    const key = `oasis:progress:${vid}`;

    // Jump to the last saved spot (skip if it's basically the end).
    const resume = () => {
      const saved = Number(localStorage.getItem(key) || 0);
      if (saved > 5 && (!el.duration || saved < el.duration - 10)) {
        el.currentTime = saved;
      }
    };

    // Store the current position, but not right at the very end.
    const save = () => {
      const t = el.currentTime;
      if (t > 0 && (!el.duration || t < el.duration - 1)) {
        localStorage.setItem(key, String(Math.floor(t)));
        localStorage.setItem("oasis:last_watched_id", String(vid));
        localStorage.setItem("oasis:last_watched_type", "play");
        if (el.duration) {
          localStorage.setItem(`oasis:duration:${vid}`, String(Math.floor(el.duration)));
        }
      }
    };

    let lastSave = 0;
    const onTimeUpdate = () => {
      const now = Date.now();
      if (now - lastSave > 3000) {
        lastSave = now;
        save();
      }
    };
    const onEnded = () => {
      localStorage.removeItem(key);
      localStorage.removeItem(`oasis:duration:${vid}`);
    };

    el.addEventListener("loadedmetadata", resume);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("pause", save);
    el.addEventListener("ended", onEnded);
    window.addEventListener("beforeunload", save);
    // Metadata may already be available from cache on a fast reload.
    if (el.readyState >= 1) resume();

    return () => {
      save();
      el.removeEventListener("loadedmetadata", resume);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("pause", save);
      el.removeEventListener("ended", onEnded);
      window.removeEventListener("beforeunload", save);
      cancelled = true;
      player?.destroy();
      plyrRef.current = null;
      theaterBtnRef.current = null;
    };
  }, [video?.video_path, video?.local_file_exists, video?.id]);

  // Reflect theater state on the injected control-bar button.
  useEffect(() => {
    theaterRef.current = theater;
    const btn = theaterBtnRef.current;
    if (!btn) return;
    btn.setAttribute("aria-pressed", theater ? "true" : "false");
    btn.setAttribute("title", theater ? "標準模式 (t)" : "劇院模式 (t)");
  }, [theater]);

  // Reset the "already logged a play" guard whenever we land on a new video.
  useEffect(() => {
    playLogged.current = false;
  }, [id]);

  // Ensure a record is available. If it's already in the shared catalog we do
  // nothing (no fetch). Only a deep link / hard reload that lands here before
  // the catalog has loaded triggers a single-record fetch.
  useEffect(() => {
    if (status !== "up") {
      if (status === "down") {
        setError("本機伺服器未連線");
        setLoading(false);
      }
      return;
    }
    if (video) {
      setLoading(false);
      setError(null);
      return;
    }
    // We just deleted this record and are navigating home; don't treat the now
    // missing record as a "video not found" case.
    if (leaving.current) return;
    if (!loaded) {
      // Catalog still loading; wait for it rather than double-fetching.
      setLoading(true);
      return;
    }
    setLoading(true);
    syncVideo(numId)
      .then((v) => {
        if (!v) {
          // Deep link / manual URL to a video that doesn't exist: send the user
          // home with a toast rather than parking them on an error page.
          toast("該影片不存在或已被刪除。", { type: "error" });
          router.replace("/");
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [status, video, loaded, numId, syncVideo, router, toast]);

  // Reflect the video code in the tab title: "[code] - OASIS".
  useEffect(() => {
    document.title = video?.code ? `${video.code} - OASIS` : "OASIS";
  }, [video?.code]);

  // Drop the optimistic flag once the server view is authoritative.
  useEffect(() => {
    if (video?.is_downloading || (video?.video_path && video?.local_file_exists)) setDownloading(false);
  }, [video?.is_downloading, video?.video_path, video?.local_file_exists]);

  // Download progress is reconciled centrally by VideoContext's watcher; since
  // `video` is derived from the shared catalog, the player appears here
  // automatically once the download finishes.

  // Formatter for file sizes
  function formatBytes(bytes?: number | null) {
    if (bytes == null) return "未知大小";
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  if (loading && !video) {
    return (
      <main className="mx-auto w-full max-w-7xl px-8 py-6 animate-pulse">
        <div className="mx-auto aspect-video w-full max-w-[calc((100vh-8rem)*16/9)] bg-surface-elevated rounded-2xl" />
        <div className="mt-8 rounded-2xl border border-border-hairline bg-surface-elevated p-6 space-y-6">
          <div className="flex justify-between items-center pb-4 border-b border-border-hairline">
            <div className="h-6 w-32 bg-surface-highest rounded" />
            <div className="h-6 w-16 bg-surface-highest rounded-full" />
          </div>
          <div className="space-y-2">
            <div className="h-5 w-full bg-surface-highest rounded" />
            <div className="h-5 w-3/4 bg-surface-highest rounded" />
          </div>
        </div>
      </main>
    );
  }

  if (error || !video) {
    return (
      <main className="mx-auto w-full max-w-7xl px-8 py-6">
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-400 font-sans leading-relaxed">
          <div className="flex items-center gap-2 font-semibold mb-1">
            <span>✕</span>
            <span>無法載入影片</span>
          </div>
          <p className="text-xs text-red-400/80">{error || "該影片不存在或已被刪除。"}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-8 py-6">
      {/* Video Player */}
      {video.video_path && video.local_file_exists ? (
        <div
          className={
            theater
              ? "theater relative left-1/2 w-screen -translate-x-1/2 bg-black"
              : "player-shell overflow-hidden rounded-2xl bg-black shadow-2xl border border-border-hairline"
          }
        >
          <div className={theater ? "mx-auto" : ""}>
            <video
              ref={videoRef}
              controls
              autoPlay={false}
              onPlay={handlePlay}
              className="mx-auto w-full aspect-video max-h-[calc(100vh-8rem)] max-w-[calc((100vh-8rem)*16/9)] outline-none"
              src={backendUrl(`/api/stream/${video.id}`)}
              poster={video.cover || undefined}
            >
              您的瀏覽器不支援影片播放。
            </video>
          </div>
        </div>
      ) : null}

      {(!video.video_path || !video.local_file_exists) && (
        <div className="relative mx-auto aspect-video w-full max-h-[calc(100vh-8rem)] max-w-[calc((100vh-8rem)*16/9)] overflow-hidden rounded-2xl border border-border-hairline bg-surface-elevated flex flex-col items-center justify-center shadow-2xl">
          {video.cover && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={video.cover}
                alt={video.code}
                className="absolute inset-0 h-full w-full object-cover blur-md opacity-15 scale-105"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={video.cover}
                alt={video.code}
                className="relative z-10 max-h-[60%] max-w-[80%] rounded-xl object-contain border border-border-hairline shadow-2xl mb-6"
              />
            </>
          )}
          
          <div className="relative z-10 flex flex-col items-center text-center px-6">
            <p className="text-text-secondary text-sm font-semibold mb-4">
              本地影片檔案不存在
            </p>
            
            <div className="flex flex-wrap items-center justify-center gap-3">
              {isDownloading ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center gap-2 rounded-xl bg-accent/10 px-5 py-3 text-sm font-bold text-accent border border-accent/20 animate-pulse">
                      <span className="h-2 w-2 rounded-full bg-accent animate-ping" />
                      {video.download_queued
                        ? "排隊中，等待前一支下載完成..."
                        : typeof video.download_progress === "number"
                          ? `正在背景下載中 ${video.download_progress}%`
                          : "正在背景下載中..."}
                    </span>
                    <button
                      onClick={handleCancelDownload}
                      className="rounded-xl border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 px-5 py-3 text-sm font-semibold text-red-400 transition cursor-pointer"
                    >
                      取消下載
                    </button>
                  </div>
                  {!video.download_queued &&
                    typeof video.download_progress === "number" && (
                      <div className="h-1.5 w-64 max-w-full overflow-hidden rounded-full bg-surface-highest">
                        <div
                          className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
                          style={{ width: `${video.download_progress}%` }}
                        />
                      </div>
                    )}
                </div>
              ) : (
                <button
                  onClick={handleDownload}
                  className="rounded-xl bg-accent text-neutral-950 px-5 py-3 text-sm font-bold transition hover:bg-accent-hover shadow-[0_4px_20px_rgba(16,185,129,0.25)] cursor-pointer"
                >
                  ↓ 下載影片至本地
                </button>
              )}
              <a
                href={safeExternalHref(video.url)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleOriginalSiteClick}
                className="rounded-xl border border-border-hairline bg-surface-highest hover:bg-border-hairline px-5 py-3 text-sm font-semibold text-text-primary transition cursor-pointer"
              >
                前往原始網站觀看 ↗
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Video Info */}
      <div className="mt-8 rounded-2xl border border-border-hairline bg-surface-elevated p-6 shadow-xl">
        {editingDetails ? (
          <div className="border-b border-border-hairline pb-5 mb-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-bold uppercase tracking-wider text-text-tertiary font-sans">
                編輯影片資訊
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveDetails}
                  disabled={savingDetails}
                  className="rounded-full bg-green-500/10 border border-green-500/20 px-3 py-1 text-[11px] font-bold text-green-500 hover:bg-green-500/20 transition cursor-pointer disabled:opacity-50"
                >
                  {savingDetails ? "儲存中…" : "儲存"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingDetails(false)}
                  disabled={savingDetails}
                  className="rounded-full bg-surface-highest border border-border-hairline px-3 py-1 text-[11px] font-bold text-text-secondary hover:text-text-primary transition cursor-pointer disabled:opacity-50"
                >
                  取消
                </button>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="block text-[10px] font-bold text-text-tertiary font-sans uppercase mb-1.5">片號</span>
                <input
                  type="text"
                  value={detailsDraft.code}
                  onChange={(e) => setDetailsDraft((d) => ({ ...d, code: e.target.value }))}
                  disabled={savingDetails}
                  placeholder="例如 START-344"
                  className="w-full rounded-xl border border-border-hairline bg-surface-highest px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-accent transition"
                />
              </label>
              <label className="block">
                <span className="block text-[10px] font-bold text-text-tertiary font-sans uppercase mb-1.5">女優</span>
                <input
                  type="text"
                  value={detailsDraft.actress}
                  onChange={(e) => setDetailsDraft((d) => ({ ...d, actress: e.target.value }))}
                  disabled={savingDetails}
                  placeholder="輸入女優名稱 (留空表示無指定)"
                  className="w-full rounded-xl border border-border-hairline bg-surface-highest px-3 py-2 text-sm text-text-primary font-sans focus:outline-none focus:border-accent transition"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="block text-[10px] font-bold text-text-tertiary font-sans uppercase mb-1.5">標題</span>
                <input
                  type="text"
                  value={detailsDraft.title}
                  onChange={(e) => setDetailsDraft((d) => ({ ...d, title: e.target.value }))}
                  disabled={savingDetails}
                  placeholder="輸入標題"
                  className="w-full rounded-xl border border-border-hairline bg-surface-highest px-3 py-2 text-sm text-text-primary font-sans focus:outline-none focus:border-accent transition"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="block text-[10px] font-bold text-text-tertiary font-sans uppercase mb-1.5">原始網址</span>
                <input
                  type="url"
                  value={detailsDraft.url}
                  onChange={(e) => setDetailsDraft((d) => ({ ...d, url: e.target.value }))}
                  disabled={savingDetails}
                  placeholder="https://…"
                  className="w-full rounded-xl border border-border-hairline bg-surface-highest px-3 py-2 text-sm text-text-primary font-sans focus:outline-none focus:border-accent transition"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="block text-[10px] font-bold text-text-tertiary font-sans uppercase mb-1.5">封面圖網址</span>
                <input
                  type="url"
                  value={detailsDraft.cover}
                  onChange={(e) => setDetailsDraft((d) => ({ ...d, cover: e.target.value }))}
                  disabled={savingDetails}
                  placeholder="https://… (留空表示無封面)"
                  className="w-full rounded-xl border border-border-hairline bg-surface-highest px-3 py-2 text-sm text-text-primary font-sans focus:outline-none focus:border-accent transition"
                />
              </label>
            </div>
          </div>
        ) : (
          <>
        {/* Code + Actress row */}
        <div className="flex items-center justify-between gap-4 border-b border-border-hairline pb-4 mb-4">
          <h1 className="font-mono text-2xl font-black text-text-primary tracking-tight flex items-center gap-2">
            {video.code}
            <button
              type="button"
              onClick={startEditingDetails}
              className="text-xs text-text-tertiary hover:text-accent font-semibold transition cursor-pointer underline underline-offset-2 font-sans"
            >
              編輯
            </button>
          </h1>
          <div className="flex items-center gap-2">
            {video.actress ? (
              <Link
                href={`/?actress=${encodeURIComponent(video.actress)}`}
                className="rounded-full bg-accent/10 border border-accent/20 px-3.5 py-1.5 text-xs font-bold text-accent hover:bg-accent/20 transition duration-150"
              >
                {video.actress}
              </Link>
            ) : (
              <span className="text-xs text-text-tertiary font-sans bg-surface-highest/40 border border-dashed border-border-hairline rounded-full px-3 py-1">
                無指定女優
              </span>
            )}
          </div>
        </div>

        {/* Titles */}
        <div className="space-y-1.5">
          {video.title_zh_tw && (
            <h2 className="text-lg font-bold text-text-primary leading-relaxed">
              {video.title_zh_tw}
            </h2>
          )}
          {video.title && video.title !== video.title_zh_tw && (
            <p className="text-sm text-text-tertiary leading-relaxed font-sans">
              {video.title}
            </p>
          )}
        </div>
          </>
        )}

        {/* Actions */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border-hairline pt-6">
          <div className="flex items-center gap-3">
            {video.video_path && video.local_file_exists && (
              <button
                onClick={handleOpenInPlayer}
                className="inline-flex items-center gap-2 rounded-xl border border-border-hairline bg-surface-highest hover:bg-border-hairline text-text-secondary hover:text-text-primary font-semibold transition px-4 py-2.5 text-xs cursor-pointer animate-none"
              >
                🖥 用電腦播放器開啟
              </button>
            )}
            <a
              href={safeExternalHref(video.url)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleOriginalSiteClick}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border-hairline bg-surface-highest hover:bg-border-hairline text-text-secondary hover:text-text-primary font-semibold transition px-4 py-2.5 text-xs cursor-pointer"
            >
              🌐 原始網站 ↗
            </a>
          </div>

          {confirmingDelete ? (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs font-sans">
              <span className="font-semibold text-red-400">
                {video.video_path && video.local_file_exists
                  ? "選擇刪除動作："
                  : "確定要刪除此影片記錄？"}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {video.video_path && video.local_file_exists && (
                  <button
                    onClick={() => handleDelete(true)}
                    disabled={deleting}
                    className="rounded-xl bg-amber-600 hover:bg-amber-700 px-3 py-1.5 font-bold text-white transition disabled:opacity-50 cursor-pointer"
                  >
                    {deleting ? "處理中…" : "僅刪除本地影片"}
                  </button>
                )}
                <button
                  onClick={() => handleDelete(false)}
                  disabled={deleting}
                  className="rounded-xl bg-red-600 px-3 py-1.5 font-bold text-white transition hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                >
                  {deleting
                    ? "處理中…"
                    : video.video_path && video.local_file_exists
                    ? "刪除整筆記錄與影片"
                    : "確定刪除"}
                </button>
                <button
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                  className="rounded-xl border border-border-hairline bg-surface-highest px-3 py-1.5 font-bold text-text-secondary hover:text-text-primary transition disabled:opacity-50 cursor-pointer"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-2.5 text-xs font-bold text-red-400 transition hover:bg-red-500/10 cursor-pointer"
            >
              🗑 刪除影片
            </button>
          )}
        </div>

        {/* Tags */}
        <div className="mt-8 border-t border-border-hairline pt-6">
          <div className="mb-3 flex items-center gap-3">
            <span className="text-xs font-bold uppercase tracking-wider text-text-tertiary font-sans">標籤</span>
            <button
              type="button"
              onClick={() => setEditingTags((v) => !v)}
              className="text-xs text-text-tertiary hover:text-accent font-semibold transition cursor-pointer underline underline-offset-2"
            >
              {editingTags ? "完成" : "編輯"}
            </button>
            {savingTags && (
              <span className="text-[11px] text-text-tertiary font-sans animate-pulse">儲存中…</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {(video.tags ?? []).map((t) =>
              editingTags ? (
                <span
                  key={t}
                  className="inline-flex items-center gap-1.5 rounded-full bg-surface-highest px-3 py-1.5 text-xs font-semibold text-text-secondary border border-border-hairline"
                >
                  {t}
                  <button
                    type="button"
                    onClick={() => removeTag(t)}
                    disabled={savingTags}
                    aria-label={`移除 ${t}`}
                    className="flex h-4 w-4 items-center justify-center rounded-full text-text-tertiary hover:bg-red-500/20 hover:text-red-400 transition disabled:opacity-50 cursor-pointer font-bold"
                  >
                    ×
                  </button>
                </span>
              ) : (
                <Link
                  key={t}
                  href={`/?tag=${encodeURIComponent(t)}`}
                  className="rounded-full bg-surface-highest/60 hover:bg-surface-highest border border-border-hairline px-3 py-1 text-xs font-semibold text-text-secondary hover:text-text-primary transition duration-150"
                >
                  {t}
                </Link>
              ),
            )}

            {editingTags && (
              <input
                type="text"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={addTag}
                disabled={savingTags}
                placeholder="+ 新增標籤"
                className="w-28 rounded-full border border-dashed border-border-hairline bg-transparent px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-sans transition"
              />
            )}

            {!editingTags && (video.tags ?? []).length === 0 && (
              <span className="text-xs text-text-tertiary font-sans">尚無標籤</span>
            )}
          </div>
        </div>

        {/* System Metadata Grid */}
        <div className="mt-8 border-t border-border-hairline pt-6">
          <span className="block text-xs font-bold uppercase tracking-wider text-text-tertiary font-sans mb-3">
            系統中繼資料
          </span>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-xl border border-border-hairline bg-surface-highest/40 p-4">
              <span className="block text-[10px] font-bold text-text-tertiary font-sans uppercase">播放次數</span>
              <span className="block mt-1 text-sm font-semibold text-text-primary font-mono">▶ {video.play_count ?? 0} 次</span>
            </div>
            
            <div className="rounded-xl border border-border-hairline bg-surface-highest/40 p-4">
              <span className="block text-[10px] font-bold text-text-tertiary font-sans uppercase">建立日期</span>
              <span className="block mt-1 text-sm font-semibold text-text-primary font-mono">
                {video.created_at ? new Date(video.created_at).toLocaleDateString("zh-TW") : "未知"}
              </span>
            </div>

            <div className="rounded-xl border border-border-hairline bg-surface-highest/40 p-4">
              <span className="block text-[10px] font-bold text-text-tertiary font-sans uppercase">檔案大小</span>
              <span className="block mt-1 text-sm font-semibold text-text-primary font-mono">
                {formatBytes(video.file_size)}
              </span>
            </div>

            <div className="rounded-xl border border-border-hairline bg-surface-highest/40 p-4">
              <span className="block text-[10px] font-bold text-text-tertiary font-sans uppercase">影音格式</span>
              <span className="block mt-1 text-sm font-semibold text-text-primary font-mono">
                {video.video_path && video.local_file_exists ? video.video_path.split('.').pop()?.toUpperCase() || "MP4" : "無本地檔案"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
