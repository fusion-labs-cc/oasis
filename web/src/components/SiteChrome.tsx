"use client";

import { usePathname } from "next/navigation";
import { ToastProvider } from "@/components/Toast";
import { BackendProvider } from "@/context/BackendContext";
import { VideoProvider } from "@/context/VideoContext";
import { TasksProvider } from "@/context/TasksContext";
import Header from "@/components/Header";
import AwakeMode from "@/components/AwakeMode";
import OasisGate from "@/components/OasisGate";
import ScrollToTop from "@/components/ScrollToTop";

// Public pages that live outside the gate. They are linked from the gate itself,
// so they must render for a visitor who has no backend at all.
const PUBLIC_ROUTES = new Set(["/terms", "/privacy", "/licenses"]);

/**
 * SiteChrome — decides whether a route gets the application, or nothing at all.
 *
 * The legal pages render bare: no gate (they must be readable without a
 * backend), no header (it would give away what this app is), and — deliberately
 * — none of the app providers either, so a visit to /privacy makes zero requests
 * to any backend. That is a promise the privacy page makes in writing.
 */
export default function SiteChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (PUBLIC_ROUTES.has(pathname)) return <>{children}</>;

  return (
    <BackendProvider>
      <VideoProvider>
        <TasksProvider>
          <ToastProvider>
            <Header />
            {children}
            <ScrollToTop />
            <OasisGate />
            <AwakeMode />
          </ToastProvider>
        </TasksProvider>
      </VideoProvider>
    </BackendProvider>
  );
}
