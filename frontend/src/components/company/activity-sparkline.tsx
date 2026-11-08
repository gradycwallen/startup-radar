"use client";

import { useId, useMemo, useState } from "react";
import type { ActivitySeries } from "@/lib/derive/activity-series";
import { metricLabel } from "@/lib/derive/signal-view-model";

/**
 * One small-multiple line chart for a single metric's real observation history. A single series
 * needs no legend box (dataviz skill, marks-and-anatomy.md) -- the card's own title names what's
 * plotted, and there is only one color in play: the shared --color-accent token every other
 * accent on this site already uses, never a new hue invented for charts.
 *
 * Deliberately NOT a sparkline-with-no-axis: a bare trend line with no scale invites the reader
 * to misjudge magnitude (a flat line at 2 and a flat line at 200 would look identical). Min/max
 * value and first/last date are shown as direct labels, never a full gridded axis -- this is a
 * small multiple, not a standalone dashboard chart.
 */

const WIDTH = 280;
const HEIGHT = 96;
const PAD_X = 8;
const PAD_Y = 14;

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ActivitySparkline({ series }: { series: ActivitySeries }) {
  const gradientId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const { points } = series;

  const { xy, minValue, maxValue } = useMemo(() => {
    const values = points.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const times = points.map((p) => new Date(p.observedAt).getTime());
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const xFor = (t: number) => (maxT === minT ? PAD_X : PAD_X + ((t - minT) / (maxT - minT)) * (WIDTH - PAD_X * 2));
    const yFor = (v: number) => (max === min ? HEIGHT / 2 : HEIGHT - PAD_Y - ((v - min) / (max - min)) * (HEIGHT - PAD_Y * 2));
    return { xy: points.map((p, i) => ({ x: xFor(times[i]!), y: yFor(p.value) })), minValue: min, maxValue: max };
  }, [points]);

  const pathD = xy.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const last = points[points.length - 1]!;
  const lastXY = xy[xy.length - 1]!;
  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const hoveredXY = hoverIndex !== null ? xy[hoverIndex] : null;

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < xy.length; i++) {
      const d = Math.abs(xy[i]!.x - px);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    setHoverIndex(nearest);
  }

  return (
    <div className="rounded-lg border border-line p-4">
      <div className="flex items-baseline justify-between">
        <h4 className="text-sm font-medium text-ink">
          {metricLabel(series.metricName)}
          {series.sourceQualifier ? <span className="font-mono text-xs font-normal text-ink-faint"> · {series.sourceQualifier}</span> : null}
        </h4>
        <span className="tabular text-xs text-ink-faint">{maxValue}{minValue !== maxValue ? ` (from ${minValue})` : ""}</span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-2 w-full touch-none"
        role="img"
        aria-label={`${metricLabel(series.metricName)}${series.sourceQualifier ? ` for ${series.sourceQualifier}` : ""} over time, from ${formatShortDate(points[0]!.observedAt)} to ${formatShortDate(last.observedAt)}: ${minValue} to ${maxValue}`}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.12" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* recessive baseline, hairline */}
        <line x1={PAD_X} y1={HEIGHT - PAD_Y} x2={WIDTH - PAD_X} y2={HEIGHT - PAD_Y} stroke="var(--color-line)" strokeWidth={1} />

        {xy.length > 1 ? <path d={`${pathD} L${lastXY.x.toFixed(1)},${HEIGHT - PAD_Y} L${xy[0]!.x.toFixed(1)},${HEIGHT - PAD_Y} Z`} fill={`url(#${gradientId})`} stroke="none" /> : null}
        <path d={pathD} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* end marker: >=8px, ringed in surface color so it reads over the line */}
        <circle cx={lastXY.x} cy={lastXY.y} r={4} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={2} />

        {hoveredXY ? (
          <>
            <line x1={hoveredXY.x} y1={PAD_Y} x2={hoveredXY.x} y2={HEIGHT - PAD_Y} stroke="var(--color-line-strong)" strokeWidth={1} />
            <circle cx={hoveredXY.x} cy={hoveredXY.y} r={4} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={2} />
          </>
        ) : null}
      </svg>
      <div className="mt-1 flex items-center justify-between text-[11px] text-ink-faint">
        <span>{formatShortDate(points[0]!.observedAt)}</span>
        {hovered ? (
          <span className="tabular font-medium text-ink">
            {hovered.value} · {formatShortDate(hovered.observedAt)}
          </span>
        ) : (
          <span>{formatShortDate(last.observedAt)}</span>
        )}
      </div>
    </div>
  );
}
