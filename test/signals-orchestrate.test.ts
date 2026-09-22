import assert from "node:assert/strict";
import { test } from "node:test";
import { runObservationPass, type SignalDataAccess } from "../src/signals/orchestrate.ts";
import type { CompanyContext, DerivedSignal, Observation, SignalSource } from "../src/signals/types.ts";
import type { Fetcher, FetchOptions, FetchResult } from "../src/sources/fetcher.ts";
import { memoryLogger } from "../src/log.ts";

// ---- test doubles -------------------------------------------------------------------------------------------------

function fakeStore(initial: { sources?: SignalSource[]; observations?: Observation[]; signals?: DerivedSignal[] } = {}) {
  let nextSourceId = 1000;
  let nextObsId = 2000;
  let nextSignalId = 3000;
  const sources = [...(initial.sources ?? [])];
  const observations = [...(initial.observations ?? [])];
  const signals = [...(initial.signals ?? [])];
  const calls = { upsertSignalSource: 0, insertObservations: 0, insertSignals: 0 };
  const store: SignalDataAccess = {
    async getActiveSourcesForCompanies(ids) {
      return sources.filter((s) => (ids as readonly number[]).includes(s.company_id) && s.active);
    },
    async getObservationHistoryForCompanies(ids) {
      return observations.filter((o) => (ids as readonly number[]).includes(o.company_id));
    },
    async getSignalsForCompanies(ids) {
      return signals.filter((s) => (ids as readonly number[]).includes(s.company_id));
    },
    async upsertSignalSource(source) {
      calls.upsertSignalSource++;
      const existing = sources.find((s) => s.company_id === source.company_id && s.source_type === source.source_type && s.external_id === source.external_id);
      if (existing) {
        Object.assign(existing, source);
        return existing;
      }
      const row: SignalSource = { ...source, id: nextSourceId++ };
      sources.push(row);
      return row;
    },
    async insertObservations(rows) {
      calls.insertObservations++;
      // `id` must be assigned AFTER the spread: rows here carry a literal `id: null` (set by
      // observe.ts before persistence, same as the real SignalStore has to guard against — see
      // src/signals/store.ts's comment on this exact hazard), so `{ ...o, id: ... }` is required;
      // `{ id: ..., ...o }` would let `o`'s own `id: null` clobber the freshly assigned one.
      const written = rows.map((o) => ({ ...o, id: nextObsId++ }) as Observation);
      observations.push(...written);
      return written;
    },
    async insertSignals(rows) {
      calls.insertSignals++;
      const written = rows.map((s) => ({ ...s, id: nextSignalId++ }) as DerivedSignal);
      signals.push(...written);
      return written;
    },
  };
  return { store, sources, observations, signals, calls };
}

interface Route {
  status: number;
  json?: unknown;
  text?: string;
  throws?: boolean;
}

function fakeFetcher(routes: Record<string, Route>): { fetcher: Fetcher; requested: string[] } {
  const requested: string[] = [];
  const fetcher: Fetcher = {
    async getText(url: string, _o?: FetchOptions): Promise<FetchResult> {
      requested.push(url);
      const r = routes[url];
      if (!r) return { url, status: 404, text: "", bytes: 0, elapsed_ms: 0 };
      if (r.throws) throw new Error(`simulated network failure for ${url}`);
      const text = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? "");
      return { url, status: r.status, text, bytes: text.length, elapsed_ms: 0 };
    },
  };
  return { fetcher, requested };
}

const NOW = () => new Date("2026-09-22T12:00:00.000Z");

const ACME: CompanyContext = { id: 1, name: "Acme Robotics", domain: "acmerobotics.com" };
const acmeGithubSource = (overrides: Partial<SignalSource> = {}): SignalSource => ({
  id: 501, company_id: 1, source_type: "github_repo", external_id: "acme/widget", canonical_url: null,
  resolution_method: "homepage_link_confirmed", resolution_confidence: 0.95, resolution_evidence: "test", active: true, metadata: null, ...overrides,
});

// ---- fresh-source skipping / stale-source collection ----------------------------------------------------------------

test("orchestrate: a source collected recently (within the freshness window) is skipped, not re-collected", async () => {
  const recentObs: Observation = { id: 1, company_id: 1, signal_source_id: 501, metric_name: "github_stars", numeric_value: 10, text_value: null, observed_at: new Date(NOW().getTime() - 2 * 3_600_000).toISOString(), source_timestamp: null, collection_version: "github-v1", raw_payload_ref: null };
  const { store, calls } = fakeStore({ sources: [acmeGithubSource()], observations: [recentObs] });
  const { fetcher, requested } = fakeFetcher({}); // no route needed — must never be called
  const summary = await runObservationPass([ACME], { fetcher, store, now: NOW }, { dryRun: false, force: false });
  assert.deepEqual([summary.collection.skipped_fresh, summary.collection.collected], [1, 0]);
  assert.deepEqual(requested, [], "a fresh source must not be fetched at all");
  assert.equal(calls.insertObservations, 0);
  assert.equal(summary.companies[0]!.sources[0]!.outcome, "skipped_fresh");
});

test("orchestrate: a stale source (older than the freshness window) IS collected", async () => {
  const staleObs: Observation = { id: 1, company_id: 1, signal_source_id: 501, metric_name: "github_stars", numeric_value: 10, text_value: null, observed_at: new Date(NOW().getTime() - 25 * 3_600_000).toISOString(), source_timestamp: null, collection_version: "github-v1", raw_payload_ref: null };
  const { store, calls } = fakeStore({ sources: [acmeGithubSource()], observations: [staleObs] });
  const { fetcher, requested } = fakeFetcher({ "https://api.github.com/repos/acme/widget": { status: 200, json: { stargazers_count: 20 } } });
  const summary = await runObservationPass([ACME], { fetcher, store, now: NOW }, { dryRun: false, force: false });
  assert.deepEqual([summary.collection.collected, summary.collection.skipped_fresh], [1, 0]);
  assert.ok(requested.length > 0, "a stale source must actually be fetched");
  assert.equal(calls.insertObservations, 1);
});

test("orchestrate: re-running immediately after a successful collection skips it the second time — no duplicate collection during cooldown", async () => {
  const { store } = fakeStore({ sources: [acmeGithubSource()] }); // no prior observations: first run must collect
  const { fetcher } = fakeFetcher({ "https://api.github.com/repos/acme/widget": { status: 200, json: { stargazers_count: 20 } } });
  const deps = { fetcher, store, now: NOW };
  const first = await runObservationPass([ACME], deps, { dryRun: false, force: false });
  assert.equal(first.collection.collected, 1, "nothing was observed yet, so the first run must collect");
  const second = await runObservationPass([ACME], deps, { dryRun: false, force: false });
  assert.deepEqual([second.collection.collected, second.collection.skipped_fresh], [0, 1], "immediately re-running must skip — the observation just written is still fresh");
});

test("orchestrate: --force bypasses freshness even immediately after a collection", async () => {
  const { store } = fakeStore({ sources: [acmeGithubSource()] });
  const { fetcher } = fakeFetcher({ "https://api.github.com/repos/acme/widget": { status: 200, json: { stargazers_count: 20 } } });
  const deps = { fetcher, store, now: NOW };
  await runObservationPass([ACME], deps, { dryRun: false, force: false });
  const forced = await runObservationPass([ACME], deps, { dryRun: false, force: true });
  assert.equal(forced.collection.collected, 1, "--force must re-collect regardless of freshness");
});

// ---- failure isolation -----------------------------------------------------------------------------------------------

test("orchestrate: one source failing does not stop the company's OTHER sources, or the rest of the run", async () => {
  const github = acmeGithubSource();
  const greenhouse = acmeGithubSource({ id: 502, source_type: "greenhouse", external_id: "acme" });
  const { store } = fakeStore({ sources: [github, greenhouse] });
  const other: CompanyContext = { id: 2, name: "OtherCo", domain: "otherco.example" };
  const { fetcher } = fakeFetcher({
    "https://api.github.com/repos/acme/widget": { status: 200, json: { stargazers_count: 5 }, throws: true }, // simulated network failure
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs": { status: 200, json: { jobs: [] } },
    "https://otherco.example/": { status: 200, text: "<p>nothing here</p>" },
  });
  const summary = await runObservationPass([ACME, other], { fetcher, store, now: NOW }, { dryRun: false, force: false });
  assert.deepEqual([summary.collection.failed, summary.collection.collected], [1, 1], "github fails but greenhouse still succeeds for the same company");
  assert.equal(summary.companies[0]!.sources.find((s) => s.source_type === "github_repo")!.outcome, "failed");
  assert.equal(summary.companies[0]!.sources.find((s) => s.source_type === "greenhouse")!.outcome, "collected");
  assert.equal(summary.companies[1]!.resolution, "no_supported_source", "the second company is still processed normally after the first company's partial failure");
});

// ---- unresolved / no-supported-source company behavior ----------------------------------------------------------------

test("orchestrate: a company with a plausible-but-rejected link is 'unresolved'; a company with nothing at all is 'no_supported_source'", async () => {
  const rejected: CompanyContext = { id: 3, name: "Acme Robotics", domain: "rejectme.example" };
  const nothing: CompanyContext = { id: 4, name: "Nothing Co", domain: "nothingco.example" };
  const { store } = fakeStore();
  const { fetcher } = fakeFetcher({
    "https://rejectme.example/": { status: 200, text: `<a href="https://github.com/totally-unrelated">link</a>` },
    "https://api.github.com/orgs/totally-unrelated": { status: 200, json: { blog: "", public_repos: 1 } },
    "https://rejectme.example/careers": { status: 404 },
    "https://nothingco.example/": { status: 200, text: "<p>no links</p>" },
    "https://nothingco.example/careers": { status: 404 },
  });
  const summary = await runObservationPass([rejected, nothing], { fetcher, store, now: NOW }, { dryRun: false, force: false });
  assert.equal(summary.companies[0]!.resolution, "unresolved");
  assert.equal(summary.companies[1]!.resolution, "no_supported_source");
  assert.deepEqual([summary.resolution.unresolved, summary.resolution.no_supported_source], [1, 1]);
});

// ---- dry-run safety -------------------------------------------------------------------------------------------------

test("orchestrate: --dry-run performs real resolution/collection reads but writes NOTHING to the store", async () => {
  const nothingYet: CompanyContext = { id: 5, name: "Acme Robotics", domain: "acmerobotics.com" };
  const { store, calls, sources, observations, signals } = fakeStore();
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.com/": { status: 200, text: `<a href="https://github.com/acmerobotics">gh</a>` },
    "https://api.github.com/orgs/acmerobotics": { status: 200, json: { blog: "https://acmerobotics.com", public_repos: 2 } },
    "https://api.github.com/repos/acmerobotics/acmerobotics": { status: 404 }, // org-only candidate, no repo call expected — fine either way
  });
  const summary = await runObservationPass([nothingYet], { fetcher, store, now: NOW }, { dryRun: true, force: false });
  assert.equal(summary.dry_run, true);
  assert.equal(summary.resolution.resolved_new_sources, 1, "resolution is still reported — a dry run previews what WOULD happen");
  assert.deepEqual([calls.upsertSignalSource, calls.insertObservations, calls.insertSignals], [0, 0, 0], "no store write method was ever called");
  assert.deepEqual([sources.length, observations.length, signals.length], [0, 0, 0], "the store's underlying data is untouched");
});

// ---- signal derivation + dedup across runs --------------------------------------------------------------------------

test("orchestrate: signals derive correctly through the full pipeline once enough history accumulates, and are traceable", async () => {
  const priorObs: Observation = { id: 1, company_id: 1, signal_source_id: 501, metric_name: "ats_open_jobs_total", numeric_value: 2, text_value: null, observed_at: new Date(NOW().getTime() - 30 * 86_400_000).toISOString(), source_timestamp: null, collection_version: "ats-v1", raw_payload_ref: null };
  const greenhouseSource = acmeGithubSource({ id: 501, source_type: "greenhouse", external_id: "acme" });
  const { store, signals } = fakeStore({ sources: [greenhouseSource], observations: [priorObs] });
  const { fetcher } = fakeFetcher({ "https://boards-api.greenhouse.io/v1/boards/acme/jobs": { status: 200, json: { jobs: Array.from({ length: 14 }, (_, i) => ({ id: i, title: "Engineer" })) } } });
  const summary = await runObservationPass([ACME], { fetcher, store, now: NOW }, { dryRun: false, force: false });
  assert.equal(summary.signals_fired, 1);
  assert.equal(summary.companies[0]!.signals_fired[0]!.signal_type, "open_jobs_surge");
  assert.equal(signals.length, 1);
  assert.ok(signals[0]!.to_observation_id !== null, "the persisted signal traces back to a real observation id");
});

test("orchestrate: re-running against UNCHANGED history never inserts the same signal twice", async () => {
  const oldObs: Observation = { id: 1, company_id: 1, signal_source_id: 501, metric_name: "ats_open_jobs_total", numeric_value: 2, text_value: null, observed_at: new Date(NOW().getTime() - 30 * 86_400_000).toISOString(), source_timestamp: null, collection_version: "ats-v1", raw_payload_ref: null };
  const freshEnoughToSkip: Observation = { id: 2, company_id: 1, signal_source_id: 501, metric_name: "ats_open_jobs_total", numeric_value: 14, text_value: null, observed_at: new Date(NOW().getTime() - 1 * 3_600_000).toISOString(), source_timestamp: null, collection_version: "ats-v1", raw_payload_ref: null };
  const greenhouseSource = acmeGithubSource({ id: 501, source_type: "greenhouse", external_id: "acme" });
  const { store, calls, signals } = fakeStore({ sources: [greenhouseSource], observations: [oldObs, freshEnoughToSkip] });
  const { fetcher } = fakeFetcher({}); // must not be called — the source is fresh
  const first = await runObservationPass([ACME], { fetcher, store, now: NOW }, { dryRun: false, force: false });
  assert.equal(first.signals_fired, 1, "the signal derives from EXISTING history even though the source itself was skipped as fresh this run");
  const second = await runObservationPass([ACME], { fetcher, store, now: NOW }, { dryRun: false, force: false });
  assert.equal(second.signals_fired, 0, "re-deriving from the exact same unchanged history must not re-insert the same signal");
  assert.equal(signals.length, 1, "only one signal row exists in the store after both runs");
  assert.equal(calls.insertSignals, 1, "insertSignals was only actually called once (the second run found nothing new to insert)");
});

// ---- Anthropic / cost guard -----------------------------------------------------------------------------------------

test("orchestrate: a full run makes zero Anthropic-shaped calls and needs no budget guard — this module has no dependency on either", async () => {
  const { store } = fakeStore({ sources: [acmeGithubSource()] });
  const { fetcher, requested } = fakeFetcher({ "https://api.github.com/repos/acme/widget": { status: 200, json: { stargazers_count: 1 } } });
  await runObservationPass([ACME], { fetcher, store, now: NOW }, { dryRun: false, force: false });
  assert.ok(requested.every((u) => !u.includes("anthropic.com")), "no request was ever made to anthropic.com");
});

// ---- V2-2B.1: backfill on newly-resolved GitHub sources ----------------------------------------------------------------

function fakeCommitActivity(): Array<{ week: number; total: number }> {
  const NOW_WEEK_START = Date.UTC(2026, 8, 21) / 1000;
  const WEEK_S = 7 * 86_400;
  return Array.from({ length: 52 }, (_, i) => ({ week: NOW_WEEK_START - (51 - i) * WEEK_S, total: 4 }));
}

test("orchestrate: a newly-resolved github_repo source is backfilled once, in the SAME pass, and the backfilled history feeds signal derivation immediately", async () => {
  const acme: CompanyContext = { id: 1, name: "Acme Robotics", domain: "acmerobotics.com" };
  const { store, observations, calls } = fakeStore();
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.com/": { status: 200, text: `<a href="https://github.com/acmerobotics/widget">gh</a>` },
    "https://api.github.com/orgs/acmerobotics": { status: 200, json: { blog: "https://acmerobotics.com" } },
    "https://api.github.com/repos/acmerobotics/widget": { status: 200, json: { stargazers_count: 5 } },
    "https://api.github.com/repos/acmerobotics/widget/contributors?per_page=100&anon=false": { status: 200, json: [] },
    "https://api.github.com/repos/acmerobotics/widget/stats/commit_activity": { status: 200, json: fakeCommitActivity() },
    "https://api.github.com/repos/acmerobotics/widget/releases?per_page=1": { status: 200, json: [] },
    "https://api.github.com/repos/acmerobotics/widget/releases?per_page=6": { status: 200, json: [] },
  });
  const summary = await runObservationPass([acme], { fetcher, store, now: NOW }, { dryRun: false, force: false });
  assert.ok(summary.observations_backfilled > 0, "a source-supported backfill (commit history) should have been found and inserted");
  assert.ok(summary.companies[0]!.newly_resolved[0]!.backfilled_observations > 0);
  const backfilled = observations.filter((o) => o.collection_version === "github-v1-backfill");
  assert.ok(backfilled.length > 0);
  assert.ok(backfilled.every((o) => o.source_timestamp !== null), "every backfilled row carries a real source_timestamp");
  assert.ok(calls.insertObservations >= 2, "backfill and live collection are separate inserts");
});

test("orchestrate: re-running after a source is already resolved never backfills again — resolution (and therefore backfill) only ever runs once per company", async () => {
  const acme: CompanyContext = { id: 1, name: "Acme Robotics", domain: "acmerobotics.com" };
  const { store, observations } = fakeStore({ sources: [acmeGithubSource()] }); // already resolved from a prior run
  const { fetcher, requested } = fakeFetcher({
    "https://api.github.com/repos/acme/widget": { status: 200, json: { stargazers_count: 6 } },
  });
  const summary = await runObservationPass([acme], { fetcher, store, now: NOW }, { dryRun: false, force: false });
  assert.equal(summary.observations_backfilled, 0, "no backfill should be attempted for an already-resolved source");
  // "/stats/commit_activity" is called by BOTH live collection and backfill, so it alone can't
  // distinguish them — "/releases?per_page=6" is backfill-ONLY (live always uses per_page=1), so
  // its absence here is the real proof that backfill was never attempted a second time.
  assert.ok(!requested.some((u) => u.includes("releases?per_page=6")), "the backfill-only releases endpoint was never called on a second pass");
  assert.ok(!observations.some((o) => o.collection_version === "github-v1-backfill"), "no duplicate/repeat historical observations are ever produced on a second pass");
});

test("orchestrate: --dry-run previews backfill (real reads) but writes nothing, exactly like live collection's own dry-run behavior", async () => {
  const acme: CompanyContext = { id: 1, name: "Acme Robotics", domain: "acmerobotics.com" };
  const { store, calls, observations } = fakeStore();
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.com/": { status: 200, text: `<a href="https://github.com/acmerobotics/widget">gh</a>` },
    "https://api.github.com/orgs/acmerobotics": { status: 200, json: { blog: "https://acmerobotics.com" } },
    "https://api.github.com/repos/acmerobotics/widget": { status: 200, json: { stargazers_count: 5 } },
    "https://api.github.com/repos/acmerobotics/widget/contributors?per_page=100&anon=false": { status: 200, json: [] },
    "https://api.github.com/repos/acmerobotics/widget/stats/commit_activity": { status: 200, json: fakeCommitActivity() },
    "https://api.github.com/repos/acmerobotics/widget/releases?per_page=1": { status: 200, json: [] },
    "https://api.github.com/repos/acmerobotics/widget/releases?per_page=6": { status: 200, json: [] },
  });
  const summary = await runObservationPass([acme], { fetcher, store, now: NOW }, { dryRun: true, force: false });
  assert.ok(summary.companies[0]!.newly_resolved[0]!.backfilled_observations > 0, "dry-run still PREVIEWS what backfill would find");
  assert.equal(summary.observations_backfilled, 0, "but the aggregate count of what was actually WRITTEN stays 0 in dry-run");
  assert.equal(calls.insertObservations, 0, "the store's insertObservations must never be called in dry-run");
  assert.equal(observations.length, 0, "nothing is actually persisted");
});

test("orchestrate: a backfill failure never blocks resolution or ongoing live collection for that source", async () => {
  const acme: CompanyContext = { id: 1, name: "Acme Robotics", domain: "acmerobotics.com" };
  const { store } = fakeStore();
  const { fetcher } = fakeFetcher({
    "https://acmerobotics.com/": { status: 200, text: `<a href="https://github.com/acmerobotics/widget">gh</a>` },
    "https://api.github.com/orgs/acmerobotics": { status: 200, json: { blog: "https://acmerobotics.com" } },
    "https://api.github.com/repos/acmerobotics/widget": { status: 200, json: { stargazers_count: 5 } },
    "https://api.github.com/repos/acmerobotics/widget/contributors?per_page=100&anon=false": { status: 200, json: [] },
    "https://api.github.com/repos/acmerobotics/widget/stats/commit_activity": { status: 200, json: fakeCommitActivity() }, // shared with live collection — must keep working
    "https://api.github.com/repos/acmerobotics/widget/releases?per_page=1": { status: 200, json: [] },
    // "/releases?per_page=6" is backfill-ONLY — failing just this one endpoint isolates a genuine
    // backfill-specific failure without also breaking live collection's own unrelated requests.
    "https://api.github.com/repos/acmerobotics/widget/releases?per_page=6": { status: 200, json: {}, throws: true },
  });
  const summary = await runObservationPass([acme], { fetcher, store, now: NOW }, { dryRun: false, force: false });
  assert.equal(summary.resolution.resolved_new_sources, 1, "resolution itself must still succeed");
  assert.equal(summary.companies[0]!.newly_resolved[0]!.backfilled_observations, 0, "the whole backfill attempt failed (one bad endpoint aborts backfillGithubRepoHistory) — recorded honestly as zero, not a crash");
  assert.equal(summary.companies[0]!.sources.find((s) => s.source_type === "github_repo")?.outcome, "collected", "live collection for this source still runs normally, unaffected by the backfill failure");
});

// ---- graceful shutdown -----------------------------------------------------------------------------------------------

test("orchestrate: an already-aborted signal stops the run before processing any company", async () => {
  const controller = new AbortController();
  controller.abort();
  const { store, calls } = fakeStore();
  const { fetcher, requested } = fakeFetcher({});
  const log = memoryLogger();
  const summary = await runObservationPass([ACME], { fetcher, store, now: NOW, signal: controller.signal, log }, { dryRun: false, force: false });
  assert.deepEqual(summary.companies, []);
  assert.deepEqual(requested, []);
  assert.equal(calls.upsertSignalSource + calls.insertObservations + calls.insertSignals, 0);
  assert.ok(log.records.some((r) => r.event === "observation_pass_aborted"));
});
