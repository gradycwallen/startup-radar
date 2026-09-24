import assert from "node:assert/strict";
import { test } from "node:test";
import type { FunnelResult } from "../src/funnel/funnel.ts";
import type { CompanyInsert, EventInsert } from "../src/discovery/accept.ts";
import { runDiscoveryPass, type DiscoveryDataAccess } from "../src/discovery/orchestrate.ts";
import { DISCOVERY_LIMITS } from "../src/discovery/limits.ts";
import { makeRankedEntity } from "./fixtures/discovery/entities.ts";

// ---- test doubles -------------------------------------------------------------------------------------------------

function fakeStore(existingDomains: string[] = []) {
  let nextId = 100;
  const domains = new Set(existingDomains);
  const inserted: Array<{ id: number; domain: string }> = [];
  const eventsByCompany = new Map<number, Set<string>>();
  const calls = { insertCompany: 0, upsertEvents: 0, companyExistsByDomain: 0 };
  const store: DiscoveryDataAccess = {
    async companyExistsByDomain(domain: string) {
      calls.companyExistsByDomain++;
      return domains.has(domain);
    },
    async insertCompany(company: CompanyInsert) {
      calls.insertCompany++;
      if (domains.has(company.domain)) return { conflict: true as const };
      domains.add(company.domain);
      const id = nextId++;
      inserted.push({ id, domain: company.domain });
      eventsByCompany.set(id, new Set());
      return { inserted: { id, name: company.name, domain: company.domain } };
    },
    async upsertEvents(companyId: number, events: readonly EventInsert[]) {
      calls.upsertEvents++;
      const seen = eventsByCompany.get(companyId) ?? new Set();
      let insertedCount = 0;
      for (const e of events) {
        if (seen.has(e.source_url)) continue;
        seen.add(e.source_url);
        insertedCount++;
      }
      eventsByCompany.set(companyId, seen);
      return { inserted: insertedCount, skipped_duplicate: events.length - insertedCount };
    },
  };
  return { store, domains, inserted, calls };
}

function fakeFunnelResult(finalists: ReturnType<typeof makeRankedEntity>[], directoryFinalists: ReturnType<typeof makeRankedEntity>[] = []): FunnelResult {
  return {
    as_of: "2026-09-22T00:00:00.000Z", window_days: 3, elapsed_ms: 0, providers: [], counts: {} as FunnelResult["counts"],
    item_drop_reasons: {}, prefilter_reasons: {}, merges: [], existing: [], ranked: [...finalists, ...directoryFinalists],
    finalists, directory_finalists: directoryFinalists, prefiltered: [], leads: [], domain_guess_audit: [],
  };
}

// ---- accept/reject + persistence --------------------------------------------------------------------------------------

test("orchestrate: an unresolved-domain finalist is reported but NEVER persisted", async () => {
  const r = makeRankedEntity({ name: "Acme", domain: null, evidence: [{ source_url: "https://x.com/1" }] });
  const { store, calls } = fakeStore();
  const summary = await runDiscoveryPass(fakeFunnelResult([r]), store, { dryRun: false });
  assert.equal(summary.unresolved_domain_count, 1);
  assert.equal(summary.new_companies_inserted, 0);
  assert.equal(calls.insertCompany, 0, "an unresolved domain must never even attempt an insert");
  assert.equal(summary.candidates[0]!.outcome, "unresolved_domain");
});

test("orchestrate: --dry-run makes ZERO store calls of any kind, even for an obviously-acceptable candidate", async () => {
  const r = makeRankedEntity({ name: "Acme", domain: "acme.com", evidence: [{ source_url: "https://x.com/1" }] });
  const { store, calls } = fakeStore();
  const summary = await runDiscoveryPass(fakeFunnelResult([r]), store, { dryRun: true });
  assert.equal(summary.dry_run, true);
  assert.equal(summary.candidates[0]!.outcome, "would_insert", "never labeled 'inserted' — that word is reserved for a real write");
  assert.equal(summary.new_companies_inserted, 1, "the preview still counts what WOULD be inserted");
  assert.deepEqual([calls.insertCompany, calls.upsertEvents, calls.companyExistsByDomain], [0, 0, 0]);
});

test("orchestrate: dry-run event counts are correctly rolled into the summary totals — regression for a real aggregation bug found during controlled replay validation", async () => {
  const r = makeRankedEntity({
    name: "Acme", domain: "acme.com",
    evidence: [{ source_url: "https://a.com/1" }, { source_url: "https://b.com/1" }],
  });
  const summary = await runDiscoveryPass(fakeFunnelResult([r]), fakeStore().store, { dryRun: true });
  assert.equal(summary.events_inserted, 2, "the summary-level total must reflect the per-candidate event count, not stay at 0");
});

test("orchestrate: an existing company (already in the DB by domain) is skipped, never duplicated", async () => {
  const r = makeRankedEntity({ name: "Acme", domain: "acme.com", evidence: [{ source_url: "https://x.com/1" }] });
  const { store, calls } = fakeStore(["acme.com"]);
  const summary = await runDiscoveryPass(fakeFunnelResult([r]), store, { dryRun: false });
  assert.equal(summary.existing_companies_skipped, 1);
  assert.equal(summary.new_companies_inserted, 0);
  assert.equal(calls.insertCompany, 0, "the defensive pre-check catches it before an insert is even attempted");
});

test("orchestrate: a race where insertCompany itself reports a conflict (domain inserted between the pre-check and the insert) is handled as a benign skip, not a failure", async () => {
  const r = makeRankedEntity({ name: "Acme", domain: "acme.com", evidence: [{ source_url: "https://x.com/1" }] });
  const store: DiscoveryDataAccess = {
    async companyExistsByDomain() { return false; }, // pre-check says "new"...
    async insertCompany() { return { conflict: true }; }, // ...but the insert itself finds it already exists
    async upsertEvents() { return { inserted: 0, skipped_duplicate: 0 }; },
  };
  const summary = await runDiscoveryPass(fakeFunnelResult([r]), store, { dryRun: false });
  assert.equal(summary.existing_companies_skipped, 1);
  assert.equal(summary.failed_writes, 0, "a conflict is not a failure");
});

// ---- hard caps --------------------------------------------------------------------------------------------------------

test("orchestrate: the write cap (--max-writes / DISCOVERY_LIMITS.maxNewCompaniesPerRun) stops new company inserts — remaining candidates are deferred, not dropped silently", async () => {
  const candidates = Array.from({ length: 4 }, (_, i) => makeRankedEntity({ name: `Co${i}`, domain: `co${i}.com`, score: 90 - i, evidence: [{ source_url: `https://x.com/${i}` }] }));
  const { store } = fakeStore();
  const summary = await runDiscoveryPass(fakeFunnelResult(candidates), store, { dryRun: false, maxNewCompanies: 2 });
  assert.equal(summary.new_companies_inserted, 2);
  assert.equal(summary.deferred_write_cap, 2);
  assert.equal(summary.candidates.length, 4, "every candidate is accounted for — none silently vanish");
});

test("orchestrate: --max-writes may only LOWER the ceiling, never raise it above DISCOVERY_LIMITS.maxNewCompaniesPerRun", async () => {
  const candidates = Array.from({ length: DISCOVERY_LIMITS.maxNewCompaniesPerRun + 3 }, (_, i) =>
    makeRankedEntity({ name: `Co${i}`, domain: `co${i}.com`, score: 90 - i, evidence: [{ source_url: `https://x.com/${i}` }] }));
  const { store } = fakeStore();
  const summary = await runDiscoveryPass(fakeFunnelResult(candidates), store, { dryRun: false, maxNewCompanies: 999 });
  assert.equal(summary.new_companies_inserted, DISCOVERY_LIMITS.maxNewCompaniesPerRun, "requesting 999 must not exceed the hard ceiling");
});

test("orchestrate: the candidate cap (DISCOVERY_LIMITS.maxAcceptedCandidates) is a second, independent backstop above the write cap", () => {
  assert.ok(DISCOVERY_LIMITS.maxAcceptedCandidates >= DISCOVERY_LIMITS.maxNewCompaniesPerRun, "the candidate cap should never be the binding constraint under normal operation");
});

test("orchestrate: accepted candidates are processed in SCORE order — the write cap protects the highest-value candidates first", async () => {
  const low = makeRankedEntity({ name: "Low", domain: "low.com", score: 40, evidence: [{ source_url: "https://x.com/low" }] });
  const high = makeRankedEntity({ name: "High", domain: "high.com", score: 95, evidence: [{ source_url: "https://x.com/high" }] });
  const { store, inserted } = fakeStore();
  await runDiscoveryPass(fakeFunnelResult([low, high]), store, { dryRun: false, maxNewCompanies: 1 }); // finalists array is NOT pre-sorted here
  assert.deepEqual(inserted.map((c) => c.domain), ["high.com"], "the higher-scoring candidate must win the single available slot regardless of array order");
});

// ---- write failure isolation --------------------------------------------------------------------------------------

test("orchestrate: one candidate's write failure does not stop the rest of the run", async () => {
  const a = makeRankedEntity({ name: "Fails", domain: "fails.com", score: 90, evidence: [{ source_url: "https://x.com/1" }] });
  const b = makeRankedEntity({ name: "Succeeds", domain: "ok.com", score: 80, evidence: [{ source_url: "https://x.com/2" }] });
  const store: DiscoveryDataAccess = {
    async companyExistsByDomain() { return false; },
    async insertCompany(c) { if (c.domain === "fails.com") throw new Error("simulated DB error"); return { inserted: { id: 1, name: c.name, domain: c.domain } }; },
    async upsertEvents() { return { inserted: 1, skipped_duplicate: 0 }; },
  };
  const summary = await runDiscoveryPass(fakeFunnelResult([a, b]), store, { dryRun: false });
  assert.equal(summary.failed_writes, 1);
  assert.equal(summary.new_companies_inserted, 1);
  assert.equal(summary.candidates.find((c) => c.name === "Fails")!.outcome, "failed");
  assert.equal(summary.candidates.find((c) => c.name === "Succeeds")!.outcome, "inserted");
});

// ---- idempotent re-run ---------------------------------------------------------------------------------------------

test("orchestrate: running the SAME funnel result twice inserts the company once — the second run sees it as existing and inserts 0 duplicates", async () => {
  const r = makeRankedEntity({ name: "Acme", domain: "acme.com", evidence: [{ source_url: "https://x.com/1" }] });
  const { store } = fakeStore();
  const first = await runDiscoveryPass(fakeFunnelResult([r]), store, { dryRun: false });
  assert.equal(first.new_companies_inserted, 1);
  const second = await runDiscoveryPass(fakeFunnelResult([r]), store, { dryRun: false });
  assert.equal(second.new_companies_inserted, 0);
  assert.equal(second.existing_companies_skipped, 1);
});

test("orchestrate: re-running with the SAME evidence set inserts 0 duplicate events — the second call to upsertEvents for a NEW company still reflects true duplicate accounting", async () => {
  // Simulates a company discovered fresh but with events that (for whatever reason — a shared
  // source_url with a previous partial run) already exist for that company_id.
  let calls = 0;
  const store: DiscoveryDataAccess = {
    async companyExistsByDomain() { return false; },
    async insertCompany(c) { return { inserted: { id: 1, name: c.name, domain: c.domain } }; },
    async upsertEvents(_id, events) { calls++; return { inserted: 0, skipped_duplicate: events.length }; }, // simulate: DB says all already exist
  };
  const r = makeRankedEntity({ name: "Acme", domain: "acme.com", evidence: [{ source_url: "https://x.com/1" }] });
  const summary = await runDiscoveryPass(fakeFunnelResult([r]), store, { dryRun: false });
  assert.equal(summary.events_inserted, 0);
  assert.equal(summary.events_skipped_duplicate, 1);
  assert.equal(calls, 1);
});

// ---- Anthropic / signal-table isolation ---------------------------------------------------------------------------

test("orchestrate: makes no Anthropic-shaped calls and never touches a V2-2A signal table — this module has no dependency on either", async () => {
  const text = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/discovery/orchestrate.ts", import.meta.url), "utf8"));
  assert.ok(!/anthropic/i.test(text), "orchestrate.ts must not reference Anthropic");
  const tableCalls = [...text.matchAll(/\.from\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(tableCalls, [], "orchestrate.ts must never call .from(<table>) directly at all — it only talks to DiscoveryDataAccess");
});

// ---- explainability -------------------------------------------------------------------------------------------------

test("every inserted candidate's discovery_reason is present and traceable to real evidence, never a placeholder", async () => {
  const r = makeRankedEntity({ name: "Acme", domain: "acme.com", evidence: [{ source_url: "https://x.com/1", source_name: "TechCrunch", title: "Acme raises $5M" }] });
  const summary = await runDiscoveryPass(fakeFunnelResult([r]), fakeStore().store, { dryRun: false });
  const c = summary.candidates[0]!;
  assert.ok(c.discovery_reason && c.discovery_reason.includes("TechCrunch") && c.discovery_reason.includes("Acme raises $5M"));
});
