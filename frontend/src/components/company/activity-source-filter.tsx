"use client";

import { useState } from "react";
import type { ActivitySourceGroup } from "@/lib/derive/activity-series";
import { ActivitySparkline } from "./activity-sparkline";

/**
 * Companies tracking several sources for the same metric (most commonly a multi-repo GitHub
 * project — Restate tracks 8) would otherwise dump dozens of chart cards on the page at once.
 * Defaults to one group (the primary one, already chosen by pickPrimarySourceId) with a dropdown
 * to switch to another single group or to "All" — never forces a choice on the common case, since
 * ActivityTimeline only renders this component at all when there's more than one group.
 */
export function ActivitySourceFilter({ groups, defaultSourceId }: { groups: ActivitySourceGroup[]; defaultSourceId: number }) {
  const [selected, setSelected] = useState<number | "all">(defaultSourceId);
  const visible = selected === "all" ? groups.flatMap((g) => g.series) : (groups.find((g) => g.signalSourceId === selected)?.series ?? []);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">Activity over time</h3>
        <label className="flex items-center gap-1.5 text-xs text-ink-muted">
          Source
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value === "all" ? "all" : Number(e.target.value))}
            className="rounded border border-line bg-surface px-1.5 py-1 text-xs font-medium text-ink"
          >
            {groups.map((g) => (
              <option key={g.signalSourceId} value={g.signalSourceId}>
                {g.label ?? `Source ${g.signalSourceId}`}
              </option>
            ))}
            <option value="all">All ({groups.length})</option>
          </select>
        </label>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {visible.map((s) => (
          <ActivitySparkline key={`${s.signalSourceId}:${s.metricName}`} series={s} />
        ))}
      </div>
    </div>
  );
}
