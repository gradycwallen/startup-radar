import type { Fetcher } from "../sources/fetcher.ts";
import { collectAshby } from "./sources/ats/ashby.ts";
import { collectGreenhouse } from "./sources/ats/greenhouse.ts";
import { collectLever } from "./sources/ats/lever.ts";
import { backfillGithubRepoHistory, collectGithubOrg, collectGithubRepo } from "./sources/github.ts";
import { collectWebsite } from "./sources/website.ts";
import type { CollectedMetric, CollectionResult } from "./sources/types.ts";
import { deriveGithubLevelSignals, deriveGithubSignals } from "./rules/github.ts";
import { deriveHiringLevelSignals, deriveHiringSignals } from "./rules/hiring.ts";
import { deriveWebsiteLevelSignals, deriveWebsiteTransitionSignals } from "./rules/website.ts";
import type { ExistingSignalRef } from "./rules/format.ts";
import type { DerivedSignal, Observation, SignalSource } from "./types.ts";

/**
 * The generic collect -> normalize step. One dispatcher per SourceType; every collector returns
 * the same shape (CollectionResult), so adding a future source (website structure, SEC Form D —
 * NOT built in V2-2A) means adding one case here, not redesigning this function.
 */
export interface ObserveOptions {
  githubToken?: string;
  now?: () => Date;
}

/** Shared metric -> Observation mapping, used by both live collection and backfill (V2-2B.1) so
 * the two never drift into two different row shapes. `observedAt` is always "when we captured/
 * computed this" (now, for both) — only `source_timestamp` differs between a live reading (usually
 * null — see each collector) and a backfilled one (a real historical date). */
function toObservations(metrics: readonly CollectedMetric[], source: SignalSource, observedAt: string, collectionVersion: string): Observation[] {
  return metrics.map((m) => ({
    id: null,
    company_id: source.company_id,
    signal_source_id: source.id!,
    metric_name: m.metricName,
    numeric_value: m.numericValue,
    text_value: m.textValue,
    observed_at: observedAt,
    source_timestamp: m.sourceTimestamp,
    collection_version: collectionVersion,
    // NOT wired in V2-2A: a pointer into the HTTP snapshot store recorded for this collection.
    // The full raw response IS preserved when snapshot recording is used (--record, like V2-1's
    // funnel CLI); this field would carry that request's key. See the V2-2A report.
    raw_payload_ref: null,
    // V2-2B.2: only the website collector ever sets this (see sources/website.ts); every other
    // collector's metrics have `metadata: undefined`, which normalizes to null here.
    metadata: m.metadata ?? null,
  }));
}

export async function collectForSource(source: SignalSource, fetcher: Fetcher, opts: ObserveOptions = {}, signal?: AbortSignal): Promise<Observation[]> {
  const observedAt = (opts.now?.() ?? new Date()).toISOString();
  let result: CollectionResult;
  switch (source.source_type) {
    case "github_repo": {
      const [owner, repo] = source.external_id.split("/");
      if (!owner || !repo) return [];
      result = await collectGithubRepo(fetcher, owner, repo, { token: opts.githubToken }, signal);
      break;
    }
    case "github_org":
      result = await collectGithubOrg(fetcher, source.external_id, { token: opts.githubToken }, signal);
      break;
    case "greenhouse":
      result = await collectGreenhouse(fetcher, source.external_id, signal);
      break;
    case "lever":
      result = await collectLever(fetcher, source.external_id, signal);
      break;
    case "ashby":
      result = await collectAshby(fetcher, source.external_id, signal);
      break;
    case "website":
      result = await collectWebsite(fetcher, source.external_id, signal);
      break;
    default:
      return [];
  }
  return toObservations(result.metrics, source, observedAt, result.collectionVersion);
}

/**
 * V2-2B.1: one-time historical backfill, called ONLY at the moment a source is newly resolved
 * (see orchestrate.ts) — never on ongoing collection. Only `github_repo` has a source-supported
 * backfill today (see sources/github.ts: backfillGithubRepoHistory for exactly what is and isn't
 * backfilled, and why); every other source type returns no observations here — not a gap to "fix,"
 * ATS backfill was investigated and deliberately deferred (see the V2-2B.1 report's ATS findings).
 * `observedAt` is "when we ran this backfill" (now) for every row — never mutated to look like it
 * happened earlier; only each row's `source_timestamp` carries the real historical date.
 */
export async function backfillForSource(source: SignalSource, fetcher: Fetcher, opts: ObserveOptions = {}, signal?: AbortSignal): Promise<Observation[]> {
  if (source.source_type !== "github_repo") return [];
  const [owner, repo] = source.external_id.split("/");
  if (!owner || !repo) return [];
  const observedAt = (opts.now?.() ?? new Date()).toISOString();
  const metrics = await backfillGithubRepoHistory(fetcher, owner, repo, { token: opts.githubToken }, signal);
  return toObservations(metrics, source, observedAt, "github-v1-backfill");
}

/**
 * The generic compare -> derive step: runs every family's rules over one company's FULL
 * observation history (all sources, all metrics) and returns whatever fired. Adding a future
 * family means adding one line here and one rules/<family>.ts, not touching this dispatcher.
 *
 * Runs BOTH the velocity rules (two-or-more observations, "X changed from A to B") and the V2-2B.1
 * level rules (a metric's first-ever observation alone, "X is present/notably high") — see
 * rules/hiring.ts/rules/github.ts's `derive*LevelSignals`. These are complementary, not exclusive:
 * a company can show momentum via Path A (current level) or Path B (velocity) or both.
 *
 * `now` is explicit and injectable (defaults to `new Date()` only for callers that don't already
 * have one threaded through, e.g. ad-hoc tooling/tests) — orchestrate.ts always passes its own
 * `deps.now()` so the whole pass shares one consistent clock.
 *
 * `existingSignals` — this company's already-fired signals — is required for the two velocity-rule
 * families (hiring/github): see rules/format.ts: alreadyReportedValue for why a window comparison
 * needs it to avoid re-firing an unchanged transition on every subsequent run. The level and
 * website-transition rules don't take it: each already fires at most once by construction (a
 * `metricSeries(...).length === 1` gate, or `findFirstAppearance`'s own "never seen present
 * earlier" check), so they need no additional history of what's already been reported.
 */
export function deriveSignalsForCompany(companyId: number, history: readonly Observation[], now: Date = new Date(), existingSignals: readonly ExistingSignalRef[] = []): Omit<DerivedSignal, "id">[] {
  return [
    ...deriveHiringSignals(companyId, history, existingSignals),
    ...deriveGithubSignals(companyId, history, existingSignals),
    ...deriveHiringLevelSignals(companyId, history),
    ...deriveGithubLevelSignals(companyId, history, now),
    ...deriveWebsiteLevelSignals(companyId, history),
    ...deriveWebsiteTransitionSignals(companyId, history),
  ];
}
