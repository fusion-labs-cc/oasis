"use client";

/* eslint-disable react-hooks/set-state-in-effect */

/**
 * User preferences — Awake Mode and the customizable keyboard
 * shortcuts. Everything lives in a single localStorage entry so it survives
 * reloads. Components read via {@link useSettings}, which re-renders whenever
 * settings change (in this tab via a custom event, or in another tab via the
 * native `storage` event).
 */

import { useEffect, useState } from "react";

export interface Hotkey {
  /** The main key, lowercased (e.g. "x", "k", "/"). */
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface Settings {
  /** When false, the Awake Mode shortcut and header button are disabled. */
  awakeEnabled: boolean;
  /** Shortcut that toggles Awake Mode (the "boss key" Google disguise). */
  awakeHotkey: Hotkey;
  /** Shortcut that opens the "add video" command palette. */
  addVideoHotkey: Hotkey;
}

const STORAGE_KEY = "oasis:settings";
/** Dispatched on `window` after settings are saved in this tab. */
export const SETTINGS_EVENT = "oasis:settings_changed";

export function isMacPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPad|iPhone|iPod/.test(navigator.userAgent)
  );
}

/**
 * The out-of-the-box settings. Shortcuts mirror the historical hardcoded
 * defaults: ⌘X / Alt+X for Awake Mode and ⌘K / Ctrl+K for adding a video.
 *
 * Pass an explicit `mac` to keep server and first client render deterministic
 * (avoiding a hydration mismatch); omit it to detect the real platform.
 */
export function defaultSettings(mac: boolean = isMacPlatform()): Settings {
  return {
    awakeEnabled: false,
    awakeHotkey: mac
      ? { key: "x", meta: true, ctrl: false, alt: false, shift: false }
      : { key: "x", meta: false, ctrl: false, alt: true, shift: false },
    addVideoHotkey: mac
      ? { key: "k", meta: true, ctrl: false, alt: false, shift: false }
      : { key: "k", meta: false, ctrl: true, alt: false, shift: false },
  };
}

function normalizeHotkey(value: unknown, fallback: Hotkey): Hotkey {
  if (!value || typeof value !== "object") return fallback;
  const v = value as Partial<Hotkey>;
  if (typeof v.key !== "string" || v.key.length === 0) return fallback;
  return {
    key: v.key.toLowerCase(),
    meta: Boolean(v.meta),
    ctrl: Boolean(v.ctrl),
    alt: Boolean(v.alt),
    shift: Boolean(v.shift),
  };
}

/** Read settings from localStorage, filling any missing fields with defaults. */
export function loadSettings(): Settings {
  const base = defaultSettings();
  if (typeof localStorage === "undefined") return base;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      awakeEnabled:
        typeof parsed.awakeEnabled === "boolean"
          ? parsed.awakeEnabled
          : base.awakeEnabled,
      awakeHotkey: normalizeHotkey(parsed.awakeHotkey, base.awakeHotkey),
      addVideoHotkey: normalizeHotkey(parsed.addVideoHotkey, base.addVideoHotkey),
    };
  } catch {
    return base;
  }
}

/** Persist settings and notify listeners in this tab. */
export function saveSettings(settings: Settings): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(SETTINGS_EVENT));
}

/** True when a keyboard event exactly matches the configured shortcut. */
export function matchesHotkey(e: KeyboardEvent, hk: Hotkey): boolean {
  return (
    e.key.toLowerCase() === hk.key.toLowerCase() &&
    e.metaKey === hk.meta &&
    e.ctrlKey === hk.ctrl &&
    e.altKey === hk.alt &&
    e.shiftKey === hk.shift
  );
}

function displayKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "escape") return "Esc";
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Human-readable shortcut, e.g. "⌘ X" on macOS or "Ctrl+K" elsewhere. */
export function formatHotkey(hk: Hotkey, mac: boolean = isMacPlatform()): string {
  const parts: string[] = [];
  if (hk.meta) parts.push(mac ? "⌘" : "Meta");
  if (hk.ctrl) parts.push(mac ? "⌃" : "Ctrl");
  if (hk.alt) parts.push(mac ? "⌥" : "Alt");
  if (hk.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(displayKey(hk.key));
  return parts.join(mac ? " " : "+");
}

/**
 * Detect macOS on the client only. Returns `false` on the server and during the
 * first client render (so hydration matches), then flips to the real value on
 * mount. Use this instead of calling {@link isMacPlatform} during render, which
 * would differ between server and client and cause a hydration mismatch.
 */
export function useIsMac(): boolean {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMacPlatform()), []);
  return mac;
}

/**
 * Subscribe to settings. Initializes with deterministic (non-mac) defaults so
 * server and first client render agree, then loads the real values on mount.
 */
export function useSettings(): Settings {
  const [settings, setSettings] = useState<Settings>(() =>
    defaultSettings(false),
  );

  useEffect(() => {
    setSettings(loadSettings());
    const onChange = () => setSettings(loadSettings());
    window.addEventListener(SETTINGS_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(SETTINGS_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  return settings;
}
