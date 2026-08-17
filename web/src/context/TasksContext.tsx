"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { checkAnalyzeStatus, checkDownloadStatus, VideoRecord } from "@/lib/api";
import { useBackend } from "./BackendContext";
import { useVideos } from "./VideoContext";

export interface AnalysisTask {
  id: string;
  url: string;
  status: "analyzing" | "success" | "error" | "canceling" | "downloading";
  error?: string;
  code?: string;
  title?: string;
  actress?: string;
  download: boolean;
  videoId?: number;
  seriesId?: number;
  // Whole-percent download progress (0–100) while status === "downloading".
  progress?: number;
  // True while the download is waiting its turn in the backend's serial queue.
  queued?: boolean;
  // Set on the summary row of a listing analysis (an anime season): how many
  // episodes it produced. The episodes themselves are separate tasks.
  episodeCount?: number;
}

interface TasksContextType {
  tasks: AnalysisTask[];
  setTasks: React.Dispatch<React.SetStateAction<AnalysisTask[]>>;
  // Settle a finished analysis task from the ids it produced.
  applyAnalysisResult: (taskId: string, ids: number[]) => Promise<void>;
  // Push a direct download (from a card / detail page) into the progress list.
  addDownloadTask: (video: VideoRecord) => void;
  // Flag the download task for this video as canceled (from a card / detail page).
  markDownloadCanceled: (videoId: number) => void;
  // Flag all download tasks for a series as canceled.
  markSeriesDownloadsCanceled: (seriesId: number) => void;
}

const TasksContext = createContext<TasksContextType | undefined>(undefined);

export function TasksProvider({ children }: { children: React.ReactNode }) {
  const { status } = useBackend();
  const { syncVideo } = useVideos();

  const [tasks, setTasks] = useState<AnalysisTask[]>([]);
  const isLoaded = useRef(false);

  // Load persisted tasks on mount.
  useEffect(() => {
    const saved = localStorage.getItem("oasis:tasks");
    if (saved) {
      try {
        setTasks(JSON.parse(saved) as AnalysisTask[]);
      } catch (e) {
        console.error(e);
      }
    }
    isLoaded.current = true;
  }, []);

  // Persist tasks whenever they change (after the initial load).
  useEffect(() => {
    if (isLoaded.current) {
      localStorage.setItem("oasis:tasks", JSON.stringify(tasks));
    }
  }, [tasks]);

  // Settle a finished analysis. One URL can produce many records — a listing
  // page (an anime season) analyses into one per episode — so this is shared by
  // the submit handler and the poller rather than written twice; whichever
  // reaches the task first wins, and the other skips it as no longer analyzing.
  const applyAnalysisResult = useCallback(
    async (taskId: string, ids: number[]) => {
      const records = await Promise.all(ids.map((id) => syncVideo(id)));
      setTasks((prev) => {
        const task = prev.find((t) => t.id === taskId);
        if (!task) return prev;

        if (records.length <= 1) {
          const record = records[0];
          return prev.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  status: t.download ? "downloading" : "success",
                  code: record?.code,
                  title: record?.title_zh_tw || record?.title,
                  actress: record?.actress || undefined,
                  videoId: ids[0],
                  seriesId: record?.series_id ?? undefined,
                }
              : t
          );
        }

        // Many episodes: the pasted task becomes a summary row and each episode
        // gets its own, so the per-video progress and cancel machinery that
        // already exists works on them unchanged.
        const first = records[0];
        const sId = first?.series_id ?? undefined;
        const summary: AnalysisTask = {
          ...task,
          status: "success",
          episodeCount: records.length,
          title: first?.title_zh_tw || first?.title,
          seriesId: sId,
          videoId: undefined,
          progress: undefined,
          queued: undefined,
        };
        const episodes: AnalysisTask[] = task.download
          ? records.flatMap((record) =>
              record?.id == null
                ? []
                : [
                    {
                      // Deterministic id so re-applying the same result replaces
                      // these rows instead of stacking duplicates.
                      id: `dl-${record.id}-${taskId}`,
                      url: record.url,
                      status: "downloading" as const,
                      code: record.code,
                      title: record.title_zh_tw || record.title,
                      actress: record.actress || undefined,
                      download: true,
                      videoId: record.id,
                      seriesId: record.series_id ?? undefined,
                    },
                  ]
            )
          : [];
        const episodeIds = new Set(episodes.map((t) => t.id));
        return [
          ...episodes,
          ...prev
            .map((t) => (t.id === taskId ? summary : t))
            .filter((t) => !episodeIds.has(t.id)),
        ];
      });
    },
    [syncVideo]
  );

  // Poll active analyzing, canceling, or downloading tasks in the background.
  useEffect(() => {
    if (status !== "up") return;
    const activeTasks = tasks.filter(
      (t) =>
        t.status === "analyzing" ||
        t.status === "canceling" ||
        t.status === "downloading"
    );
    if (activeTasks.length === 0) return;

    let active = true;
    const interval = setInterval(async () => {
      for (const task of activeTasks) {
        try {
          if (task.status === "downloading") {
            if (typeof task.videoId === "number") {
              const res = await checkDownloadStatus(task.videoId);
              if (!active) return;

              if (res.status === "completed") {
                setTasks((prev) =>
                  prev.map((t) =>
                    t.id === task.id
                      ? { ...t, status: "success", progress: 100, queued: false }
                      : t
                  )
                );
                syncVideo(task.videoId);
              } else if (res.status === "idle") {
                setTasks((prev) =>
                  prev.map((t) =>
                    t.id === task.id
                      ? { ...t, status: "error", error: "下載已取消或失敗" }
                      : t
                  )
                );
              } else {
                // "downloading" or "queued": surface progress / waiting state.
                setTasks((prev) =>
                  prev.map((t) =>
                    t.id === task.id
                      ? {
                          ...t,
                          queued: res.status === "queued",
                          progress:
                            typeof res.progress === "number"
                              ? res.progress
                              : t.progress,
                        }
                      : t
                  )
                );
              }
            }
            continue;
          }

          const res = await checkAnalyzeStatus(task.id);
          if (!active) return;

          if (res.status === "success" && res.id != null) {
            // Status is just a completion signal + ids; fetch the records now.
            await applyAnalysisResult(task.id, res.ids?.length ? res.ids : [res.id]);
            if (!active) return;
          } else if (res.status === "error") {
            setTasks((prev) =>
              prev.map((t) =>
                t.id === task.id
                  ? { ...t, status: "error", error: res.error || "分析失敗" }
                  : t
              )
            );
          } else if (res.status === "not_found") {
            setTasks((prev) =>
              prev.map((t) =>
                t.id === task.id
                  ? { ...t, status: "error", error: "任務不存在或已被取消" }
                  : t
              )
            );
          }
        } catch (e) {
          console.error("Error polling task status:", e);
        }
      }
    }, 2000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [tasks, status, syncVideo, applyAnalysisResult]);

  const addDownloadTask = useCallback((video: VideoRecord) => {
    if (video.id == null) return;
    const task: AnalysisTask = {
      id: `dl-${video.id}-${Date.now()}`,
      url: video.url,
      status: "downloading",
      code: video.code,
      title: video.title_zh_tw || video.title,
      actress: video.actress || undefined,
      download: true,
      videoId: video.id,
    };
    setTasks((prev) => {
      // Replace an existing in-flight download task for the same video rather
      // than stacking duplicates.
      const idx = prev.findIndex(
        (t) => t.videoId === video.id && t.status === "downloading"
      );
      if (idx !== -1) {
        const next = [...prev];
        next[idx] = task;
        return next;
      }
      return [task, ...prev];
    });
  }, []);

  const markDownloadCanceled = useCallback((videoId: number) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.videoId === videoId && t.status === "downloading"
          ? { ...t, status: "error", error: "下載已取消" }
          : t
      )
    );
  }, []);

  const markSeriesDownloadsCanceled = useCallback((seriesId: number) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.seriesId === seriesId && (t.status === "downloading" || t.status === "analyzing" || t.status === "canceling")
          ? { ...t, status: "error", error: "下載已取消" }
          : t
      )
    );
  }, []);

  return (
    <TasksContext.Provider
      value={{
        tasks,
        setTasks,
        applyAnalysisResult,
        addDownloadTask,
        markDownloadCanceled,
        markSeriesDownloadsCanceled,
      }}
    >
      {children}
    </TasksContext.Provider>
  );

}

export function useTasks() {
  const context = useContext(TasksContext);
  if (context === undefined) {
    throw new Error("useTasks must be used within a TasksProvider");
  }
  return context;
}
