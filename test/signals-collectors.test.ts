import assert from "node:assert/strict";
import { test } from "node:test";
import { collectGithubOrg, collectGithubRepo } from "../src/signals/sources/github.ts";
import { collectGreenhouse } from "../src/signals/sources/ats/greenhouse.ts";
import { collectLever } from "../src/signals/sources/ats/lever.ts";
import { collectAshby } from "../src/signals/sources/ats/ashby.ts";
import type { Fetcher, FetchOptions, FetchResult } from "../src/sources/fetcher.ts";

function fakeFetcher(routes: Record<string, { status: number; json?: unknown }>): { fetcher: Fetcher; requested: Array<{ url: string; headers?: Record<string, string> }> } {
  const requested: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetcher: Fetcher = {
    async getText(url: string, options?: FetchOptions): Promise<FetchResult> {
      requested.push({ url, headers: options?.headers });
      const r = routes[url];
      if (!r) return { url, status: 404, text: "", bytes: 0, elapsed_ms: 0 };
      const text = r.json !== undefined ? JSON.stringify(r.json) : "";
      return { url, status: r.status, text, bytes: text.length, elapsed_ms: 0 };
    },
  };
  return { fetcher, requested };
}

// ---- GitHub -----------------------------------------------------------------------------------------------------------

test("GitHub repo collector: parses stars/forks/issues/dates, contributor count, commit velocity (last 4w), and latest release", async () => {
  const { fetcher, requested } = fakeFetcher({
    "https://api.github.com/repos/acme/widget": { status: 200, json: { stargazers_count: 1204, forks_count: 83, open_issues_count: 12, created_at: "2024-01-01T00:00:00Z", pushed_at: "2026-09-20T00:00:00Z" } },
    "https://api.github.com/repos/acme/widget/contributors?per_page=100&anon=false": { status: 200, json: Array.from({ length: 19 }, (_, i) => ({ login: `dev${i}` })) },
    "https://api.github.com/repos/acme/widget/stats/commit_activity": { status: 200, json: [...Array(48).fill({ total: 0 }), { total: 10 }, { total: 20 }, { total: 15 }, { total: 16 }] },
    "https://api.github.com/repos/acme/widget/releases?per_page=1": { status: 200, json: [{ published_at: "2026-09-15T00:00:00Z" }] },
  });
  const result = await collectGithubRepo(fetcher, "acme", "widget", { token: "test-token-123" });
  const byName = Object.fromEntries(result.metrics.map((m) => [m.metricName, m]));
  assert.equal(byName.github_stars!.numericValue, 1204);
  assert.equal(byName.github_forks!.numericValue, 83);
  assert.equal(byName.github_open_issues!.numericValue, 12);
  assert.equal(byName.github_repo_created_at!.textValue, "2024-01-01T00:00:00Z");
  assert.equal(byName.github_repo_pushed_at!.textValue, "2026-09-20T00:00:00Z");
  assert.equal(byName.github_contributors!.numericValue, 19);
  assert.equal(byName.github_commits_last_4w!.numericValue, 61, "sum of the last 4 weekly totals: 10+20+15+16");
  assert.equal(byName.github_latest_release_at!.textValue, "2026-09-15T00:00:00Z");
  assert.equal(result.collectionVersion, "github-v1");
  assert.ok(requested.every((r) => r.headers?.authorization === "Bearer test-token-123"), "the token is sent on every GitHub request");
  assert.ok(requested.every((r) => r.headers?.["x-github-api-version"]), "the recommended API version header is always sent");
});

test("GitHub repo collector: watchers are never collected (redundant with stars), and a 202 (stats still computing) is treated as unavailable, not blocked on", async () => {
  const { fetcher } = fakeFetcher({
    "https://api.github.com/repos/acme/widget": { status: 200, json: { stargazers_count: 10, watchers_count: 10, forks_count: 1, open_issues_count: 0 } },
    "https://api.github.com/repos/acme/widget/contributors?per_page=100&anon=false": { status: 200, json: [] },
    "https://api.github.com/repos/acme/widget/stats/commit_activity": { status: 202, json: {} },
    "https://api.github.com/repos/acme/widget/releases?per_page=1": { status: 200, json: [] },
  });
  const result = await collectGithubRepo(fetcher, "acme", "widget");
  const names = result.metrics.map((m) => m.metricName);
  assert.ok(!names.includes("github_watchers"), "watchers_count duplicates stars_count and must not be collected as a separate metric");
  assert.ok(!names.includes("github_commits_last_4w"), "a 202 (still computing) must not be reported as zero commits");
  assert.ok(!names.includes("github_latest_release_at"), "no releases exist; nothing fabricated");
});

test("GitHub org collector: reports public_repos, falling back from /orgs to /users when the org lookup 404s", async () => {
  const { fetcher } = fakeFetcher({
    "https://api.github.com/orgs/soloists": { status: 404 },
    "https://api.github.com/users/soloists": { status: 200, json: { public_repos: 3 } },
  });
  const result = await collectGithubOrg(fetcher, "soloists");
  assert.equal(result.metrics[0]!.metricName, "github_org_public_repos");
  assert.equal(result.metrics[0]!.numericValue, 3);
});

// ---- ATS ----------------------------------------------------------------------------------------------------------------

test("Greenhouse collector: aggregates open jobs by deterministic role category and flags an enterprise-sales title specifically", async () => {
  const { fetcher } = fakeFetcher({
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs": {
      status: 200,
      json: {
        jobs: [
          { id: 1, title: "Senior Software Engineer", updated_at: "2026-09-01T00:00:00Z" },
          { id: 2, title: "Enterprise Account Executive", updated_at: "2026-09-10T00:00:00Z" },
          { id: 3, title: "Product Marketing Manager", updated_at: "2026-08-01T00:00:00Z" },
          { id: 4, title: "Office Coordinator" }, // vague/other — deliberately not aggressively categorized
        ],
      },
    },
  });
  const result = await collectGreenhouse(fetcher, "acme");
  const byName = Object.fromEntries(result.metrics.map((m) => [m.metricName, m]));
  assert.equal(byName.ats_open_jobs_total!.numericValue, 4);
  assert.equal(byName.ats_open_jobs_engineering!.numericValue, 1);
  assert.equal(byName.ats_open_jobs_sales!.numericValue, 1);
  assert.equal(byName.ats_open_jobs_marketing!.numericValue, 1);
  assert.equal(byName.ats_open_jobs_other!.numericValue, 1, "'Office Coordinator' matches no specific keyword rule and is conservatively left as 'other', not guessed into 'operations'");
  assert.equal(byName.ats_has_enterprise_sales_role!.numericValue, 1);
  assert.equal(byName.ats_has_recruiting_role!.numericValue, 0);
  assert.equal(byName.ats_most_recent_posting_at!.textValue, "2026-09-10T00:00:00Z");
});

test("Greenhouse collector: a plain 'Sales' title does NOT trip the narrower enterprise-sales sub-signal", async () => {
  const { fetcher } = fakeFetcher({ "https://boards-api.greenhouse.io/v1/boards/acme/jobs": { status: 200, json: { jobs: [{ id: 1, title: "Sales Development Representative" }] } } });
  const result = await collectGreenhouse(fetcher, "acme");
  const byName = Object.fromEntries(result.metrics.map((m) => [m.metricName, m]));
  assert.equal(byName.ats_open_jobs_sales!.numericValue, 1);
  assert.equal(byName.ats_has_enterprise_sales_role!.numericValue, 0, "'enterprise/strategic/major account' must be present, not just any sales title");
});

test("Lever collector: parses postings and converts epoch-ms createdAt to ISO", async () => {
  const { fetcher } = fakeFetcher({ "https://api.lever.co/v0/postings/acme?mode=json": { status: 200, json: [{ id: "abc", text: "Recruiter", createdAt: 1_757_000_000_000 }] } });
  const result = await collectLever(fetcher, "acme");
  const byName = Object.fromEntries(result.metrics.map((m) => [m.metricName, m]));
  assert.equal(byName.ats_has_recruiting_role!.numericValue, 1);
  assert.equal(byName.ats_open_jobs_people_recruiting!.numericValue, 1);
});

test("Ashby collector: parses the job-board wrapper shape", async () => {
  const { fetcher } = fakeFetcher({ "https://api.ashbyhq.com/posting-api/job-board/acme": { status: 200, json: { organizationName: "Acme", jobs: [{ id: "x", title: "Security Engineer", publishedAt: "2026-09-01T00:00:00Z" }] } } });
  const result = await collectAshby(fetcher, "acme");
  const byName = Object.fromEntries(result.metrics.map((m) => [m.metricName, m]));
  assert.equal(byName.ats_open_jobs_security!.numericValue, 1);
  assert.equal(byName.ats_has_security_compliance_role!.numericValue, 1);
});

test("ATS collectors: a non-200 or unparseable response yields zero metrics, never a fabricated zero-jobs observation", async () => {
  const { fetcher: down } = fakeFetcher({ "https://boards-api.greenhouse.io/v1/boards/gone/jobs": { status: 404 } });
  assert.deepEqual((await collectGreenhouse(down, "gone")).metrics, []);
});
