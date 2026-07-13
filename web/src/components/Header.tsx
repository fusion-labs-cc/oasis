"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BackendStatus from "./BackendStatus";
import AddVideoModal from "./AddVideoModal";
import { useVideos } from "@/context/VideoContext";
import { useToast } from "@/components/Toast";

export default function Header() {
  const [isOpen, setIsOpen] = useState(false);
  const [keyDisplay, setKeyDisplay] = useState("⌘ K");
  const [awakeKey, setAwakeKey] = useState("⌘ X");

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

  // OS detection for keyboard shortcut display
  useEffect(() => {
    if (typeof window !== "undefined") {
      const isMac = /Mac|iPad|iPhone|iPod/.test(navigator.userAgent);
      setKeyDisplay(isMac ? "⌘ K" : "Ctrl+K");
      setAwakeKey(isMac ? "⌘ X" : "Alt+X");
    }
  }, []);

  // Shortcut listener: `/` or `⌘+K` or `Ctrl+K`
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          (activeEl as HTMLElement).isContentEditable)
      ) {
        // If focused inside our command palette input, allow Cmd+K/Ctrl+K to close it
        if (
          activeEl.id === "add-video-url" &&
          (e.metaKey || e.ctrlKey) &&
          e.key.toLowerCase() === "k"
        ) {
          e.preventDefault();
          setIsOpen(false);
        }
        return;
      }

      if (
        e.key === "/" ||
        ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")
      ) {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <header className="sticky top-0 z-45 border-b border-border-hairline bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-[1680px] items-center justify-between px-8 py-4">
          <Link
            href="/"
            className="flex items-center gap-1.5 font-mono text-xl font-black tracking-[0.25em] text-text-primary transition hover:text-accent"
          >
            OASIS
          </Link>

          <div className="flex items-center gap-4">
            <BackendStatus />

            {/* Random Pick Action Button — jumps to a random downloaded video */}
            <button
              type="button"
              onClick={handleRandomPick}
              title="隨機播放：從已下載的影片中隨機挑一部"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border-hairline bg-surface-elevated text-text-secondary transition duration-200 hover:scale-[1.02] hover:bg-surface-highest hover:text-text-primary active:scale-98 cursor-pointer"
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

            {/* Awake Mode (boss key) Action Button */}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("awake:toggle"))}
              title="Awake 模式：一鍵偽裝成 Google 並暫停播放"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border-hairline bg-surface-elevated text-text-secondary transition duration-200 hover:scale-[1.02] hover:bg-surface-highest hover:text-text-primary active:scale-98 cursor-pointer"
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
              <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[9px] font-mono font-bold bg-surface-highest text-text-tertiary border border-border-hairline rounded shadow-sm">
                {awakeKey}
              </kbd>
            </button>

            {/* Add Media Action Button */}
            <button
              type="button"
              onClick={() => setIsOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border-hairline bg-surface-elevated text-accent transition duration-200 hover:scale-[1.02] hover:bg-surface-highest hover:text-accent-hover hover:shadow-[0_0_12px_rgba(16,185,129,0.15)] active:scale-98 cursor-pointer"
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
              <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[9px] font-mono font-bold bg-surface-highest text-text-tertiary border border-border-hairline rounded shadow-sm">
                {keyDisplay}
              </kbd>
            </button>
          </div>
        </div>
      </header>

      <AddVideoModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}
