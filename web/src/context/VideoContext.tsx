"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { fetchVideos, fetchVideo, checkDownloadStatus, VideoRecord } from "@/lib/api";
import { useBackend } from "./BackendContext";

interface VideoContextType {
  videos: VideoRecord[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
  // Force a full catalog refetch (initial load / manual retry).
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
  // Fetch a single record and merge it into the store; returns it, or null on failure.
  syncVideo: (id: number) => Promise<VideoRecord | null>;
  // Replace by id, or prepend when new.
  upsertVideo: (v: VideoRecord) => void;
  // Shallow-merge a patch onto the matching record (optimistic updates).
  updateVideo: (id: number, patch: Partial<VideoRecord>) => void;
  removeVideo: (id: number) => void;
  getVideo: (id: number) => VideoRecord | undefined;
}

const VideoContext = createContext<VideoContextType | undefined>(undefined);

export function VideoProvider({ children }: { children: React.ReactNode }) {
  const { status } = useBackend();

  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Mirror of `videos` for the download watcher's interval to read without
  // re-subscribing on every list change.
  const videosRef = useRef<VideoRecord[]>([]);
  useEffect(() => {
    videosRef.current = videos;
  }, [videos]);

  const upsertVideo = useCallback((v: VideoRecord) => {
    setVideos((prev) => {
      const idx = prev.findIndex((x) => x.id === v.id);
      if (idx === -1) return [v, ...prev];
      const next = [...prev];
      next[idx] = v;
      return next;
    });
  }, []);

  const updateVideo = useCallback((id: number, patch: Partial<VideoRecord>) => {
    setVideos((prev) =>
      prev.map((v) => (v.id === id ? { ...v, ...patch } : v)),
    );
  }, []);

  const removeVideo = useCallback((id: number) => {
    setVideos((prev) => prev.filter((v) => v.id !== id));
  }, []);

  const getVideo = useCallback(
    (id: number) => videosRef.current.find((v) => v.id === id),
    [],
  );

  const syncVideo = useCallback(
    async (id: number): Promise<VideoRecord | null> => {
      try {
        const v = await fetchVideo(id);
        upsertVideo(v);
        return v;
      } catch {
        return null;
      }
    },
    [upsertVideo],
  );

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) {
        setLoading(true);
        // Clear any stale error up front (e.g. the "本機伺服器未連線" set while
        // the gate was showing) so it doesn't flash through during the reveal.
        setError(null);
      }
      try {
        const data = await fetchVideos();
        setVideos(data);
        setError(null);
        setLoaded(true);
      } catch (e) {
        if (!opts?.silent) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [],
  );

  // Initial load: fetch the whole catalog once the backend is reachable.
  useEffect(() => {
    if (status === "up") {
      // Reconnected/authorized: drop any stale "down" error, even when the
      // catalog is already loaded (a transient health-check drop won't refetch).
      setError(null);
      if (!loaded) refresh();
    } else if (status === "down") {
      setError("本機伺服器未連線");
      setLoading(false);
    }
  }, [status, loaded, refresh]);

  // Watch downloading videos with the lightweight per-video status endpoint;
  // pull a fresh single record once each one settles. This replaces the old
  // 4s full-catalog polling on the home and detail pages.
  const anyDownloading = videos.some((v) => v.is_downloading);
  useEffect(() => {
    if (!anyDownloading || status !== "up") return;
    let active = true;
    const timer = setInterval(async () => {
      const ids = videosRef.current
        .filter((v) => v.is_downloading && v.id != null)
        .map((v) => v.id as number);
      for (const id of ids) {
        try {
          const res = await checkDownloadStatus(id);
          if (!active) return;
          // "completed" → the file has landed; "idle" → canceled/failed. Either
          // way a single fetch reconciles is_downloading / video_path.
          if (res.status === "completed" || res.status === "idle") {
            await syncVideo(id);
          } else {
            // Still "downloading" / "queued": push the live percent + queue state
            // onto the record so cards and the detail page update in place. Keep
            // the last-known percent when the backend hasn't reported one yet
            // (null) so this matches the progress list exactly instead of
            // blanking the number — the two must not diverge.
            const patch: Partial<VideoRecord> = {
              is_downloading: true,
              download_queued: res.status === "queued",
            };
            if (typeof res.progress === "number") {
              patch.download_progress = res.progress;
            }
            updateVideo(id, patch);
          }
        } catch {
          // Transient error; try again on the next tick.
        }
      }
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [anyDownloading, status, syncVideo, updateVideo]);

  return (
    <VideoContext.Provider
      value={{
        videos,
        loading,
        error,
        loaded,
        refresh,
        syncVideo,
        upsertVideo,
        updateVideo,
        removeVideo,
        getVideo,
      }}
    >
      {children}
    </VideoContext.Provider>
  );
}

export function useVideos() {
  const context = useContext(VideoContext);
  if (context === undefined) {
    throw new Error("useVideos must be used within a VideoProvider");
  }
  return context;
}
