"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { checkHealth, login } from "@/lib/api";
import {
  getBackendUrl,
  setBackendUrl,
  getAuthorized,
  setAuthorized,
  setSessionToken,
} from "@/lib/backend";

export type BackendStatusType = "checking" | "up" | "down";

// Why the backend is "down", so the gate can word it correctly:
//   "failed" — a connection attempt (auto, manual, or a dropped poll) couldn't
//              reach the backend → 連線失敗.
//   "manual" — the user disconnected on purpose (or a fresh, never-connected
//              load) and we are NOT auto-retrying → 連線中斷.
//   "auth"   — the backend answered but won't have us: either it wants an access
//              code we don't hold, or it has none set and refuses us for being
//              remote. Only a device that isn't the backend's own machine ever
//              lands here, and no amount of retrying fixes it — the gate has to
//              ask for the code (see `codeSet` for which of the two it is).
export type BackendDownReason = "failed" | "manual" | "auth";

interface BackendContextType {
  status: BackendStatusType;
  downReason: BackendDownReason;
  ping: () => Promise<boolean>;
  backendUrl: string;
  updateBackendUrl: (url: string) => void;
  // The backend has an access code set (so remote devices may log in). When
  // false it is in local-only mode and refuses every non-local caller outright.
  codeSet: boolean;
  // This browser is on the backend's own machine (may manage the access code).
  local: boolean;
  // Log in with the access code. Throws the backend's message on a bad code.
  submitCode: (code: string) => Promise<void>;
  // Adopt a session minted on the owner's PC (the pairing QR), against the
  // backend URL it was minted for.
  applyPairing: (url: string, token: string) => Promise<boolean>;
  disconnect: () => void;
}

const BackendContext = createContext<BackendContextType | undefined>(undefined);

// How often to re-check the backend *while connected*, to notice a drop.
const POLL_INTERVAL_MS = 10000;

// How often to retry *after a dropped connection* (e.g. the backend was
// Ctrl+C'd and restarted). Faster than the connected poll so the UI restores
// itself promptly once the server is back.
const RETRY_INTERVAL_MS = 3000;

export function BackendProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<BackendStatusType>("checking");
  // Defaults to "manual" so a fresh, never-connected load reads as 連線中斷
  // rather than a failure the user never triggered.
  const [downReason, setDownReason] = useState<BackendDownReason>("manual");
  const [backendUrlState, setBackendUrlState] = useState<string>("");
  const [codeSet, setCodeSet] = useState(false);
  const [local, setLocal] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const ping = useCallback(async () => {
    const health = await checkHealth();
    setCodeSet(health.codeSet);
    setLocal(health.local);

    // A session the backend no longer honours (the owner changed the code, which
    // drops every session) is dead weight: drop it so we stop presenting it and
    // the gate can ask for the code cleanly.
    if (health.ok && !health.authenticated && health.codeSet) setSessionToken("");

    const connected = health.ok && health.authenticated;
    if (!health.ok) {
      // A ping that comes back unreachable is a connection *failure*.
      setDownReason("failed");
    } else if (!health.authenticated) {
      setDownReason("auth");
    }
    setStatus(connected ? "up" : "down");
    // A successful check authorizes future auto-connects; a failed one revokes
    // it, so the next load requires an explicit "進入".
    setAuthorized(connected);
    return connected;
  }, []);

  // Log in with the access code and keep the session it returns. Lets the error
  // out so the gate can show *why* (wrong code vs. locked out vs. unreachable).
  const submitCode = useCallback(
    async (code: string) => {
      const token = await login(code);
      setSessionToken(token);
      await ping();
    },
    [ping],
  );

  // Adopt a session minted on the owner's PC (scanned from the pairing QR). The
  // URL has to be persisted before the token, so the session is filed against the
  // backend that actually issued it.
  const applyPairing = useCallback(
    async (url: string, token: string) => {
      setBackendUrl(url);
      setBackendUrlState(getBackendUrl());
      setSessionToken(token, url);
      setStatus("checking");
      return ping();
    },
    [ping],
  );

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

  // Auto-reconnect after a *dropped* connection (downReason "failed"), e.g. the
  // backend was Ctrl+C'd and restarted. Keep pinging the same backend in the
  // background; a successful ping flips status back to "up" (and re-authorizes),
  // so the UI — including in-progress downloads resumed on the server — restores
  // itself without the user re-entering. A deliberate disconnect ("manual") does
  // NOT retry, so the entrance gate still gates intentional teardowns.
  useEffect(() => {
    if (status === "down" && downReason === "failed") {
      retryTimer.current = setInterval(ping, RETRY_INTERVAL_MS);
      return () => {
        if (retryTimer.current) {
          clearInterval(retryTimer.current);
          retryTimer.current = null;
        }
      };
    }
  }, [status, downReason, ping]);

  return (
    <BackendContext.Provider
      value={{
        status,
        downReason,
        ping,
        backendUrl: backendUrlState,
        updateBackendUrl,
        codeSet,
        local,
        submitCode,
        applyPairing,
        disconnect,
      }}
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
