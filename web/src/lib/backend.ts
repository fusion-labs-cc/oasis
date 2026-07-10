// Base URL of the Python FastAPI backend, which each user runs on their own
// machine. The public frontend calls it directly from the browser, so the URL
// must be resolvable client-side (localStorage override → build-time default →
// localhost). HTTPS pages may call http://localhost / http://127.0.0.1 without
// mixed-content errors, so localhost is the recommended default.

const STORAGE_KEY = "oasis:backendUrl";
const DEFAULT_BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

// Resolve the backend base URL for browser fetches.
export function getBackendUrl(): string {
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return normalize(stored);
  }
  return normalize(DEFAULT_BACKEND_URL);
}

// Persist a user-chosen backend URL (e.g. a different port). Empty clears it.
export function setBackendUrl(url: string): void {
  if (typeof window === "undefined") return;
  const clean = normalize(url);
  if (clean) window.localStorage.setItem(STORAGE_KEY, clean);
  else window.localStorage.removeItem(STORAGE_KEY);
}

// "Authorized" flag: set once the user has successfully entered the OASIS.
// While set, the portal auto-connects on load (no manual "進入" needed) across
// refreshes and reopens. It is cleared on a manual disconnect or a failed
// health check, after which manual entry is required again. Persisted in
// localStorage so it survives tab/browser restarts.
const AUTHORIZED_KEY = "oasis:authorized";

export function getAuthorized(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(AUTHORIZED_KEY) === "1";
}

export function setAuthorized(on: boolean): void {
  if (typeof window === "undefined") return;
  if (on) window.localStorage.setItem(AUTHORIZED_KEY, "1");
  else window.localStorage.removeItem(AUTHORIZED_KEY);
}
