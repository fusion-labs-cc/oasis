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

// Is this URL pointing back at the machine the browser is running on? Used to
// keep such a URL out of a pairing QR, where it is worse than useless: a phone
// that scanned it would dial *itself*, not the backend.
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "0.0.0.0" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

// The backend's **public** URL — the tunnel the owner set up so their other
// devices can reach it. Deliberately not the same thing as getBackendUrl(): on
// the owner's own machine that one is localhost, which is exactly the URL a
// pairing QR must not carry. Only the QR needs this, so it stays in localStorage
// with the rest of the portal's per-device state; the backend never learns it
// (it cannot — it has no idea what tunnel, if any, is pointed at it).
const PUBLIC_URL_KEY = "oasis:publicBackendUrl";

export function getPublicBackendUrl(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(PUBLIC_URL_KEY) ?? "";
}

export function setPublicBackendUrl(url: string): void {
  if (typeof window === "undefined") return;
  const clean = normalize(url);
  if (clean) window.localStorage.setItem(PUBLIC_URL_KEY, clean);
  else window.localStorage.removeItem(PUBLIC_URL_KEY);
}

// The access code, attached to every /api/* call (see backendFetch). The backend
// generates it and prints it to its own console; a remote device is told it once
// by the user and stores it here. It *is* the credential — there is no session to
// exchange it for — so rotating it is done at the backend (switch off, switch on),
// which is what invalidates every copy of it at once.
//
// The machine running the backend needs none of this: it is trusted for being
// local. Only devices coming in over a tunnel ever hold a code.
//
// Keyed *per backend URL*: the same browser may talk to localhost at home and to
// a tunnel URL from elsewhere, and a code that belongs to one must never be sent
// to the other — nor be clobbered by it.
function codeKey(url: string): string {
  return `oasis:code:${normalize(url)}`;
}

export function getAccessCode(url: string = getBackendUrl()): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(codeKey(url)) ?? "";
}

export function storeAccessCode(code: string, url: string = getBackendUrl()): void {
  if (typeof window === "undefined") return;
  const clean = code.trim();
  if (clean) window.localStorage.setItem(codeKey(url), clean);
  else window.localStorage.removeItem(codeKey(url));
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
