import { eventTypeMeta } from "@/lib/derive/event-type";

/** Plain small-caps text, not a pill — matches the same reasoning `categoryLabelClasses` already
 * documents (src/lib/derive/category-color.ts): typography carries "this is a tag," not a
 * background chip. Kept visually distinct from the category label only by weight/color, since
 * position in the card already disambiguates the two. */
export function SignalBadge({ eventType, short = false }: { eventType: string; short?: boolean }) {
  const meta = eventTypeMeta(eventType);
  return <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink">{short ? meta.short : meta.label}</span>;
}
