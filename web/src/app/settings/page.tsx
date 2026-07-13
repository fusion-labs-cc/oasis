"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import {
  applyUpdate,
  checkForUpdate,
  checkHealth,
  fetchUpdateLogs,
  fetchUpdateProgress,
  UpdateInfo,
  UpdateLogs,
  UpdateProgress,
} from "@/lib/api";
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
 * Flatten the update diagnostics into one plain-text blob — what the user pastes
 * into a bug report. Mirrors what's rendered below, so a report carries the same
 * evidence we'd have asked them to go dig out of the install folder by hand.
 */
function formatLogs(logs: UpdateLogs): string {
  const head = [
    `version: ${logs.version}`,
    `platform: ${logs.platform} (asset: ${logs.platform_stamp ?? "未標記"})`,
    `frozen: ${logs.frozen}  pid: ${logs.pid}`,
    `install: ${logs.base}`,
    `progress: ${JSON.stringify(logs.progress)}`,
    "",
    "安裝資料夾內容：",
    ...logs.install_entries.map(
      (e) => `  ${e.modified ?? "?"}  ${e.name}`,
    ),
  ];
  const files = logs.files.map((f) =>
    [
      `\n===== ${f.name} (${f.modified ?? "不存在"}) =====`,
      f.text ?? "（沒有這個檔案）",
    ].join("\n"),
  );
  return [...head, ...files].join("\n");
}

/**
 * The update log files, shown after an update fails.
 *
 * An update runs across three processes — the backend that downloads, the helper
 * that swaps the files, and the backend that relaunches — and by the time the
 * user is looking at "更新未生效", the two that know what went wrong are gone.
 * All they leave behind are logs in the install folder, so we read them back out
 * here rather than asking the user to go find a dotfolder. The install-folder
 * listing is part of the evidence: an exe whose mtime predates the update means
 * the swap never happened (locked file), not that the download failed.
 */
function UpdateDiagnostics({
  logs,
  logsError,
  loading,
  onReload,
}: {
  logs: UpdateLogs | null;
  logsError: string | null;
  loading: boolean;
  onReload: () => void;
}) {
  const toast = useToast();

  return (
    <details className="border-t border-border-hairline py-4" open={!!logs}>
      <summary className="cursor-pointer text-xs font-bold text-text-secondary transition hover:text-text-primary">
        更新診斷紀錄
      </summary>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onReload}
          disabled={loading}
          className="rounded-lg border border-border-hairline bg-surface-highest px-3 py-1.5 text-[11px] font-bold text-text-secondary transition hover:text-text-primary disabled:opacity-50 cursor-pointer"
        >
          {loading ? "讀取中…" : "重新讀取"}
        </button>
        {logs && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(formatLogs(logs))
                .then(() => toast("已複製診斷紀錄", { type: "success" }))
                .catch(() => toast("複製失敗", { type: "error" }));
            }}
            className="rounded-lg border border-border-hairline bg-surface-highest px-3 py-1.5 text-[11px] font-bold text-text-secondary transition hover:text-text-primary cursor-pointer"
          >
            複製全部
          </button>
        )}
      </div>

      {logsError && (
        <p className="mt-3 text-xs text-amber-500">{logsError}</p>
      )}

      {logs && (
        <div className="mt-3 space-y-3">
          <p className="font-mono text-[11px] leading-relaxed text-text-tertiary">
            版本 {logs.version} · {logs.platform} ·{" "}
            {logs.platform_stamp ?? "未標記安裝檔"}
            <br />
            安裝位置：{logs.base}
          </p>

          {logs.files.map((file) => (
            <div key={file.name}>
              <p className="mb-1 font-mono text-[11px] font-bold text-text-secondary">
                {file.name}
                {file.modified && (
                  <span className="ml-2 font-normal text-text-tertiary">
                    {file.modified}
                  </span>
                )}
              </p>
              <pre className="max-h-64 overflow-auto rounded-lg bg-surface-highest p-3 font-mono text-[10px] leading-relaxed text-text-tertiary whitespace-pre-wrap break-all">
                {file.text ?? "（沒有這個檔案 — 這個步驟沒有執行到）"}
              </pre>
            </div>
          ))}

          <div>
            <p className="mb-1 font-mono text-[11px] font-bold text-text-secondary">
              安裝資料夾
            </p>
            <pre className="max-h-48 overflow-auto rounded-lg bg-surface-highest p-3 font-mono text-[10px] leading-relaxed text-text-tertiary">
              {logs.install_entries
                .map((e) => `${e.modified ?? "?"}  ${e.name}`)
                .join("\n")}
            </pre>
          </div>
        </div>
      )}
    </details>
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
  // Set once an update is confirmed applied (the relaunched backend reports the
  // new version), e.g. "已更新到 v0.2.3".
  const [success, setSuccess] = useState<string | null>(null);
  // null → idle; otherwise the current phase of an in-progress auto-update.
  const [phase, setPhase] = useState<
    "downloading" | "installing" | "restarting" | null
  >(null);
  // Download progress 0..100 while phase === "downloading", or -1 when the
  // download size is unknown (shown as an indeterminate state).
  const [percent, setPercent] = useState(0);
  // Update log files + install-folder state, loaded on demand when an update
  // fails (the failure happened in processes that no longer exist, so the logs
  // on disk are the only account of it).
  const [logs, setLogs] = useState<UpdateLogs | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const updating = phase !== null;

  async function loadLogs() {
    setLoadingLogs(true);
    setLogsError(null);
    try {
      setLogs(await fetchUpdateLogs());
    } catch (e) {
      setLogs(null);
      setLogsError(
        e instanceof Error ? e.message : "無法讀取更新紀錄（後端沒有回應）。",
      );
    } finally {
      setLoadingLogs(false);
    }
  }

  async function runCheck(signal?: AbortSignal) {
    setChecking(true);
    setError(null);
    setSuccess(null);
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

  // Poll the backend's download progress until it starts installing (after
  // which the helper kills the backend, so the endpoint goes unreachable — we
  // treat that as "installing" and move on to waiting for the relaunch).
  // Resolves true to continue to the restart wait, or false when the download
  // itself failed (an error has already been surfaced).
  async function pollDownload() {
    const deadline = Date.now() + 600_000; // 10 min cap for a slow download
    while (Date.now() < deadline) {
      let p: UpdateProgress;
      try {
        p = await fetchUpdateProgress();
      } catch {
        // Backend unreachable — it most likely moved to installing and the
        // helper already stopped it. Proceed to wait for the relaunch.
        return true;
      }
      if (p.phase === "error") {
        setError(p.error ?? "下載更新失敗。");
        return false;
      }
      if (p.phase === "installing") {
        setPercent(100);
        setPhase("installing");
        return true;
      }
      if (p.phase === "downloading") setPercent(p.percent);
      await new Promise((r) => setTimeout(r, 500));
    }
    setError("下載更新逾時，請稍後再試，或改用下方「手動下載」安裝。");
    return false;
  }

  async function runUpdate() {
    setError(null);
    setSuccess(null);
    setLogs(null);
    setLogsError(null);
    setPercent(0);
    setPhase("downloading");
    // The version we're updating to, so we can confirm the relaunched backend is
    // actually the new build (a failed swap relaunches the OLD build, which is
    // healthy but unchanged — health alone can't tell success from failure).
    let target: string | null = info?.latest ?? null;
    try {
      const res = await applyUpdate();
      if (res.status !== "updating") {
        setError(res.error ?? "更新失敗。");
        setPhase(null);
        return;
      }
      target = res.latest ?? target;
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失敗。");
      setPhase(null);
      return;
    }

    // Stream the download percent, then the "installing" phase, before the
    // backend is stopped and swapped by the helper.
    if (!(await pollDownload())) {
      setPhase(null);
      return;
    }

    setPhase("restarting");
    const back = await waitForRestart();
    if (!back) {
      setPhase(null);
      setError(
        "後端重新啟動逾時，更新可能未完成。請手動重新啟動 OASIS；若版本仍未變更，請改用下方「手動下載」安裝。",
      );
      // The backend is (probably) down, so this likely fails too — but if the
      // helper did relaunch it and we just gave up too early, the logs load and
      // say exactly that, which is worth the one request.
      void loadLogs();
      return;
    }

    // Backend is answering again — confirm it's the NEW version before calling
    // this a success. If it came back on the old version, the file swap failed
    // (e.g. the update helper couldn't replace locked files) and the old build
    // relaunched, so we surface an explicit failure with the manual fallback.
    try {
      const fresh = await checkForUpdate();
      setInfo(fresh);
      setPhase(null);
      if ((target && fresh.current === target) || !fresh.update_available) {
        setSuccess(`已更新到 ${fresh.current}`);
      } else {
        setError(
          `更新未生效：目前仍是 ${fresh.current}（預期 ${target ?? "新版本"}）。` +
            "檔案置換沒有成功，請展開下方的「更新診斷紀錄」查看原因，或改用「手動下載」安裝。",
        );
        // Pull the logs straight away: this is the failure we most need an
        // account of, and the newly relaunched backend can read them off disk.
        void loadLogs();
      }
    } catch {
      setPhase(null);
      setError("後端已重新啟動，但無法確認版本。請重新整理頁面並再次「檢查更新」確認。");
      void loadLogs();
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
          {success && (
            <p className="max-w-[16rem] text-right text-xs text-emerald-500">
              {success}
            </p>
          )}
          {info?.error && (
            <p className="max-w-[16rem] text-right text-xs text-amber-500">
              {info.error}
            </p>
          )}
          {phase ? (
            <div className="flex w-[16rem] flex-col items-end gap-1.5">
              <p className="text-xs text-text-tertiary">
                {phase === "downloading"
                  ? percent >= 0
                    ? `下載更新中… ${percent}%`
                    : "下載更新中…"
                  : phase === "installing"
                    ? "安裝中…"
                    : "安裝完成，正在重新啟動後端…"}
              </p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-highest">
                <div
                  className={`h-full rounded-full bg-accent transition-all duration-300 ${
                    // Indeterminate cases (unknown size / installing / restart)
                    // pulse a filled bar; a known percent fills proportionally.
                    phase === "downloading" && percent >= 0 ? "" : "animate-pulse"
                  }`}
                  style={{
                    width:
                      phase === "downloading" && percent >= 0
                        ? `${percent}%`
                        : "100%",
                  }}
                />
              </div>
            </div>
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
                disabled={updating || checking}
                className="rounded-lg bg-accent px-4 py-2 text-xs font-bold text-neutral-950 transition hover:bg-accent-hover shadow-[0_2px_10px_rgba(16,185,129,0.2)] disabled:opacity-50 cursor-pointer"
              >
                {updating ? "更新中…" : "立即更新"}
              </button>
            )}
            <button
              type="button"
              onClick={() => runCheck()}
              disabled={checking || updating}
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

      {/* Only after something went wrong — a healthy update needs no forensics.
          `error` covers the failed-swap, restart-timeout and download-error
          paths, all of which leave an account of themselves on disk. */}
      {error && !updating && (
        <UpdateDiagnostics
          logs={logs}
          logsError={logsError}
          loading={loadingLogs}
          onReload={() => void loadLogs()}
        />
      )}
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
