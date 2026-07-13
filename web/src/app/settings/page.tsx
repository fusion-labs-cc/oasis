"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { applyUpdate, checkForUpdate, checkHealth, UpdateInfo } from "@/lib/api";
import {
  defaultSettings,
  formatHotkey,
  Hotkey,
  loadSettings,
  saveSettings,
  Settings,
  useIsMac,
} from "@/lib/settings";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * Records a keyboard shortcut. Click to start capturing, then press the desired
 * combination — the first non-modifier key finalizes it. Escape cancels.
 */
function HotkeyInput({
  value,
  onChange,
}: {
  value: Hotkey;
  onChange: (hk: Hotkey) => void;
}) {
  const [recording, setRecording] = useState(false);
  const isMac = useIsMac();
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!recording) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      // Wait for a "real" key; ignore lone modifier presses.
      if (MODIFIER_KEYS.has(e.key)) return;

      onChange({
        key: e.key.toLowerCase(),
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
      });
      setRecording(false);
    };

    // Capture phase so we intercept before app-wide shortcut listeners.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recording, onChange]);

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={() => setRecording((r) => !r)}
      onBlur={() => setRecording(false)}
      className={`inline-flex min-w-[9rem] items-center justify-center gap-2 rounded-lg border px-4 py-2 font-mono text-sm font-bold transition cursor-pointer ${
        recording
          ? "border-accent bg-accent/10 text-accent animate-pulse"
          : "border-border-hairline bg-surface-highest text-text-primary hover:border-accent/40 hover:text-accent"
      }`}
    >
      {recording ? "請按下按鍵組合…" : formatHotkey(value, isMac)}
    </button>
  );
}

function Field({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border-hairline py-6 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 pr-4">
        <h3 className="text-sm font-bold text-text-primary">{title}</h3>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * Shows the running build's version and, when the backend can reach GitHub,
 * whether a newer release exists — with a direct download for this OS. The
 * check runs against the user's local backend, so it fails soft: an
 * unreachable backend or a blocked GitHub call just shows a "couldn't check"
 * note with a manual retry rather than breaking the settings page.
 */
function UpdateSection() {
  // Keep the last result across re-checks: the current version is the build's
  // own and never changes, so it stays on screen while re-checking instead of
  // flickering to a placeholder — the button already signals the busy state.
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // null → idle; otherwise the current phase of an in-progress auto-update.
  const [updating, setUpdating] = useState<
    "downloading" | "restarting" | null
  >(null);

  async function runCheck(signal?: AbortSignal) {
    setChecking(true);
    setError(null);
    try {
      setInfo(await checkForUpdate(signal));
    } catch {
      if (signal?.aborted) return;
      setError("無法連線到後端，請確認 OASIS 後端正在執行後再試。");
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  }

  // Wait for the backend to go down and come back up after it relaunches
  // itself, then re-check so the UI reflects the freshly installed version.
  async function waitForRestart() {
    const deadline = Date.now() + 180_000; // 3 min — the swap + relaunch is quick
    // Give the old process time to actually exit before we start expecting a
    // *new* healthy answer (otherwise we'd immediately see the old one as "up").
    await new Promise((r) => setTimeout(r, 4000));
    while (Date.now() < deadline) {
      if (await checkHealth()) return true;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async function runUpdate() {
    setError(null);
    setUpdating("downloading");
    try {
      const res = await applyUpdate();
      if (res.status !== "updating") {
        setError(res.error ?? "更新失敗。");
        setUpdating(null);
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失敗。");
      setUpdating(null);
      return;
    }

    setUpdating("restarting");
    const back = await waitForRestart();
    setUpdating(null);
    if (back) {
      await runCheck();
    } else {
      setError(
        "後端重新啟動逾時。更新可能仍在進行，請稍候重新整理頁面；若持續無法連線，請手動重新啟動 OASIS。",
      );
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    runCheck(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <section className="mb-8 rounded-2xl border border-border-hairline bg-surface-elevated/40 px-6">
      <div className="pt-6">
        <span className="text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
          關於與更新
        </span>
      </div>

      <Field
        title="目前版本"
        description="此後端執行檔的版本。原始碼直接執行時會顯示為 dev。"
      >
        <span className="font-mono text-sm font-bold text-text-primary">
          {info?.current ?? (checking ? "檢查中…" : "—")}
        </span>
      </Field>

      <Field
        title="軟體更新"
        description={
          info?.update_available
            ? "有新版本可用。點「立即更新」會自動下載並安裝，完成後後端會自行重新啟動，你的資料庫與影片會保留。"
            : "檢查是否有新的發行版本。"
        }
      >
        <div className="flex flex-col items-end gap-2">
          {error && (
            <p className="max-w-[16rem] text-right text-xs text-amber-500">
              {error}
            </p>
          )}
          {info?.error && (
            <p className="max-w-[16rem] text-right text-xs text-amber-500">
              {info.error}
            </p>
          )}
          {updating ? (
            <p className="text-xs text-text-tertiary">
              {updating === "downloading"
                ? "下載更新中…"
                : "安裝完成，正在重新啟動後端…"}
            </p>
          ) : (
            info &&
            !info.error && (
              <p className="text-xs text-text-tertiary">
                {info.update_available ? (
                  <>
                    最新版本{" "}
                    <span className="font-mono font-bold text-accent">
                      {info.latest}
                    </span>
                  </>
                ) : (
                  "已是最新版本"
                )}
              </p>
            )
          )}

          <div className="flex items-center gap-2">
            {info?.update_available && (
              <button
                type="button"
                onClick={() => runUpdate()}
                disabled={updating !== null || checking}
                className="rounded-lg bg-accent px-4 py-2 text-xs font-bold text-neutral-950 transition hover:bg-accent-hover shadow-[0_2px_10px_rgba(16,185,129,0.2)] disabled:opacity-50 cursor-pointer"
              >
                {updating ? "更新中…" : "立即更新"}
              </button>
            )}
            <button
              type="button"
              onClick={() => runCheck()}
              disabled={checking || updating !== null}
              className="rounded-lg border border-border-hairline bg-surface-highest px-4 py-2 text-xs font-bold text-text-secondary transition hover:text-text-primary disabled:opacity-50 cursor-pointer"
            >
              {checking ? "檢查中…" : "檢查更新"}
            </button>
          </div>

          {/* Fallback for source checkouts (auto-update is frozen-build only) or
              if the in-app update fails — the manual download still works. */}
          {info?.update_available && (
            <a
              href={info.download_url ?? info.release_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-text-tertiary underline decoration-dotted underline-offset-2 transition hover:text-text-secondary"
            >
              或手動下載
            </a>
          )}
        </div>
      </Field>
    </section>
  );
}

export default function SettingsPage() {
  const toast = useToast();
  const [form, setForm] = useState<Settings>(() => defaultSettings(false));

  useEffect(() => {
    document.title = "設定 — OASIS";
    setForm(loadSettings());
  }, []);

  function update<K extends keyof Settings>(key: K, val: Settings[K]) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleSave() {
    const trimmed: Settings = { ...form, nickname: form.nickname.trim() };
    saveSettings(trimmed);
    setForm(trimmed);
    toast("已儲存設定", { type: "success" });
  }

  function handleReset() {
    const defaults = defaultSettings();
    setForm(defaults);
    saveSettings(defaults);
    toast("已還原為預設值", { type: "info" });
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-10">
      <div className="mb-8">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-text-tertiary transition hover:text-accent"
        >
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
          返回資料庫
        </Link>
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-text-primary">
          設定
        </h1>
        <p className="mt-1 text-xs text-text-tertiary">
          個人化你的暱稱、Awake 模式與鍵盤快速鍵。設定會保存在此瀏覽器中。
        </p>
      </div>

      {/* Profile */}
      <section className="mb-8 rounded-2xl border border-border-hairline bg-surface-elevated/40 px-6">
        <div className="pt-6">
          <span className="text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
            個人資料
          </span>
        </div>
        <Field
          title="暱稱"
          description="顯示在首頁歡迎區的稱呼。留空則不顯示暱稱。"
        >
          <input
            type="text"
            value={form.nickname}
            onChange={(e) => update("nickname", e.target.value)}
            maxLength={40}
            placeholder="輸入你的暱稱"
            className="w-56 rounded-lg border border-border-hairline bg-surface-highest px-3 py-2 text-sm text-text-primary placeholder-text-tertiary outline-none transition focus:border-accent/50"
          />
        </Field>
      </section>

      {/* Awake Mode */}
      <section className="mb-8 rounded-2xl border border-border-hairline bg-surface-elevated/40 px-6">
        <div className="pt-6">
          <span className="text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
            Awake 模式
          </span>
        </div>
        <Field
          title="啟用 Awake 模式"
          description="一鍵將整個網站偽裝成 Google 首頁並暫停播放。關閉後將隱藏標頭按鈕並停用其快速鍵。"
        >
          <button
            type="button"
            role="switch"
            aria-checked={form.awakeEnabled}
            onClick={() => update("awakeEnabled", !form.awakeEnabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition cursor-pointer ${
              form.awakeEnabled ? "bg-accent" : "bg-surface-highest border border-border-hairline"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
                form.awakeEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </Field>
        <Field
          title="Awake 模式快速鍵"
          description="切換偽裝畫面的按鍵組合。"
        >
          <HotkeyInput
            value={form.awakeHotkey}
            onChange={(hk) => update("awakeHotkey", hk)}
          />
        </Field>
      </section>

      {/* Shortcuts */}
      <section className="mb-8 rounded-2xl border border-border-hairline bg-surface-elevated/40 px-6">
        <div className="pt-6">
          <span className="text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
            鍵盤快速鍵
          </span>
        </div>
        <Field
          title="新增影片快速鍵"
          description="開啟「新增影片」指令列的按鍵組合。斜線鍵 / 仍會保持有效。"
        >
          <HotkeyInput
            value={form.addVideoHotkey}
            onChange={(hk) => update("addVideoHotkey", hk)}
          />
        </Field>
      </section>

      {/* About & Updates */}
      <UpdateSection />

      {/* Actions */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={handleReset}
          className="rounded-lg border border-border-hairline bg-surface-elevated px-4 py-2 text-xs font-bold text-text-secondary transition hover:bg-surface-highest hover:text-text-primary cursor-pointer"
        >
          還原為預設值
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="rounded-lg bg-accent px-6 py-2 text-xs font-bold text-neutral-950 transition hover:bg-accent-hover shadow-[0_2px_10px_rgba(16,185,129,0.2)] cursor-pointer"
        >
          儲存變更
        </button>
      </div>
    </div>
  );
}
