"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BackendStatus from "./BackendStatus";
import AddVideoModal from "./AddVideoModal";
import ImportExportModal from "./ImportExportModal";
import { useVideos } from "@/context/VideoContext";
import { useToast } from "@/components/Toast";
import { formatHotkey, matchesHotkey, useIsMac, useSettings } from "@/lib/settings";

// The five header actions, shared between the desktop row and the mobile
// hamburger panel. `vertical` renders the full-width stacked variant; the
// hotkey <kbd> hints only exist horizontally — the panel only shows below
// `md`, where there is no physical keyboard to speak of.
function HeaderActions({
  vertical = false,
  onAction,
  awakeEnabled,
  awakeKey,
  keyDisplay,
  onRandomPick,
  onImportExport,
  onAddVideo,
}: {
  vertical?: boolean;
  onAction?: () => void;
  awakeEnabled: boolean;
  awakeKey: string;
  keyDisplay: string;
  onRandomPick: () => void;
  onImportExport: () => void;
  onAddVideo: () => void;
}) {
  const buttonClass = `flex items-center gap-2 rounded-lg border border-border-hairline bg-surface-elevated text-text-secondary transition duration-200 hover:scale-[1.02] hover:bg-surface-highest hover:text-text-primary active:scale-98 cursor-pointer ${
    vertical ? "w-full px-3 py-2.5" : "px-3 py-1.5"
  }`;
  const kbdClass =
    "hidden md:inline-block px-1.5 py-0.5 text-[9px] font-mono font-bold bg-surface-highest text-text-tertiary border border-border-hairline rounded shadow-sm";

  return (
    <>
      {/* Random Pick Action Button — jumps to a random downloaded video */}
      <button
        type="button"
        onClick={() => {
          onRandomPick();
          onAction?.();
        }}
        title="隨機播放：從已下載的影片中隨機挑一部"
        className={buttonClass}
      >
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 3h5v5" />
          <path d="M4 20 21 3" />
          <path d="M21 16v5h-5" />
          <path d="m15 15 6 6" />
          <path d="M4 4l5 5" />
        </svg>
        <span className="text-xs font-semibold">隨機播放</span>
      </button>

      {/* Awake Mode (boss key) Action Button — hidden when disabled in settings */}
      {awakeEnabled && (
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new Event("awake:toggle"));
            onAction?.();
          }}
          title="Awake 模式：一鍵偽裝成 Google 並暫停播放"
          className={buttonClass}
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span className="text-xs font-semibold">Awake</span>
          {!vertical && <kbd className={kbdClass}>{awakeKey}</kbd>}
        </button>
      )}

      {/* Import / Export Action Button — opens a dialog for copy/download
          (export) or paste/upload (import). */}
      <button
        type="button"
        onClick={() => {
          onImportExport();
          onAction?.();
        }}
        title="匯入 / 匯出：以 JSON 備份或還原整個影片目錄（僅中繼資料）"
        className={buttonClass}
      >
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          <polyline points="7 9 12 4 17 9" />
          <line x1="12" y1="4" x2="12" y2="16" />
        </svg>
        <span className="text-xs font-semibold">匯入 / 匯出</span>
      </button>

      {/* Add Media Action Button */}
      <button
        type="button"
        onClick={() => {
          onAddVideo();
          onAction?.();
        }}
        className={`flex items-center gap-2 rounded-lg border border-border-hairline bg-surface-elevated text-accent transition duration-200 hover:scale-[1.02] hover:bg-surface-highest hover:text-accent-hover hover:shadow-[0_0_12px_rgba(16,185,129,0.15)] active:scale-98 cursor-pointer ${
          vertical ? "w-full px-3 py-2.5" : "px-3 py-1.5"
        }`}
      >
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span className="text-xs font-semibold text-text-secondary">新增影片</span>
        {!vertical && <kbd className={kbdClass}>{keyDisplay}</kbd>}
      </button>

      {/* Settings — nickname, Awake Mode, and keyboard shortcuts */}
      <Link
        href="/settings"
        title="設定：暱稱、Awake 模式與鍵盤快速鍵"
        aria-label="設定"
        onClick={onAction}
        className={
          vertical
            ? buttonClass
            : "flex items-center justify-center h-9 w-9 rounded-lg border border-border-hairline bg-surface-elevated text-text-secondary transition duration-200 hover:scale-[1.02] hover:bg-surface-highest hover:text-text-primary active:scale-98 cursor-pointer"
        }
      >
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
        {vertical && <span className="text-xs font-semibold">設定</span>}
      </Link>
    </>
  );
}

export default function Header() {
  const [isOpen, setIsOpen] = useState(false);
  // The import/export dialog and which tab it opens on.
  const [ioTab, setIoTab] = useState<"export" | "import" | null>(null);
  // Mobile hamburger panel (< md). Every action closes it via onAction.
  const [menuOpen, setMenuOpen] = useState(false);

  const settings = useSettings();
  const isMac = useIsMac();
  const keyDisplay = formatHotkey(settings.addVideoHotkey, isMac);
  const awakeKey = formatHotkey(settings.awakeHotkey, isMac);

  const router = useRouter();
  const { videos } = useVideos();
  const toast = useToast();

  // Pick a random already-downloaded video and jump to its detail page.
  // "Downloaded" mirrors the VideoCard check: a local file that still exists.
  function handleRandomPick() {
    const downloaded = videos.filter((v) => v.video_path && v.local_file_exists);
    if (downloaded.length === 0) {
      toast("目前沒有已下載的影片可供隨機播放", { type: "info" });
      return;
    }
    const pick = downloaded[Math.floor(Math.random() * downloaded.length)];
    router.push(`/video/${pick.id}`);
  }

  // Shortcut listener: `/` or the user-configured "add video" shortcut.
  useEffect(() => {
    const addHotkey = settings.addVideoHotkey;

    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;

      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          (activeEl as HTMLElement).isContentEditable)
      ) {
        // If focused inside our command palette input, allow the shortcut to close it.
        if (activeEl.id === "add-video-url" && matchesHotkey(e, addHotkey)) {
          e.preventDefault();
          setIsOpen(false);
        }
        return;
      }

      if (e.key === "/" || matchesHotkey(e, addHotkey)) {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settings.addVideoHotkey]);

  const actionProps = {
    awakeEnabled: settings.awakeEnabled,
    awakeKey,
    keyDisplay,
    onRandomPick: handleRandomPick,
    onImportExport: () => setIoTab("export"),
    onAddVideo: () => setIsOpen(true),
  };

  return (
    <>
      <header className="sticky top-0 z-45 border-b border-border-hairline bg-background/80 backdrop-blur-md">
        <div className="relative mx-auto w-full max-w-[1680px]">
          <div className="flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4 lg:px-8">
            <Link
              href="/"
              className="flex items-center gap-1.5 font-mono text-lg font-black tracking-[0.15em] text-text-primary transition hover:text-accent sm:text-xl sm:tracking-[0.25em]"
            >
              OASIS
            </Link>

            {/* Status pill is always visible; the actions live inline on md+
                and collapse behind the hamburger below that. */}
            <div className="flex items-center gap-2 md:gap-4">
              <BackendStatus />

              <div className="hidden items-center gap-4 md:flex">
                <HeaderActions {...actionProps} />
              </div>
              <button
                type="button"
                onClick={() => setMenuOpen((prev) => !prev)}
                aria-label="選單"
                aria-expanded={menuOpen}
                className="flex items-center justify-center h-9 w-9 rounded-lg border border-border-hairline bg-surface-elevated text-text-secondary transition duration-200 hover:bg-surface-highest hover:text-text-primary active:scale-98 cursor-pointer md:hidden"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {menuOpen ? (
                    <>
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </>
                  ) : (
                    <>
                      <line x1="3" y1="6" x2="21" y2="6" />
                      <line x1="3" y1="12" x2="21" y2="12" />
                      <line x1="3" y1="18" x2="21" y2="18" />
                    </>
                  )}
                </svg>
              </button>
            </div>
          </div>

          {/* Mobile hamburger panel, anchored under the header row */}
          {menuOpen && (
            <div className="absolute inset-x-0 top-full border-b border-border-hairline bg-background/95 backdrop-blur-md md:hidden">
              <div className="flex flex-col gap-1.5 p-4">
                <HeaderActions
                  vertical
                  onAction={() => setMenuOpen(false)}
                  {...actionProps}
                />
              </div>
            </div>
          )}
        </div>
      </header>

      <AddVideoModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
      <ImportExportModal
        isOpen={ioTab !== null}
        tab={ioTab ?? "export"}
        onClose={() => setIoTab(null)}
      />
    </>
  );
}
