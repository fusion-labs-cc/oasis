// The brand mark: the "O" of OASIS rendered as an emerald ring wrapped around a
// play triangle — the letter as a lens, the triangle saying "watch". Kept
// geometric and single-colour-family so it survives shrinking to a 16px favicon
// (see app/icon.svg, which mirrors this same artwork).

type OasisLogoProps = {
  className?: string;
  /** Unique gradient ids so multiple instances on one page don't collide. */
  idPrefix?: string;
};

export default function OasisLogo({
  className,
  idPrefix = "oasis-logo",
}: OasisLogoProps) {
  const ring = `${idPrefix}-ring`;
  const play = `${idPrefix}-play`;

  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="OASIS"
      className={className}
    >
      <defs>
        <linearGradient id={ring} x1="4" y1="4" x2="28" y2="28">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
        <linearGradient id={play} x1="13" y1="11" x2="22" y2="21">
          <stop offset="0%" stopColor="#6ee7b7" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
      </defs>

      {/* The "O" */}
      <circle cx="16" cy="16" r="12.5" stroke={`url(#${ring})`} strokeWidth="3" />

      {/* The play triangle nested inside it (optically nudged right of centre) */}
      <path
        d="M13.4 10.8 L22 16 L13.4 21.2 Z"
        fill={`url(#${play})`}
        stroke={`url(#${play})`}
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
