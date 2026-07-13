// Shared types + client helpers. The browser calls the user's local FastAPI
// backend directly (see getBackendUrl); there is no server-side proxy.

import { getBackendUrl } from "./backend";

export interface VideoRecord {
  id?: number;
  code: string;
  url: string;
  title: string;
  title_zh_tw?: string | null;
  actress?: string | null;
  tags: string[];
  cover?: string | null;
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
const CLIENT_HEADER: Record<string, string> = { "X-Oasis-Client": "1" };

// fetch() against the local backend with the client header always attached.
export function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(backendUrl(path), {
    ...init,
    headers: { ...CLIENT_HEADER, ...(init.headers ?? {}) },
  });
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

// Ping the backend; true when reachable and healthy.
export async function checkHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await backendFetch("/api/health", {
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
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
