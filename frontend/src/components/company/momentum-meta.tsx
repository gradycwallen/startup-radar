import type { CompanyWithEvents } from "@/lib/data/types";
import { computeMomentum, type MomentumBand } from "@/lib/derive/momentum";
import { hourGranularRecencyLabel } from "@/lib/derive/recency";

// Bars, not a color — Confidence (src/components/company/confidence-badge.tsx) already owns the
// emerald/sky/faint dot language for evidence QUALITY. Momentum is a different axis (activity
// LEVEL), so it gets a different shape entirely rather than reusing those hues for something else;
// otherwise two unrelated metrics look like the same signal repeated. Filled-bar count carries the
// level; only High picks up the accent, so the busiest companies stand out in a scan.
const BAND_META: Record<MomentumBand, { label: string; text: string; bar: string; filledBars: 1 | 2 | 3 }> = {
  high: { label: "High Momentum", text: "text-accent", bar: "bg-accent", filledBars: 3 },
  medium: { label: "Medium Momentum", text: "text-ink-muted", bar: "bg-ink-muted", filledBars: 2 },
  low: { label: "Low Momentum", text: "text-ink-faint", bar: "bg-ink-faint", filledBars: 1 },
};

function MomentumBars({ filled, bar: barColor }: { filled: 1 | 2 | 3; bar: string }) {
  return (
    <span aria-hidden className="flex shrink-0 items-end gap-[1.5px]">
      {([1, 2, 3] as const).map((bar) => (
        <span
          key={bar}
          className={`w-[3px] rounded-[1px] ${bar <= filled ? barColor : "bg-line-strong"}`}
          style={{ height: 3 + bar * 2 }}
        />
      ))}
    </span>
  );
}

/** Compact Momentum metadata line for a company card/row — e.g. "High Momentum · 3 signals ·
 * latest 3h ago".
 * Deliberately restrained: no score, no gauge, no meter (see src/lib/derive/momentum.ts). Renders
 * nothing for a company with no events at all (nothing to compute momentum from). */
export function MomentumMeta({ company, now = new Date() }: { company: CompanyWithEvents; now?: Date }) {
  const momentum = computeMomentum(company, now);
  if (momentum.latestAt === null) return null;

  const meta = BAND_META[momentum.band];
  const signalsLabel = momentum.signalCount === 1 ? "1 signal" : `${momentum.signalCount} signals`;
  const latestLabel = hourGranularRecencyLabel(momentum.latestAt, now);

  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
      <span className={`inline-flex items-center gap-1.5 font-medium ${meta.text}`}>
        <MomentumBars filled={meta.filledBars} bar={meta.bar} />
        {meta.label}
      </span>
      <span className="text-ink-faint">
        {signalsLabel} · latest {latestLabel}
      </span>
    </div>
  );
}
