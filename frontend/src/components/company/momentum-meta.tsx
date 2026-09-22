import type { CompanyWithEvents } from "@/lib/data/types";
import { computeMomentum, latestMemberTimestamp, type MomentumBand } from "@/lib/derive/momentum";
import { hourGranularRecencyLabel } from "@/lib/derive/recency";

const BAND_META: Record<MomentumBand, { label: string; dot: string; text: string }> = {
  high: { label: "High Momentum", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
  medium: { label: "Medium Momentum", dot: "bg-sky-500", text: "text-sky-700 dark:text-sky-300" },
  low: { label: "Low Momentum", dot: "bg-ink-faint", text: "text-ink-faint" },
};

const TOOLTIP_TEXT =
  "Momentum reflects how recent a company’s activity is, how well it is corroborated across sources, and how many different types of signals have appeared recently.";

/** Compact Momentum metadata line for a company card/row — e.g. "High Momentum · 6 sources · 2
 * signal types · latest 3h ago" — plus a small, zero-JS info affordance explaining the concept.
 * Deliberately restrained: no score, no gauge, no meter (see src/lib/derive/momentum.ts). Renders
 * nothing for a company with no events at all (nothing to compute momentum from). */
export function MomentumMeta({ company, now = new Date() }: { company: CompanyWithEvents; now?: Date }) {
  const momentum = computeMomentum(company, now);
  if (!momentum.latestGroup) return null;

  const meta = BAND_META[momentum.band];
  const sourcesLabel = momentum.sourceCount === 1 ? "1 source" : `${momentum.sourceCount} sources`;
  const typesLabel = momentum.signalTypeCount === 1 ? "1 signal type" : `${momentum.signalTypeCount} signal types`;
  // The same MAX-across-members timestamp Recency itself is scored from (src/lib/derive/momentum.ts)
  // — keeps this label consistent with the score even when the group's displayed `primary` source
  // (chosen by confidence) isn't the group's most recently-dated member.
  const latestLabel = hourGranularRecencyLabel(latestMemberTimestamp(momentum.latestGroup), now);

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className={`inline-flex items-center gap-1.5 font-medium ${meta.text}`}>
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
        {meta.label}
      </span>
      <span className="text-ink-faint">
        {sourcesLabel} · {typesLabel} · latest {latestLabel}
      </span>
      <MomentumInfo />
    </div>
  );
}

/** A small "i" affordance with a CSS-only tooltip (no client component / JS needed — shown on
 * hover via `:hover` and on keyboard focus via `:focus-within`, so it works for mouse, touch-hold
 * and keyboard users alike) plus a native `title` as a redundant fallback. */
function MomentumInfo() {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="What is Momentum?"
        title={TOOLTIP_TEXT}
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[10px] leading-none text-ink-faint ring-1 ring-inset ring-line hover:text-ink-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 w-56 -translate-x-1/2 rounded-md bg-ink px-2.5 py-1.5 text-[11px] leading-snug text-canvas opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100 dark:bg-canvas dark:text-ink dark:ring-1 dark:ring-line"
      >
        {TOOLTIP_TEXT}
      </span>
    </span>
  );
}
