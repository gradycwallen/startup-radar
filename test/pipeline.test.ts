import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, LIMITS, type RunConfig } from "../src/config.ts";
import { RunClock } from "../src/deadline.ts";
import { nullLogger } from "../src/log.ts";
import { runPipeline, selectLeads, selectLeadsDetailed } from "../src/pipeline.ts";
import type { DiscoveryProvider } from "../src/providers/types.ts";
import type { RawLead } from "../src/schema.ts";
import { emptyUsage } from "../src/claude.ts";
import type { Verifier } from "../src/verify.ts";
import { FakeReader, NOW, okHomepage, testBudget, testLedger, verification } from "./helpers.ts";

const config = (over: Partial<RunConfig> = {}): RunConfig => ({
  dryRun: true, maxNew: DEFAULTS.maxNew, maxCandidates: 50, minConfidence: 0.75, recencyDays: 14,
  maxEventAgeDays: 45, concurrency: 2, leadsPerLane: 6, lanes: undefined, logDir: "logs", limits: { ...LIMITS }, budgetUsd: 0.75, ...over,
});

const lead = (n: number, lane = "funding", over: Partial<RawLead> = {}): RawLead => ({
  provider: "fake", lane, name: `Co${n}`, homepage_hint: `https://co${n}.ai`, event_type_hint: "funding",
  source_url: `https://news.example.com/co${n}`, source_name: "News", event_date: "2026-09-10", headline: `Co${n} raises`,
  snippet: null, source_retrieved: true, ...over,
});

function provider(leads: RawLead[]): DiscoveryProvider {
  return { name: "fake", lanes: ["funding"], discover: async () => ({ leads, errors: [], lanes: [], usage: emptyUsage() }) };
}

/** Verifier that returns a valid verification derived from the lead. */
const verifierFor = (patch: (l: RawLead, i: number) => Partial<ReturnType<typeof verification>> = () => ({})): Verifier => ({
  async verify(l) {
    const n = l.name.replace("Co", "");
    const v = verification({ name: l.name, canonical_url: `https://co${n}.ai`, source_url: l.source_url, headline: `${l.name} raises $${Number(n) + 1}M`, discovery_reason: `${l.name} raised $${Number(n) + 1}M.`, ...patch(l, Number(n)) });
    return { verification: v, retrievedUrls: new Set([l.source_url]) };
  },
});

const run = (leads: RawLead[], verifier: Verifier, db = new FakeReader(), cfg = config()) =>
  runPipeline({
    provider: provider(leads), verifier, db, checkHomepage: okHomepage("Co1 Co2 Co3 Co4 Co5 Co6 Co7 Co8 Co9 Co10 Co11 Co12 Co13 Co14 Co15"),
    log: nullLogger(), config: cfg, now: NOW, budget: testBudget(), ledger: testLedger(), signal: new AbortController().signal, clock: new RunClock(cfg.limits.runSoftDeadlineMs),
  });

test("--max-new caps accepted NEW companies; extras are deferred, not dropped silently", async () => {
  const leads = Array.from({ length: 12 }, (_, i) => lead(i + 1));
  const s = await run(leads, verifierFor(), new FakeReader(), config({ maxNew: 10 }));
  assert.equal(s.counts.would_insert_company_and_event, 10);
  assert.equal(s.counts.deferred_max_new, 2);
  const s3 = await run(leads, verifierFor(), new FakeReader(), config({ maxNew: 3 }));
  assert.equal(s3.counts.would_insert_company_and_event, 3);
  assert.equal(s3.counts.deferred_max_new, 9);
});

test("discovery may produce more candidates than max-new; verification budget still applies", async () => {
  const leads = Array.from({ length: 30 }, (_, i) => lead(i + 1));
  const s = await run(leads, verifierFor(), new FakeReader(), config({ maxCandidates: 15, maxNew: 10 }));
  assert.equal(s.leads_discovered, 30);
  assert.equal(s.leads_selected, 15);
});

test("dry run leaves row counts unchanged and reports it", async () => {
  const db = new FakeReader([{ id: 1, name: "Existing", domain: "existing.com" }]);
  const s = await run([lead(1), lead(2)], verifierFor(), db);
  assert.equal(s.db_unchanged, true);
  assert.deepEqual(s.rows_before, s.rows_after);
  assert.equal(db.companies.length, 1);
  assert.equal(db.events.length, 0);
});

test("existing company: duplicate source is skipped, a genuinely new event is 'event only', no duplicate company", async () => {
  const db = new FakeReader(
    [{ id: 7, name: "Co1", domain: "co1.ai" }],
    [{ id: 1, company_id: 7, event_type: "funding", event_date: null, source_url: "https://news.example.com/co1", headline: "Co1 raises $2M", description: "Co1 raised $2M." }],
  );
  // lead(1) points at the already-recorded source: skipped before paying for verification
  const s = await run([lead(1)], { verify: async () => { throw new Error("must not be called"); } } as Verifier, db);
  assert.equal(s.counts.skipped_duplicate_event, 1);
  // a different source about a different event (launch) => event only
  const s2 = await run([lead(1, "launches", { source_url: "https://news.example.com/co1-launch" })], verifierFor(() => ({ event_type: "product_launch", headline: "Co1 launches product", discovery_reason: "Co1 launched its first product." })), db);
  assert.equal(s2.counts.would_insert_event_only, 1);
  assert.equal(s2.counts.would_insert_company_and_event, 0);
});

test("a failing verification is isolated: one error, the rest proceed", async () => {
  const verifier: Verifier = {
    async verify(l, ctx) {
      if (l.name === "Co2") throw new Error("boom");
      return verifierFor().verify(l, ctx);
    },
  };
  const s = await run([lead(1), lead(2), lead(3)], verifier);
  assert.equal(s.counts.error, 1);
  assert.equal(s.counts.would_insert_company_and_event, 2);
});

test("rejections are counted with reasons", async () => {
  const s = await run([lead(1), lead(2)], verifierFor((_, n) => (n === 2 ? { confidence: 0.5 } : {})));
  assert.equal(s.counts.rejected, 1);
  assert.equal(s.rejection_reasons["confidence_below_0.75"], 1);
});

test("selectLeadsDetailed: EVERY lead is either selected or reported dropped; none is silently lost (regression)", () => {
  const leads = [lead(1, "funding"), lead(2, "launches"), lead(3, "stealth"), lead(4, "accelerator"), lead(5, "open_source"), lead(6, "news")];
  const { selected, dropped } = selectLeadsDetailed(leads, 3);
  assert.equal(selected.length, 3);
  assert.equal(selected.length + dropped.length, leads.length, "selected + dropped must account for every lead");
  assert.deepEqual(dropped.map((d) => d.reason), ["over_verification_limit", "over_verification_limit", "over_verification_limit"]);
  assert.equal(new Set([...selected, ...dropped.map((d) => d.lead)]).size, leads.length);
});

test("selectLeads: de-duplicates, balances lanes, honors the limit", () => {
  const leads = [
    lead(1, "funding"), lead(2, "funding"), lead(3, "funding"),
    lead(4, "launches"), lead(5, "launches"),
    lead(1, "news", { source_url: "https://other.com/co1" }), // same hinted domain as Co1 => dropped
  ];
  const out = selectLeads(leads, 4);
  assert.equal(out.length, 4);
  assert.deepEqual(new Set(out.map((l) => l.lane)), new Set(["funding", "launches"]));
  assert.equal(new Set(out.map((l) => l.homepage_hint)).size, 4);
});
