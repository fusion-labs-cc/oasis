"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useBackend } from "@/context/BackendContext";
import { getAuthorized } from "@/lib/backend";

/**
 * OasisGate — the "Ready Player One" entry portal.
 *
 * Until the browser can reach the user's private backend, the whole site is
 * covered by a cinematic OASIS entrance that gives away *nothing* about what
 * this app actually is: no catalog, no header, no hint of its purpose. It reads
 * as a generic virtual-world portal.
 *
 * The only interactive element is the "portal coordinates" field — really the
 * backend URL. Enter it, connect, and once the backend answers the gate
 * dissolves to reveal the real application underneath.
 *
 * The gate re-arms automatically if the connection is later lost, so a dropped
 * backend never leaks the interface.
 */
// Tunable portal behavior — tweak these to taste.
const CONFIG = {
  revealMs: 1100, // dissolve-animation length before the app is revealed
  shakeMs: 550, // screen-shake duration on a failed connection attempt
  boostMs: 1800, // how long the motes keep rushing upward after a failure
  boostFactor: 0.3, // mote rise-time multiplier while boosting (smaller = faster)
};

// Where a new visitor can download the OASIS portal bundle. The release ships a
// macOS and a Windows build; the gate offers both and lets the visitor pick.
// Set per-OS shareable links — e.g. Google Drive "anyone with the link" files:
//   NEXT_PUBLIC_PORTAL_DOWNLOAD_URL_MAC  → macos-arm64 zip
//   NEXT_PUBLIC_PORTAL_DOWNLOAD_URL_WIN  → win64 zip
// Each link that is set renders its own button; unset ones are hidden. When
// neither is set the prompt is hidden so the gate stays minimal. Inlined at
// build time (must be NEXT_PUBLIC_).
const PORTAL_DOWNLOADS: { label: string; url: string }[] = [
  { label: "macOS", url: process.env.NEXT_PUBLIC_PORTAL_DOWNLOAD_URL_MAC || "" },
  { label: "Windows", url: process.env.NEXT_PUBLIC_PORTAL_DOWNLOAD_URL_WIN || "" },
].filter((d) => d.url);

// The companion Chrome extension (chrome-extension/, shipped as the OS-independent
// oasis-extension.zip). One link for every platform since the extension has no
// per-OS build. Unset → hidden, like the portal downloads. Inlined at build time.
const EXTENSION_DOWNLOAD_URL = process.env.NEXT_PUBLIC_EXTENSION_DOWNLOAD_URL || "";

// A pairing QR encodes the backend URL — nothing else. It exists to spare the
// user typing a long tunnel URL into a phone; it carries no credential, so a
// scanned phone still has to be told the access code (which only ever appears on
// the backend's console). Carried in the URL *fragment*, which browsers never
// send to a server, and wiped from the address bar the moment it is read.
const PAIR_FRAGMENT = "oasis-pair=";

function readPairingFragment(): string | null {
  const hash = window.location.hash.slice(1);
  if (!hash.startsWith(PAIR_FRAGMENT)) return null;
  try {
    const raw = atob(hash.slice(PAIR_FRAGMENT.length).replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(raw);
    if (typeof data.u === "string" && data.u) return data.u;
  } catch {
    // Malformed link — fall through to the normal gate.
  }
  return null;
}

export default function OasisGate() {
  const { status, downReason, backendUrl, updateBackendUrl, codeSet, submitCode } = useBackend();

  // Overlay lifecycle: shown while gated, briefly "revealing" on connect, then
  // fully unmounted so the app beneath is interactive. `visibleRef` mirrors
  // `visible` so the status effect can read it without depending on it.
  const [visible, setVisible] = useState(true);
  const visibleRef = useRef(true);
  const [revealing, setRevealing] = useState(false);
  const [draft, setDraft] = useState("");
  // Access code, asked for only when the backend wants one we don't hold — which
  // only ever happens on a device that isn't the one running the backend (a phone
  // on a tunnel). The owner's own machine needs no credential.
  const [codeDraft, setCodeDraft] = useState("");
  const [authError, setAuthError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Lets someone stuck on the code prompt go back and retarget a different
  // backend instead (e.g. they pasted the wrong tunnel URL).
  const [editingUrl, setEditingUrl] = useState(false);
  // A scanned pairing link's backend URL, held until the user confirms it. Never
  // applied silently: a link is something someone else can send you, and applying
  // it unasked would let them point this browser at a backend of their choosing.
  const [pending, setPending] = useState<string | null>(null);
  // Failure feedback: a brief screen shake + faster-rising motes when a
  // user-initiated connection attempt comes back unreachable.
  const [shaking, setShaking] = useState(false);
  const [boost, setBoost] = useState(false);
  const attempted = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Authorized users skip the gate entirely: hide it before first paint so a
  // refresh/reopen drops straight into the app — no entrance, no dissolve.
  useLayoutEffect(() => {
    if (getAuthorized()) {
      visibleRef.current = false;
      setVisible(false);
    }
    // React now owns the gate; release the pre-hydration CSS hide so a later
    // disconnect/failure can re-show it.
    document.documentElement.classList.add("oasis-hydrated");
  }, []);

  // Keep the coordinates field in sync with the resolved backend URL.
  useEffect(() => {
    setDraft(backendUrl);
  }, [backendUrl]);

  // Pick up a scanned pairing link, and scrub it from the address bar (and from
  // history) straight away so a stale backend URL can't be re-applied on reload.
  useEffect(() => {
    const url = readPairingFragment();
    if (!url) return;
    setPending(url);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  // Drive the gate off the connection status.
  useEffect(() => {
    if (status === "up") {
      attempted.current = false;
      // Only dissolve if the gate is actually on screen (manual entry). On an
      // authorized auto-connect it's already hidden — do nothing.
      if (!visibleRef.current) return;
      setRevealing(true);
      const t = setTimeout(() => {
        visibleRef.current = false;
        setVisible(false);
        setRevealing(false);
      }, CONFIG.revealMs);
      return () => clearTimeout(t);
    }
    if (status === "down") {
      // Disconnected, revoked, or a failed check: re-arm the portal.
      visibleRef.current = true;
      setVisible(true);
      setRevealing(false);
      // If this "down" is the result of a user connection attempt, react: shake
      // the portal and send the motes rushing upward.
      if (attempted.current) {
        attempted.current = false;
        setShaking(true);
        setBoost(true);
        const t1 = setTimeout(() => setShaking(false), CONFIG.shakeMs);
        const t2 = setTimeout(() => setBoost(false), CONFIG.boostMs);
        return () => {
          clearTimeout(t1);
          clearTimeout(t2);
        };
      }
    }
    // status === "checking": leave the gate as-is — don't flash it for an
    // authorized reconnect, don't hide it mid manual entry.
  }, [status]);

  // Lock scroll and neutralize the tab while the gate covers everything.
  useEffect(() => {
    if (!visible) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [visible]);

  function connect() {
    const url = draft.trim();
    if (!url) return;
    // Mark this as a deliberate attempt so a failed ping triggers the shake.
    attempted.current = true;
    setEditingUrl(false);
    setAuthError("");
    // Persist + re-ping (BackendContext flips status to "checking" then pings).
    updateBackendUrl(url);
  }

  // Enter the access code the backend printed on its own console. The backend URL
  // is already the right one by the time this form shows (that is how we learned a
  // code was wanted), so the code is filed against the correct host.
  async function enterCode() {
    const code = codeDraft.trim();
    if (!code || submitting) return;
    attempted.current = true;
    setSubmitting(true);
    setAuthError("");
    try {
      await submitCode(code);
      setCodeDraft("");
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "存取碼錯誤");
    } finally {
      setSubmitting(false);
    }
  }

  // Adopt the scanned backend URL. There is no credential in the link, so this is
  // exactly the manual "enter the coordinates" path — the gate will then ask for
  // the access code, which the user reads off the backend's console.
  function acceptPairing() {
    if (!pending) return;
    const url = pending;
    setPending(null);
    attempted.current = true;
    setEditingUrl(false);
    setAuthError("");
    updateBackendUrl(url);
  }

  if (!visible) return null;

  // Reachable, but it won't have us: either it wants an access code we don't
  // hold, or it has none set and refuses us for not being its own machine.
  const blocked = status === "down" && downReason === "auth" && !editingUrl;
  const needsCode = blocked && codeSet;
  const notConfigured = blocked && !codeSet;

  return (
    <div
      className={`oasis-gate fixed inset-0 z-[9000] flex select-none flex-col items-center justify-center overflow-hidden bg-[#050510] font-sans text-white transition-all duration-1000 ${
        revealing ? "pointer-events-none scale-110 opacity-0 blur-md" : "opacity-100"
      }`}
      style={
        shaking
          ? { animation: `oasis-shake ${CONFIG.shakeMs}ms cubic-bezier(.36,.07,.19,.97)` }
          : undefined
      }
    >
      <style>{`
        @keyframes oasis-pulse {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 1; }
        }
        @keyframes oasis-grid-scroll {
          0% { background-position: 0 0; }
          100% { background-position: 0 60px; }
        }
        @keyframes oasis-flicker {
          0%, 100% { opacity: 1; }
          92% { opacity: 1; }
          94% { opacity: 0.55; }
          96% { opacity: 1; }
        }
        @keyframes oasis-shake {
          10%, 90% { transform: translateX(-2px); }
          20%, 80% { transform: translateX(4px); }
          30%, 50%, 70% { transform: translateX(-8px); }
          40%, 60% { transform: translateX(8px); }
        }
        .oasis-wordmark {
          background: linear-gradient(120deg, #4be1ff 0%, #a78bfa 45%, #ff5ea8 100%);
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          text-shadow: 0 0 42px rgba(122, 162, 255, 0.35);
        }
      `}</style>

      {/* Synthwave horizon grid */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 top-1/2 overflow-hidden [perspective:340px]">
        <div
          className="absolute inset-0 [transform:rotateX(62deg)] [transform-origin:center_top]"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(94,140,255,0.28) 1px, transparent 1px), linear-gradient(to bottom, rgba(94,140,255,0.28) 1px, transparent 1px)",
            backgroundSize: "60px 60px",
            animation: "oasis-grid-scroll 3s linear infinite",
            maskImage:
              "linear-gradient(to bottom, transparent, black 40%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent, black 40%)",
          }}
        />
      </div>

      {/* Ambient glows */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[#5b8cff]/20 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-0 left-1/2 h-[380px] w-[720px] -translate-x-1/2 translate-y-1/3 rounded-full bg-[#ff5ea8]/10 blur-[130px]" />

      {/* Drifting motes */}
      <div className="pointer-events-none absolute inset-0">
        {MOTES.map((m, i) => (
          <Mote key={i} left={m.left} dur={m.dur} delay={m.delay} boost={boost} />
        ))}
      </div>

      {/* Center content */}
      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        <h1
          className="oasis-wordmark -mr-[0.35em] text-7xl font-black tracking-[0.35em] sm:text-8xl"
          style={{ animation: "oasis-flicker 6s ease-in-out infinite" }}
        >
          OASIS
        </h1>

        <p className="mt-8 max-w-md text-sm leading-relaxed text-white/55">
          歡迎來到綠洲。
          <br />
          在這裡，唯一的極限，是你的想像力。
        </p>

        {/* Connection zone */}
        <div className="mt-12 flex min-h-[132px] w-full max-w-sm flex-col items-center">
          {pending ? (
            // A scanned pairing link. Confirm the destination before adopting it:
            // anyone can send you a link, and one applied silently would hand this
            // browser to a backend the sender chose.
            <div className="w-full">
              <div className="mb-3 flex items-center justify-center gap-2 text-xs tracking-[0.25em] text-white/45">
                <span
                  className="h-2 w-2 rounded-full bg-[#4be1ff] shadow-[0_0_10px_rgba(75,225,255,0.8)]"
                  style={{ animation: "oasis-pulse 1.1s ease-in-out infinite" }}
                />
                偵測到入口座標
              </div>
              <p className="mb-3 text-left text-[11px] leading-relaxed text-white/40">
                要將這台裝置連線到以下綠洲嗎？只有在這是你自己的入口座標時才繼續。連線後仍需輸入存取碼。
              </p>
              <code className="mb-4 block w-full truncate rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2.5 text-left font-mono text-xs text-white/80">
                {pending}
              </code>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={acceptPairing}
                  className="flex-1 rounded-lg bg-gradient-to-r from-[#4be1ff] to-[#a78bfa] px-5 py-2.5 text-sm font-bold text-[#050510] transition hover:brightness-110 active:scale-95"
                >
                  連線
                </button>
                <button
                  type="button"
                  onClick={() => setPending(null)}
                  className="rounded-lg border border-white/15 px-5 py-2.5 text-sm font-semibold text-white/60 transition hover:bg-white/[0.06]"
                >
                  取消
                </button>
              </div>
            </div>
          ) : status !== "down" ? (
            // "checking" (dialing in) or "up" (connected, gate now dissolving).
            // Both show the same calm pulse so a successful connect never flashes
            // the disconnect/failure form during the reveal animation.
            <div className="flex flex-col items-center gap-3">
              <div className="flex items-center gap-1.5">
                {[0, 1, 2].map((d) => (
                  <span
                    key={d}
                    className="h-2 w-2 rounded-full bg-[#7aa2ff]"
                    style={{
                      animation: "oasis-pulse 1.2s ease-in-out infinite",
                      animationDelay: `${d * 0.18}s`,
                    }}
                  />
                ))}
              </div>
              <span className="text-xs tracking-[0.3em] text-white/45">
                {status === "up" ? "連線成功" : "正在建立連線…"}
              </span>
            </div>
          ) : needsCode ? (
            // The backend is right there and answering — it just wants the access
            // code. Only a device that isn't its own machine ever sees this.
            <div className="w-full">
              <div className="mb-3 flex items-center justify-center gap-2 text-xs tracking-[0.25em] text-white/45">
                <span
                  className="h-2 w-2 rounded-full bg-[#ffc55c] shadow-[0_0_10px_rgba(255,197,92,0.8)]"
                  style={{ animation: "oasis-pulse 1.1s ease-in-out infinite" }}
                />
                需要存取碼
              </div>
              <label className="mb-2 block text-left text-[10px] font-semibold uppercase tracking-[0.3em] text-white/35">
                存取碼
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={codeDraft}
                  onChange={(e) => setCodeDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") enterCode();
                  }}
                  placeholder="XXXX-XXXX"
                  autoComplete="current-password"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2.5 font-mono text-sm uppercase tracking-widest text-white/90 outline-none backdrop-blur transition placeholder:normal-case placeholder:tracking-normal placeholder:text-white/25 focus:border-[#7aa2ff] focus:bg-white/[0.07]"
                />
                <button
                  type="button"
                  onClick={enterCode}
                  disabled={submitting}
                  className="shrink-0 rounded-lg bg-gradient-to-r from-[#4be1ff] to-[#a78bfa] px-5 py-2.5 text-sm font-bold text-[#050510] transition hover:brightness-110 active:scale-95 disabled:opacity-50"
                >
                  {submitting ? "驗證中…" : "進入"}
                </button>
              </div>
              {authError ? (
                <p className="mt-3 text-left text-[11px] leading-relaxed text-[#ff8fa3]">
                  {authError}
                </p>
              ) : (
                <p className="mt-3 text-left text-[11px] leading-relaxed text-white/30">
                  存取碼顯示在執行綠洲那台電腦的主控台視窗上。此裝置只需輸入一次。
                </p>
              )}
              <button
                type="button"
                onClick={() => setEditingUrl(true)}
                className="mt-2 text-[11px] text-white/30 underline underline-offset-2 transition hover:text-white/60"
              >
                改用其他入口座標
              </button>
            </div>
          ) : notConfigured ? (
            // Reachable, but it has no access code — so it serves nobody but its
            // own machine, and there is nothing this device can type to get in.
            <div className="w-full">
              <div className="mb-3 flex items-center justify-center gap-2 text-xs tracking-[0.25em] text-white/45">
                <span
                  className="h-2 w-2 rounded-full bg-[#ff5c7a] shadow-[0_0_10px_rgba(255,92,122,0.8)]"
                  style={{ animation: "oasis-pulse 1.1s ease-in-out infinite" }}
                />
                尚未開放遠端存取
              </div>
              <p className="text-left text-[11px] leading-relaxed text-white/40">
                這座綠洲目前只接受本機連線。請到執行綠洲的那台電腦上開啟「設定 →
                遠端存取」，打開開關後主控台會顯示存取碼，即可用這台裝置進入。
              </p>
              <button
                type="button"
                onClick={() => setEditingUrl(true)}
                className="mt-3 text-[11px] text-white/30 underline underline-offset-2 transition hover:text-white/60"
              >
                改用其他入口座標
              </button>
            </div>
          ) : (
            <div className="w-full">
              <div className="mb-3 flex items-center justify-center gap-2 text-xs tracking-[0.25em] text-white/45">
                <span
                  className="h-2 w-2 rounded-full bg-[#ff5c7a] shadow-[0_0_10px_rgba(255,92,122,0.8)]"
                  style={{ animation: "oasis-pulse 1.1s ease-in-out infinite" }}
                />
                {downReason === "failed" ? "連線中斷 · 自動重新連線中…" : "連線中斷"}
              </div>
              <label className="mb-2 block text-left text-[10px] font-semibold uppercase tracking-[0.3em] text-white/35">
                入口座標
              </label>
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  type="url"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") connect();
                  }}
                  placeholder="http://localhost:8000"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2.5 font-mono text-sm text-white/90 outline-none backdrop-blur transition placeholder:text-white/25 focus:border-[#7aa2ff] focus:bg-white/[0.07]"
                />
                <button
                  type="button"
                  onClick={connect}
                  className="shrink-0 rounded-lg bg-gradient-to-r from-[#4be1ff] to-[#a78bfa] px-5 py-2.5 text-sm font-bold text-[#050510] transition hover:brightness-110 active:scale-95"
                >
                  進入
                </button>
              </div>
              <p className="mt-3 text-left text-[11px] leading-relaxed text-white/30">
                在你的裝置上啟動綠洲，再輸入入口座標以進入。
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Quiet footer. The download prompt only appears while gated (never during
          the connect/reveal), so a new visitor without the bundle can grab it
          without cluttering the connection form; both platform builds are shown
          side by side so the visitor picks their own OS. The legal links sit
          below it and are always present — they are the only way in to /terms,
          /privacy and /licenses from outside the gate, and the FFmpeg notices on
          /licenses have to stay reachable by anyone offered a download here. */}
      <div className="absolute inset-x-0 bottom-6 z-10 flex flex-col items-center gap-5 px-6">
        {status === "down" && (PORTAL_DOWNLOADS.length > 0 || EXTENSION_DOWNLOAD_URL) && (
          <div className="flex flex-col items-center gap-3">
            {PORTAL_DOWNLOADS.length > 0 && (
              <div className="flex flex-col items-center gap-2">
                <span className="text-[11px] tracking-[0.15em] text-white/30">
                  還沒有綠洲？下載入口程式
                </span>
                <div className="flex items-center gap-4">
                  {PORTAL_DOWNLOADS.map((d) => (
                    <a
                      key={d.label}
                      href={d.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center gap-1.5 text-[11px] tracking-[0.15em] text-white/40 transition hover:text-white/80"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="h-3.5 w-3.5 transition group-hover:translate-y-0.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 3v12" />
                        <path d="m7 10 5 5 5-5" />
                        <path d="M5 21h14" />
                      </svg>
                      {d.label}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {EXTENSION_DOWNLOAD_URL && (
              <a
                href={EXTENSION_DOWNLOAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center gap-1.5 text-[11px] tracking-[0.15em] text-white/40 transition hover:text-white/80"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19.44 7.85c-.05.32.06.65.29.88l1.56 1.57c.47.47.71 1.08.71 1.7s-.24 1.23-.71 1.7l-1.6 1.62c-.24.23-.55.34-.84.27-.47-.07-.8-.48-.97-.92a2.5 2.5 0 1 0-3.21 3.21c.44.17.85.5.92.97a.98.98 0 0 1-.27.84l-1.62 1.6c-.47.47-1.08.71-1.7.71s-1.23-.24-1.7-.71l-1.57-1.56a1.03 1.03 0 0 0-.88-.29c-.49.07-.84.5-1.02.97a2.5 2.5 0 1 1-3.24-3.24c.47-.18.9-.53.97-1.02a1.03 1.03 0 0 0-.29-.88l-1.56-1.57A2.4 2.4 0 0 1 2 12c0-.62.24-1.23.71-1.7l1.52-1.53c.24-.24.58-.35.92-.3.51.08.88.53 1.07 1.01a2.5 2.5 0 1 0 3.26-3.26c-.48-.2-.93-.56-1.01-1.07a1.03 1.03 0 0 1 .3-.92l1.53-1.52A2.4 2.4 0 0 1 12 2c.62 0 1.23.24 1.7.71l1.57 1.56c.23.23.56.34.88.29.49-.07.84-.5 1.02-.97a2.5 2.5 0 1 1 3.24 3.24c-.47.18-.9.53-.97 1.02Z" />
                </svg>
                安裝瀏覽器擴充功能
              </a>
            )}
          </div>
        )}

        <nav className="flex items-center gap-3 text-[10px] tracking-[0.15em] text-white/25">
          <Link href="/terms" className="transition hover:text-white/60">
            使用條款
          </Link>
          <span aria-hidden className="text-white/15">
            ·
          </span>
          <Link href="/privacy" className="transition hover:text-white/60">
            隱私權
          </Link>
          <span aria-hidden className="text-white/15">
            ·
          </span>
          <Link href="/licenses" className="transition hover:text-white/60">
            授權
          </Link>
          <span aria-hidden className="text-white/15">
            ·
          </span>
          <a
            href="https://forms.gle/q4WhDeBxHkQu7TB8A"
            target="_blank"
            rel="noopener noreferrer"
            className="transition hover:text-white/60"
          >
            問題回饋
          </a>
        </nav>
      </div>
    </div>
  );
}

// A single rising mote. Driven by the Web Animations API rather than a CSS
// keyframe so that boosting can change `playbackRate` mid-flight: the mote
// speeds up smoothly from its current position instead of snapping back to the
// bottom (which a CSS duration/delay swap would cause).
function Mote({
  left,
  dur,
  delay,
  boost,
}: {
  left: number;
  dur: number;
  delay: number;
  boost: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const anim = useRef<Animation | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Negative delay so motes start already spread across the rise.
    const a = el.animate(
      [
        { transform: "translateY(0)", opacity: 0 },
        { opacity: 0.6, offset: 0.1 },
        { opacity: 0.6, offset: 0.9 },
        { transform: "translateY(-120vh)", opacity: 0 },
      ],
      {
        duration: dur * 1000,
        delay: -delay * 1000,
        iterations: Infinity,
        easing: "linear",
      },
    );
    anim.current = a;
    return () => a.cancel();
  }, [dur, delay]);

  // Accelerate/settle without restarting the timeline.
  useEffect(() => {
    if (anim.current) anim.current.playbackRate = boost ? 1 / CONFIG.boostFactor : 1;
  }, [boost]);

  return (
    <span
      ref={ref}
      className="absolute bottom-0 h-1 w-1 rounded-full bg-white/70"
      style={{ left: `${left}%` }}
    />
  );
}

// Precomputed so the motes don't reshuffle on every render.
const MOTES = [
  { left: 8, dur: 14, delay: 0 },
  { left: 19, dur: 18, delay: 4 },
  { left: 31, dur: 12, delay: 2 },
  { left: 44, dur: 20, delay: 7 },
  { left: 57, dur: 15, delay: 1 },
  { left: 68, dur: 17, delay: 5 },
  { left: 79, dur: 13, delay: 3 },
  { left: 91, dur: 19, delay: 6 },
];
