import { confidenceInfo } from "@/lib/derive/confidence";

// Dot + text, not a soft-tint ring-inset pill — matches the taxonomy language MomentumMeta already
// established (src/components/company/momentum-meta.tsx). A colored dot carries the tier; the pill
// shape carried nothing tier-specific and was purely decorative.
const TIER_TEXT = {
  strong: "text-emerald-700 dark:text-emerald-300",
  moderate: "text-sky-700 dark:text-sky-300",
  emerging: "text-ink-faint",
} as const;

const TIER_DOT = {
  strong: "bg-emerald-500",
  moderate: "bg-sky-500",
  emerging: "bg-ink-faint",
} as const;

export function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  const info = confidenceInfo(confidence);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${TIER_TEXT[info.tier]}`}>
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${TIER_DOT[info.tier]}`} />
      {info.percent !== null ? <span className="tabular">{info.percent}%</span> : null}
      {info.label}
    </span>
  );
}
