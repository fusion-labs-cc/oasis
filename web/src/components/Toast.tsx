"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastOptions {
  type?: ToastType;
  duration?: number;
}

const ToastContext = createContext<
  ((message: string, opts?: ToastOptions) => void) | null
>(null);

// Access the toast(message, opts) function from any client component.
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a <ToastProvider>");
  return ctx;
}

const STYLES: Record<ToastType, string> = {
  success:
    "border-accent/20 bg-surface-elevated text-accent shadow-[0_8px_30px_rgb(16,185,129,0.08)]",
  error:
    "border-red-500/20 bg-surface-elevated text-red-400 shadow-[0_8px_30px_rgb(239,68,68,0.08)]",
  info: "border-border-hairline bg-surface-elevated text-text-primary shadow-2xl",
};

const ICONS: Record<ToastType, string> = {
  success: "✓",
  error: "✕",
  info: "ℹ",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, opts?: ToastOptions) => {
      const id = Date.now() + Math.random();
      const type = opts?.type ?? "info";
      setToasts((prev) => [...prev, { id, message, type }]);
      window.setTimeout(() => dismiss(id), opts?.duration ?? 4000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="pointer-events-none fixed left-1/2 top-6 z-50 flex w-[calc(100vw-2rem)] max-w-80 -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border px-4 py-3 text-left text-sm shadow-lg transition ${STYLES[t.type]}`}
          >
            <span className="mt-px shrink-0 font-semibold">{ICONS[t.type]}</span>
            <span className="flex-1">{t.message}</span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
