/** Section/page kicker — small-caps accent label used above a heading. */
export function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-xs font-semibold uppercase tracking-[0.2em] text-accent ${className}`}>{children}</p>;
}
