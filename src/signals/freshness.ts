import type { Observation, SourceType } from "./types.ts";

/**
 * Collection freshness/cooldown policy.
 *
 * Centralized here, deliberately, so "how stale must a source be before we re-collect it" is one
 * number, not scattered through the orchestrator. Chosen at 22h (inside the 20-24h band): a daily
 * GitHub Actions cron can start late (GitHub's own docs note scheduled runs are not guaranteed to
 * fire at the exact minute — see the V2-2A.1 report), so 22h gives room for that drift on both
 * sides without ever allowing two collections inside the same calendar day under normal operation,
 * while still being comfortably under 24h so a slightly-early run doesn't get skipped as "not
 * stale enough yet."
 */
export const COLLECTION_FRESHNESS_HOURS = 22;
const HOUR_MS = 3_600_000;

/** The most recent `observed_at` across ALL LIVE observations for one signal source, or null if
 * this source has never been LIVE-observed (in which case it is never "fresh" — always collect).
 *
 * V2-2B.1: backfilled observations (collection_version "github-v1-backfill") are deliberately
 * EXCLUDED here — a real bug found while building backfill. Backfill rows are written with
 * `observed_at = now` (honestly — that's when we ran the backfill), which otherwise makes the
 * source look freshly-collected the instant backfill finishes, silently skipping that source's own
 * first LIVE "today" collection in the very same pass. Backfill supplements history; it is not
 * itself a live collection and must never satisfy the freshness check. */
export function mostRecentObservedAt(history: readonly Observation[], signalSourceId: number): string | null {
  let best: string | null = null;
  for (const o of history) {
    if (o.signal_source_id !== signalSourceId) continue;
    if (o.collection_version.endsWith("-backfill")) continue;
    if (best === null || o.observed_at > best) best = o.observed_at;
  }
  return best;
}

/** True when a source was collected recently enough that collecting it again would just be
 * redundant/impolite — the "skipped_fresh" outcome. A source with NO prior observation is never
 * fresh (there's nothing to have gone stale). `force` bypasses this — never the default. */
export function isFresh(history: readonly Observation[], signalSourceId: number, now: Date, force: boolean, freshnessHours: number = COLLECTION_FRESHNESS_HOURS): boolean {
  if (force) return false;
  const last = mostRecentObservedAt(history, signalSourceId);
  if (last === null) return false;
  return now.getTime() - new Date(last).getTime() < freshnessHours * HOUR_MS;
}

// ---- V2-2B.2: per-source-type freshness policy --------------------------------------------------------------------
//
// GitHub/ATS keep the flat 22h COLLECTION_FRESHNESS_HOURS above, unchanged. Website structural
// monitoring does NOT need daily polling (see the design report §17): its own policy is derived
// deterministically from that source's OWN `website_fetch_outcome` history — no new column, no
// new state, exactly the same "compute freshness from what's already in `observations`" discipline
// COLLECTION_FRESHNESS_HOURS itself already follows.

/** Normal cadence once a website source has a stable "ok" reading with nothing pending. */
export const WEBSITE_FRESHNESS_HOURS = 166;
/** Re-check cadence while a page-level change is unconfirmed (see hasPendingWebsiteChange) OR a
 * fetch failure is still within its retry streak — both cases want a fast next look. */
export const WEBSITE_PENDING_FRESHNESS_HOURS = 22;
/** Consecutive transient-failure passes (timeout/dns_failure/http_5xx) before giving up on daily
 * retries and falling back to the normal cadence — retrying a genuinely down site every day
 * forever is not more polite or more useful than checking it weekly. */
export const WEBSITE_FAILURE_FALLBACK_AFTER = 3;

const WEBSITE_PAGE_METRICS = [
  "website_page_pricing", "website_page_enterprise", "website_page_security", "website_page_customers", "website_page_careers", "website_homepage_prelaunch",
] as const;

/** Outcomes that reflect something durable about the site (blocked, off-domain, non-HTML, an SPA
 * shell, robots denial) rather than a transient network hiccup — retrying tomorrow is exactly as
 * likely to help as retrying next week, so these go straight to the normal (slow) cadence instead
 * of burning through the failure-retry budget. */
const WEBSITE_STABLE_OUTCOMES = new Set(["blocked", "robots_denied", "non_html", "offdomain_redirect", "spa_shell"]);
/** Outcomes worth a same-cadence-as-pending retry a day or two later, because they plausibly
 * resolve on their own (a deploy blip, a transient DNS hiccup, a momentary 5xx). */
const WEBSITE_TRANSIENT_FAILURE_OUTCOMES = new Set(["timeout", "dns_failure", "http_5xx"]);

function sourceHistory(history: readonly Observation[], signalSourceId: number): Observation[] {
  return history.filter((o) => o.signal_source_id === signalSourceId);
}

function chronological(observations: readonly Observation[]): Observation[] {
  return observations.slice().sort((a, b) => a.observed_at.localeCompare(b.observed_at));
}

/** True when the LATEST vs. second-latest reading of any tracked website metric disagree (both
 * known/written — see the missing-vs-zero discipline in sources/website.ts, which never writes a
 * row for "unknown"). This is a real, unconfirmed change worth re-checking sooner — NOT a signal
 * itself, just a freshness-policy input. */
export function hasPendingWebsiteChange(history: readonly Observation[], signalSourceId: number): boolean {
  const own = sourceHistory(history, signalSourceId);
  for (const metric of WEBSITE_PAGE_METRICS) {
    const series = chronological(own.filter((o) => o.metric_name === metric));
    if (series.length < 2) continue;
    const last = series[series.length - 1]!, prev = series[series.length - 2]!;
    if (last.numeric_value !== null && prev.numeric_value !== null && last.numeric_value !== prev.numeric_value) return true;
  }
  return false;
}

/** Computes the freshness window for ONE website signal source from its own
 * `website_fetch_outcome` history. Never mutates/reads anything beyond `observations` already in
 * hand — matches the resolution-cooldown-free design already established for V2-2A.1. */
export function websiteFreshnessHours(history: readonly Observation[], signalSourceId: number): number {
  const outcomes = chronological(sourceHistory(history, signalSourceId).filter((o) => o.metric_name === "website_fetch_outcome"));
  if (outcomes.length === 0) return WEBSITE_FRESHNESS_HOURS; // never observed — irrelevant to isFresh (mostRecentObservedAt is already null, so it's never "fresh" anyway)

  const last = outcomes[outcomes.length - 1]!;
  const lastOutcome = last.text_value ?? "";
  if (lastOutcome === "ok") {
    return hasPendingWebsiteChange(history, signalSourceId) ? WEBSITE_PENDING_FRESHNESS_HOURS : WEBSITE_FRESHNESS_HOURS;
  }
  if (WEBSITE_TRANSIENT_FAILURE_OUTCOMES.has(lastOutcome)) {
    let streak = 0;
    for (let i = outcomes.length - 1; i >= 0; i--) {
      if (!WEBSITE_TRANSIENT_FAILURE_OUTCOMES.has(outcomes[i]!.text_value ?? "")) break;
      streak++;
    }
    return streak >= WEBSITE_FAILURE_FALLBACK_AFTER ? WEBSITE_FRESHNESS_HOURS : WEBSITE_PENDING_FRESHNESS_HOURS;
  }
  // WEBSITE_STABLE_OUTCOMES, or any outcome string this policy doesn't specifically recognize —
  // conservative default: don't hammer a site that's blocking us or otherwise durably unreachable.
  return WEBSITE_FRESHNESS_HOURS;
}

/** The single entry point orchestrate.ts calls: dispatches to the website policy for a `website`
 * source, and falls back to the caller-supplied default (GitHub/ATS's flat cadence) for everything
 * else. Keeps the per-source-type policy centralized and swappable in one place, per the design
 * report §17's "should freshness.ts become a per-source-type policy map" question — yes, in the
 * smallest form that actually needs it today. */
export function freshnessHoursFor(source: { source_type: SourceType; id: number | null }, history: readonly Observation[], defaultHours: number = COLLECTION_FRESHNESS_HOURS): number {
  if (source.source_type === "website" && source.id !== null) return websiteFreshnessHours(history, source.id);
  return defaultHours;
}
