"use client";

import { useId, useState } from "react";
import type { WeekBucket } from "@/lib/derive/insights-series";

/**
 * A single-series weekly bar chart — the aggregate-page counterpart to the company detail page's
 * ActivitySparkline, same token discipline (one accent hue, no legend needed for one series).
 * Bars (not a line) because each value here is a genuine per-week COUNT, not a continuously
 * sampled metric — a bar's discrete, bounded shape matches what the data actually is.
 *
 * A left-axis gutter (0 and the max value) plus a hairline reference at the max bar's height
 * means the magnitude is readable at a glance — hover still gives the exact per-week number, but
 * per the dataviz skill's own rule ("a tooltip is never the only way to read a value"), nothing
 * here is hover-gated.
 */

const HEIGHT = 120;
const AXIS_GUTTER = 28;
const BAR_GAP = 3;
const MAX_BAR_WIDTH = 20; // dataviz mark spec: bars capped at 24px, never filling the slot
const BASELINE_Y = HEIGHT - 16;
const TOP_Y = 14;

function formatWeekLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function WeeklyBarChart({ title, buckets }: { title: string; buckets: WeekBucket[] }) {
  const titleId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  if (buckets.length === 0) return null;

  const max = Math.max(...buckets.map((b) => b.count), 1);
  const plotWidth = Math.max(buckets.length * (MAX_BAR_WIDTH + BAR_GAP), 220);
  const width = plotWidth + AXIS_GUTTER;
  const slotWidth = plotWidth / buckets.length;
  const barWidth = Math.min(MAX_BAR_WIDTH, slotWidth - BAR_GAP);
  const hovered = hoverIndex !== null ? buckets[hoverIndex] : null;
  const peakIndex = buckets.reduce((best, b, i) => (b.count > buckets[best]!.count ? i : best), 0);

  return (
    <div className="rounded-lg border border-line p-4">
      <div className="flex items-baseline justify-between">
        <h4 id={titleId} className="text-sm font-medium text-ink">
          {title}
        </h4>
        <span className="tabular text-xs text-ink-faint">
          {hovered ? `${hovered.count} · week of ${formatWeekLabel(hovered.weekStart)}` : `${buckets.reduce((s, b) => s + b.count, 0)} total`}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} className="mt-3 w-full" role="img" aria-labelledby={titleId} preserveAspectRatio="none">
        {/* axis gutter: 0 and the max value, so magnitude never depends on hovering */}
        <text x={AXIS_GUTTER - 6} y={BASELINE_Y + 3} textAnchor="end" fill="var(--color-ink-faint)" fontSize={10}>
          0
        </text>
        <text x={AXIS_GUTTER - 6} y={TOP_Y + 3} textAnchor="end" fill="var(--color-ink-faint)" fontSize={10}>
          {max}
        </text>
        <line x1={AXIS_GUTTER} y1={TOP_Y} x2={width} y2={TOP_Y} stroke="var(--color-line)" strokeWidth={1} />
        <line x1={AXIS_GUTTER} y1={BASELINE_Y} x2={width} y2={BASELINE_Y} stroke="var(--color-line)" strokeWidth={1} />

        {buckets.map((b, i) => {
          const h = (b.count / max) * (BASELINE_Y - TOP_Y);
          const x = AXIS_GUTTER + i * slotWidth + (slotWidth - barWidth) / 2;
          const y = BASELINE_Y - h;
          const isHovered = hoverIndex === i;
          return (
            <g key={b.weekStart}>
              <rect
                x={x}
                y={b.count === 0 ? BASELINE_Y - 1.5 : y}
                width={barWidth}
                height={b.count === 0 ? 1.5 : h}
                rx={3}
                fill="var(--color-accent)"
                opacity={isHovered ? 1 : b.count === 0 ? 0.25 : 0.75}
                onPointerEnter={() => setHoverIndex(i)}
                onPointerLeave={() => setHoverIndex((cur) => (cur === i ? null : cur))}
              />
              {i === peakIndex && b.count > 0 ? (
                <text x={x + barWidth / 2} y={y - 5} textAnchor="middle" className="tabular" fill="var(--color-ink)" fontSize={10} fontWeight={600}>
                  {b.count}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between pl-7 text-[11px] text-ink-faint">
        <span>{formatWeekLabel(buckets[0]!.weekStart)}</span>
        <span>{formatWeekLabel(buckets[buckets.length - 1]!.weekStart)}</span>
      </div>
    </div>
  );
}
