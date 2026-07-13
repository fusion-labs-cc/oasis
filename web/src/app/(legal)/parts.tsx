/**
 * Shared building blocks for the public legal pages (/terms, /privacy,
 * /licenses). Server components — these pages are static and ship no JS.
 */

// Bump this whenever the substance of any legal page changes.
export const LAST_UPDATED = "2026 年 7 月 14 日";

export const REPO_URL = "https://github.com/fusion-labs-cc/oasis";

export function PageTitle({ title, lede }: { title: string; lede: string }) {
  return (
    <header className="mb-12">
      <h1 className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
        {title}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-text-secondary">{lede}</p>
      <p className="mt-4 text-[11px] text-text-tertiary">最後更新：{LAST_UPDATED}</p>
    </header>
  );
}

export function Section({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <h2 className="mb-3 flex items-baseline gap-3 text-sm font-bold text-text-primary">
        <span className="font-mono text-xs text-accent">
          {String(n).padStart(2, "0")}
        </span>
        {title}
      </h2>
      <div className="space-y-3 border-l border-border-hairline pl-6 text-sm leading-relaxed text-text-secondary">
        {children}
      </div>
    </section>
  );
}

/** A bulleted list with the project's hairline-and-accent styling. */
export function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5">
          <span aria-hidden className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-accent/60" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** A callout for the one sentence on a page that actually matters. */
export function Highlight({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-accent/20 bg-accent/[0.06] px-4 py-3 text-sm leading-relaxed text-text-primary">
      {children}
    </p>
  );
}

export function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-text-primary underline decoration-border-hairline underline-offset-4 transition hover:text-accent hover:decoration-accent/50"
    >
      {children}
    </a>
  );
}

/** Fixed-width term used inline for paths, keys and URLs. */
export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-surface-highest px-1.5 py-0.5 font-mono text-[12px] text-text-primary">
      {children}
    </code>
  );
}
