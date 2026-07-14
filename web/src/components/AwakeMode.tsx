"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import { matchesHotkey, useSettings } from "@/lib/settings";

/**
 * Awake Mode — a "boss key" disguise.
 *
 * Shortcut: ⌘+X (macOS) / Alt+X (Windows & others).
 * When triggered, the entire site is instantly covered by a Google-looking
 * homepage. Typing a query and pressing Enter (or clicking "Google 搜尋")
 * runs a real Google search. The same shortcut, or Escape, dismisses it.
 *
 * While active we also swap the document title and favicon so browser tabs and
 * history look like plain Google.
 */

const SUGGESTIONS = [
  "最新科技趨勢 2026",
  "如何使用 AI 輔助日常工作流程",
  "Google 桌面端 UI 改版設計",
];

const STORAGE_KEY = "awake:active";

export default function AwakeMode() {
  const settings = useSettings();
  const [active, setActive] = useState(false);
  const [query, setQuery] = useState("");
  const [aiMode, setAiMode] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  const lastTap = useRef<number>(0);
  const touchTimeout = useRef<NodeJS.Timeout | null>(null);

  const handleTouchStart = () => {
    // Set a timer for long-press (e.g. 1 second)
    touchTimeout.current = setTimeout(() => {
      setActive(false);
    }, 1000);
  };

  const handleTouchMove = () => {
    // If they drag/scroll, cancel the long press
    if (touchTimeout.current) {
      clearTimeout(touchTimeout.current);
      touchTimeout.current = null;
    }
  };

  const handleTouchEnd = () => {
    // Cancel the long-press timer if it hasn't fired yet
    if (touchTimeout.current) {
      clearTimeout(touchTimeout.current);
      touchTimeout.current = null;
    }

    // Double tap detection
    const now = Date.now();
    if (now - lastTap.current < 300) {
      setActive(false);
    }
    lastTap.current = now;
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (touchTimeout.current) {
        clearTimeout(touchTimeout.current);
      }
    };
  }, []);

  // Restore the disguise after a refresh, tab close/reopen, or navigating away
  // and back. We read localStorage in an effect (not during render) so the
  // server-rendered markup and the first client render agree, avoiding a
  // hydration mismatch.
  useEffect(() => {
    // Avoid auto-restoring on mobile/tablet devices to prevent getting locked out.
    const isMobileTablet = typeof window !== "undefined" && typeof navigator !== "undefined" && (
      /mobi|android|iphone|ipad|tablet/.test(navigator.userAgent.toLowerCase()) ||
      (("ontouchstart" in window || navigator.maxTouchPoints > 0) && /mac/.test(navigator.userAgent.toLowerCase()))
    );

    if (!isMobileTablet && localStorage.getItem(STORAGE_KEY) === "1") {
      setActive(true);
    }
  }, []);

  // Persist every change so the state survives a full reload.
  useEffect(() => {
    if (active) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  }, [active]);

  // Toggle on the user-configured shortcut (unless Awake Mode is disabled).
  useEffect(() => {
    if (!settings.awakeEnabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesHotkey(e, settings.awakeHotkey)) {
        e.preventDefault();
        setActive((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settings.awakeEnabled, settings.awakeHotkey]);

  // If Awake Mode gets disabled while the disguise is up, drop it.
  useEffect(() => {
    if (!settings.awakeEnabled) setActive(false);
  }, [settings.awakeEnabled]);

  // Allow other UI (e.g. the header button) to toggle Awake Mode.
  useEffect(() => {
    const toggle = () => setActive((prev) => !prev);
    window.addEventListener("awake:toggle", toggle);
    return () => window.removeEventListener("awake:toggle", toggle);
  }, []);

  // Disguise the tab (title + favicon), lock scroll, wire up dismissal.
  useEffect(() => {
    if (!active) return;

    const prevTitle = document.title;
    const iconLink = document.querySelector<HTMLLinkElement>(
      'link[rel~="icon"]',
    );
    const prevIcon = iconLink?.getAttribute("href") ?? null;
    const prevOverflow = document.body.style.overflow;

    document.title = "Google";
    if (iconLink) iconLink.href = "https://www.google.com/favicon.ico";
    document.body.style.overflow = "hidden";

    // Panic: silence any playing media so nothing gives the disguise away.
    document
      .querySelectorAll<HTMLMediaElement>("video, audio")
      .forEach((media) => {
        if (!media.paused) media.pause();
      });

    // Native <dialog>s opened with showModal() live in the browser's top layer,
    // which sits above any z-index — including this overlay. Close any open ones
    // so a modal can't peek through and blow the disguise.
    document
      .querySelectorAll<HTMLDialogElement>("dialog[open]")
      .forEach((dialog) => dialog.close());

    // Focus the search box on the next frame.
    const raf = requestAnimationFrame(() => inputRef.current?.focus());

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(false);
    };
    // Close popovers when clicking outside their triggers.
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (searchBoxRef.current && !searchBoxRef.current.contains(target)) {
        setShowSuggestions(false);
      }
      if (settingsRef.current && !settingsRef.current.contains(target)) {
        setShowSettings(false);
      }
    };

    window.addEventListener("keydown", handleEsc);
    document.addEventListener("click", handleClick);

    return () => {
      document.title = prevTitle;
      if (iconLink && prevIcon !== null) iconLink.href = prevIcon;
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", handleEsc);
      document.removeEventListener("click", handleClick);
      cancelAnimationFrame(raf);
      setQuery("");
      setAiMode(false);
      setShowSuggestions(false);
      setShowSettings(false);
      if (touchTimeout.current) {
        clearTimeout(touchTimeout.current);
        touchTimeout.current = null;
      }
    };
  }, [active]);

  const runSearch = (term?: string) => {
    const q = (term ?? query).trim();
    if (!q) return;
    // Behave like Google: navigate to the real results page.
    window.location.href = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  };

  if (!active) return null;

  return (
    <div className="fixed inset-0 z-[99999] flex flex-col justify-between select-none overflow-auto bg-[#22242a] font-sans text-[#e8e8e8]">
      {/* Scoped styles for the AI-mode animated gradient border. */}
      <style>{`
        @keyframes awake-ai-glow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .awake-ai-gradient {
          background: linear-gradient(90deg, #3186ff, #9378ff, #f96bd6, #fc413d, #ff6b2b, #fec700, #88de42, #3186ff);
          background-size: 200% 200%;
          animation: awake-ai-glow 6s linear infinite;
        }
      `}</style>

      {/* Header */}
      <header className="z-10 flex items-center justify-between p-4 text-sm">
        <div className="flex items-center space-x-4">
          <a href="https://about.google/" className="text-[#e8e8e8] hover:underline">
            關於 Google
          </a>
          <a href="https://store.google.com/" className="text-[#e8e8e8] hover:underline">
            Google 商店
          </a>
        </div>

        <div className="flex items-center space-x-4">
          <a href="https://mail.google.com/" className="text-[#e8e8e8] hover:underline">
            Gmail
          </a>
          <a href="https://www.google.com.tw/imghp" className="text-[#e8e8e8] hover:underline">
            圖片
          </a>

          <button
            type="button"
            aria-label="Google 應用程式"
            className="rounded-full p-2 text-[#adafb8] transition hover:bg-[#363840] hover:text-[#e8e8e8]"
          >
            <svg className="h-6 w-6 fill-current" viewBox="0 0 24 24">
              <path d="M6,8c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM12,20c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM6,20c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM6,14c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM12,14c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM16,6c0,1.1 0.9,2 2,2s2,-0.9 2,-2 -0.9,-2 -2,-2 -2,0.9 -2,2zM12,8c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM18,14c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM18,20c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2z" />
            </svg>
          </button>

          <a
            href="#"
            className="rounded-full bg-[#8ab4f8] px-6 py-2.5 text-sm font-semibold text-[#17181f] transition hover:bg-opacity-90"
          >
            登入
          </a>
        </div>
      </header>

      {/* Main */}
      <main className="-mt-16 flex flex-grow flex-col items-center justify-center px-4">
        {/* Logo / AI greeting */}
        <div
          className="relative mb-8 flex h-28 items-center justify-center select-none"
          onDoubleClick={() => setActive(false)}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchMove={handleTouchMove}
        >
          <div
            className={`transition-all duration-500 ${
              aiMode ? "scale-95 opacity-0" : "scale-100 opacity-100"
            }`}
          >
            <svg
              className="h-24 w-72"
              viewBox="0 0 272 92"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-label="Google"
            >
              <path
                d="M250.17 70.25a22.1 22.1 0 0 0 19-10.54l-6.86-4.49c-3 4.2-7.1 6.6-11.72 6.6a13.6 13.6 0 0 1-11.93-7.23l30.93-13.12a20 20 0 0 0-.84-3.22c-3.69-9.48-10.12-13.8-18.8-13.8-13.24 0-22.25 9.66-22.25 23.03 0 13.67 9.47 22.77 22.47 22.77m-13.5-22.81v-.51c0-8.76 5.03-14.64 12.95-14.64 3.76 0 7.15 1.69 9.44 5.67zM222.91 8.33h-9.22v60.6h9.22zm-37.54 80.24q21.51 0 21.5-24.63V25.77h-8.8v5.37h-.17c-2.75-4.27-7.96-6.68-13.84-6.68-12.7 0-20.44 9.69-20.44 22.6 0 12.86 7.53 22.34 20.78 22.34 6.52 0 11.34-3.72 13.37-6.77h.3v3.94c0 8.67-4.49 13.8-12.82 13.8-5.46 0-9.1-3.01-11.77-8.05l-7.96 3.52c4.2 8.84 10.16 12.73 19.85 12.73m0-27.55c-7.74 0-12.7-5.71-12.7-14.22 0-8.2 4.92-14.13 12.75-14.13s12.65 5.5 12.65 14.09c0 8.68-5.08 14.26-12.7 14.26m-47.95 9.31c13.29 0 22.77-9.73 22.77-23.15 0-13.2-9.35-22.98-22.77-22.98-12.7 0-22.68 9.02-22.68 22.98 0 13.33 9.43 23.15 22.68 23.15m0-8.04c-8.04 0-13.67-6.6-13.67-15.1s5.93-14.95 13.67-14.95c8.17 0 13.67 6.6 13.67 14.94 0 8.64-5.63 15.11-13.67 15.11M88.2 70.33c13.2 0 22.77-9.69 22.77-23.15 0-13.2-9.35-22.98-22.77-22.98-12.7 0-22.68 9.02-22.68 22.98 0 13.33 9.43 23.15 22.68 23.15m0-8.04c-8.04 0-13.67-6.6-13.67-15.1s5.93-14.95 13.67-14.95c8.17 0 13.67 6.6 13.67 14.94 0 8.64-5.63 15.11-13.67 15.11M31.32 70.33c17.65.17 29.67-11.68 29.67-29.92q.01-2.29-.43-5.08H31.2v8.76h20.6c-1.1 11.47-9.18 17.44-20.27 17.44-12.44 0-21.96-9.35-21.96-22.94 0-13.41 9.1-22.77 21.96-22.77 6.48 0 11.26 2 16.04 6.9l6.14-6.43c-5.38-6.3-13.16-9.31-22.3-9.31C13.7 6.98 0 20.27 0 38.46c0 17.4 13.25 31.7 31.32 31.87"
                fill="#fff"
              />
            </svg>
          </div>
          <div
            className={`absolute flex flex-col items-center transition-all duration-500 ${
              aiMode ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"
            }`}
          >
            <h1 className="bg-gradient-to-r from-[#e8e8e8] via-[#8ab4f8] to-[#e8e8e8] bg-clip-text text-3xl font-medium tracking-wide text-transparent">
              在想什麼嗎？
            </h1>
          </div>
        </div>

        {/* Search box */}
        <div className="relative z-20 w-full max-w-2xl">
          <div
            ref={searchBoxRef}
            className={`flex flex-col overflow-hidden border border-zinc-700 bg-[#363840] transition-all duration-200 hover:border-zinc-600 ${
              showSuggestions
                ? "rounded-[20px] shadow-2xl"
                : "rounded-[26px] shadow-md hover:shadow-lg"
            }`}
          >
            {/* Input row */}
            <div className="flex h-[52px] items-center px-4">
              <button
                type="button"
                aria-label="新增檔案和工具"
                className="mr-1 rounded-full p-2 text-[#adafb8] transition hover:bg-zinc-700 hover:text-[#e8e8e8]"
              >
                <svg className="h-6 w-6" fill="currentColor" viewBox="0 -960 960 960">
                  <path d="M434.5-434.5H191.87v-91H434.5v-242.63h91v242.63h242.63v91H525.5v242.63h-91V-434.5Z" />
                </svg>
              </button>

              <input
                ref={inputRef}
                type="text"
                aria-label="搜尋"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setShowSuggestions(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runSearch();
                }}
                className="flex-grow bg-transparent py-2 text-[16px] text-[#e8e8e8] placeholder-zinc-500 outline-none"
              />

              <div className="flex items-center space-x-2 pl-2">
                <button
                  type="button"
                  aria-label="語音搜尋"
                  className="rounded-full p-2 text-[#adafb8] transition hover:bg-zinc-700 hover:text-[#e8e8e8]"
                >
                  <svg className="h-5 w-5 fill-current" viewBox="0 -960 960 960">
                    <path d="M480-400q-50 0-85-35t-35-85v-240q0-50 35-85t85-35q50 0 85 35t35 85v240q0 50-35 85t-85 35Zm-40 280v-123q-104-14-172-93t-68-184h80q0 83 58.5 141.5T480-320q83 0 141.5-58.5T680-520h80q0 105-68 184t-172 93v123h-80Z" />
                  </svg>
                </button>

                <button
                  type="button"
                  aria-label="以圖搜尋"
                  className="rounded-full p-2 text-[#adafb8] transition hover:bg-zinc-700 hover:text-[#e8e8e8]"
                >
                  <svg className="h-5 w-5 fill-current" viewBox="0 -960 960 960">
                    <path d="M480-320q-50 0-85-35t-35-85q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35Zm240 160q-33 0-56.5-23.5T640-240q0-33 23.5-56.5T720-320q33 0 56.5 23.5T800-240q0 33-23.5 56.5T720-160Zm-440 40q-66 0-113-47t-47-113v-80h80v80q0 33 23.5 56.5T280-200h200v80H280Zm480-320v-160q0-33-23.5-56.5T680-680H280q-33 0-56.5 23.5T200-600v120h-80v-120q0-66 47-113t113-47h80l40-80h160l40 80h80q66 0 113 47t47 113v160h-80Z" />
                  </svg>
                </button>

                {/* AI mode toggle with animated gradient border */}
                <button
                  type="button"
                  aria-label="切換 AI 模式"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAiMode((prev) => !prev);
                  }}
                  className="group relative overflow-hidden rounded-full p-[2px] transition duration-300"
                >
                  <div className="awake-ai-gradient absolute inset-0 opacity-70 transition group-hover:opacity-100" />
                  <div
                    className={`relative flex items-center space-x-1 rounded-full px-3.5 py-1.5 text-[#e8e8e8] transition-colors ${
                      aiMode ? "bg-zinc-900" : "bg-zinc-800 hover:bg-zinc-900"
                    }`}
                  >
                    <svg className="h-4 w-4 text-[#8ab4f8]" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" />
                    </svg>
                    <span className="text-sm font-medium">
                      {aiMode ? "經典模式" : "AI 模式"}
                    </span>
                  </div>
                </button>
              </div>
            </div>

            {/* Focus suggestions */}
            {showSuggestions && (
              <div className="border-t border-zinc-700 py-3">
                <ul className="flex flex-col text-sm">
                  {SUGGESTIONS.map((s) => (
                    <li
                      key={s}
                      onClick={() => runSearch(s)}
                      className="flex cursor-pointer items-center px-4 py-2 transition hover:bg-zinc-700"
                    >
                      <svg
                        className="mr-3 h-4 w-4 text-[#adafb8]"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                      </svg>
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="mt-8 flex space-x-3 text-sm">
          <button
            type="button"
            onClick={() => runSearch()}
            className="rounded border border-transparent bg-zinc-800 px-4 py-2 text-[#e8e8e8] transition hover:border-zinc-600 hover:bg-zinc-700"
          >
            Google 搜尋
          </button>
          <button
            type="button"
            onClick={() => {
              window.location.href = "https://www.google.com/doodles";
            }}
            className="rounded border border-transparent bg-zinc-800 px-4 py-2 text-[#e8e8e8] transition hover:border-zinc-600 hover:bg-zinc-700"
          >
            好手氣
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800 bg-zinc-900 text-[14px] text-[#adafb8]">
        <div className="border-b border-zinc-800 px-8 py-3.5">台灣</div>

        <div className="flex flex-col items-center justify-between space-y-4 px-8 py-2 md:flex-row md:space-y-0">
          <div className="flex flex-wrap justify-center space-x-6">
            <a href="https://www.google.com.tw/intl/zh-TW/ads" className="py-1.5 hover:underline">
              廣告
            </a>
            <a href="https://www.google.com.tw/services" className="py-1.5 hover:underline">
              商業
            </a>
            <a href="https://google.com/search/howsearchworks" className="py-1.5 hover:underline">
              搜尋服務的運作方式
            </a>
          </div>

          <div className="relative flex flex-wrap items-center justify-center space-x-6">
            <a href="https://policies.google.com/privacy" className="py-1.5 hover:underline">
              隱私權
            </a>
            <a href="https://policies.google.com/terms" className="py-1.5 hover:underline">
              服務條款
            </a>

            <div className="relative" ref={settingsRef}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowSettings((prev) => !prev);
                }}
                className="flex items-center py-1.5 hover:underline focus:outline-none"
              >
                設定
              </button>
              {showSettings && (
                <div className="absolute bottom-full right-0 z-30 mb-2 w-52 rounded-lg border border-zinc-700 bg-zinc-800 py-2 text-left shadow-xl">
                  <a
                    href="https://www.google.com/preferences"
                    className="block px-4 py-2 transition hover:bg-zinc-700 hover:text-white"
                  >
                    搜尋設定
                  </a>
                  <a
                    href="https://www.google.com/advanced_search"
                    className="block px-4 py-2 transition hover:bg-zinc-700 hover:text-white"
                  >
                    進階搜尋
                  </a>
                  <a
                    href="https://myactivity.google.com/"
                    className="block px-4 py-2 transition hover:bg-zinc-700 hover:text-white"
                  >
                    搜尋紀錄
                  </a>
                  <a
                    href="https://support.google.com/websearch"
                    className="block px-4 py-2 transition hover:bg-zinc-700 hover:text-white"
                  >
                    搜尋說明
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
