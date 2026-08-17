"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import {
  assignVideosToSeries,
  createSeries,
  deleteSeries,
  fetchSeries,
  type SeriesRecord,
} from "@/lib/api";

interface SeriesAssignModalProps {
  isOpen: boolean;
  onClose: () => void;
  // Videos to place, in the order they should be numbered.
  videoIds: number[];
  // Called after a successful assignment so the caller can refresh the catalog.
  onAssigned: (seriesName: string, count: number) => void;
}

const inputClass =
  "w-full bg-surface-highest border border-border-hairline rounded-xl px-3.5 py-2.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/40 transition";

const btnBase =
  "flex items-center gap-2 rounded-xl px-5 py-3 text-xs font-bold transition duration-150 active:scale-98 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
const btnGhost =
  "border border-border-hairline bg-transparent hover:bg-surface-highest text-text-secondary hover:text-text-primary font-semibold";
const btnAccent =
  "bg-accent text-neutral-950 hover:bg-accent-hover shadow-[0_4px_20px_rgba(16,185,129,0.2)] hover:shadow-[0_4px_24px_rgba(16,185,129,0.3)]";

export default function SeriesAssignModal({
  isOpen,
  onClose,
  videoIds,
  onAssigned,
}: SeriesAssignModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropMouseDownRef = useRef(false);

  const [series, setSeries] = useState<SeriesRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      setError(null);
      setNewName("");
      setSelectedId(null);
      setConfirmingDeleteId(null);
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  // Reload on every open: a series may have been created or emptied elsewhere.
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setLoading(true);
    fetchSeries()
      .then((rows) => {
        if (active) setSeries(rows);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isOpen]);

  const handleBackdropMouseDown = (e: React.MouseEvent<HTMLDialogElement>) => {
    backdropMouseDownRef.current = e.target === dialogRef.current;
  };
  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current && backdropMouseDownRef.current) onClose();
    backdropMouseDownRef.current = false;
  };

  async function handleCreate() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createSeries(name);
      // The backend keys on the name, so this may be an existing series —
      // merge rather than append so it never shows up twice.
      setSeries((prev) =>
        prev.some((s) => s.id === created.id)
          ? prev
          : [...prev, { ...created, count: created.count ?? 0 }]
      );
      setSelectedId(created.id);
      setNewName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: number) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSeries(id);
      setSeries((prev) => prev.filter((s) => s.id !== id));
      if (selectedId === id) setSelectedId(null);
      setConfirmingDeleteId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleAssign() {
    if (selectedId == null || busy || videoIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await assignVideosToSeries(selectedId, videoIds);
      const name = series.find((s) => s.id === selectedId)?.name ?? "";
      // Close first, then let the caller toast: a toast raised while the dialog
      // is open renders under its top layer and is never seen.
      onClose();
      onAssigned(name, res.assigned);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
      onClose={onClose}
      className="fixed left-1/2 top-[7vh] -translate-x-1/2 w-[calc(100%-2rem)] max-w-xl max-h-[86vh] overflow-y-auto rounded-2xl border border-border-hairline bg-surface-elevated p-6 shadow-2xl outline-none"
    >
      <div className="flex items-center justify-between border-b border-border-hairline pb-4 mb-4">
        <div>
          <h2 className="text-base font-bold text-text-primary">加入系列</h2>
          <p className="text-xs text-text-tertiary mt-0.5 font-sans">
            把所選 {videoIds.length} 部影片放進一個系列，集數會接在該系列現有的最後一集之後
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

      {/* Create */}
      <div className="mb-4">
        <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-text-tertiary font-sans">
          新建系列
        </span>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCreate();
              }
            }}
            disabled={busy}
            placeholder="輸入系列名稱，例如「北海道辣妹金古錐」"
            className={inputClass}
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={busy || !newName.trim()}
            className={`${btnBase} ${btnGhost} shrink-0 whitespace-nowrap`}
          >
            建立
          </button>
        </div>
      </div>

      {/* Pick */}
      <div className="mb-4">
        <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-text-tertiary font-sans">
          選擇系列
        </span>
        {loading ? (
          <p className="py-6 text-center text-xs text-text-tertiary font-sans">載入中…</p>
        ) : series.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-tertiary font-sans">
            還沒有任何系列，先在上面建立一個
          </p>
        ) : (
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {series.map((s) => {
              const active = selectedId === s.id;
              return (
                <div key={s.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    className={`flex flex-1 items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition font-semibold cursor-pointer min-w-0 ${
                      active
                        ? "bg-accent text-neutral-950 font-bold"
                        : "text-text-secondary hover:bg-surface-highest hover:text-text-primary"
                    }`}
                  >
                    <span className="truncate">{s.name}</span>
                    <span
                      className={`font-mono text-[10px] shrink-0 ${
                        active ? "text-neutral-950/70" : "text-text-tertiary"
                      }`}
                    >
                      {s.count} 部
                    </span>
                  </button>
                  {confirmingDeleteId === s.id ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleDelete(s.id)}
                        disabled={busy}
                        className="rounded-md bg-red-500 px-2 py-1 text-[10px] font-bold text-white transition hover:bg-red-400 disabled:opacity-50 cursor-pointer"
                      >
                        確定
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingDeleteId(null)}
                        disabled={busy}
                        className="rounded-md px-1.5 py-1 text-[10px] font-semibold text-text-tertiary transition hover:text-text-primary disabled:opacity-50 cursor-pointer"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingDeleteId(s.id)}
                      title="刪除系列（影片會保留，只是回到未分類）"
                      className="shrink-0 rounded-md px-1.5 py-1 text-[10px] font-semibold text-text-tertiary transition hover:text-red-400 cursor-pointer"
                    >
                      刪除
                    </button>
                  )}
                </div>
              );
            })}
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
          onClick={handleAssign}
          disabled={busy || selectedId == null || videoIds.length === 0}
          className={`${btnBase} ${btnAccent}`}
        >
          {busy ? "加入中…" : `加入 ${videoIds.length} 部`}
        </button>
      </div>
    </dialog>
  );
}
