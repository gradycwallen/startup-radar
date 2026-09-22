import assert from "node:assert/strict";
import { test } from "node:test";
import { backfillGithubRepoHistory } from "../src/signals/sources/github.ts";
import { backfillForSource } from "../src/signals/observe.ts";
import type { Fetcher, FetchOptions, FetchResult } from "../src/sources/fetcher.ts";
import type { SignalSource } from "../src/signals/types.ts";

function fakeFetcher(routes: Record<string, { status: number; json?: unknown }>): Fetcher {
  return {
    async getText(url: string, _options?: FetchOptions): Promise<FetchResult> {
      const r = routes[url];
      if (!r) return { url, status: 404, text: "", bytes: 0, elapsed_ms: 0 };
      const text = r.json !== undefined ? JSON.stringify(r.json) : "";
      return { url, status: r.status, text, bytes: text.length, elapsed_ms: 0 };
    },
  };
}

/** 52 weeks, oldest first, index 51 = the current/most-recent week. `week` is a real Unix
 * timestamp (seconds) per GitHub's own API shape. */
function fakeCommitActivity(totalsFromOldest: number[]): Array<{ week: number; total: number }> {
  const NOW_WEEK_START = Date.UTC(2026, 8, 21) / 1000; // a Monday-ish anchor, seconds
  const WEEK_S = 7 * 86_400;
  const weeks: Array<{ week: number; total: number }> = [];
  for (let i = 0; i < 52; i++) {
    const weeksAgo = 51 - i;
    weeks.push({ week: NOW_WEEK_START - weeksAgo * WEEK_S, total: totalsFromOldest[i] ?? 0 });
  }
  return weeks;
}

test("backfillGithubRepoHistory: reconstructs github_commits_last_4w at real week boundaries near 7/14/30/90 days ago, using REAL weekly totals (no interpolation)", async () => {
  // Give every week a total of 5, so any trailing-4-week sum is predictably 20 wherever it lands.
  const weeks = fakeCommitActivity(Array(52).fill(5));
  const fetcher = fakeFetcher({
    "https://api.github.com/repos/acme/widget/stats/commit_activity": { status: 200, json: weeks },
    "https://api.github.com/repos/acme/widget/releases?per_page=6": { status: 200, json: [] },
  });
  const metrics = await backfillGithubRepoHistory(fetcher, "acme", "widget");
  const commitMetrics = metrics.filter((m) => m.metricName === "github_commits_last_4w");
  assert.equal(commitMetrics.length, 4, "one checkpoint per STANDARD_WINDOWS_DAYS entry (7/14/30/90)");
  for (const m of commitMetrics) {
    assert.equal(m.numericValue, 20, "each checkpoint sums 4 real consecutive weeks of 5 each");
    assert.ok(m.sourceTimestamp, "every backfilled point must carry a real source_timestamp");
    assert.ok(!Number.isNaN(new Date(m.sourceTimestamp!).getTime()), `sourceTimestamp must be a valid date: ${m.sourceTimestamp}`);
  }
  // Checkpoints must be at DISTINCT, chronologically ordered real dates, not duplicates of "now".
  const dates = commitMetrics.map((m) => new Date(m.sourceTimestamp!).getTime()).sort((a, b) => a - b);
  assert.ok(new Set(dates).size === dates.length, "no duplicate historical observations");
  for (const d of dates) assert.ok(d < Date.now(), "every backfilled checkpoint must be in the past, never today's live point");
});

test("backfillGithubRepoHistory: a checkpoint that the 52-week array cannot reach is SKIPPED, never padded or guessed", async () => {
  // Only 10 weeks of real data (a young repo) — the 30d/90d checkpoints (needing 4+/13+ weeks back)
  // cannot be reconstructed and must be silently skipped, not fabricated as zero or interpolated.
  const NOW_WEEK_START = Date.UTC(2026, 8, 21) / 1000;
  const WEEK_S = 7 * 86_400;
  const weeks = Array.from({ length: 10 }, (_, i) => ({ week: NOW_WEEK_START - (9 - i) * WEEK_S, total: 3 }));
  const fetcher = fakeFetcher({
    "https://api.github.com/repos/acme/newrepo/stats/commit_activity": { status: 200, json: weeks },
    "https://api.github.com/repos/acme/newrepo/releases?per_page=6": { status: 200, json: [] },
  });
  const metrics = await backfillGithubRepoHistory(fetcher, "acme", "newrepo");
  const commitMetrics = metrics.filter((m) => m.metricName === "github_commits_last_4w");
  // 7d (1 week back) and 14d (2 weeks back) need indices reachable within 10 weeks; 30d/90d do not.
  assert.ok(commitMetrics.length < 4, "checkpoints beyond the real data's reach must be skipped, not invented");
  assert.ok(commitMetrics.length > 0, "the checkpoints that ARE reachable should still be produced");
});

test("backfillGithubRepoHistory: past releases beyond the current one are backfilled with their OWN real published_at, the current one is left to live collection", async () => {
  const fetcher = fakeFetcher({
    "https://api.github.com/repos/acme/widget/stats/commit_activity": { status: 200, json: [] },
    "https://api.github.com/repos/acme/widget/releases?per_page=6": {
      status: 200,
      json: [
        { published_at: "2026-09-20T00:00:00Z" }, // current — NOT backfilled, already covered by live collection
        { published_at: "2026-08-01T00:00:00Z" },
        { published_at: "2026-06-15T00:00:00Z" },
      ],
    },
  });
  const metrics = await backfillGithubRepoHistory(fetcher, "acme", "widget");
  const releaseMetrics = metrics.filter((m) => m.metricName === "github_latest_release_at");
  assert.equal(releaseMetrics.length, 2);
  assert.deepEqual(releaseMetrics.map((m) => m.textValue).sort(), ["2026-06-15T00:00:00Z", "2026-08-01T00:00:00Z"]);
  for (const m of releaseMetrics) assert.equal(m.sourceTimestamp, m.textValue, "source_timestamp is that release's own real published_at");
  assert.ok(!releaseMetrics.some((m) => m.textValue === "2026-09-20T00:00:00Z"), "the current release is the live collector's job, not backfill's");
});

test("backfillGithubRepoHistory: no stars/forks/issues/contributors are ever backfilled — GitHub's API has no historical endpoint for these, so there is no source-supported fact to use", async () => {
  const weeks = fakeCommitActivity(Array(52).fill(2));
  const fetcher = fakeFetcher({
    "https://api.github.com/repos/acme/widget/stats/commit_activity": { status: 200, json: weeks },
    "https://api.github.com/repos/acme/widget/releases?per_page=6": { status: 200, json: [] },
  });
  const metrics = await backfillGithubRepoHistory(fetcher, "acme", "widget");
  const names = new Set(metrics.map((m) => m.metricName));
  for (const forbidden of ["github_stars", "github_forks", "github_open_issues", "github_contributors"]) {
    assert.ok(!names.has(forbidden), `${forbidden} has no historical source data and must never be backfilled`);
  }
});

test("backfillGithubRepoHistory: a 404/unreachable repo yields no metrics, never a fabricated empty history", async () => {
  const fetcher = fakeFetcher({});
  const metrics = await backfillGithubRepoHistory(fetcher, "ghost", "repo");
  assert.deepEqual(metrics, []);
});

// ---- observe.ts dispatcher ---------------------------------------------------------------------------------------

const baseSource: Omit<SignalSource, "id"> = {
  company_id: 1, source_type: "github_repo", external_id: "acme/widget", canonical_url: null,
  resolution_method: "homepage_link_confirmed", resolution_confidence: 0.95, resolution_evidence: "test", active: true, metadata: null,
};

test("backfillForSource: dispatches github_repo to the backfill collector and stamps company_id/signal_source_id, using collection_version 'github-v1-backfill' (never conflated with live collection's own version)", async () => {
  const fetcher = fakeFetcher({
    "https://api.github.com/repos/acme/widget/stats/commit_activity": { status: 200, json: fakeCommitActivity(Array(52).fill(3)) },
    "https://api.github.com/repos/acme/widget/releases?per_page=6": { status: 200, json: [] },
  });
  const source: SignalSource = { id: 42, ...baseSource };
  const observations = await backfillForSource(source, fetcher, { now: () => new Date("2026-09-22T12:00:00Z") });
  assert.ok(observations.length > 0);
  for (const o of observations) {
    assert.equal(o.company_id, 1);
    assert.equal(o.signal_source_id, 42);
    assert.equal(o.observed_at, "2026-09-22T12:00:00.000Z", "observed_at is honestly 'now' (when backfill ran), never backdated");
    assert.equal(o.collection_version, "github-v1-backfill");
    assert.ok(o.source_timestamp, "every backfilled row carries a real historical source_timestamp");
  }
});

test("backfillForSource: every OTHER source type returns no observations — ATS backfill was investigated and deliberately deferred (see the V2-2B.1 report)", async () => {
  const fetcher = fakeFetcher({});
  for (const sourceType of ["github_org", "greenhouse", "lever", "ashby"] as const) {
    const source: SignalSource = { id: 1, ...baseSource, source_type: sourceType, external_id: sourceType === "github_org" ? "acme" : "acme-board" };
    const observations = await backfillForSource(source, fetcher);
    assert.deepEqual(observations, [], `${sourceType} must not attempt backfill yet`);
  }
});

test("backfillForSource: a malformed github_repo external_id (no owner/repo split) yields no observations rather than throwing", async () => {
  const source: SignalSource = { id: 1, ...baseSource, external_id: "not-a-valid-repo-id" };
  const observations = await backfillForSource(source, fakeFetcher({}));
  assert.deepEqual(observations, []);
});
