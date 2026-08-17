"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import {
  coverUrl,
  seriesCoverUrl,
  updateSeries,
  type SeriesRecord,
  type VideoRecord,
} from "@/lib/api";

interface SeriesEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  series: SeriesRecord | null;
  episodes?: VideoRecord[];
  onUpdated: (updatedSeries: SeriesRecord) => void;
}

const inputClass =
  "w-full bg-surface-highest border border-border-hairline rounded-xl px-3.5 py-2.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/40 transition font-mono";

const btnBase =
  "flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-bold transition duration-150 active:scale-98 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
const btnGhost =
  "border border-border-hairline bg-transparent hover:bg-surface-highest text-text-secondary hover:text-text-primary font-semibold";
const btnAccent =
  "bg-accent text-neutral-950 hover:bg-accent-hover shadow-[0_4px_20px_rgba(16,185,129,0.2)] hover:shadow-[0_4px_24px_rgba(16,185,129,0.3)]";

export default function SeriesEditModal({
  isOpen,
  onClose,
  series,
  episodes = [],
  onUpdated,
}: SeriesEditModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropMouseDownRef = useRef(false);

  const [name, setName] = useState("");
  const [cover, setCover] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && series) {
      setName(series.name || "");
      setCover(series.cover || "");
      setError(null);
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isOpen, series]);

  if (!series) return null;

  const handleBackdropMouseDown = (e: React.MouseEvent<HTMLDialogElement>) => {
    backdropMouseDownRef.current = e.target === dialogRef.current;
  };
  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current && backdropMouseDownRef.current) onClose();
    backdropMouseDownRef.current = false;
  };

  async function handleSave() {
    if (!series || busy) return;
    const cleanName = name.trim();
    if (!cleanName) {
      setError("系列名稱不可為空");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateSeries(series.id, {
        name: cleanName,
        cover: cover.trim() || null,
      });
      onUpdated(updated);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Determine current active preview image
  const previewUrl = cover.trim()
    ? cover.trim()
    : seriesCoverUrl(series) || (episodes.map(coverUrl).find(Boolean) ?? null);

  return (
    <dialog
      ref={dialogRef}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
      onClose={onClose}
      className="fixed left-1/2 top-[7vh] -translate-x-1/2 w-[calc(100%-2rem)] max-w-lg max-h-[86vh] overflow-y-auto rounded-2xl border border-border-hairline bg-surface-elevated p-6 shadow-2xl outline-none"
    >
      <div className="flex items-center justify-between border-b border-border-hairline pb-4 mb-4">
        <div>
          <h2 className="text-base font-bold text-text-primary">設定系列封面與資料</h2>
          <p className="text-xs text-text-tertiary mt-0.5 font-sans">
            可為系列設定自訂封面圖片網址，或從劇集中挑選一集作為封面
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-text-tertiary hover:bg-surface-highest hover:text-text-primary transition cursor-pointer"
        >
          ✕
        </button>
      </div>

      {/* Preview Card */}
      <div className="mb-5 flex gap-4 rounded-xl border border-border-hairline bg-surface-highest/50 p-3 items-center">
        <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-surface-highest border border-border-hairline">
          {previewUrl ? (
            <img src={previewUrl} alt={name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] font-mono text-text-tertiary font-bold">
              無封面
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[10px] font-bold text-accent uppercase tracking-wider">
            預覽封面
          </span>
          <h4 className="truncate text-xs font-semibold text-text-primary mt-0.5">
            {name || "（未命名系列）"}
          </h4>
          <p className="text-[11px] text-text-tertiary mt-1 font-sans">
            {cover.trim() ? "使用自訂系列封面" : "使用自動預設封面"}
          </p>
        </div>
      </div>

      {/* Form Fields */}
      <div className="space-y-4 mb-5">
        <div>
          <label className="mb-1.5 block text-xs font-bold text-text-secondary font-sans">
            系列名稱
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如「北海道辣妹金古錐」"
            className={inputClass}
            disabled={busy}
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs font-bold text-text-secondary font-sans">
              封面圖片網址 (Cover URL)
            </label>
            {cover.trim() && (
              <button
                type="button"
                onClick={() => setCover("")}
                className="text-[11px] font-semibold text-accent hover:underline cursor-pointer"
              >
                重設為預設
              </button>
            )}
          </div>
          <input
            type="text"
            value={cover}
            onChange={(e) => setCover(e.target.value)}
            placeholder="https://example.com/cover.jpg"
            className={inputClass}
            disabled={busy}
          />
        </div>

        {/* Quick selection from episodes */}
        {episodes.length > 0 && (
          <div>
            <span className="mb-2 block text-xs font-bold text-text-secondary font-sans">
              或從劇集中選擇一集封面：
            </span>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-44 overflow-y-auto p-1 border border-border-hairline rounded-xl bg-surface-highest/30">
              {episodes.map((ep) => {
                const previewImg = coverUrl(ep) || ep.cover;
                const targetCover = ep.cover || coverUrl(ep) || "";
                const isSelected =
                  targetCover &&
                  (cover.trim() === targetCover.trim() ||
                    (ep.cover && cover.trim() === ep.cover.trim()) ||
                    (ep.id && cover.includes(`/api/stream/cover/${ep.id}`)));
                return (
                  <button
                    key={ep.id}
                    type="button"
                    onClick={() => {
                      if (targetCover) setCover(targetCover);
                    }}
                    disabled={!previewImg}
                    className={`relative aspect-video overflow-hidden rounded-lg border transition text-left cursor-pointer group ${
                      isSelected
                        ? "border-accent ring-2 ring-accent/50"
                        : "border-border-hairline hover:border-accent/40"
                    } ${!previewImg ? "opacity-40 cursor-not-allowed" : ""}`}
                  >
                    {previewImg ? (
                      <img src={previewImg} alt={ep.title} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-[9px] text-text-tertiary">
                        無封面
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-neutral-950/80 px-1 py-0.5 text-[9px] font-mono font-bold text-white truncate">
                      {ep.episode != null ? `第 ${ep.episode} 集` : ep.code || `ID:${ep.id}`}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/5 p-3.5 text-xs text-red-400 font-sans leading-relaxed">
          ⚠️ {error}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-border-hairline pt-4">
        <button type="button" onClick={onClose} disabled={busy} className={`${btnBase} ${btnGhost}`}>
          取消
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !name.trim()}
          className={`${btnBase} ${btnAccent}`}
        >
          {busy ? "儲存中…" : "儲存變更"}
        </button>
      </div>
    </dialog>
  );
}
