"use client";

import { useId, useState } from "react";
import type { WeekBucket } from "@/lib/derive/insights-series";

/**
 * A single-series weekly bar chart — the aggregate-page counterpart to the company detail page's
 * ActivitySparkline, same token discipline (one accent hue, no legend needed for one series).
 * Bars (not a line) because each value here is a genuine per-week COUNT, not a continuously
 * sampled metric — a bar's discrete, bounded shape matches what the data actually is.
 */

const HEIGHT = 120;
const BAR_GAP = 3;
const MAX_BAR_WIDTH = 20; // dataviz mark spec: bars capped at 24px, never filling the slot

function formatWeekLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function WeeklyBarChart({ title, buckets }: { title: string; buckets: WeekBucket[] }) {
  const titleId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  if (buckets.length === 0) return null;

  const max = Math.max(...buckets.map((b) => b.count), 1);
  const width = Math.max(buckets.length * (MAX_BAR_WIDTH + BAR_GAP), 240);
  const slotWidth = width / buckets.length;
  const barWidth = Math.min(MAX_BAR_WIDTH, slotWidth - BAR_GAP);
  const hovered = hoverIndex !== null ? buckets[hoverIndex] : null;

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
        <line x1={0} y1={HEIGHT - 16} x2={width} y2={HEIGHT - 16} stroke="var(--color-line)" strokeWidth={1} />
        {buckets.map((b, i) => {
          const h = (b.count / max) * (HEIGHT - 32);
          const x = i * slotWidth + (slotWidth - barWidth) / 2;
          const y = HEIGHT - 16 - h;
          const isHovered = hoverIndex === i;
          return (
            <rect
              key={b.weekStart}
              x={x}
              y={b.count === 0 ? HEIGHT - 16 - 1.5 : y}
              width={barWidth}
              height={b.count === 0 ? 1.5 : h}
              rx={3}
              fill="var(--color-accent)"
              opacity={isHovered ? 1 : b.count === 0 ? 0.25 : 0.75}
              onPointerEnter={() => setHoverIndex(i)}
              onPointerLeave={() => setHoverIndex((cur) => (cur === i ? null : cur))}
            />
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-ink-faint">
        <span>{formatWeekLabel(buckets[0]!.weekStart)}</span>
        <span>{formatWeekLabel(buckets[buckets.length - 1]!.weekStart)}</span>
      </div>
    </div>
  );
}
