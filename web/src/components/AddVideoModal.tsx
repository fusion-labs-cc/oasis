"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import { useVideos } from "@/context/VideoContext";
import { useTasks, AnalysisTask } from "@/context/TasksContext";
import { useToast } from "@/components/Toast";
import { analyzeUrl, cancelAnalyze, cancelDownload, createVideo } from "@/lib/api";
import SupportedSites from "./SupportedSites";

interface AddVideoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// Same code shape the backend extracts: 2–10 uppercase letters, hyphen, digits.
// \b lets it match inside brackets too, e.g. "[START-344]".
const CODE_RE = /\b([A-Z]{2,10}-\d{2,5})\b/;

// Mirrors the backend heuristic: a CJK/kana name of 2–10 chars with little noise.
function looksLikeName(text: string): boolean {
  if (!text || text.length < 2 || text.length > 10) return false;
  if (!/[一-鿿぀-ゟ゠-ヿ]/.test(text)) return false;
  const noise = text.replace(/[一-鿿぀-ゟ゠-ヿ・]/g, "");
  return noise.length <= 2;
}

// If the title ends with "[space][actress name]", return that trailing name.
function guessActress(title: string, code?: string): string {
  let t = title;
  if (code) t = t.replace(code, "");
  t = t.replace(/[[\](){}【】（）]/g, " ").trim();
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return ""; // need content before the name
  const last = parts[parts.length - 1];
  return looksLikeName(last) ? last : "";
}

type Mode = "auto" | "manual";

const manualInputClass =
  "w-full bg-surface-highest border border-border-hairline rounded-xl px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/40 transition font-sans";

function ManualField({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-text-tertiary font-sans">
        {label}
        {required && <span className="text-accent">*</span>}
        {hint && (
          <span className="normal-case tracking-normal font-medium text-text-tertiary/70">
            — {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

export default function AddVideoModal({ isOpen, onClose }: AddVideoModalProps) {
  const { syncVideo, upsertVideo } = useVideos();
  const toast = useToast();
  // The progress list ("解析進度") is shared state so downloads started from
  // cards / the detail page also land here.
  const { tasks, setTasks } = useTasks();
  const [mode, setMode] = useState<Mode>("auto");
  const [url, setUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks whether the mouse was pressed down on the backdrop itself, so a
  // text selection that starts inside the modal and ends on the backdrop
  // (mouseup) doesn't get mistaken for a backdrop click and close the dialog.
  const backdropMouseDownRef = useRef(false);

  // Manual-entry form fields.
  const [mUrl, setMUrl] = useState("");
  const [mTitle, setMTitle] = useState("");
  const [mCode, setMCode] = useState("");
  const [mActress, setMActress] = useState("");
  const [mTags, setMTags] = useState("");
  const [mCover, setMCover] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Whether the user has hand-edited the code / actress; while false we keep
  // those fields auto-synced from whatever the title yields.
  const [codeTouched, setCodeTouched] = useState(false);
  const [actressTouched, setActressTouched] = useState(false);

  // Auto-extract the code and trailing actress name from the title (frontend)
  // and fill their fields, unless the user has typed their own values.
  const handleTitleChange = (v: string) => {
    setMTitle(v);
    setErrorMessage(null);
    const code = v.match(CODE_RE)?.[1] ?? "";
    if (!codeTouched) setMCode(code);
    if (!actressTouched) setMActress(guessActress(v, code || undefined));
  };

  const resetManual = () => {
    setMUrl("");
    setMTitle("");
    setMCode("");
    setMActress("");
    setMTags("");
    setMCover("");
    setCodeTouched(false);
    setActressTouched(false);
  };

  // Sync dialog visibility with state
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      setUrl("");
      setErrorMessage(null);
      dialog.showModal();
      // Auto-focus input on open (only relevant for the URL tab)
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      if (dialog.open) {
        dialog.close();
      }
    }
  }, [isOpen]);

  const handleBackdropMouseDown = (e: React.MouseEvent<HTMLDialogElement>) => {
    backdropMouseDownRef.current = e.target === dialogRef.current;
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    // Only close when both the press and the release happened on the backdrop.
    // This avoids closing when a drag-select started inside the modal.
    if (e.target === dialogRef.current && backdropMouseDownRef.current) {
      onClose();
    }
    backdropMouseDownRef.current = false;
  };

  const handleSubmit = async (e: React.FormEvent, download: boolean) => {
    e.preventDefault();
    const targetUrl = url.trim();
    if (!targetUrl) return;

    const isAlreadyAnalyzing = tasks.some(
      (t) => t.url === targetUrl && t.status === "analyzing"
    );
    if (isAlreadyAnalyzing) {
      setErrorMessage("此影片連結已在解析中，請勿重複提交！");
      return;
    }

    setErrorMessage(null);

    // Reset url input so user can submit next one immediately
    setUrl("");
    setTimeout(() => inputRef.current?.focus(), 50);

    const taskId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const newTask: AnalysisTask = {
      id: taskId,
      url: targetUrl,
      status: "analyzing",
      download,
    };

    setTasks((prev) => [newTask, ...prev]);

    try {
      // analyzeUrl resolves to just the new video id; fetch the full record
      // (which also merges it into the shared catalog).
      const videoId = await analyzeUrl(targetUrl, download, taskId);
      const record = await syncVideo(videoId);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                status: download ? "downloading" : "success",
                code: record?.code,
                title: record?.title_zh_tw || record?.title,
                actress: record?.actress || undefined,
                videoId,
              }
            : t
        )
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                status: "error",
                error: errMsg,
              }
            : t
        )
      );
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const url = mUrl.trim();
    const title = mTitle.trim();
    if (!url || !title) {
      setErrorMessage("網址與標題為必填欄位");
      return;
    }
    setErrorMessage(null);
    setSubmitting(true);
    try {
      const record = await createVideo({
        url,
        title,
        code: mCode.trim() || undefined,
        actress: mActress.trim() || undefined,
        tags: mTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        cover: mCover.trim() || undefined,
      });
      upsertVideo(record);
      toast(`已新增影片 ${record.code}`, { type: "success" });
      resetManual();
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelAnalyze = async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === "canceling") return;

    // Optimistically update status to "canceling"
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: "canceling" as const } : t))
    );

    try {
      await cancelAnalyze(taskId);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                status: "error",
                error: "分析已取消",
              }
            : t
        )
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      // Revert status back to analyzing if cancel fails
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: "analyzing" as const } : t))
      );
    }
  };

  const handleCancelDownload = async (videoId: number) => {
    try {
      await cancelDownload(videoId);
      setTasks((prev) =>
        prev.map((t) =>
          t.videoId === videoId
            ? {
                ...t,
                status: "error",
                error: "下載已取消",
              }
            : t
        )
      );
      syncVideo(videoId);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleClearTask = (taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  };

  const isTaskActive = (task: AnalysisTask) => {
    return task.status === "analyzing" || task.status === "canceling" || task.status === "downloading";
  };

  const handleClearAll = () => {
    setTasks((prev) => prev.filter(isTaskActive));
  };

  return (
    <dialog
      ref={dialogRef}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
      onClose={onClose}
      className="fixed left-1/2 top-[7vh] -translate-x-1/2 w-full max-w-xl max-h-[86vh] overflow-y-auto rounded-2xl border border-border-hairline bg-surface-elevated p-6 shadow-2xl outline-none"
    >
      <div className="flex items-center justify-between border-b border-border-hairline pb-4 mb-4">
        <div>
          <h2 className="text-base font-bold text-text-primary">新增影片</h2>
          <p className="text-xs text-text-tertiary mt-0.5 font-sans">
            {mode === "auto"
              ? "輸入支援網站的影片網址以解析或下載"
              : "手動填寫欄位，新增其他來源的影片"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-text-tertiary hover:bg-surface-highest hover:text-text-primary transition"
        >
          ✕
        </button>
      </div>

      {/* Mode tabs: scrape a URL vs. fill fields manually */}
      <div className="mb-4 flex gap-1 rounded-xl border border-border-hairline bg-surface-highest/40 p-1">
        {([
          ["auto", "解析網址"],
          ["manual", "手動新增"],
        ] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setErrorMessage(null);
            }}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold transition cursor-pointer ${
              mode === m
                ? "bg-accent text-neutral-950 shadow-[0_2px_10px_rgba(16,185,129,0.2)]"
                : "text-text-secondary hover:text-text-primary hover:bg-surface-highest"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "manual" && (
        <form onSubmit={handleManualSubmit} className="space-y-3.5">
          <ManualField label="影片網址" required>
            <input
              type="url"
              required
              value={mUrl}
              onChange={(e) => {
                setMUrl(e.target.value);
                setErrorMessage(null);
              }}
              placeholder="https://..."
              className={manualInputClass}
            />
          </ManualField>

          <ManualField label="標題" required>
            <input
              type="text"
              required
              value={mTitle}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="影片標題"
              className={manualInputClass}
            />
          </ManualField>

          <ManualField label="片號" hint="選填，會自動從標題擷取，留空則產生編號">
            <input
              type="text"
              value={mCode}
              onChange={(e) => {
                const v = e.target.value;
                setMCode(v);
                // Empty again → resume auto-syncing from the title.
                setCodeTouched(v.trim() !== "");
              }}
              placeholder="例如 START-344"
              className={manualInputClass}
            />
          </ManualField>

          <div className="grid grid-cols-2 gap-3">
            <ManualField label="女優" hint="選填，自動從標題結尾擷取">
              <input
                type="text"
                value={mActress}
                onChange={(e) => {
                  const v = e.target.value;
                  setMActress(v);
                  // Empty again → resume auto-syncing from the title.
                  setActressTouched(v.trim() !== "");
                }}
                placeholder="女優名稱"
                className={manualInputClass}
              />
            </ManualField>
            <ManualField label="標籤" hint="選填，逗號分隔">
              <input
                type="text"
                value={mTags}
                onChange={(e) => setMTags(e.target.value)}
                placeholder="標籤1, 標籤2"
                className={manualInputClass}
              />
            </ManualField>
          </div>

          <ManualField label="封面圖片網址" hint="選填">
            <input
              type="url"
              value={mCover}
              onChange={(e) => setMCover(e.target.value)}
              placeholder="https://..."
              className={manualInputClass}
            />
          </ManualField>

          {errorMessage && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3.5 text-xs text-red-400 font-sans leading-relaxed">
              ⚠️ {errorMessage}
            </div>
          )}

          <div className="flex justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={() => {
                resetManual();
                setErrorMessage(null);
              }}
              disabled={submitting}
              className="rounded-xl border border-border-hairline bg-transparent hover:bg-surface-highest text-text-secondary hover:text-text-primary transition duration-150 px-5 py-3 text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              重置
            </button>
            <button
              type="submit"
              disabled={!mUrl.trim() || !mTitle.trim() || submitting}
              className="rounded-xl bg-accent text-neutral-950 hover:bg-accent-hover transition duration-150 px-5 py-3 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_4px_20px_rgba(16,185,129,0.2)] hover:shadow-[0_4px_24px_rgba(16,185,129,0.3)] active:scale-98 cursor-pointer"
            >
              {submitting ? "新增中..." : "新增至資料庫"}
            </button>
          </div>
        </form>
      )}

      {mode === "auto" && (
      <form onSubmit={(e) => handleSubmit(e, true)} className="space-y-4">
        <div className="relative">
          <input
            ref={inputRef}
            id="add-video-url"
            type="url"
            required
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setErrorMessage(null);
            }}
            placeholder="貼上支援網站的影片網址…"
            className="w-full bg-surface-highest border border-border-hairline rounded-xl px-4 py-3.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/40 transition font-sans"
          />
        </div>

        <SupportedSites />

        {errorMessage && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3.5 text-xs text-red-400 font-sans leading-relaxed">
            ⚠️ {errorMessage}
          </div>
        )}

        <div className="flex justify-end gap-2.5 pt-2">
          <button
            type="button"
            onClick={(e) => handleSubmit(e, false)}
            disabled={!url.trim()}
            className="rounded-xl border border-border-hairline bg-transparent hover:bg-surface-highest text-text-secondary hover:text-text-primary transition duration-150 px-5 py-3 text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            僅分析
          </button>
          <button
            type="submit"
            disabled={!url.trim()}
            className="rounded-xl bg-accent text-neutral-950 hover:bg-accent-hover transition duration-150 px-5 py-3 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_4px_20px_rgba(16,185,129,0.2)] hover:shadow-[0_4px_24px_rgba(16,185,129,0.3)] active:scale-98 cursor-pointer"
          >
            分析並下載
          </button>
        </div>
      </form>
      )}

      {tasks.length > 0 && (
        <div className="mt-6 border-t border-border-hairline pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-tertiary font-sans">
              解析進度 ({tasks.filter((t) => t.status === "analyzing" || t.status === "downloading").length} 進行中)
            </h3>
            <button
              type="button"
              onClick={handleClearAll}
              className="text-[10px] text-text-tertiary hover:text-accent transition cursor-pointer"
            >
              清除所有記錄
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto space-y-2.5 pr-1">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="flex flex-col gap-1.5 rounded-xl border border-border-hairline bg-surface-base/50 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-mono text-text-secondary select-all" title={task.url}>
                    {task.url}
                  </span>
                  {task.status === "analyzing" && (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-accent animate-pulse">
                        <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
                        解析中...
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCancelAnalyze(task.id)}
                        title="取消解析"
                        className="text-[11px] font-bold text-red-400 hover:text-red-300 transition duration-150 cursor-pointer"
                      >
                        取消
                      </button>
                    </div>
                  )}
                  {task.status === "canceling" && (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-text-tertiary animate-pulse">
                        <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-text-tertiary/20 border-t-text-tertiary" />
                        取消中...
                      </span>
                    </div>
                  )}
                  {task.status === "downloading" && (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-accent animate-pulse">
                        <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
                        下載中...
                      </span>
                      {typeof task.videoId === "number" && (
                        <button
                          type="button"
                          onClick={() => handleCancelDownload(task.videoId!)}
                          title="取消下載"
                          className="text-[11px] font-bold text-red-400 hover:text-red-300 transition duration-150 cursor-pointer"
                        >
                          取消
                        </button>
                      )}
                    </div>
                  )}
                  {task.status === "success" && (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-accent shrink-0">
                        ✓ {task.download ? "下載完成" : "解析成功"}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleClearTask(task.id)}
                        title="清除記錄"
                        className="text-[11px] text-text-tertiary hover:text-text-primary transition duration-150 cursor-pointer"
                      >
                        清除
                      </button>
                    </div>
                  )}
                  {task.status === "error" && (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-red-400 shrink-0">
                        ✕ 失敗
                      </span>
                      <button
                        type="button"
                        onClick={() => handleClearTask(task.id)}
                        title="清除記錄"
                        className="text-[11px] text-text-tertiary hover:text-text-primary transition duration-150 cursor-pointer"
                      >
                        清除
                      </button>
                    </div>
                  )}
                </div>

                {(task.status === "success" || task.status === "downloading") && (
                  <div className="mt-1 flex items-center justify-between gap-2 border-t border-border-hairline/50 pt-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-[10px] font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded shrink-0">
                        {task.code}
                      </span>
                      {task.actress && (
                        <span className="truncate text-[10px] font-semibold text-text-secondary">
                          {task.actress}
                        </span>
                      )}
                      <span className="truncate text-[10px] text-text-tertiary">
                        {task.title}
                      </span>
                    </div>
                    <span className="text-[9px] font-semibold text-text-tertiary shrink-0">
                      {task.status === "downloading" ? "📥 下載中" : task.download ? "📥 下載完成" : "🔍 僅 analysis"}
                    </span>
                  </div>
                )}

                {task.status === "error" && (
                  <p className="mt-1 text-[10px] text-red-400/80 leading-relaxed font-sans border-t border-border-hairline/50 pt-1.5">
                    {task.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </dialog>
  );
}
