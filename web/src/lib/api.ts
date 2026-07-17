// Shared types + client helpers. The browser calls the user's local FastAPI
// backend directly (see getBackendUrl); there is no server-side proxy.

import { getAccessCode, getBackendUrl } from "./backend";

export interface VideoRecord {
  id?: number;
  code: string;
  url: string;
  title: string;
  title_zh_tw?: string | null;
  actress?: string | null;
  tags: string[];
  // `cover` is the origin image URL (kept for editing/re-fetching). `has_cover`
  // is true once the backend has cached the actual image bytes — prefer
  // coverUrl(), which serves those from the local backend.
  cover?: string | null;
  has_cover?: boolean;
  video_path?: string | null;
  created_at?: string;
  is_downloading?: boolean;
  play_count?: number;
  file_size?: number | null;
  local_file_exists?: boolean;
  // True while the download is waiting its turn in the backend's serial queue.
  download_queued?: boolean;
  // Whole-percent download progress (0–100); null when queued or not downloading.
  download_progress?: number | null;
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data.detail || data.error || `請求失敗 (${res.status})`;
  } catch {
    return `請求失敗 (${res.status})`;
  }
}

// Build an absolute URL against the user's local backend.
export function backendUrl(path: string): string {
  return `${getBackendUrl()}${path}`;
}

// Every call to the local backend carries this header. The backend rejects any
// /api/* request that lacks it (except <video>/<img>-loaded media). Because a
// custom header makes a cross-origin request non-"simple", the browser forces a
// CORS preflight the backend only answers for its allowed origins — so an
// arbitrary website the user visits can neither send this header nor forge a
// header-less request that the backend would accept. That closes the CSRF hole
// on side-effecting endpoints (e.g. open-in-player) without any user setup.
const CLIENT_HEADER: Record<string, string> = {
  "X-Oasis-Client": "1",
  "ngrok-skip-browser-warning": "true",
};

// fetch() against the local backend with the client header and, if this device
// holds one, the access code always attached. The header above is only a CSRF
// guard — it is public and fixed, so it proves nothing about *who* is calling and
// is worthless against anything that isn't a browser (a plain `curl` ignores CORS
// entirely). The bearer code is the actual authentication, and it is what makes
// it safe to put the backend behind a tunnel so a phone can reach it. On the
// machine running the backend there is no code and none is needed: it is trusted
// for being local.
export function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const code = getAccessCode();
  return fetch(backendUrl(path), {
    ...init,
    headers: {
      ...CLIENT_HEADER,
      ...(code ? { Authorization: `Bearer ${code}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

// <video src> can send neither a header nor a cookie, so streaming carries the
// code in the query string instead (the backend accepts it on /api/stream only).
export function streamUrl(videoId: number): string {
  const code = getAccessCode();
  const query = code ? `?token=${encodeURIComponent(code)}` : "";
  return backendUrl(`/api/stream/${videoId}${query}`);
}

// The URL to display a video's cover in an <img>/poster. Prefer the backend's
// cached copy (served locally, survives a dead origin, and — like streaming —
// carries the code as ?token= since <img> can send no header); the endpoint
// lazily fetches + caches the origin bytes on first view. Falls back to the raw
// origin URL only when there is no id to address it by, and null when there is
// no cover at all.
export function coverUrl(video: VideoRecord): string | null {
  if (video.id != null && (video.has_cover || video.cover)) {
    const code = getAccessCode();
    const query = code ? `?token=${encodeURIComponent(code)}` : "";
    return backendUrl(`/api/stream/cover/${video.id}${query}`);
  }
  return video.cover || null;
}

// Allow only http(s) URLs into an anchor href. A video's `url` is user/scrape
// supplied, so a stored `javascript:`/`data:` value would run in our origin the
// moment it is clicked; anything that isn't a plain web link collapses to
// undefined and renders as an inert anchor.
export function safeExternalHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const protocol = new URL(url).protocol;
    if (protocol === "http:" || protocol === "https:") return url;
  } catch {
    // Not an absolute URL — treat as unsafe.
  }
  return undefined;
}

// Max time to wait for a health check before treating the backend as down.
// Keeps an unreachable (silently dropped) host from hanging the "connecting"
// state indefinitely.
export const HEALTH_TIMEOUT_MS = 3000;

export interface HealthResult {
  // Backend reachable at all.
  ok: boolean;
  // Remote access is on, so this backend accepts other devices (with the code).
  // False = local-only: it refuses every non-local caller outright.
  codeSet: boolean;
  // We may use the API right now — either we hold the right code, or we are on
  // the backend's own machine and need none.
  authenticated: boolean;
  // This browser is on the backend's own machine, so it may flip the remote-access
  // switch. False for a phone coming in over a tunnel.
  local: boolean;
}

// Ping the backend, and learn where we stand with it.
export async function checkHealth(signal?: AbortSignal): Promise<HealthResult> {
  try {
    const res = await backendFetch("/api/health", {
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, codeSet: false, authenticated: false, local: false };
    const data = await res.json().catch(() => ({}));
    return {
      ok: true,
      // A backend older than access codes answers without these fields. Absent
      // `authenticated` must read as "no auth needed", or this frontend (which
      // deploys independently of the backend a user has installed) would lock
      // every un-updated install out of its own catalog.
      authenticated: data.authenticated !== false,
      codeSet: data.code_set === true,
      local: data.local === true,
    };
  } catch {
    return { ok: false, codeSet: false, authenticated: false, local: false };
  }
}

// Check an access code with the backend before storing it. The code itself stays
// the credential — this only confirms it is the right one (and is the call whose
// failures the backend throttles), returning it in canonical form.
export async function login(code: string): Promise<string> {
  const res = await backendFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return data.token as string;
}

// Turn remote access on (local machine only). The backend mints a fresh code and
// prints it to *its own console* — it is never returned here, so the code cannot
// leak from this page. Always a new code, so this doubles as "rotate".
export async function enableRemoteAccess(): Promise<void> {
  const res = await backendFetch("/api/auth/remote", { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
}

// Turn remote access off (local machine only): the code is deleted, every device
// holding it is cut off, and non-local callers are refused outright again.
export async function disableRemoteAccess(): Promise<void> {
  const res = await backendFetch("/api/auth/remote", { method: "DELETE" });
  if (!res.ok) throw new Error(await parseError(res));
}

// Ask the backend to print the current code to its console again — what a user
// who forgot it clicks. The answer arrives on the console, not in this response.
export async function revealAccessCode(): Promise<void> {
  const res = await backendFetch("/api/auth/reveal", { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
}

export interface UpdateInfo {
  // This build's version ("dev" for an un-stamped source checkout).
  current: string;
  // Latest published release tag, or null when the check couldn't reach GitHub.
  latest: string | null;
  update_available: boolean;
  // GitHub Releases page to open.
  release_url: string;
  // Direct download for this OS's asset, or null if unavailable.
  download_url: string | null;
  // Present when the check failed (network/API); the rest degrades gracefully.
  error?: string;
}

// Ask the local backend to compare itself against the latest GitHub Release.
export async function checkForUpdate(signal?: AbortSignal): Promise<UpdateInfo> {
  const res = await backendFetch("/api/update/check", {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export interface ApplyUpdateResult {
  // "updating" → the backend accepted the request and is downloading the new
  // build in the background; poll fetchUpdateProgress, then checkHealth once it
  // starts installing. "error" → nothing changed (couldn't even start).
  status: "updating" | "error";
  latest?: string | null;
  error?: string;
}

// Tell the local backend to download the latest release and swap itself in.
// Only the frozen build can do this; a source checkout returns an error.
// Returns immediately; the download runs in the background — poll
// fetchUpdateProgress for the percent and phase, then checkHealth for the
// relaunched backend.
export async function applyUpdate(): Promise<ApplyUpdateResult> {
  const res = await backendFetch("/api/update/apply", { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export interface UpdateProgress {
  // idle → nothing running; downloading → streaming the zip; installing →
  // download done, the backend is about to be killed + swapped by the helper;
  // error → the download/spawn failed and the backend is still running.
  phase: "idle" | "downloading" | "installing" | "error";
  // 0..100 while downloading, or -1 when the download size is unknown.
  percent: number;
  received: number;
  total: number;
  latest: string | null;
  error?: string | null;
}

// Poll the phase/percent of the in-flight auto-update (see applyUpdate).
export async function fetchUpdateProgress(
  signal?: AbortSignal,
): Promise<UpdateProgress> {
  const res = await backendFetch("/api/update/progress", {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export interface UpdateLogFile {
  // One of updater.log / update.log / helper-output.log / backend.log.
  name: string;
  modified: string | null;
  // Tail of the file, or null when it doesn't exist (e.g. no update was run).
  text: string | null;
}

export interface UpdateLogs {
  version: string;
  platform: string;
  platform_stamp: string | null;
  frozen: boolean;
  pid: number;
  // Install folder, and the .oasis-update work folder inside it.
  base: string;
  work: string;
  progress: UpdateProgress;
  // Top-level contents of the install folder with mtimes — an old mtime on the
  // exe / _internal after an "update" means the file swap never happened.
  install_entries: { name: string; modified: string | null }[];
  files: UpdateLogFile[];
}

// Fetch the update log files + install-folder state from the backend. Used to
// explain a failed update (see the settings page), which happens across
// processes that are gone by the time the user sees the failure.
export async function fetchUpdateLogs(): Promise<UpdateLogs> {
  const res = await backendFetch("/api/update/logs", { cache: "no-store" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export interface SupportedSite {
  id: string;
  name: string;
  domain: string;
}

// Fetch the list of sites the backend's URL analyser supports.
export async function fetchSupportedSites(): Promise<SupportedSite[]> {
  const res = await backendFetch("/api/supported-sites", { cache: "no-store" });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return (data.sites ?? []) as SupportedSite[];
}

export interface AnalyzeStatusResponse {
  status: "analyzing" | "success" | "error" | "not_found";
  // On success the backend returns only the new video id; the caller fetches
  // the full record separately (see fetchVideo).
  id?: number;
  error?: string;
}

export async function checkAnalyzeStatus(taskId: string): Promise<AnalyzeStatusResponse> {
  const res = await backendFetch(`/api/analyze/${taskId}/status`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Start an analysis task and poll until it settles; resolves to the new video id.
export async function analyzeUrl(url: string, download: boolean = false, taskId?: string): Promise<number> {
  const id = taskId || Date.now().toString() + Math.random().toString(36).substring(2, 9);

  const startRes = await backendFetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, download, task_id: id }),
  });
  if (!startRes.ok) throw new Error(await parseError(startRes));

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const statusRes = await checkAnalyzeStatus(id);
    if (statusRes.status === "success" && statusRes.id != null) {
      return statusRes.id;
    } else if (statusRes.status === "error") {
      throw new Error(statusRes.error || "分析失敗");
    } else if (statusRes.status === "not_found") {
      throw new Error("任務未找到或已被取消");
    }
  }
}

export interface CreateVideoPayload {
  url: string;
  title: string;
  code?: string;
  actress?: string;
  tags?: string[];
  cover?: string;
}

// Manually add a catalog entry (no scraping); returns the created record.
// Backend auto-extracts the code from the title when `code` is omitted.
export async function createVideo(payload: CreateVideoPayload): Promise<VideoRecord> {
  const res = await backendFetch("/api/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Portable video metadata carried in an import/export file. Mirrors the
// backend's EXPORT_FIELDS: no local path, play count, pending flag or timestamps.
export interface ExportedVideo {
  code: string;
  url: string;
  title: string;
  title_zh_tw?: string | null;
  actress?: string | null;
  tags: string[];
  cover?: string | null;
}

// Reduce a full catalog record to the portable export shape (drops the local
// path, play count, download state, etc.). Used to export a client-side
// selection without a round-trip to the backend.
export function toExportedVideo(v: VideoRecord): ExportedVideo {
  return {
    code: v.code,
    url: v.url,
    title: v.title,
    title_zh_tw: v.title_zh_tw ?? null,
    actress: v.actress ?? null,
    tags: v.tags ?? [],
    cover: v.cover ?? null,
  };
}

// Fetch the whole catalog as portable JSON (metadata only), e.g. to save a backup.
export async function exportVideos(): Promise<ExportedVideo[]> {
  const res = await backendFetch("/api/export", { cache: "no-store" });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return (data.videos ?? []) as ExportedVideo[];
}

export interface ImportSummary {
  imported: number;
  skipped: number;
}

// Import videos from a previously exported list; existing codes are updated.
export async function importVideos(videos: ExportedVideo[]): Promise<ImportSummary> {
  const res = await backendFetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function cancelAnalyze(taskId: string): Promise<{ status: string, message: string }> {
  const res = await backendFetch(`/api/analyze/cancel/${taskId}`, { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function downloadVideo(id: number): Promise<{ status: string, message: string }> {
  const res = await backendFetch(`/api/download/${id}`, { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function cancelDownload(id: number): Promise<{ status: string, message: string }> {
  const res = await backendFetch(`/api/download/${id}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export interface DownloadStatusResponse {
  status: "downloading" | "queued" | "completed" | "idle";
  // Whole-percent download progress (0–100); null until the backend reports it
  // or when the download is only queued.
  progress?: number | null;
}

export async function checkDownloadStatus(id: number): Promise<DownloadStatusResponse> {
  const res = await backendFetch(`/api/download/${id}/status`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export interface Facet {
  name: string;
  count: number;
}

export interface Facets {
  actresses: Facet[];
  tags: Facet[];
}

// Fetch the whole catalog once; filtering happens client-side.
export async function fetchVideos(): Promise<VideoRecord[]> {
  const res = await backendFetch("/api/videos", { cache: "no-store" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Delete a video (its local file and/or DB record).
export async function deleteVideo(
  id: number,
  localOnly?: boolean,
): Promise<{ status: string; deleted_file: boolean }> {
  const path = `/api/videos/${id}` + (localOnly ? "?local_only=true" : "");
  const res = await backendFetch(path, { method: "DELETE" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Replace the whole tag list for a video; returns the updated record.
export async function updateVideoTags(
  id: number,
  tags: string[],
): Promise<VideoRecord> {
  const res = await backendFetch(`/api/videos/${id}/tags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Update editable metadata (code/title/url/cover); returns the updated record.
export async function updateVideoDetails(
  id: number,
  details: { code?: string; title?: string; actress?: string; url?: string; cover?: string },
): Promise<VideoRecord> {
  const res = await backendFetch(`/api/videos/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(details),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Open the local file in the OS default player (local app only).
export async function openInPlayer(
  id: number,
): Promise<{ status: string; play_count?: number }> {
  const res = await backendFetch(`/api/videos/${id}/open`, { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Log a play (called when playback starts); returns the updated count.
export async function logPlay(id: number): Promise<number> {
  const res = await backendFetch(`/api/videos/${id}/play`, { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return data.play_count as number;
}

// Fetch a single video by ID.
export async function fetchVideo(id: number): Promise<VideoRecord> {
  const res = await backendFetch(`/api/videos/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Derive actress/tag facets (with counts) from an in-memory video list.
export function computeFacets(videos: VideoRecord[]): Facets {
  const actresses = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const v of videos) {
    if (v.actress) actresses.set(v.actress, (actresses.get(v.actress) ?? 0) + 1);
    for (const t of v.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  const sortFacet = (m: Map<string, number>): Facet[] =>
    [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { actresses: sortFacet(actresses), tags: sortFacet(tags) };
}
