import type { Fetcher } from "../../sources/fetcher.ts";
import { STANDARD_WINDOWS_DAYS } from "../velocity.ts";
import type { CollectedMetric, CollectionResult } from "./types.ts";

/**
 * GitHub collector. Official REST API only (docs.github.com/rest), read-only, through the same
 * PoliteFetcher every other source in this codebase uses.
 *
 * Deliberately excluded as vanity/redundant:
 *  - "watchers": GitHub's `watchers_count` has been identical to `stargazers_count` for years
 *    (the old separate "watch" concept was renamed "subscribe"); tracking it separately would be
 *    double-counting stars under a different name, not a second signal.
 *  - the full contributor LIST: only the COUNT is collected (via the `Link` response header's
 *    last page number on a `per_page=1` request — one cheap request, no pagination needed).
 *
 * `collection_version: "github-v1"` — bump this and the rule_version in rules/github.ts together
 * if the metric set or its meaning changes; never silently redefine an existing metric name.
 */
export const GITHUB_COLLECTOR_VERSION = "github-v1";

export interface GithubCollectorOptions {
  /** Optional personal access token (`public_repo` read scope is enough) — raises the rate limit
   * from 60/hr to 5,000/hr. Never hardcode one; read from an env var at the call site. */
  token?: string;
}

function authHeaders(opts: GithubCollectorOptions): Record<string, string> {
  const headers: Record<string, string> = { "x-github-api-version": "2022-11-28" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return headers;
}

async function getJson(fetcher: Fetcher, url: string, opts: GithubCollectorOptions, signal: AbortSignal | undefined): Promise<{ status: number; json: unknown }> {
  const res = await fetcher.getText(url, { accept: "application/vnd.github+json", provider: "signals-github", signal, headers: authHeaders(opts) });
  let json: unknown = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Repo-level metrics for a specific `owner/repo`.
 * Note on contributor count: PoliteFetcher's FetchResult intentionally does not expose response
 * headers (see src/sources/fetcher.ts), so the `Link`-header pagination trick GitHub's docs
 * recommend for a cheap contributor count is not available through it. Falling back to the
 * `/contributors` array length on a single capped page (`per_page=100`) — exact up to 100
 * contributors, a documented lower bound ("100+") beyond that. This is disclosed as a known
 * limitation in the V2-2A report, not silently approximated.
 */
export async function collectGithubRepo(fetcher: Fetcher, owner: string, repo: string, opts: GithubCollectorOptions = {}, signal?: AbortSignal): Promise<CollectionResult> {
  const metrics: CollectedMetric[] = [];
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const repoRes = await getJson(fetcher, base, opts, signal);
  if (repoRes.status === 200 && repoRes.json && typeof repoRes.json === "object") {
    const r = repoRes.json as Record<string, unknown>;
    metrics.push({ metricName: "github_stars", numericValue: num(r.stargazers_count), textValue: null, sourceTimestamp: null });
    metrics.push({ metricName: "github_forks", numericValue: num(r.forks_count), textValue: null, sourceTimestamp: null });
    metrics.push({ metricName: "github_open_issues", numericValue: num(r.open_issues_count), textValue: null, sourceTimestamp: null });
    metrics.push({ metricName: "github_repo_created_at", numericValue: null, textValue: str(r.created_at), sourceTimestamp: str(r.created_at) });
    metrics.push({ metricName: "github_repo_pushed_at", numericValue: null, textValue: str(r.pushed_at), sourceTimestamp: str(r.pushed_at) });
  }

  const contributorsRes = await getJson(fetcher, `${base}/contributors?per_page=100&anon=false`, opts, signal);
  if (contributorsRes.status === 200 && Array.isArray(contributorsRes.json)) {
    const count = contributorsRes.json.length;
    metrics.push({ metricName: "github_contributors", numericValue: count, textValue: count >= 100 ? "100+" : null, sourceTimestamp: null });
  }

  // /stats/commit_activity can return 202 while GitHub computes it for the first time (async, cached
  // after). A 202 is recorded as "not yet available" this pass rather than retried with a wait —
  // deterministic collection must not block on an unbounded async job; a later scheduled pass will
  // very likely see it cached.
  const commitsRes = await getJson(fetcher, `${base}/stats/commit_activity`, opts, signal);
  if (commitsRes.status === 200 && Array.isArray(commitsRes.json)) {
    const weeks = commitsRes.json as Array<{ total?: number }>;
    const last4 = weeks.slice(-4).reduce((sum, w) => sum + (typeof w.total === "number" ? w.total : 0), 0);
    metrics.push({ metricName: "github_commits_last_4w", numericValue: last4, textValue: null, sourceTimestamp: null });
  }

  const releasesRes = await getJson(fetcher, `${base}/releases?per_page=1`, opts, signal);
  if (releasesRes.status === 200 && Array.isArray(releasesRes.json) && releasesRes.json.length > 0) {
    const latest = releasesRes.json[0] as Record<string, unknown>;
    metrics.push({ metricName: "github_latest_release_at", numericValue: null, textValue: str(latest.published_at), sourceTimestamp: str(latest.published_at) });
  }

  return { metrics, collectionVersion: GITHUB_COLLECTOR_VERSION, sourceStatus: repoRes.status };
}

/**
 * V2-2B.1: one-time historical backfill for a repo, run ONCE at the moment a company's GitHub
 * source is first resolved (see orchestrate.ts) — never on ongoing daily collection, which keeps
 * capturing only "now" exactly as before. Gives a brand-new company's velocity math real history
 * to work with immediately, instead of needing to wait real days/weeks for a second live
 * observation to accumulate.
 *
 * ONLY source-supported historical facts are persisted, each with a real `sourceTimestamp` GitHub
 * itself reported — never interpolated, never guessed. Two things are backfilled:
 *
 *  1. `github_commits_last_4w` at several REAL past week boundaries — computed by summing four
 *     CONSECUTIVE real weekly totals from `/stats/commit_activity`'s own 52-week array (the same
 *     metric the live collector already reports, just evaluated at earlier real points instead of
 *     only "now"). This is aggregation of real weekly data GitHub reported, not interpolation
 *     between two known values — no week's commit count is ever invented. Checkpoints are chosen
 *     at STANDARD_WINDOWS_DAYS (7/14/30/90 days ago, converted to whole weeks) so velocity.ts's
 *     window comparisons have real history to find immediately; a checkpoint is skipped outright
 *     if the 52-week array doesn't actually reach back that far (never padded/guessed).
 *  2. `github_latest_release_at` for each of the next few PAST releases beyond the one the live
 *     collector already captures (fetched once, `per_page=6`) — each with its own real
 *     `published_at` as `sourceTimestamp`. At each of those real past moments, that release WAS
 *     genuinely the latest known one; this is exactly the history the existing `release_activity`
 *     velocity rule already knows how to compare.
 *
 * Deliberately NOT backfilled: `github_stars`/`github_forks`/`github_open_issues`/
 * `github_contributors` — GitHub's REST API exposes no historical endpoint for any of these (only
 * a current snapshot), so there is no source-supported fact to backfill; inventing one would be
 * exactly the "fake daily observations by interpolating aggregate values" this is required not to do.
 */
export async function backfillGithubRepoHistory(fetcher: Fetcher, owner: string, repo: string, opts: GithubCollectorOptions = {}, signal?: AbortSignal): Promise<CollectedMetric[]> {
  const metrics: CollectedMetric[] = [];
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const commitsRes = await getJson(fetcher, `${base}/stats/commit_activity`, opts, signal);
  if (commitsRes.status === 200 && Array.isArray(commitsRes.json)) {
    const weeks = commitsRes.json as Array<{ total?: number; week?: number }>; // oldest first; last entry = the current week
    for (const days of STANDARD_WINDOWS_DAYS) {
      const weeksAgo = Math.round(days / 7);
      if (weeksAgo < 1) continue; // "now" — already covered by the live collector, not a backfill point
      const endIndex = weeks.length - 1 - weeksAgo;
      const startIndex = endIndex - 3;
      if (startIndex < 0) continue; // the real weekly history doesn't reach back this far — skip, never pad
      const slice = weeks.slice(startIndex, endIndex + 1);
      if (slice.length !== 4) continue;
      const weekTimestamp = weeks[endIndex]?.week;
      if (typeof weekTimestamp !== "number") continue; // no real source-reported week boundary — skip, never guess
      const sum = slice.reduce((sum, w) => sum + (typeof w.total === "number" ? w.total : 0), 0);
      metrics.push({ metricName: "github_commits_last_4w", numericValue: sum, textValue: null, sourceTimestamp: new Date(weekTimestamp * 1000).toISOString() });
    }
  }

  const releasesRes = await getJson(fetcher, `${base}/releases?per_page=6`, opts, signal);
  if (releasesRes.status === 200 && Array.isArray(releasesRes.json)) {
    // index 0 is the current/latest release — already captured by the live collector's own
    // per_page=1 request; backfill only the PAST releases beyond that.
    for (const release of (releasesRes.json as Array<Record<string, unknown>>).slice(1)) {
      const publishedAt = str(release.published_at);
      if (publishedAt) metrics.push({ metricName: "github_latest_release_at", numericValue: null, textValue: publishedAt, sourceTimestamp: publishedAt });
    }
  }

  return metrics;
}

/** Org-level metrics for a GitHub organization/user (no specific repo resolved). */
export async function collectGithubOrg(fetcher: Fetcher, org: string, opts: GithubCollectorOptions = {}, signal?: AbortSignal): Promise<CollectionResult> {
  const metrics: CollectedMetric[] = [];
  let status = 0;
  for (const kind of ["orgs", "users"]) {
    const res = await getJson(fetcher, `https://api.github.com/${kind}/${org}`, opts, signal);
    status = res.status;
    if (res.status === 404) continue;
    if (res.status === 200 && res.json && typeof res.json === "object") {
      const r = res.json as Record<string, unknown>;
      metrics.push({ metricName: "github_org_public_repos", numericValue: num(r.public_repos), textValue: null, sourceTimestamp: null });
    }
    break;
  }
  return { metrics, collectionVersion: GITHUB_COLLECTOR_VERSION, sourceStatus: status };
}
