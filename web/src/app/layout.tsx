import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import SiteChrome from "@/components/SiteChrome";
import "./globals.css";

// This UI is predominantly Chinese (CJK), which the Latin-subset Geist webfonts
// don't cover — the browser renders CJK with system fallbacks. So on first paint
// almost no visible text actually uses these Latin woff2 files, and Next.js's
// automatic <link rel="preload"> gets flagged "preloaded but not used". Skipping
// the preload drops those links; the fonts are still fetched lazily when CSS
// references them (e.g. the OASIS wordmark and font-mono bits behind the gate).
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  preload: false,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
});

export const metadata: Metadata = {
  title: "OASIS",
  description: "歡迎來到綠洲 — 唯一的極限，是你的想像力。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // The anti-flash <head> script below adds `oasis-authed` to <html>
      // before React hydrates, so the server/client className intentionally
      // differ on first paint. Suppress the resulting hydration warning.
      suppressHydrationWarning
    >
      <head>
        {/* Anti-flash: before first paint, mark authorized visitors so CSS can
            hide the entrance gate immediately (React releases this once it has
            hydrated and taken control of the gate). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('oasis:authorized')==='1')document.documentElement.classList.add('oasis-authed')}catch(e){}",
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <SiteChrome>{children}</SiteChrome>
      </body>
    </html>
  );
}

