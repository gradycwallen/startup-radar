import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCompanySources } from "../src/signals/resolution.ts";
import type { Fetcher, FetchOptions, FetchResult } from "../src/sources/fetcher.ts";
import type { CompanyContext } from "../src/signals/types.ts";

function fakeFetcher(routes: Record<string, { status: number; json?: unknown; text?: string }>): { fetcher: Fetcher; requested: string[] } {
  const requested: string[] = [];
  const fetcher: Fetcher = {
    async getText(url: string, _options?: FetchOptions): Promise<FetchResult> {
      requested.push(url);
      const r = routes[url];
      if (!r) return { url, status: 404, text: "", bytes: 0, elapsed_ms: 0 };
      const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
      return { url, status: r.status, text, bytes: text.length, elapsed_ms: 0 };
    },
  };
  return { fetcher, requested };
}

const company: CompanyContext = { id: 1, name: "Acme Robotics", domain: "acmerobotics.com" };

test("resolution: GitHub org linked from the homepage AND confirmed by its own website field -> homepage_link_confirmed, high confidence", async () => {
  const { fetcher, requested } = fakeFetcher({
    "https://acmerobotics.com/": { status: 200, text: `<a href="https://github.com/acmerobotics">GitHub</a>` },
    "https://api.github.com/orgs/acmerobotics": { status: 200, json: { blog: "https://acmerobotics.com", public_repos: 4 } },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  const r = result.resolved[0]!;
  assert.deepEqual([r.source_type, r.external_id, r.resolution_method], ["github_org", "acmerobotics", "homepage_link_confirmed"]);
  assert.ok(r.resolution_confidence >= 0.9);
  assert.match(r.resolution_evidence, /website field/);
  assert.deepEqual(requested, ["https://acmerobotics.com/", "https://acmerobotics.com/careers", "https://api.github.com/orgs/acmerobotics"]);
});

test("resolution: a linked GitHub repo whose slug closely matches the company name, but with NO confirming metadata -> homepage_link_name_match, lower confidence", async () => {
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.com/": { status: 200, text: `<a href="https://github.com/someoneelse/acmerobotics">code</a>` },
    "https://api.github.com/orgs/someoneelse": { status: 404 },
    "https://api.github.com/users/someoneelse": { status: 200, json: { blog: "", public_repos: 1 } },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  assert.deepEqual([result.resolved[0]!.resolution_method, result.resolved[0]!.external_id], ["homepage_link_name_match", "someoneelse/acmerobotics"]);
  assert.ok(result.resolved[0]!.resolution_confidence < 0.9);
});

test("resolution: a linked GitHub org whose name does NOT resemble the company, with no confirmation, is REJECTED (not returned at all)", async () => {
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.com/": { status: 200, text: `<a href="https://github.com/totally-unrelated-widgets">partner</a>` },
    "https://api.github.com/orgs/totally-unrelated-widgets": { status: 200, json: { blog: "https://unrelatedwidgets.example", public_repos: 9 } },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.deepEqual(result.resolved, []);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0]!.reason, /does not resemble the company name/);
});

test("resolution: GitHub's own navigation paths (e.g. github.com/pricing) are never treated as a candidate org", async () => {
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.com/": { status: 200, text: `<a href="https://github.com/pricing">GitHub Pricing</a><a href="https://github.com/about">About</a>` },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.unresolved, []);
});

test("resolution: Greenhouse board confirmed by its own reported organization name", async () => {
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.com/": { status: 200, text: `<a href="https://boards.greenhouse.io/acmerobotics">Careers</a>` },
    "https://boards-api.greenhouse.io/v1/boards/acmerobotics": { status: 200, json: { name: "Acme Robotics" } },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  assert.deepEqual([result.resolved[0]!.source_type, result.resolved[0]!.resolution_method], ["greenhouse", "homepage_link_confirmed"]);
});

test("resolution: no ATS link on the homepage falls back to checking the conventional /careers page once, never more", async () => {
  const { fetcher, requested } = fakeFetcher({
    "https://acmerobotics.com/": { status: 200, text: `<p>No links here.</p>` },
    "https://acmerobotics.com/careers": { status: 200, text: `<a href="https://jobs.lever.co/acmerobotics">Open roles</a>` },
    "https://api.lever.co/v0/postings/acmerobotics?mode=json": { status: 200, json: [] },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0]!.source_type, "lever");
  assert.equal(requested.length, 3, `expected exactly 3 requests (homepage, careers, lever confirm), got: ${requested.join(", ")}`);
});

test("resolution: an ATS board link that turns out unreachable is reported unresolved with a clear reason, never guessed at", async () => {
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.com/": { status: 200, text: `<a href="https://boards.greenhouse.io/acmerobotics">Careers</a>` },
    "https://boards-api.greenhouse.io/v1/boards/acmerobotics": { status: 500, text: "" },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.deepEqual(result.resolved, []);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0]!.reason, /unreachable/);
});

test("resolution: a homepage that fails to load entirely yields no candidates, not an error", async () => {
  const { fetcher } = fakeFetcher({});
  const result = await resolveCompanySources(company, fetcher);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.unresolved, []);
});
