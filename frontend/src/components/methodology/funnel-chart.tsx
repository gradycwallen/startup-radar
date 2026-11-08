/**
 * A single narrowing path of ordered stages — one accent hue stepped by OPACITY (not a second
 * color), monotone light-to-full across the stage order, matching the dataviz skill's ordinal-
 * ramp rule ("funnel stages, tiers -> the ordinal ramp... one hue, monotone lightness steps").
 * Every bar is directly labeled with its own stage name, description, and real count — never
 * gated behind hover, since there's no continuous axis here worth a tooltip for.
 */

export interface FunnelStage {
  label: string;
  description: string;
  count: number;
}

export function FunnelChart({ stages }: { stages: readonly FunnelStage[] }) {
  if (stages.length === 0) return null;
  const max = stages[0]!.count;
  const minOpacity = 0.3;

  return (
    <div className="space-y-4 border-t border-line pt-4">
      {stages.map((stage, i) => {
        const widthPct = Math.max((stage.count / max) * 100, 4);
        const opacity = minOpacity + (1 - minOpacity) * (i / Math.max(stages.length - 1, 1));
        const dropped = i > 0 ? stages[i - 1]!.count - stage.count : null;
        return (
          <div key={stage.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-ink">{stage.label}</span>
              <span className="tabular shrink-0 text-sm font-semibold text-ink">{stage.count.toLocaleString()}</span>
            </div>
            <div className="mt-2 h-2 bg-line/40">
              <div className="h-full" style={{ width: `${widthPct}%`, backgroundColor: "var(--color-accent)", opacity }} />
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              {stage.description}
              {dropped !== null && dropped > 0 ? ` · ${dropped.toLocaleString()} dropped here` : null}
            </p>
          </div>
        );
      })}
    </div>
  );
}
