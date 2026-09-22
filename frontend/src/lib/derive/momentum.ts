import type { CompanyWithEvents, DiscoveryEvent } from "../data/types";
import { groupEvents, type EventGroup } from "./group-events";

/**
 * Deterministic "Momentum" ranking — answers "which companies should I pay attention to right
 * now?" using data Scout already has. NO new database reads, NO schema changes, NO discovery
 * pipeline changes — this is a pure function over `CompanyWithEvents[]`, computed at render/sort
 * time. Three weighted factors:
 *
 *   50% Recency         — how fresh is the company's most recent grouped event? Credited from the
 *                          MOST RECENT event_date among that group's members (`latestMemberTimestamp`),
 *                          not necessarily the same date as the group's displayed `primary` (which
 *                          is chosen by confidence, not recency) — see `latestMemberTimestamp`.
 *   30% Corroboration    — how many INDEPENDENT sources (by distinct source_name, not raw row
 *                          count) support that most recent event? Diminishing returns past ~6.
 *   20% Signal diversity — how many DISTINCT event types has the company shown in the last
 *                          `DIVERSITY_WINDOW_DAYS` days?
 *
 * All three factors are computed over GROUPED events (./group-events.ts), never raw
 * discovery_events rows — a duplicate/syndicated article (e.g. the same PR Newswire release
 * picked up once directly and once via a Google News redirect, as happened for Chamelio) must
 * never inflate momentum. See root CLAUDE.md §5C for why the backend deliberately keeps every
 * distinct source_url as its own row rather than deduplicating at write time — grouping/momentum
 * is a presentation-layer correction for that, not a sign the backend behavior is wrong.
 *
 * `signal_sources`/`observations`/`signals` (V2-2A/V2-2A.1) were inspected while building this and
 * are deliberately NOT used here: the frontend has no existing read path to them (adding one would
 * be new backend surface, which this feature's brief asked to avoid unless absolutely necessary),
 * and as of this writing `signals` has zero rows in the live database — there is no derived signal
 * data yet for Momentum to use even if it read that table. "Signal diversity" below is scoped to
 * discovery_events' own `event_type` values, the only per-event signal typing the frontend
 * currently has access to.
 */

export type MomentumBand = "high" | "medium" | "low";

export interface MomentumResult {
  /** 0-100, internal only — never shown raw in the UI per the brief; used for sorting/banding. */
  score: number;
  band: MomentumBand;
  recencyScore: number; // 0-1
  corroborationScore: number; // 0-1
  diversityScore: number; // 0-1
  /** Distinct sources behind the single most recent grouped event (what the Recency/Corroboration
   * factors are scored against) — this is the "N sources" figure shown in the compact label. */
  sourceCount: number;
  /** Distinct event types across all grouped events within the diversity window — the "N signal
   * types" figure shown in the compact label. Deliberately a BROADER scope than sourceCount (the
   * whole recent window, not just the latest story) — see module doc. */
  signalTypeCount: number;
  /** The group Recency/Corroboration and the label's "latest …" text are based on. Null only when
   * the company has no events at all. */
  latestGroup: EventGroup | null;
}

const WEIGHTS = { recency: 0.5, corroboration: 0.3, diversity: 0.2 } as const;

/** How many days back "signal diversity" looks for distinct event types. Broad enough that a
 * genuinely multi-signal company (e.g. funding, then a product launch weeks later) gets credit;
 * narrow enough that an event from a year ago doesn't count as "current" diversity. Easily tuned —
 * a single named constant, not scattered magic numbers. */
const DIVERSITY_WINDOW_DAYS = 30;

/** Distinct-source count at which Corroboration is treated as maxed out (log-scaled below it, see
 * `corroborationScoreFor`) — chosen so 2-3 sources already matter meaningfully but 8-10 sources
 * are nowhere near 4-5x a 2-source event: at CORROBORATION_CAP = 6, 2 sources ≈ 0.57, 6 sources =
 * 1.00 (the cap), and 10 sources is still capped at 1.00 — roughly 1.8x, not 4-5x, the gap between
 * 2 and "as many sources as you like." */
const CORROBORATION_CAP = 6;

/** Distinct event-TYPE count (out of the 6 known EVENT_TYPES) at which Signal diversity is treated
 * as maxed out. 3 different kinds of signal within the window is already a strong multi-signal
 * company; requiring all 6 would make the maximum practically unreachable. */
const DIVERSITY_TYPE_CAP = 3;

const DAY_MS = 86_400_000;

/** Momentum score (0-100) thresholds for the High/Medium/Low band shown in the UI. Chosen by
 * inspecting the real, live post-V2-1.1 database's actual score distribution (see the Momentum
 * delivery report for the exact numbers this was calibrated against) — not arbitrary round
 * numbers. Deterministic; re-inspect and adjust here (not at the call site) if the distribution
 * shifts materially as more data accumulates. */
const BAND_THRESHOLDS = { high: 60, medium: 35 } as const; // score >= high -> "high", >= medium -> "medium", else "low"

/** event_date (a real-world date, no time-of-day) is preferred over observed_at (when a Scout run
 * happened to see it) — Momentum reflects how recent the company's ACTUAL activity is, not how
 * recently a scheduled crawl happened to run. Falls back to observed_at only when event_date is
 * genuinely absent, matching the same fallback already used for sorting/display elsewhere
 * (src/lib/data/companies.ts, src/components/company/evidence-timeline.tsx). Interpreted at UTC
 * midnight since only a date, not a time, is known — a known, disclosed granularity limitation:
 * see the delivery report's "edge cases" section. */
export function eventTimestamp(event: DiscoveryEvent): number {
  if (event.eventDate) return new Date(`${event.eventDate}T00:00:00Z`).getTime();
  return new Date(event.observedAt).getTime();
}

function groupTimestamp(group: EventGroup): number {
  return eventTimestamp(group.primary);
}

/** The MOST RECENT event_date among ALL members of a group — used for Recency ONLY, never for
 * choosing which group is "latest" (that's still `groupTimestamp`, primary-based, unchanged) and
 * never for Corroboration/Diversity. Cross-date grouping (./group-events.ts) can now merge a
 * high-confidence older article with a newer one covering the same fact (e.g. Corridor's $25M
 * round: a Sep 21 TechCrunch piece as the group's primary/displayed source, plus Sep 22
 * corroboration) — `primary` stays whichever member has the highest confidence (unchanged, still
 * what's displayed), but Recency should credit the group's freshest evidence, not be penalized
 * just because the most-confident source happened to run a day earlier. */
export function latestMemberTimestamp(group: EventGroup): number {
  return Math.max(...group.events.map(eventTimestamp));
}

function recencyScoreFor(ageDays: number): number {
  if (ageDays < 1) return 1.0;
  if (ageDays <= 3) return 0.8;
  if (ageDays <= 7) return 0.55;
  if (ageDays <= 14) return 0.3;
  return 0.1;
}

/** Distinct, normalized source names within a group. This is the actual fix for the "same PR
 * Newswire release counted twice" problem: two rows from the same outlet — reached via two
 * different URLs, e.g. a direct link and a Google News redirect of the same article — must count
 * as ONE independent source, not two. Falls back to source_url, then a synthetic per-row key, only
 * when source_name itself is missing (never silently drops a row from the count). */
function distinctSourceCount(group: EventGroup): number {
  const names = new Set(group.events.map((e) => (e.sourceName ?? e.sourceUrl ?? `event-${e.id}`).trim().toLowerCase()));
  return names.size;
}

function corroborationScoreFor(sourceCount: number): number {
  if (sourceCount <= 0) return 0;
  return Math.min(1, Math.log(1 + sourceCount) / Math.log(1 + CORROBORATION_CAP));
}

function diversityScoreFor(distinctTypeCount: number): number {
  return Math.min(1, distinctTypeCount / DIVERSITY_TYPE_CAP);
}

function bandFor(score: number): MomentumBand {
  if (score >= BAND_THRESHOLDS.high) return "high";
  if (score >= BAND_THRESHOLDS.medium) return "medium";
  return "low";
}

export function computeMomentum(company: CompanyWithEvents, now: Date = new Date()): MomentumResult {
  if (company.events.length === 0) {
    return { score: 0, band: "low", recencyScore: 0, corroborationScore: 0, diversityScore: 0, sourceCount: 0, signalTypeCount: 0, latestGroup: null };
  }

  // Sort groups explicitly rather than trusting groupEvents' incoming order: event_date has no
  // time-of-day, so two genuinely different stories discovered in the same run can tie exactly on
  // date (a real case found while calibrating this against live data — Nexstrom's product_launch
  // and funding groups both dated the same day). On a tie, prefer the group with MORE distinct
  // sources — the better-corroborated story is the more meaningful one to call "latest" when the
  // dates themselves can't break the tie.
  const groups = [...groupEvents(company.events)].sort((a, b) => {
    const byDate = groupTimestamp(b) - groupTimestamp(a);
    if (byDate !== 0) return byDate;
    return distinctSourceCount(b) - distinctSourceCount(a);
  });
  const latestGroup = groups[0]!;

  const ageDays = Math.max(0, (now.getTime() - latestMemberTimestamp(latestGroup)) / DAY_MS);
  const recencyScore = recencyScoreFor(ageDays);

  const sourceCount = distinctSourceCount(latestGroup);
  const corroborationScore = corroborationScoreFor(sourceCount);

  const windowStart = now.getTime() - DIVERSITY_WINDOW_DAYS * DAY_MS;
  const windowGroups = groups.filter((g) => groupTimestamp(g) >= windowStart);
  const signalTypeCount = new Set(windowGroups.map((g) => g.primary.eventType)).size;
  const diversityScore = diversityScoreFor(signalTypeCount);

  const score = Math.round((WEIGHTS.recency * recencyScore + WEIGHTS.corroboration * corroborationScore + WEIGHTS.diversity * diversityScore) * 100);

  return { score, band: bandFor(score), recencyScore, corroborationScore, diversityScore, sourceCount, signalTypeCount, latestGroup };
}

/** Descending comparator for Array#sort — higher momentum first. Ties broken by discoveredAt
 * (newest first), matching the "recent" sort's own tie behavior, for a stable, predictable order. */
export function compareMomentumDesc(a: CompanyWithEvents, b: CompanyWithEvents, now: Date = new Date()): number {
  const diff = computeMomentum(b, now).score - computeMomentum(a, now).score;
  if (diff !== 0) return diff;
  return b.discoveredAt.localeCompare(a.discoveredAt);
}
