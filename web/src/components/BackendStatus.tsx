"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from "react";
import { useBackend } from "@/context/BackendContext";

// Header widget that pings the user's local backend and, when it's down, lets
// them point the app at a different URL/port (persisted in the browser).
export default function BackendStatus() {
  const { status, backendUrl, updateBackendUrl, disconnect } = useBackend();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setDraft(backendUrl);
  }, [backendUrl]);

  function save() {
    updateBackendUrl(draft);
    setOpen(false);
  }

  function handleDisconnect() {
    disconnect();
    setOpen(false);
  }

  const dot =
    status === "up"
      ? "bg-green-500"
      : status === "down"
        ? "bg-red-500"
        : "bg-neutral-400 animate-pulse";
  const label =
    status === "up" ? "已連線" : status === "down" ? "未連線" : "檢查中…";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="本機伺服器連線狀態"
        className="inline-flex items-center gap-1.5 rounded-full border border-border-hairline bg-surface-elevated px-3 py-1 text-xs text-text-secondary transition hover:bg-surface-highest hover:text-text-primary"
      >
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        {label}
      </button>

      {open && (
        <div className="fixed inset-x-4 top-16 z-50 rounded-xl border border-border-hairline bg-surface-highest p-4 text-sm shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80">
          {status === "up" && (
            <div className="mb-3 border-b border-border-hairline pb-3">
              <button
                type="button"
                onClick={handleDisconnect}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-400 transition hover:bg-red-500/20 hover:text-red-300"
              >
                🔒 中斷連線
              </button>
              <p className="mt-1.5 text-[11px] text-text-tertiary">
                立即回到綠洲入口。在你再次手動點擊「進入」成功前，重新整理或重開都不會自動連線。
              </p>
            </div>
          )}
          {status === "down" && (
            <p className="mb-3 text-xs text-text-tertiary">
              無法連線到你的本機伺服器。請先在你的電腦啟動後端
              （<code className="font-mono text-text-secondary">uvicorn api:app --port 8000</code>），
              再確認下方網址是否正確。
            </p>
          )}
          <label className="mb-1 block text-xs font-semibold text-text-secondary">
            後端網址
          </label>
          <input
            type="url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            placeholder="http://localhost:8000"
            className="w-full rounded-lg border border-border-hairline bg-surface-elevated px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
          />
          <p className="mt-1.5 text-[11px] text-text-tertiary font-sans">
            建議使用 <span className="font-mono text-text-secondary">http://localhost</span>
            （HTTPS 網站無法連到區網 IP）。
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(backendUrl);
                setOpen(false);
              }}
              className="rounded-md border border-border-hairline bg-transparent px-3 py-1.5 text-xs font-medium text-text-secondary transition hover:bg-surface-elevated hover:text-text-primary"
            >
              取消
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-neutral-950 transition hover:bg-accent-hover"
            >
              儲存並重試
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

