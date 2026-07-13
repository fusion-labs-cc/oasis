"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import { useVideos } from "@/context/VideoContext";
import { useToast } from "@/components/Toast";
import { exportVideos, importVideos, type ExportedVideo } from "@/lib/api";

type Tab = "export" | "import";

interface ImportExportModalProps {
  isOpen: boolean;
  tab: Tab;
  onClose: () => void;
  // When provided, the export tab serialises this fixed list (e.g. a selection)
  // instead of fetching the whole catalog from the backend.
  exportData?: ExportedVideo[] | null;
  // Hide the import tab and lock to export (used by the "export selection" flow).
  exportOnly?: boolean;
  // Extra line under the title, e.g. "匯出所選 3 部影片".
  subtitle?: string;
}

const textareaClass =
  "w-full h-64 resize-none bg-surface-highest border border-border-hairline rounded-xl px-3.5 py-2.5 text-xs font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/40 transition";

export default function ImportExportModal({
  isOpen,
  tab,
  onClose,
  exportData = null,
  exportOnly = false,
  subtitle,
}: ImportExportModalProps) {
  const { refresh } = useVideos();
  const toast = useToast();

  const [mode, setMode] = useState<Tab>(tab);
  // Export: the serialised catalog JSON, loaded once the modal opens.
  const [exportJson, setExportJson] = useState("");
  const [exportCount, setExportCount] = useState(0);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // Brief "copied" confirmation on the copy button. A global toast is rendered
  // *under* the dialog's top layer, so it wouldn't be visible here — show the
  // feedback inline instead.
  const [copied, setCopied] = useState(false);
  // Import: the pasted / uploaded JSON text.
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backdropMouseDownRef = useRef(false);

  // Sync dialog visibility + entry tab with props.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      setMode(tab);
      setImportError(null);
      setCopied(false);
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isOpen, tab]);

  // Load the export JSON whenever the export tab becomes visible. With a fixed
  // list (a selection) serialise it directly; otherwise fetch the whole catalog.
  useEffect(() => {
    if (!isOpen || mode !== "export") return;
    if (exportData) {
      setExportJson(JSON.stringify(exportData, null, 2));
      setExportCount(exportData.length);
      setExportLoading(false);
      setExportError(null);
      return;
    }
    let active = true;
    setExportLoading(true);
    setExportError(null);
    exportVideos()
      .then((data) => {
        if (!active) return;
        setExportJson(JSON.stringify(data, null, 2));
        setExportCount(data.length);
      })
      .catch((e) => {
        if (!active) return;
        setExportError(e instanceof Error ? e.message : "匯出失敗");
      })
      .finally(() => {
        if (active) setExportLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isOpen, mode, exportData]);

  const handleBackdropMouseDown = (e: React.MouseEvent<HTMLDialogElement>) => {
    backdropMouseDownRef.current = e.target === dialogRef.current;
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current && backdropMouseDownRef.current) onClose();
    backdropMouseDownRef.current = false;
  };

  async function handleCopy() {
    if (!exportJson) return;
    try {
      await navigator.clipboard.writeText(exportJson);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      toast("已複製 JSON 到剪貼簿", { type: "success" });
    } catch {
      toast("無法存取剪貼簿，請手動選取複製", { type: "error" });
    }
  }

  function handleDownload() {
    if (!exportJson) return;
    const blob = new Blob([exportJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `oasis-catalog-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已下載 ${exportCount} 部影片`, { type: "success" });
  }

  // Read an uploaded file into the paste box (does not import until confirmed).
  async function handleUploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    try {
      setImportText(await file.text());
      setImportError(null);
    } catch {
      setImportError("無法讀取檔案");
    }
  }

  async function handleImport() {
    if (importing) return;
    const text = importText.trim();
    if (!text) {
      setImportError("請貼上或上傳 JSON 內容");
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const parsed = JSON.parse(text);
      // Accept a bare array or the { videos: [...] } export envelope.
      const list: ExportedVideo[] = Array.isArray(parsed) ? parsed : parsed?.videos;
      if (!Array.isArray(list)) {
        throw new Error("格式不正確：找不到影片陣列");
      }
      const summary = await importVideos(list);
      await refresh({ silent: true });
      const skipped = summary.skipped ? `，略過 ${summary.skipped} 筆` : "";
      toast(`已匯入 ${summary.imported} 部影片${skipped}`, { type: "success" });
      setImportText("");
      onClose();
    } catch (err) {
      if (err instanceof SyntaxError) {
        setImportError("JSON 解析失敗，請確認內容格式正確");
      } else {
        setImportError(err instanceof Error ? err.message : "匯入失敗");
      }
    } finally {
      setImporting(false);
    }
  }

  const btnBase =
    "flex items-center gap-2 rounded-xl px-5 py-3 text-xs font-bold transition duration-150 active:scale-98 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
  const btnGhost =
    "border border-border-hairline bg-transparent hover:bg-surface-highest text-text-secondary hover:text-text-primary font-semibold";
  const btnAccent =
    "bg-accent text-neutral-950 hover:bg-accent-hover shadow-[0_4px_20px_rgba(16,185,129,0.2)] hover:shadow-[0_4px_24px_rgba(16,185,129,0.3)]";

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
          <h2 className="text-base font-bold text-text-primary">
            {exportOnly ? "匯出所選影片" : "匯入 / 匯出"}
          </h2>
          <p className="text-xs text-text-tertiary mt-0.5 font-sans">
            {subtitle
              ? subtitle
              : mode === "export"
                ? "複製或下載整個影片目錄（僅中繼資料，不含影片檔）"
                : "貼上或上傳先前匯出的 JSON 以還原影片目錄"}
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

      {/* Mode tabs — hidden when locked to export-only (e.g. export a selection) */}
      {!exportOnly && (
      <div className="mb-4 flex gap-1 rounded-xl border border-border-hairline bg-surface-highest/40 p-1">
        {([
          ["export", "匯出"],
          ["import", "匯入"],
        ] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
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
      )}

      {mode === "export" && (
        <div className="space-y-3.5">
          {exportError ? (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3.5 text-xs text-red-400 font-sans leading-relaxed">
              ⚠️ {exportError}
            </div>
          ) : (
            <textarea
              readOnly
              value={exportLoading ? "載入中…" : exportJson}
              onFocus={(e) => e.currentTarget.select()}
              className={textareaClass}
            />
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[11px] font-semibold text-text-tertiary font-sans">
              {exportLoading ? "" : `共 ${exportCount} 部影片`}
            </span>
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={handleCopy}
                disabled={exportLoading || !exportJson}
                className={`${btnBase} ${copied ? "border border-accent/40 bg-accent/10 text-accent" : btnGhost}`}
              >
                {copied ? "已複製 ✓" : "複製 JSON"}
              </button>
              <button
                type="button"
                onClick={handleDownload}
                disabled={exportLoading || !exportJson}
                className={`${btnBase} ${btnAccent}`}
              >
                下載 JSON
              </button>
            </div>
          </div>
        </div>
      )}

      {mode === "import" && (
        <div className="space-y-3.5">
          <textarea
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value);
              setImportError(null);
            }}
            placeholder='貼上匯出的 JSON，例如 [{ "code": "START-344", ... }]'
            className={textareaClass}
          />
          {importError && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3.5 text-xs text-red-400 font-sans leading-relaxed">
              ⚠️ {importError}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={`${btnBase} ${btnGhost}`}
            >
              上傳檔案
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleUploadFile}
            />
            <button
              type="button"
              onClick={handleImport}
              disabled={importing || !importText.trim()}
              className={`${btnBase} ${btnAccent}`}
            >
              {importing ? "匯入中…" : "匯入"}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
