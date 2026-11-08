import type { SourceMixEntry } from "@/lib/derive/insights-series";

/**
 * Horizontal ranked bars — one measure (company count) across named categories (discovery
 * sources), not multiple series, so one accent hue and no legend, same as every other chart on
 * this page. Value is a direct label at the bar's end (dataviz skill: "Bars -> value at the tip"),
 * never a tooltip-only number, since there's no continuous axis here worth hovering along.
 */
export function SourceMixChart({ entries }: { entries: SourceMixEntry[] }) {
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map((e) => e.count));

  return (
    <div className="border-t border-line py-3">
      <h4 className="text-xs font-semibold text-ink">Discovery source mix</h4>
      <div className="mt-3 space-y-2">
        {entries.map((e) => (
          <div key={e.source} className="flex items-center gap-3">
            <span className="w-36 shrink-0 truncate text-xs text-ink-muted" title={e.source}>
              {e.source}
            </span>
            <div className="h-2 flex-1 overflow-hidden bg-line/40">
              <div className="h-full bg-accent/70" style={{ width: `${Math.max((e.count / max) * 100, 3)}%` }} />
            </div>
            <span className="tabular w-8 shrink-0 text-right text-xs font-medium text-ink">{e.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
