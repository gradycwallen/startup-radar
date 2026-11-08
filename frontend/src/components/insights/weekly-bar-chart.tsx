"use client";

import { useState } from "react";
import type { WeekBucket } from "@/lib/derive/insights-series";

function formatWeekLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  });
}

export function WeeklyBarChart({ title, buckets }: { title: string; buckets: WeekBucket[] }) {
  const [activeWeek, setActiveWeek] = useState<string | null>(null);
  if (buckets.length === 0) return null;
  const max = Math.max(...buckets.map((bucket) => bucket.count), 1);
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const active = buckets.find((bucket) => bucket.weekStart === activeWeek);

  return (
    <div className="border-t border-line py-4">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <span className="tabular text-xs text-ink-muted" aria-live="polite">{active ? `${active.count.toLocaleString("en-US")} · week of ${formatWeekLabel(active.weekStart)}` : `${total.toLocaleString("en-US")} total`}</span>
      </div>
      <div className="mt-7 flex h-28 items-end gap-1 border-b border-line sm:gap-2" role="group" aria-label={`${title} by week`}>
        {buckets.map((bucket) => (
          <button type="button" key={bucket.weekStart} className="relative flex h-full min-w-0 flex-1 items-end justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" aria-label={`Week of ${formatWeekLabel(bucket.weekStart)}: ${bucket.count}`} onPointerEnter={() => setActiveWeek(bucket.weekStart)} onPointerLeave={() => setActiveWeek(null)} onFocus={() => setActiveWeek(bucket.weekStart)} onBlur={() => setActiveWeek(null)}>
            <div className={`relative w-full max-w-12 ${activeWeek === bucket.weekStart ? "bg-accent" : "bg-accent/65"}`} style={{ height: bucket.count === 0 ? "1px" : `${(bucket.count / max) * 100}%` }}>
              {activeWeek === bucket.weekStart && <span aria-hidden="true" className="tabular absolute bottom-full left-1/2 mb-1 -translate-x-1/2 text-xs font-semibold text-ink">{bucket.count}</span>}
            </div>
          </button>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs text-ink-faint">
        <span>{formatWeekLabel(buckets[0]!.weekStart)}</span>
        <span>{formatWeekLabel(buckets[buckets.length - 1]!.weekStart)}</span>
      </div>
    </div>
  );
}
