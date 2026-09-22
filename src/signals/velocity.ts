import type { Observation } from "./types.ts";

/**
 * Windowed comparison over a metric's observation history. Deliberately STRICT about what counts
 * as "history for this window": `from` is the latest observation at or before
 * `to.observed_at - windowDays`. If no observation is that old, the window is `insufficient` —
 * we never stretch a near-enough observation to pretend we have a window we don't. Two
 * observations three days apart never produce a "30-day" comparison; they can still produce a
 * valid 3-day-or-shorter one, which this function will honestly report if asked for a small window.
 */
export interface WindowComparison {
  metricName: string;
  windowDays: number;
  to: Observation;
  from: Observation | null;
  /** True only when `from` exists and is a genuinely different, older observation. */
  sufficientHistory: boolean;
  /** Real elapsed days between `from` and `to`, when `from` exists — may be MORE than `windowDays` (we never invent a tighter window than we actually have; we only ever discard windows that are too SHORT). */
  actualSpanDays: number | null;
  delta: number | null;
  /** (to - from) / from. Null when insufficient history, or `from` is 0/null (see `fromWasZero`). */
  relativeChange: number | null;
  /** True when `from.numeric_value` was 0 — a relative_change would be infinite/undefined, so the
   * caller should describe this as "appeared" / "started from nothing" rather than a percentage. */
  fromWasZero: boolean;
}

const DAY_MS = 86_400_000;

export const STANDARD_WINDOWS_DAYS = [7, 14, 30, 90] as const;

/** All observations for one metric, oldest first. */
export function metricSeries(history: readonly Observation[], metricName: string): Observation[] {
  return history.filter((o) => o.metric_name === metricName).slice().sort((a, b) => a.observed_at.localeCompare(b.observed_at));
}

export function compareWindow(history: readonly Observation[], metricName: string, windowDays: number): WindowComparison | null {
  const series = metricSeries(history, metricName);
  if (series.length === 0) return null;
  const to = series[series.length - 1]!;
  const toMs = new Date(to.observed_at).getTime();
  const cutoffMs = toMs - windowDays * DAY_MS;

  let from: Observation | null = null;
  for (const o of series) {
    if (o === to) break;
    if (new Date(o.observed_at).getTime() <= cutoffMs) from = o;
    else break; // series is ascending: once we pass the cutoff, nothing later qualifies either
  }

  const sufficientHistory = from !== null;
  const actualSpanDays = from ? (toMs - new Date(from.observed_at).getTime()) / DAY_MS : null;
  const toVal = to.numeric_value;
  const fromVal = from?.numeric_value ?? null;
  const fromWasZero = fromVal === 0;
  const delta = sufficientHistory && toVal !== null && fromVal !== null ? toVal - fromVal : null;
  const relativeChange = sufficientHistory && toVal !== null && fromVal !== null && fromVal !== 0 ? (toVal - fromVal) / fromVal : null;

  return { metricName, windowDays, to, from, sufficientHistory, actualSpanDays, delta, relativeChange, fromWasZero };
}

/** Runs `compareWindow` for every standard window and returns only the ones with sufficient history. */
export function compareStandardWindows(history: readonly Observation[], metricName: string): WindowComparison[] {
  return STANDARD_WINDOWS_DAYS.map((w) => compareWindow(history, metricName, w)).filter((c): c is WindowComparison => c !== null && c.sufficientHistory);
}

/**
 * The single best comparison for a metric: the LARGEST standard window that has sufficient
 * history, largest-first (90 -> 30 -> 14 -> 7). A longer, more representative window is preferred
 * over a shorter, noisier one whenever both are available; a short window is only ever used when
 * it's genuinely all the history there is — never invented from data that doesn't cover it.
 */
export function bestAvailableWindow(history: readonly Observation[], metricName: string): WindowComparison | null {
  const sorted = [...STANDARD_WINDOWS_DAYS].sort((a, b) => b - a);
  for (const w of sorted) {
    const cmp = compareWindow(history, metricName, w);
    if (cmp && cmp.sufficientHistory) return cmp;
  }
  return null;
}

/**
 * A window comparison only ever looks at its two ENDPOINTS — a value that spikes and falls back
 * within the window produces no signal by construction, since `to` (the latest observation) would
 * already reflect the fall. The one case that can't be caught that way is a spike that IS the
 * latest observation: we have no future data to know whether it holds.
 *
 * For that case, strong (surge-tier) rules run this extra, deterministic check: with 3+
 * observations for a metric, the move must already have been underway by the reading just before
 * `to` — i.e. `prev` is on the same side of `from` as the overall move (any amount counts; this is
 * a direction check, not a magnitude threshold, so genuine late-accelerating growth like 8 -> 11 ->
 * 48 still passes: 11 is already above 8). A metric that was flat right up to the very last reading
 * (e.g. 2 -> 2 -> 14) fails this check — the rise appears in exactly one data point, which is
 * precisely the "did it just spike, or is it actually moving" question this exists to answer. With
 * fewer than 3 observations this cannot be checked at all, so it is not enforced (a documented
 * limitation, not a false pass) — see the V2-2A report.
 */
export function isPersistent(history: readonly Observation[], cmp: WindowComparison): boolean {
  if (!cmp.from || cmp.delta === null || cmp.delta === 0) return true; // nothing to check against
  const series = metricSeries(history, cmp.metricName);
  const toIndex = series.indexOf(cmp.to);
  if (toIndex < 1) return true; // fewer than 2 points before `to`: cannot check, not enforced
  const prev = series[toIndex - 1]!;
  if (prev === cmp.from) return true; // `from` IS the immediately-prior observation: nothing further to check
  const prevVal = prev.numeric_value;
  const fromVal = cmp.from.numeric_value;
  if (prevVal === null || fromVal === null) return true;
  return cmp.delta > 0 ? prevVal > fromVal : prevVal < fromVal;
}
