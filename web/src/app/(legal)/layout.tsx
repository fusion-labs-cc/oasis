import type { Metadata } from "next";
import Link from "next/link";

// These pages exist to be *reachable* (the GPL notices in particular), not to be
// found in search. Keeping them out of the index preserves the gate's premise
// that the site gives nothing away to a passer-by.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const LINKS = [
  { href: "/terms", label: "使用條款" },
  { href: "/privacy", label: "隱私權" },
  { href: "/licenses", label: "授權與致謝" },
];

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-14 sm:py-20">
        <Link
          href="/"
          className="mb-14 self-start font-mono text-base font-black tracking-[0.25em] text-text-tertiary transition hover:text-accent"
        >
          OASIS
        </Link>

        <main className="flex-1">{children}</main>

        <footer className="mt-20 border-t border-border-hairline pt-6">
          <nav className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] text-text-tertiary">
            {LINKS.map((l, i) => (
              <span key={l.href} className="flex items-center gap-3">
                {i > 0 && <span aria-hidden className="text-border-hairline">·</span>}
                <Link href={l.href} className="transition hover:text-accent">
                  {l.label}
                </Link>
              </span>
            ))}
            <span aria-hidden className="text-border-hairline">·</span>
            <a
              href="https://forms.gle/q4WhDeBxHkQu7TB8A"
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-accent"
            >
              問題回饋
            </a>
            <span aria-hidden className="text-border-hairline">·</span>
            <Link href="/" className="transition hover:text-accent">
              返回入口
            </Link>
          </nav>
        </footer>
      </div>
    </div>
  );
}
