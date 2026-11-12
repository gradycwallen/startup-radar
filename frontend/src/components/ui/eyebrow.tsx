/** Section/page kicker — small mono uppercase label above a heading, matching gradyallen.com's
 * label/date/tag treatment (JetBrains Mono, small, uppercase, letter-spaced). */
export function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`font-mono text-xs font-medium uppercase tracking-[0.2em] text-ink-faint ${className}`}>{children}</p>;
}
