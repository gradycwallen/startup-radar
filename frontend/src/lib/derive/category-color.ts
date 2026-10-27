/** Category is shown as a plain small-caps text label, not a colored chip — a hashed rainbow
 * palette (one of N hues assigned by string hash) is the classic "auto-generated tag color" tell,
 * and there's no real per-category meaning to justify color here. Typography (case + tracking +
 * weight) carries the "this is a tag" signal instead of a background/ring. */
export function categoryLabelClasses(): string {
  return "font-mono text-[11px] uppercase tracking-[0.06em] text-ink-faint";
}
