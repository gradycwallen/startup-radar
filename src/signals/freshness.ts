import type { Observation } from "./types.ts";

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
