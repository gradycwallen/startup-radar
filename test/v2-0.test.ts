import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetGuard, BudgetRefusalError } from "../src/budget.ts";
import { emptyUsage } from "../src/claude.ts";
import { DEFAULTS, LIMITS, type RunConfig } from "../src/config.ts";
import { RunAbortError, RunClock, ShutdownError } from "../src/deadline.ts";
import { FatalApiError } from "../src/fatal.ts";
import { LeadLedger, leadId } from "../src/ledger.ts";
import { memoryLogger } from "../src/log.ts";
import { createDefaultRouter } from "../src/models.ts";
import { runPipeline } from "../src/pipeline.ts";
import { ClaudeWebProvider } from "../src/providers/claude-web.ts";
import type { DiscoveryContext, DiscoveryProvider, LaneReport } from "../src/providers/types.ts";
import { EXIT, executeRun, exitCodeFor } from "../src/run.ts";
import type { RawLead } from "../src/schema.ts";
import type { ShutdownHandle } from "../src/shutdown.ts";
import { ClaudeVerifier, type Verifier, type VerifyContext } from "../src/verify.ts";
import { CREDIT_ERROR_BODY, aLead, fakeAnthropic, leadsResponse } from "./fake-anthropic.ts";
import { FakeReader, NOW, okHomepage, testBudget, testLedger, verification } from "./helpers.ts";

const config = (over: Partial<RunConfig> = {}, logDir = "logs"): RunConfig => ({
  dryRun: true, maxNew: DEFAULTS.maxNew, maxCandidates: 50, minConfidence: 0.75, recencyDays: 14, maxEventAgeDays: 45,
  concurrency: 1, leadsPerLane: 6, lanes: undefined, logDir, limits: { ...LIMITS }, budgetUsd: 0.75, ...over,
});
const lead = (n: number, lane = "funding", over: Partial<RawLead> = {}): RawLead => ({
  provider: "fake", lane, name: `Co${n}`, homepage_hint: `https://co${n}.ai`, event_type_hint: "funding",
  source_url: `https://news.example.com/co${n}`, source_name: "News", event_date: "2026-09-10", headline: `Co${n} raises`, snippet: null, source_retrieved: true, ...over,
});
const stubShutdown = (): ShutdownHandle => ({ signal: new AbortController().signal, requestedBy: () => null, exitCode: () => null, dispose() {} });
const laneOk = (lane: string, leads: number): LaneReport => ({ lane, status: "ok", elapsed_ms: 1, leads, usage: emptyUsage() });

/** A provider that streams its leads to the ledger (like real providers), then returns them. */
function provider(leads: RawLead[], extra: Partial<{ fatal: FatalApiError; before: (ctx: DiscoveryContext) => Promise<void> | void }> = {}): DiscoveryProvider {
  return {
    name: "fake",
    lanes: ["funding"],
    async discover(ctx) {
      ctx.onLeads?.(leads);
      await extra.before?.(ctx);
      return { leads, errors: [], lanes: [laneOk("funding", leads.length)], usage: emptyUsage(), ...(extra.fatal ? { fatal: extra.fatal } : {}) };
    },
  };
}
const okVerification = (l: RawLead, over: Record<string, unknown> = {}) => {
  const n = l.name.replace("Co", "");
  return {
    verification: verification({ name: l.name, canonical_url: `https://co${n}.ai`, source_url: l.source_url, headline: `${l.name} raises $${Number(n) + 1}M`, discovery_reason: `${l.name} raised $${Number(n) + 1}M.`, ...over }),
    retrievedUrls: new Set([l.source_url]),
  };
};
const hangUntilAborted = (ctx: VerifyContext) => new Promise<never>((_, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("APIUserAbortError: Request was aborted.")), { once: true }));
const credit = () => new FatalApiError("insufficient_credit", "Your credit balance is too low to access the Anthropic API.", 400, "req_credit");

interface Ctx {
  leads: RawLead[]; verifier: Verifier; cfg?: RunConfig; db?: FakeReader; budget?: BudgetGuard; ledger?: LeadLedger;
  prov?: DiscoveryProvider; signal?: AbortSignal; log?: ReturnType<typeof memoryLogger>;
}
function run(c: Ctx) {
  const cfg = c.cfg ?? config();
  const log = c.log ?? memoryLogger();
  const ledger = c.ledger ?? testLedger();
  const budget = c.budget ?? testBudget();
  return {
    log, ledger, budget,
    promise: runPipeline({
      provider: c.prov ?? provider(c.leads), verifier: c.verifier, db: c.db ?? new FakeReader(), checkHomepage: okHomepage("Co1 Co2 Co3 Co4 Co5 Co6 Co7 Co8"),
      log, config: cfg, now: NOW, signal: c.signal ?? new AbortController().signal, clock: new RunClock(cfg.limits.runSoftDeadlineMs), budget, ledger,
    }),
  };
}

// ============ 1. RAW LEAD LEDGER ==========================================================================

test("LEDGER: every raw lead is recorded BEFORE selection or verification, and every lead ends with a disposition", async () => {
  const leads = [
    lead(1, "funding"), lead(2, "launches"), lead(1, "news", { source_url: "https://other.example.com/co1-again" }), // same company as #1 (same hinted domain)
    lead(4, "stealth"), lead(5, "accelerator"), lead(6, "open_source"),
  ];
  let ledgerSizeWhenVerificationStarted = -1;
  const verifier: Verifier = {
    async verify(l, ctx) {
      if (ledgerSizeWhenVerificationStarted < 0) ledgerSizeWhenVerificationStarted = ledgerRef.all().length;
      if (l.name === "Co4") throw new Error("boom");
      return okVerification(l, l.name === "Co2" ? { confidence: 0.5 } : {});
    },
  };
  const r = run({ leads, verifier, cfg: config({ maxCandidates: 3 }) });
  const ledgerRef = r.ledger;
  const s = await r.promise;

  assert.equal(ledgerSizeWhenVerificationStarted, 6, "all 6 raw leads were already in the ledger when the first verification began");
  const byName = (name: string, lane?: string) => r.ledger.all().find((x) => x.name === name && (!lane || x.lane === lane))!;
  assert.equal(byName("Co1", "funding").disposition, "would_insert_company_and_event");
  assert.equal(byName("Co2").disposition, "rejected");
  assert.match(byName("Co2").drop_reason ?? "", /confidence_below/);
  assert.equal(byName("Co4").disposition, "error");
  const dup = byName("Co1", "news");
  assert.equal(dup.disposition, "dropped_duplicate_lead");
  assert.equal(dup.duplicate_of, byName("Co1", "funding").lead_id);
  assert.equal(byName("Co5").disposition, "not_selected_verification_limit");
  assert.equal(byName("Co6").disposition, "not_selected_verification_limit");
  assert.ok(r.ledger.all().every((x) => x.disposition !== null && x.stage_reached === "decided" && x.decided_at));
  assert.equal(s.lead_ledger.total, 6);
  assert.deepEqual(s.lead_ledger.by_disposition, { would_insert_company_and_event: 1, rejected: 1, error: 1, dropped_duplicate_lead: 1, not_selected_verification_limit: 2 });
  const accepted = byName("Co1", "funding");
  assert.deepEqual([accepted.candidate_domain, accepted.event_type, accepted.confidence !== null], ["co1.ai", "funding", true]);
  assert.ok(accepted.selected_at && accepted.verification_started_at && accepted.decided_at);
});

test("LEDGER: leads streamed by a provider are on disk even if the run is killed during discovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-killed-"));
  const ledger = new LeadLedger({ dir, runId: "killed" });
  const shutdown = new AbortController();
  let onDiskWhileDiscoveryWasStillRunning = 0;
  const prov = provider([lead(1), lead(2)], {
    async before(ctx) {
      onDiskWhileDiscoveryWasStillRunning = readFileSync(join(dir, "killed.leads.jsonl"), "utf8").trim().split("\n").length;
      setTimeout(() => shutdown.abort(new ShutdownError("SIGTERM")), 20);
      await new Promise<void>((res) => ctx.signal.addEventListener("abort", () => res(), { once: true }));
    },
  });
  const r = run({ leads: [], prov, ledger, signal: shutdown.signal, verifier: { verify: async () => { throw new Error("unused"); } } });
  const s = await r.promise;
  assert.equal(onDiskWhileDiscoveryWasStillRunning, 2, "the leads were persisted the moment the lane produced them, before discovery finished");
  assert.equal(s.status, "interrupted");
  assert.ok(ledger.all().every((x) => x.disposition === "not_started"), "and each ended with a disposition explaining why nothing happened");
  assert.ok(existsSync(join(dir, "killed.leads.json")), "the consolidated file is written even for an interrupted run");
});

// ============ 2. FATAL API ERRORS ===========================================================================

test("FATAL in verification: in-flight work is aborted immediately, nothing new starts, the run FAILS and exits 4 with a partial summary", async () => {
  const calls: string[] = [];
  let inFlightSignalReason: unknown;
  const t0 = performance.now();
  const verifier: Verifier = {
    async verify(l, ctx) {
      calls.push(l.name);
      if (l.name === "Co3") { await new Promise((r) => setTimeout(r, 30)); throw credit(); }
      if (l.name === "Co4") { ctx.signal.addEventListener("abort", () => { inFlightSignalReason = ctx.signal.reason; }, { once: true }); return hangUntilAborted(ctx); }
      return okVerification(l);
    },
  };
  const r = run({ leads: [1, 2, 3, 4, 5, 6].map((n) => lead(n)), verifier, cfg: config({ concurrency: 2 }) });
  const s = await r.promise;

  assert.ok(performance.now() - t0 < 3_000, "the in-flight candidate was aborted at once, not left to run to its own timeout");
  assert.deepEqual(calls, ["Co1", "Co2", "Co3", "Co4"], "no verification was started after the fatal error");
  assert.ok(inFlightSignalReason instanceof RunAbortError && inFlightSignalReason.reason instanceof FatalApiError);
  const by = Object.fromEntries(s.candidates.map((c) => [c.lead_name, c]));
  assert.equal(by.Co1!.status, "would_insert_company_and_event", "results completed before the failure are kept");
  assert.equal(by.Co2!.status, "would_insert_company_and_event");
  assert.deepEqual([by.Co3!.status, by.Co3!.reasons[0]], ["error", "fatal_api_error:insufficient_credit"]);
  assert.deepEqual([by.Co4!.status, by.Co4!.reasons[0]], ["aborted", "aborted:fatal_api_error:insufficient_credit"]);
  assert.deepEqual([by.Co5!.status, by.Co6!.status], ["not_started", "not_started"]);
  assert.equal(by.Co5!.reasons[0], "not_started:fatal_api_error:insufficient_credit");

  assert.equal(s.status, "failed");
  assert.equal(s.stop_reason, "fatal_api_error:insufficient_credit");
  assert.deepEqual({ kind: s.fatal_error!.kind, status: s.fatal_error!.status, id: s.fatal_error!.request_id }, { kind: "insufficient_credit", status: 400, id: "req_credit" });
  assert.ok(!Number.isNaN(Date.parse(s.fatal_error!.at)));
  assert.equal(exitCodeFor(s, stubShutdown()), EXIT.FATAL_API_ERROR);
  assert.equal(EXIT.FATAL_API_ERROR, 4);
  assert.ok(r.log.records.some((x) => x.event === "fatal_api_error" && x.level === "error"));
  assert.equal(s.db_unchanged, true);
  assert.ok(r.ledger.all().every((x) => x.disposition !== null), "the ledger still accounts for every lead");
});

test("FATAL in discovery (real provider, real SDK, fake transport): the next lanes are skipped, no verification runs, exit 4", async () => {
  const { client, calls } = fakeAnthropic([leadsResponse([aLead()]), { kind: "status", status: 400, headers: { "request-id": "req_credit_lane" }, body: CREDIT_ERROR_BODY }]);
  const budget = testBudget();
  const prov = new ClaudeWebProvider(client, createDefaultRouter({}), { ...LIMITS, discoveryRequestMs: 5000 }, budget);
  let verifierCalls = 0;
  const r = run({
    leads: [], prov, budget, verifier: { verify: async () => { verifierCalls++; throw new Error("must not run"); } },
    cfg: config({ lanes: ["funding", "launches", "stealth", "accelerator"] }),
  });
  const s = await r.promise;
  assert.equal(calls.length, 2, "only the first two lane requests were ever sent");
  assert.deepEqual(s.lanes.map((l) => l.status), ["ok", "failed", "skipped_fatal", "skipped_fatal"]);
  assert.equal(verifierCalls, 0);
  assert.equal(s.status, "failed");
  assert.equal(s.stop_reason, "fatal_api_error:insufficient_credit");
  assert.equal(s.fatal_error!.request_id, "req_credit_lane");
  assert.equal(exitCodeFor(s, stubShutdown()), 4);
  // the lead the first lane DID find is preserved and accounted for
  assert.equal(s.lead_ledger.total, 1);
  assert.equal(r.ledger.all()[0]!.disposition, "not_processed");
  assert.equal(r.ledger.all()[0]!.drop_reason, "run_ended:fatal_api_error:insufficient_credit");
  assert.deepEqual(budget.entries().map((e) => e.outcome), ["ok", "no_charge"]);
});

test("FATAL through the REAL verifier and SDK: the first credit error stops the run; later candidates are never sent", async () => {
  const { client, calls } = fakeAnthropic([{ kind: "status", status: 400, body: CREDIT_ERROR_BODY }]);
  const budget = testBudget();
  const verifier = new ClaudeVerifier(client, createDefaultRouter({}), budget, NOW, { ...LIMITS, verificationRequestMs: 5000 });
  const r = run({ leads: [lead(1), lead(2), lead(3)], verifier, budget });
  const s = await r.promise;
  assert.equal(calls.length, 1);
  assert.deepEqual(s.candidates.map((c) => c.status), ["error", "not_started", "not_started"]);
  assert.equal(s.status, "failed");
  assert.equal(exitCodeFor(s, stubShutdown()), 4);
});

test("a fatal error takes precedence over 'db unchanged' bookkeeping but a DB change still exits 3 when there is no fatal error", () => {
  const base = { status: "completed", db_unchanged: true, fatal_error: null, leads_discovered: 3, provider_errors: [] } as any;
  const none = stubShutdown();
  assert.equal(exitCodeFor(base, none), EXIT.OK);
  assert.equal(exitCodeFor({ ...base, db_unchanged: false }, none), EXIT.DB_CHANGED);
  assert.equal(exitCodeFor({ ...base, status: "failed", fatal_error: { kind: "authentication" } }, none), EXIT.FATAL_API_ERROR);
  assert.equal(exitCodeFor({ ...base, status: "failed" }, none), EXIT.FAILED);
  assert.equal(exitCodeFor({ ...base, status: "stopped_at_budget" }, none), EXIT.BUDGET_CEILING);
  assert.deepEqual([EXIT.OK, EXIT.FAILED, EXIT.USAGE, EXIT.DB_CHANGED, EXIT.FATAL_API_ERROR, EXIT.BUDGET_CEILING], [0, 1, 2, 3, 4, 5]);
  const shutdown = { ...none, exitCode: () => 143 };
  assert.equal(exitCodeFor({ ...base, status: "interrupted" }, shutdown), 143, "a signal-driven stop keeps its signal exit code");
});

// ============ 3. BUDGET GUARD IN THE PIPELINE ===============================================================

test("BUDGET at discovery: the pessimistic guard refuses the Phase 1-style lane BEFORE any request; lanes skipped; exit 5", async () => {
  const { client, calls } = fakeAnthropic([leadsResponse([aLead()])]);
  const budget = new BudgetGuard(); // real assumptions, real caps, $0.75
  const prov = new ClaudeWebProvider(client, createDefaultRouter({}), { ...LIMITS }, budget);
  let verifierCalls = 0;
  const r = run({ leads: [], prov, budget, verifier: { verify: async () => { verifierCalls++; throw new Error("unused"); } }, cfg: config({ lanes: ["funding", "launches"] }) });
  const s = await r.promise;
  assert.equal(calls.length, 0, "not a single request reached the network");
  assert.deepEqual(s.lanes.map((l) => l.status), ["skipped_budget", "skipped_budget"]);
  assert.equal(verifierCalls, 0);
  assert.equal(s.status, "stopped_at_budget");
  assert.equal(s.stop_reason, "budget_ceiling");
  assert.equal(s.cost.exhausted, true);
  assert.ok(s.cost.refused_count >= 1);
  assert.equal(s.cost.committed_usd, 0);
  assert.equal(s.cost.ceiling_usd, 0.75);
  assert.equal(exitCodeFor(s, stubShutdown()), EXIT.BUDGET_CEILING);
});

test("BUDGET mid-verification: the refused candidate did not start, every later candidate is not_started, earlier results are kept", async () => {
  const budget = testBudget();
  const verifier: Verifier = {
    async verify(l) {
      if (l.name === "Co3") budget.reserve({ label: "verify:Co3#1", stage: "verify", model: "claude-sonnet-5", estimate: { inputTokens: 0, outputTokens: 0, webSearches: 0, webFetches: 0, usd: 99, basis: "test" } });
      return okVerification(l);
    },
  };
  const r = run({ leads: [1, 2, 3, 4, 5].map((n) => lead(n)), verifier, budget });
  const s = await r.promise;
  assert.deepEqual(s.candidates.map((c) => c.status), ["would_insert_company_and_event", "would_insert_company_and_event", "not_started", "not_started", "not_started"]);
  assert.equal(s.candidates[2]!.reasons[0], "budget_refused:verify:Co3#1");
  assert.equal(s.candidates[3]!.reasons[0], "not_started:budget_exhausted");
  assert.equal(s.status, "stopped_at_budget");
  assert.equal(exitCodeFor(s, stubShutdown()), 5);
  assert.ok(r.ledger.all().every((x) => x.disposition !== null));
});

test("BUDGET refusal is a BudgetRefusalError carrying the numbers, and it is not a fatal API error", async () => {
  const budget = new BudgetGuard({ ceilingUsd: 0.1 });
  try {
    budget.reserve({ label: "x", stage: "s", model: "claude-sonnet-5", estimate: { inputTokens: 0, outputTokens: 0, webSearches: 0, webFetches: 0, usd: 0.5, basis: "t" } });
    assert.fail("should refuse");
  } catch (err) {
    assert.ok(err instanceof BudgetRefusalError && !(err instanceof FatalApiError));
    assert.deepEqual([err.estimatedUsd, err.ceilingUsd], [0.5, 0.1]);
  }
});

// ============ 4. ARTIFACTS ALWAYS LEFT COMPLETE =============================================================

test("ARTIFACTS: executeRun flushes the lead and cost ledgers even when the pipeline throws before it can build a summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-artifacts-"));
  const ledger = new LeadLedger({ dir, runId: "boom" });
  const budget = new BudgetGuard({ persist: { dir, runId: "boom" } });
  class Broken extends FakeReader { override async counts(): Promise<never> { throw new Error("database unreachable"); } }
  await assert.rejects(
    executeRun({
      provider: provider([lead(1)]), verifier: { verify: async () => { throw new Error("unused"); } }, db: new Broken(), checkHomepage: okHomepage(),
      log: memoryLogger(), config: config({}, dir), now: NOW, clock: new RunClock(LIMITS.runSoftDeadlineMs), shutdown: stubShutdown(), budget, ledger,
    }),
    /database unreachable/,
  );
  assert.ok(existsSync(join(dir, "boom.leads.json")));
  assert.ok(existsSync(join(dir, "boom.cost.json")));
});

test("ARTIFACTS: a normal run's summary embeds the cost snapshot and lead-ledger summary, and the files exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-artifacts-"));
  const ledger = new LeadLedger({ dir, runId: "ok" });
  const budget = new BudgetGuard({ persist: { dir, runId: "ok" } });
  const out = await executeRun({
    provider: provider([lead(1), lead(2)]), verifier: { verify: async (l) => okVerification(l) }, db: new FakeReader(), checkHomepage: okHomepage("Co1 Co2"),
    log: memoryLogger(), config: config({}, dir), now: NOW, clock: new RunClock(LIMITS.runSoftDeadlineMs), shutdown: stubShutdown(), budget, ledger,
  });
  assert.equal(out.exitCode, 0);
  assert.equal(out.summary.mode, "live");
  assert.equal(out.summary.cost.ceiling_usd, 0.75);
  assert.equal(out.summary.lead_ledger.total, 2);
  assert.equal(out.summary.fatal_error, null);
  for (const f of [out.summary.lead_ledger.files.json, out.summary.lead_ledger.files.jsonl, out.summary.cost.files.json, out.summary.cost.files.jsonl, out.summaryFile]) assert.ok(f && existsSync(f), String(f));
  assert.equal(JSON.parse(readFileSync(out.summaryFile, "utf8")).lead_ledger.total, 2);
});

test("ledger ids in the summary match the ledger (candidates link back to their raw lead)", async () => {
  const r = run({ leads: [lead(1)], verifier: { verify: async (l) => okVerification(l) } });
  const s = await r.promise;
  assert.equal(s.candidates[0]!.lead_id, leadId(lead(1)));
  assert.ok(r.ledger.get(s.candidates[0]!.lead_id));
});
