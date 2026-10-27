import type { ActivitySignal, CompanyWithEvents, DiscoveryEvent } from "../data/types.ts";
import { classifyKind } from "./signal-view-model.ts";

/**
 * Deterministic "Momentum" ranking — answers "which companies should I pay attention to right
 * now?" using data Scout already has. A pure function over `CompanyWithEvents[]`, computed at
 * render/sort time; no new database reads.
 *
 * Momentum = how MANY distinct signals a company has, weighted by how RECENT each one is:
 *
 *   score = Σ over signals in the last SIGNAL_WINDOW_DAYS of 0.5 ^ (ageDays / HALF_LIFE_DAYS)
 *
 * Two kinds of signal count:
 *   - Discovery news cycles: every discovery event within SIGNAL_SPAN_DAYS of the cycle's newest
 *     event is ONE signal, whatever outlet or event type reported it.
 *   - Confirmed changes from Signal Intelligence (public.signals `transition` types — a new GitHub
 *     release, contributor growth, an open-jobs increase, a security page appearing…), one per
 *     signal_type per SIGNAL_SPAN_DAYS. First-look signals are excluded: they describe the state
 *     Scout saw on its first visit, and their fired_at is when Scout looked, not when anything
 *     happened.
 *
 * The news-cycle rule This is deliberately coarser than the
 * display grouping in ./group-events.ts, which only merges on exact amount/headline matches and so
 * (correctly, for display) keeps e.g. "raises ₹7.6 crore" and "raises $900K" apart. For counting
 * activity that conservatism is wrong: checked against live data, Bucketlistt's one seed round
 * showed up as 7 display groups and Pluto's single $42M stealth exit as ~12 (stealth + funding
 * stories from a dozen outlets). Coverage volume belongs to Confidence, not Momentum.
 *
 * An earlier version scored 50% recency + 30% source count + 20% event-type diversity, which in
 * practice made the sort mirror "most recent" and rewarded heavily-syndicated single stories.
 *
 * With a 14-day half-life: one signal today = 1.0, one two weeks old = 0.5, two signals from ten
 * days ago ≈ 1.2 — so a company with repeated recent activity outranks one fresh headline, while
 * recency still decides between companies with the same amount of activity.
 */

export type MomentumBand = "high" | "medium" | "low";

export interface MomentumResult {
  /** Internal only — never shown raw in the UI; used for sorting/banding. */
  score: number;
  band: MomentumBand;
  /** Distinct signals inside the window — the "N signals" figure in the compact label. */
  signalCount: number;
  /** Timestamp of the company's most recent signal — drives the label's "latest …" text. Null only
   * when the company has no events at all. */
  latestAt: number | null;
}

/** Events within this many days of a signal's newest event belong to that same signal. A week
 * covers staggered outlet pickup of one announcement (Pluto's coverage spans Oct 13–15). */
const SIGNAL_SPAN_DAYS = 7;

/** Days for a signal's contribution to halve. */
const HALF_LIFE_DAYS = 14;

/** Signals older than this contribute nothing (at 90 days a signal would only be worth ~0.01). */
const SIGNAL_WINDOW_DAYS = 90;

/** score >= high -> "high", >= medium -> "medium", else "low". High needs two signals within
 * roughly the last couple of weeks; Medium is one signal from about the past week. */
const BAND_THRESHOLDS = { high: 1.5, medium: 0.7 } as const;

const DAY_MS = 86_400_000;

/** event_date (a real-world date, no time-of-day) is preferred over observed_at (when a Scout run
 * happened to see it) — Momentum reflects how recent the company's ACTUAL activity is, not how
 * recently a crawl ran. Falls back to observed_at only when event_date is absent, matching
 * src/lib/data/companies.ts and src/components/company/evidence-timeline.tsx. Interpreted at UTC
 * midnight since only a date is known. */
export function eventTimestamp(event: DiscoveryEvent): number {
  if (event.eventDate) return new Date(`${event.eventDate}T00:00:00Z`).getTime();
  return new Date(event.observedAt).getTime();
}

/** Collapses timestamps into newest-first signal anchors. Anchored, not chained: a timestamp joins
 * the current signal only if it is within SIGNAL_SPAN_DAYS of that signal's NEWEST timestamp, so a
 * steady drip of weekly news can't collapse into one endless signal. */
function anchorsFor(timestamps: readonly number[]): number[] {
  const times = [...timestamps].sort((a, b) => b - a);
  const anchors: number[] = [];
  for (const t of times) {
    const anchor = anchors[anchors.length - 1];
    if (anchor === undefined || anchor - t > SIGNAL_SPAN_DAYS * DAY_MS) anchors.push(t);
  }
  return anchors;
}

function signalTimestamps(events: readonly DiscoveryEvent[], activity: readonly ActivitySignal[]): number[] {
  const byType = new Map<string, number[]>();
  for (const s of activity) {
    if (classifyKind(s.signalType) !== "transition") continue;
    const list = byType.get(s.signalType) ?? [];
    list.push(new Date(s.firedAt).getTime());
    byType.set(s.signalType, list);
  }
  const all = anchorsFor(events.map(eventTimestamp));
  for (const times of byType.values()) all.push(...anchorsFor(times));
  return all.sort((a, b) => b - a);
}

function bandFor(score: number): MomentumBand {
  if (score >= BAND_THRESHOLDS.high) return "high";
  if (score >= BAND_THRESHOLDS.medium) return "medium";
  return "low";
}

export function computeMomentum(company: CompanyWithEvents, now: Date = new Date()): MomentumResult {
  const signals = signalTimestamps(company.events, company.activitySignals ?? []);
  if (signals.length === 0) return { score: 0, band: "low", signalCount: 0, latestAt: null };

  let score = 0;
  let signalCount = 0;
  for (const t of signals) {
    const ageDays = Math.max(0, (now.getTime() - t) / DAY_MS);
    if (ageDays > SIGNAL_WINDOW_DAYS) continue;
    score += Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    signalCount += 1;
  }

  return { score, band: bandFor(score), signalCount, latestAt: signals[0]! };
}

/** Descending comparator for Array#sort — higher momentum first. Ties broken by discoveredAt
 * (newest first), matching the "recent" sort's own tie behavior, for a stable, predictable order. */
export function compareMomentumDesc(a: CompanyWithEvents, b: CompanyWithEvents, now: Date = new Date()): number {
  const diff = computeMomentum(b, now).score - computeMomentum(a, now).score;
  if (diff !== 0) return diff;
  return b.discoveredAt.localeCompare(a.discoveredAt);
}
