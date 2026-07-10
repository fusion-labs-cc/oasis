"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { checkHealth } from "@/lib/api";
import {
  getBackendUrl,
  setBackendUrl,
  getAuthorized,
  setAuthorized,
} from "@/lib/backend";

export type BackendStatusType = "checking" | "up" | "down";

// Why the backend is "down", so the gate can word it correctly:
//   "failed" — a connection attempt (auto, manual, or a dropped poll) couldn't
//              reach the backend → 連線失敗.
//   "manual" — the user disconnected on purpose (or a fresh, never-connected
//              load) and we are NOT auto-retrying → 連線中斷.
export type BackendDownReason = "failed" | "manual";

interface BackendContextType {
  status: BackendStatusType;
  downReason: BackendDownReason;
  ping: () => Promise<boolean>;
  backendUrl: string;
  updateBackendUrl: (url: string) => void;
  disconnect: () => void;
}

const BackendContext = createContext<BackendContextType | undefined>(undefined);

// How often to re-check the backend *while connected*, to notice a drop.
const POLL_INTERVAL_MS = 10000;

export function BackendProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<BackendStatusType>("checking");
  // Defaults to "manual" so a fresh, never-connected load reads as 連線中斷
  // rather than a failure the user never triggered.
  const [downReason, setDownReason] = useState<BackendDownReason>("manual");
  const [backendUrlState, setBackendUrlState] = useState<string>("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const ping = useCallback(async () => {
    const ok = await checkHealth();
    // A ping that comes back unreachable is a connection *failure*.
    if (!ok) setDownReason("failed");
    setStatus(ok ? "up" : "down");
    // A successful check authorizes future auto-connects; a failed one revokes
    // it, so the next load requires an explicit "進入".
    setAuthorized(ok);
    return ok;
  }, []);

  // On load, auto-connect only if the user is already authorized (has entered
  // before and hasn't disconnected/failed since). Otherwise stay on the gate.
  useEffect(() => {
    setBackendUrlState(getBackendUrl());
    if (getAuthorized()) {
      ping();
    } else {
      setStatus("down");
    }
  }, [ping]);

  const updateBackendUrl = useCallback(
    (url: string) => {
      setBackendUrl(url);
      setBackendUrlState(getBackendUrl());
      setStatus("checking");
      // Attempt immediately — even if the URL is unchanged (manual retry).
      // ping() sets the authorized flag based on the result.
      ping();
    },
    [ping],
  );

  // Manual disconnect: drop the connection, revoke authorization, and return to
  // the entrance gate. Future loads require an explicit "進入" until it succeeds.
  const disconnect = useCallback(() => {
    setAuthorized(false);
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    // A deliberate teardown with no auto-retry — this is 連線中斷, not a failure.
    setDownReason("manual");
    setStatus("down");
  }, []);

  // Poll only while connected, so a dropped backend re-arms the gate. Once the
  // gate is showing (status !== "up"), no automatic checks run.
  useEffect(() => {
    if (status !== "up") {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
      return;
    }
    timer.current = setInterval(ping, POLL_INTERVAL_MS);
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [status, ping]);

  return (
    <BackendContext.Provider
      value={{ status, downReason, ping, backendUrl: backendUrlState, updateBackendUrl, disconnect }}
    >
      {children}
    </BackendContext.Provider>
  );
}

export function useBackend() {
  const context = useContext(BackendContext);
  if (context === undefined) {
    throw new Error("useBackend must be used within a BackendProvider");
  }
  return context;
}
