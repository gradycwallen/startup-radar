import type { InsightsCompanyRow, InsightsSignalRow } from "@/lib/data/insights";

/**
 * Pure aggregation for the /insights page. No fabrication: a week with zero real rows is a real
 * zero (companies/signals genuinely didn't appear that week), never omitted or interpolated —
 * distinct from the missing-vs-zero discipline elsewhere in this codebase, which is about a
 * metric that was never OBSERVED. Here, the absence of a row IS the observation.
 */

export interface WeekBucket {
  /** ISO date (Monday) of the week this bucket covers. */
  weekStart: string;
  count: number;
}

export type SignalFamily = "hiring" | "github" | "website";

function startOfIsoWeek(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
  return monday.toISOString().slice(0, 10);
}

/** Every week from the earliest date in `dates` through the current week, inclusive — so a
 * silent week shows as a real zero-height bar, never a gap that could be misread as missing data. */
function weekRange(dates: readonly string[], now: Date): string[] {
  if (dates.length === 0) return [];
  const earliest = dates.reduce((min, d) => (d < min ? d : min), dates[0]!);
  const weeks: string[] = [];
  let cursor = new Date(startOfIsoWeek(earliest) + "T00:00:00Z");
  const end = new Date(startOfIsoWeek(now.toISOString()) + "T00:00:00Z");
  while (cursor.getTime() <= end.getTime()) {
    weeks.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 7 * 86_400_000);
  }
  return weeks;
}

export function buildWeeklyDiscoveryVolume(companies: readonly InsightsCompanyRow[], now: Date = new Date()): WeekBucket[] {
  const dates = companies.map((c) => c.discoveredAt);
  const weeks = weekRange(dates, now);
  const counts = new Map<string, number>();
  for (const c of companies) counts.set(startOfIsoWeek(c.discoveredAt), (counts.get(startOfIsoWeek(c.discoveredAt)) ?? 0) + 1);
  return weeks.map((w) => ({ weekStart: w, count: counts.get(w) ?? 0 }));
}

export function buildWeeklySignalVolume(signals: readonly InsightsSignalRow[], family: SignalFamily, now: Date = new Date()): WeekBucket[] {
  const familySignals = signals.filter((s) => s.family === family);
  const weeks = weekRange(signals.map((s) => s.firedAt), now);
  const counts = new Map<string, number>();
  for (const s of familySignals) counts.set(startOfIsoWeek(s.firedAt), (counts.get(startOfIsoWeek(s.firedAt)) ?? 0) + 1);
  return weeks.map((w) => ({ weekStart: w, count: counts.get(w) ?? 0 }));
}

export interface SourceMixEntry {
  source: string;
  count: number;
}

/** Companies with a null discovery_source are grouped under "Unlabeled" rather than silently
 * dropped — a real company that would otherwise just vanish from the total. */
export function buildSourceMix(companies: readonly InsightsCompanyRow[]): SourceMixEntry[] {
  const counts = new Map<string, number>();
  for (const c of companies) {
    const key = c.discoverySource?.trim() || "Unlabeled";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);
}
