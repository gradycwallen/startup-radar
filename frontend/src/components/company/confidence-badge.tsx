import { Badge } from "@/components/ui/badge";
import { confidenceInfo } from "@/lib/derive/confidence";

const TIER_CLASSES = {
  strong: "bg-emerald-50 text-emerald-800 ring-emerald-600/15 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  moderate: "bg-sky-50 text-sky-800 ring-sky-600/15 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/20",
  emerging: "bg-zinc-100 text-zinc-600 ring-zinc-600/10 dark:bg-white/5 dark:text-ink-faint dark:ring-white/10",
} as const;

export function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  const info = confidenceInfo(confidence);
  return (
    <Badge className={TIER_CLASSES[info.tier]}>
      {info.percent !== null ? <span className="tabular">{info.percent}%</span> : null}
      {info.label}
    </Badge>
  );
}
