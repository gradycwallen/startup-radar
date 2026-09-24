import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCompanySources } from "../src/signals/resolution.ts";
import type { Fetcher, FetchOptions, FetchResult } from "../src/sources/fetcher.ts";
import type { CompanyContext } from "../src/signals/types.ts";

/**
 * V2-2C.1 — hiring source resolver coverage fix. Regression suite for the three new candidate-
 * discovery mechanisms (script-src, embedded-text) and the /jobs fallback, per the delivery brief's
 * required cases A–L. Fixtures B/C/D use trimmed excerpts of the REAL page structure captured
 * during the live hiring audit (Chamelio/Glow/XDOF), not hand-invented markup — same discipline as
 * the domain-verify Ande/Travix regression tests.
 *
 * Ashby's real public job-board API (`api.ashbyhq.com/posting-api/job-board/{org}`) returns only
 * `{jobs, apiVersion}` — confirmed live during the audit, no `organizationName` field exists. Every
 * Ashby fixture below therefore resolves via the SECOND confidence tier (`homepage_link_name_match`,
 * name similarity ≥0.75), never the first — this is confirmAts's existing, unmodified behavior for
 * every Ashby board, not something loosened for these tests.
 */

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

const ashbyBoard = (jobCount: number) => ({ status: 200, json: { jobs: Array.from({ length: jobCount }, (_, i) => ({ id: `job-${i}` })), apiVersion: "1" } });

// ---- A. existing anchor-link Ashby resolution still works ---------------------------------------------------------

test("A. anchor-link Ashby resolution still works (pre-existing path, untouched)", async () => {
  const company: CompanyContext = { id: 1, name: "Acme", domain: "acme.example" };
  const { fetcher } = fakeFetcher({
    "https://acme.example/": { status: 200, text: `<a href="https://jobs.ashbyhq.com/acme">Careers</a>` },
    "https://api.ashbyhq.com/posting-api/job-board/acme": ashbyBoard(5),
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  assert.deepEqual([result.resolved[0]!.source_type, result.resolved[0]!.external_id, result.resolved[0]!.resolution_method], ["ashby", "acme", "homepage_link_name_match"]);
});

// ---- B. Glow pattern: <script src="...embed..."> ------------------------------------------------------------------

test("B. Glow pattern: Ashby embedded via <script src> (no anchor at all) -> discovered, confirmAts succeeds", async () => {
  const company: CompanyContext = { id: 2, name: "Glow", domain: "glow.example" };
  const { fetcher } = fakeFetcher({
    "https://glow.example/": { status: 200, text: `<p>Careers</p>` },
    "https://glow.example/careers": {
      status: 200,
      text: `<div id="ashby_embed"></div><script src="https://jobs.ashbyhq.com/glow/embed?version=2"></script>`,
    },
    "https://api.ashbyhq.com/posting-api/job-board/glow": ashbyBoard(18),
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  assert.deepEqual([result.resolved[0]!.source_type, result.resolved[0]!.external_id, result.resolved[0]!.resolution_method], ["ashby", "glow", "homepage_link_name_match"]);
});

// ---- C. Chamelio pattern: inline config + script src, deduped to ONE confirmation -----------------------------------

test("C. Chamelio pattern: inline Ashby config AND a <script src> both present -> deduped to ONE candidate, ONE confirmation call", async () => {
  const company: CompanyContext = { id: 3, name: "Chamelio", domain: "chamelio.example" };
  const { fetcher, requested } = fakeFetcher({
    "https://chamelio.example/": { status: 200, text: `<p>Home</p>` },
    "https://chamelio.example/careers": {
      status: 200,
      text: `<script>window.__Ashby = {settings: {ashbyBaseJobBoardUrl: 'https://jobs.ashbyhq.com/chamelio'}};</script>\n<script src="https://jobs.ashbyhq.com/chamelio/embed?version=2"></script>`,
    },
    "https://api.ashbyhq.com/posting-api/job-board/chamelio": ashbyBoard(10),
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  assert.deepEqual([result.resolved[0]!.source_type, result.resolved[0]!.external_id, result.resolved[0]!.resolution_method], ["ashby", "chamelio", "homepage_link_name_match"]);
  const confirmCalls = requested.filter((u) => u.includes("api.ashbyhq.com"));
  assert.equal(confirmCalls.length, 1, `expected exactly one Ashby confirmation call, got: ${confirmCalls.join(", ")}`);
});

// ---- D. XDOF pattern: many per-job URLs inside server-rendered JSON, no bare board link at all ------------------------

test("D. XDOF pattern: multiple per-job Ashby application URLs embedded in JSON -> all normalize to ONE board candidate", async () => {
  const company: CompanyContext = { id: 4, name: "XDOF", domain: "xdof.example" };
  const jobJson = JSON.stringify({
    props: {
      jobs: [
        { applyUrl: "https://jobs.ashbyhq.com/XDOF/14299b6f-727a-4947-be1a-2b288a32a6b8/application", jobUrl: "https://jobs.ashbyhq.com/XDOF/14299b6f-727a-4947-be1a-2b288a32a6b8" },
        { applyUrl: "https://jobs.ashbyhq.com/XDOF/d565027e-297d-46c4-9bec-61e9c00dbdb6/application", jobUrl: "https://jobs.ashbyhq.com/XDOF/d565027e-297d-46c4-9bec-61e9c00dbdb6" },
        { applyUrl: "https://jobs.ashbyhq.com/XDOF/cd508d93-5ae9-486a-a633-48402ef1fe53/application", jobUrl: "https://jobs.ashbyhq.com/XDOF/cd508d93-5ae9-486a-a633-48402ef1fe53" },
      ],
    },
  });
  const { fetcher, requested } = fakeFetcher({
    "https://xdof.example/": { status: 200, text: `<p>Home</p>` },
    "https://xdof.example/careers": { status: 200, text: `<script id="__NEXT_DATA__" type="application/json">${jobJson}</script>` },
    "https://api.ashbyhq.com/posting-api/job-board/xdof": ashbyBoard(20),
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  assert.deepEqual([result.resolved[0]!.source_type, result.resolved[0]!.external_id, result.resolved[0]!.canonical_url], ["ashby", "xdof", "https://jobs.ashbyhq.com/xdof"]);
  const confirmCalls = requested.filter((u) => u.includes("api.ashbyhq.com"));
  assert.equal(confirmCalls.length, 1, `expected exactly one Ashby confirmation call despite 6 distinct embedded URLs, got: ${confirmCalls.join(", ")}`);
});

// ---- E. wrong-company Ashby URL: discovered but REJECTED by identity confirmation ---------------------------------

test("E. Company A's page mentions Company B's Ashby board (e.g. a blog post) -> candidate discovered, confirmAts/name-similarity REJECTS it, no source created", async () => {
  const company: CompanyContext = { id: 5, name: "Acme Robotics", domain: "acmerobotics.example" };
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.example/": {
      status: 200,
      text: `<article>Great writeup — see how our friends at TotallyUnrelatedCo hire: <script src="https://jobs.ashbyhq.com/totallyunrelatedco/embed?version=2"></script></article>`,
    },
    "https://api.ashbyhq.com/posting-api/job-board/totallyunrelatedco": ashbyBoard(3),
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.deepEqual(result.resolved, [], "a wrong-company board must never be accepted");
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0]!.reason, /does not resemble the company name/);
});

// ---- F. an unsupported hiring-jobs domain embedded in raw text is completely ignored ---------------------------------

test("F. raw text mentioning an UNSUPPORTED jobs domain is ignored entirely (not even a candidate)", async () => {
  const company: CompanyContext = { id: 6, name: "Acme", domain: "acme.example" };
  const { fetcher } = fakeFetcher({
    "https://acme.example/": { status: 200, text: `<p>We use Teamtailor: https://jobs.teamtailor.com/acme for hiring.</p>` },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.unresolved, [], "an unsupported host must never even register as a candidate, let alone an unresolved one");
});

// ---- G. the exact same URL appearing via anchor AND embedded text still yields ONE candidate ------------------------

test("G. duplicate URLs across an anchor AND embedded raw text -> ONE candidate, ONE confirmation", async () => {
  const company: CompanyContext = { id: 7, name: "Acme", domain: "acme.example" };
  const { fetcher, requested } = fakeFetcher({
    "https://acme.example/": {
      status: 200,
      text: `<a href="https://jobs.ashbyhq.com/acme">Careers</a><script>var x = "https://jobs.ashbyhq.com/acme";</script>`,
    },
    "https://api.ashbyhq.com/posting-api/job-board/acme": ashbyBoard(2),
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  const confirmCalls = requested.filter((u) => u.includes("api.ashbyhq.com"));
  assert.equal(confirmCalls.length, 1);
});

// ---- H/I/J. existing Greenhouse / Lever / GitHub resolution unaffected by the new discovery paths --------------------

test("H. existing Greenhouse anchor resolution is unaffected by the new discovery paths", async () => {
  const company: CompanyContext = { id: 8, name: "Acme Robotics", domain: "acmerobotics.example" };
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.example/": { status: 200, text: `<a href="https://boards.greenhouse.io/acmerobotics">Careers</a>` },
    "https://boards-api.greenhouse.io/v1/boards/acmerobotics": { status: 200, json: { name: "Acme Robotics" } },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  assert.deepEqual([result.resolved[0]!.source_type, result.resolved[0]!.resolution_method], ["greenhouse", "homepage_link_confirmed"]);
});

test("I. existing Lever /careers-fallback resolution is unaffected by the new discovery paths", async () => {
  const company: CompanyContext = { id: 9, name: "Acme Robotics", domain: "acmerobotics.example" };
  const { fetcher, requested } = fakeFetcher({
    "https://acmerobotics.example/": { status: 200, text: `<p>No links here.</p>` },
    "https://acmerobotics.example/careers": { status: 200, text: `<a href="https://jobs.lever.co/acmerobotics">Open roles</a>` },
    "https://api.lever.co/v0/postings/acmerobotics?mode=json": { status: 200, json: [] },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0]!.source_type, "lever");
  assert.equal(requested.length, 3, `expected exactly 3 requests (homepage, careers, lever confirm — /jobs never tried once an ATS candidate exists), got: ${requested.join(", ")}`);
});

test("J. existing GitHub org confirmation is unaffected by the new discovery paths", async () => {
  const company: CompanyContext = { id: 10, name: "Acme Robotics", domain: "acmerobotics.example" };
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.example/": { status: 200, text: `<a href="https://github.com/acmerobotics">GitHub</a>` },
    "https://acmerobotics.example/careers": { status: 404, text: "" },
    "https://acmerobotics.example/jobs": { status: 404, text: "" },
    "https://api.github.com/orgs/acmerobotics": { status: 200, json: { blog: "https://acmerobotics.example", public_repos: 4 } },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.equal(result.resolved.length, 1);
  assert.deepEqual([result.resolved[0]!.source_type, result.resolved[0]!.resolution_method], ["github_org", "homepage_link_confirmed"]);
});

// ---- K. request bound remains enforced, even in the worst case (no candidate ever found) -----------------------------

test("K. request bound remains enforced: at most 3 page fetches (homepage, /careers, /jobs), never a 4th, even with zero candidates throughout", async () => {
  const company: CompanyContext = { id: 11, name: "Acme", domain: "acme.example" };
  const { fetcher, requested } = fakeFetcher({
    "https://acme.example/": { status: 200, text: `<p>Nothing here.</p>` },
    "https://acme.example/careers": { status: 200, text: `<p>Also nothing.</p>` },
    "https://acme.example/jobs": { status: 200, text: `<p>Still nothing.</p>` },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(requested, ["https://acme.example/", "https://acme.example/careers", "https://acme.example/jobs"]);
  assert.equal(result.pagesChecked.length, 3);
});

test("K (bound holds even with a candidate on every single page): candidate discovery never causes MORE than the documented page fetches", async () => {
  const company: CompanyContext = { id: 12, name: "Acme", domain: "acme.example" };
  const { fetcher, requested } = fakeFetcher({
    "https://acme.example/": { status: 200, text: `<a href="https://jobs.ashbyhq.com/acme">Careers</a>` },
    "https://api.ashbyhq.com/posting-api/job-board/acme": ashbyBoard(1),
  });
  await resolveCompanySources(company, fetcher);
  // homepage + 1 confirmation call only — an ATS candidate on the homepage stops /careers and /jobs from ever being tried.
  assert.equal(requested.length, 2, `expected exactly 2 requests, got: ${requested.join(", ")}`);
});

// ---- L. a genuinely absent source stays unresolved, never fabricated ------------------------------------------------

test("L. no candidate anywhere (homepage, careers, jobs all empty) -> resolved and unresolved both stay empty, never fabricated", async () => {
  const company: CompanyContext = { id: 13, name: "Acme", domain: "acme.example" };
  const { fetcher } = fakeFetcher({
    "https://acme.example/": { status: 200, text: `<p>We build widgets.</p>` },
    "https://acme.example/careers": { status: 404, text: "" },
    "https://acme.example/jobs": { status: 404, text: "" },
  });
  const result = await resolveCompanySources(company, fetcher);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.unresolved, []);
});
