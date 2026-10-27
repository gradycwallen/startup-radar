/** A quiet, text-first family label ("Hiring"/"GitHub"/"Website") — deliberately NOT a pill (root
 * CLAUDE.md's V2-3A design report §8/§16: family is secondary metadata on a signal card, not the
 * primary marker). Plain small-caps text carries "this is a tag" without a ring/background — no
 * per-family color, see the design report for why a 4th color axis was deliberately avoided. */
export function FamilyBadge({ label }: { label: string }) {
  return <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-faint">{label}</span>;
}
