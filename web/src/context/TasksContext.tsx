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
  // Whole-percent download progress (0–100) while status === "downloading".
  progress?: number;
  // True while the download is waiting its turn in the backend's serial queue.
  queued?: boolean;
}

interface TasksContextType {
  tasks: AnalysisTask[];
  setTasks: React.Dispatch<React.SetStateAction<AnalysisTask[]>>;
  // Push a direct download (from a card / detail page) into the progress list.
  addDownloadTask: (video: VideoRecord) => void;
  // Flag the download task for this video as canceled (from a card / detail page).
  markDownloadCanceled: (videoId: number) => void;
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
            // Status is just a completion signal + id; fetch the full record now.
            const record = await syncVideo(res.id);
            if (!active) return;
            setTasks((prev) =>
              prev.map((t) =>
                t.id === task.id
                  ? {
                      ...t,
                      status: t.download ? "downloading" : "success",
                      code: record?.code,
                      title: record?.title_zh_tw || record?.title,
                      actress: record?.actress || undefined,
                      videoId: res.id,
                    }
                  : t
              )
            );
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
  }, [tasks, status, syncVideo]);

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

  return (
    <TasksContext.Provider
      value={{ tasks, setTasks, addDownloadTask, markDownloadCanceled }}
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
