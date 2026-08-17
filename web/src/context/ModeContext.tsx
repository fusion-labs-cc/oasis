"use client";

/* eslint-disable react-hooks/set-state-in-effect */

/**
 * Catalog mode — 一般影音 vs 成人影音 — held as state, not in the URL.
 *
 * There is one catalog route (`/`) and the mode filters it. It used to be a
 * second route (`/adult`), which meant every page that isn't the catalog — a
 * video, a series, settings — had no mode in its path and silently fell back to
 * 一般: the add-video dialog listed general-only sites while you were looking at
 * an AV video, and an AV series' back link sent you to the general catalog.
 *
 * Stored in localStorage, so a reload lands the user back where they were.
 * Pages that *know* their content's category (a video, a series) set the mode
 * from it, so arriving by deep link or by random-pick corrects the mode instead
 * of contradicting it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type CatalogMode = "general" | "av";

const STORAGE_KEY = "oasis:mode";
const DEFAULT_MODE: CatalogMode = "general";

function loadMode(): CatalogMode {
  if (typeof localStorage === "undefined") return DEFAULT_MODE;
  return localStorage.getItem(STORAGE_KEY) === "av" ? "av" : DEFAULT_MODE;
}

interface ModeContextType {
  mode: CatalogMode;
  setMode: (mode: CatalogMode) => void;
}

const ModeContext = createContext<ModeContextType>({
  mode: DEFAULT_MODE,
  setMode: () => {},
});

export function ModeProvider({ children }: { children: React.ReactNode }) {
  // Start at the default so the server and the first client render agree — the
  // same reason `useSettings` does — then pick the stored mode up on mount.
  // Nothing mode-dependent is on screen that early: the catalog itself is
  // fetched after the backend health check.
  const [mode, setModeState] = useState<CatalogMode>(DEFAULT_MODE);

  useEffect(() => {
    setModeState(loadMode());
  }, []);

  const setMode = useCallback((next: CatalogMode) => {
    setModeState(next);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeContextType {
  return useContext(ModeContext);
}
