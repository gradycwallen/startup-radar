import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage } from "../src/claude.ts";
import { DEFAULTS, LIMITS, type RunConfig } from "../src/config.ts";
import { RunClock, ScoutTimeoutError, ShutdownError } from "../src/deadline.ts";
import { memoryLogger } from "../src/log.ts";
import { runPipeline } from "../src/pipeline.ts";
import type { DiscoveryProvider, LaneReport } from "../src/providers/types.ts";
import type { RawLead } from "../src/schema.ts";
import type { Verifier, VerifyContext } from "../src/verify.ts";
import { FakeReader, NOW, okHomepage, testBudget, testLedger, verification } from "./helpers.ts";

const config = (over: Partial<RunConfig> = {}, limits: Partial<RunConfig["limits"]> = {}): RunConfig => ({
  dryRun: true, maxNew: DEFAULTS.maxNew, maxCandidates: 50, minConfidence: 0.75, recencyDays: 14, maxEventAgeDays: 45,
  concurrency: 1, leadsPerLane: 6, lanes: undefined, logDir: "logs", ...over, limits: { ...LIMITS, ...limits }, budgetUsd: 0.75,
});

const lead = (n: number, lane = "funding"): RawLead => ({
  provider: "fake", lane, name: `Co${n}`, homepage_hint: `https://co${n}.ai`, event_type_hint: "funding",
  source_url: `https://news.example.com/co${n}`, source_name: "News", event_date: "2026-09-10", headline: `Co${n} raises`,
  snippet: null, source_retrieved: true,
});

const laneOk = (lane: string, leads: number): LaneReport => ({ lane, status: "ok", elapsed_ms: 1200, leads, usage: { ...emptyUsage(), inputTokens: 1000, outputTokens: 50, webSearches: 2, webFetches: 1, apiCalls: 1 } });

function provider(leads: RawLead[], lanes: LaneReport[] = []): DiscoveryProvider {
  return { name: "fake", lanes: ["funding"], discover: async () => ({ leads, errors: [], lanes, usage: lanes.reduce((a, l) => ({ ...a, inputTokens: a.inputTokens + l.usage.inputTokens, outputTokens: a.outputTokens + l.usage.outputTokens, webSearches: a.webSearches + l.usage.webSearches, webFetches: a.webFetches + l.usage.webFetches, apiCalls: a.apiCalls + l.usage.apiCalls }), emptyUsage()) }) };
}

const okVerification = (l: RawLead) => {
  const n = l.name.replace("Co", "");
  return { verification: verification({ name: l.name, canonical_url: `https://co${n}.ai`, source_url: l.source_url, headline: `${l.name} raises $${Number(n) + 1}M`, discovery_reason: `${l.name} raised $${Number(n) + 1}M.` }), retrievedUrls: new Set([l.source_url]) };
};

/** Rejects when the (candidate-scope) signal aborts, like a real verifier whose request gets aborted. */
const hangUntilAborted = (ctx: VerifyContext) =>
  new Promise<never>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("APIUserAbortError: Request was aborted.")), { once: true }));

function run(opts: { leads: RawLead[]; verifier: Verifier; cfg?: RunConfig; db?: FakeReader; signal?: AbortSignal; clock?: RunClock; lanes?: LaneReport[]; log?: ReturnType<typeof memoryLogger> }) {
  const cfg = opts.cfg ?? config();
  const log = opts.log ?? memoryLogger();
  return runPipeline({
    provider: provider(opts.leads, opts.lanes), verifier: opts.verifier, db: opts.db ?? new FakeReader(),
    checkHomepage: okHomepage("Co1 Co2 Co3 Co4 Co5 Co6 Co7 Co8"), log, config: cfg, now: NOW, budget: testBudget(), ledger: testLedger(),
    signal: opts.signal ?? new AbortController().signal, clock: opts.clock ?? new RunClock(cfg.limits.runSoftDeadlineMs),
  });
}

test("CANDIDATE DEADLINE: an overrunning verification is failed as 'timeout' (naming what timed out) and the run continues", async () => {
  const verifier: Verifier = {
    async verify(l, ctx) {
      if (l.name === "Co2") return hangUntilAborted(ctx);
      return okVerification(l);
    },
  };
  const s = await run({ leads: [lead(1), lead(2), lead(3)], verifier, cfg: config({}, { candidateMs: 150 }) });
  const co2 = s.candidates.find((c) => c.lead_name === "Co2")!;
  assert.equal(co2.status, "timeout");
  assert.deepEqual(co2.reasons, ["timeout:candidate:Co2"]);
  assert.deepEqual({ kind: co2.timeout!.kind, label: co2.timeout!.label, limit: co2.timeout!.limit_ms, item: co2.timeout!.item }, { kind: "candidate", label: "Co2", limit: 150, item: "Co2" });
  assert.ok(co2.elapsed_ms >= 140 && co2.elapsed_ms < 3_000, `elapsed ${co2.elapsed_ms}`);
  assert.equal(s.counts.timeout, 1);
  assert.equal(s.counts.would_insert_company_and_event, 2, "the other candidates still complete");
  assert.deepEqual(s.timeouts.map((t) => t.item), ["Co2"]);
  assert.equal(s.status, "completed");
});

test("a request-level timeout raised inside verification is also a 'timeout' with its own kind and label", async () => {
  const verifier: Verifier = {
    async verify(l) {
      if (l.name === "Co1") throw new ScoutTimeoutError("request", "verify:Co1#1", 300_000, 300_004);
      return okVerification(l);
    },
  };
  const s = await run({ leads: [lead(1), lead(2)], verifier });
  const co1 = s.candidates[0]!;
  assert.equal(co1.status, "timeout");
  assert.deepEqual(co1.reasons, ["timeout:request:verify:Co1#1"]);
  assert.equal(co1.timeout!.limit_ms, 300_000);
  assert.equal(s.counts.would_insert_company_and_event, 1);
});

test("RUN SOFT DEADLINE: stops STARTING candidates, lets the in-flight one finish, and says so", async () => {
  let now = 0;
  const cfg = config({}, { runSoftDeadlineMs: 1_000 });
  const clock = new RunClock(cfg.limits.runSoftDeadlineMs, () => now);
  const started: string[] = [];
  const verifier: Verifier = {
    async verify(l) {
      started.push(l.name);
      if (l.name === "Co2") now = 10_000; // the deadline passes while Co2 is in flight
      return okVerification(l);
    },
  };
  const log = memoryLogger();
  const s = await run({ leads: [lead(1), lead(2), lead(3), lead(4)], verifier, cfg, clock, log });
  assert.deepEqual(started, ["Co1", "Co2"], "nothing new starts once the soft deadline has passed");
  assert.equal(s.candidates.find((c) => c.lead_name === "Co2")!.status, "would_insert_company_and_event", "in-flight work is allowed to finish");
  const skipped = s.candidates.filter((c) => c.status === "not_started");
  assert.deepEqual(skipped.map((c) => c.lead_name), ["Co3", "Co4"]);
  assert.ok(skipped.every((c) => c.reasons.includes("not_started:run_soft_deadline")));
  assert.equal(s.status, "stopped_at_run_deadline");
  assert.equal(s.stop_reason, "run_soft_deadline");
  assert.ok(log.records.some((r) => r.event === "candidate_skipped"));
  assert.equal(s.db_unchanged, true);
});

test("the soft deadline does NOT abort in-flight work (no timeout is recorded for it)", async () => {
  let now = 0;
  const cfg = config({}, { runSoftDeadlineMs: 500 });
  const verifier: Verifier = { verify: async (l) => { now = 999_999; await new Promise((r) => setTimeout(r, 30)); return okVerification(l); } };
  const s = await run({ leads: [lead(1)], verifier, cfg, clock: new RunClock(500, () => now) });
  assert.equal(s.candidates[0]!.status, "would_insert_company_and_event");
  assert.equal(s.timeouts.length, 0);
});

test("SHUTDOWN mid-verification: in-flight candidate aborted, nothing new starts, partial summary still complete and accurate", async () => {
  const shutdown = new AbortController();
  const started: string[] = [];
  const verifier: Verifier = {
    async verify(l, ctx) {
      started.push(l.name);
      if (l.name === "Co2") {
        setTimeout(() => shutdown.abort(new ShutdownError("SIGTERM")), 30);
        return hangUntilAborted(ctx);
      }
      return okVerification(l);
    },
  };
  const s = await run({ leads: [lead(1), lead(2), lead(3), lead(4)], verifier, signal: shutdown.signal });
  assert.deepEqual(started, ["Co1", "Co2"]);
  assert.equal(s.status, "interrupted");
  assert.equal(s.stop_reason, "shutdown:SIGTERM");
  const byName = Object.fromEntries(s.candidates.map((c) => [c.lead_name, c]));
  assert.equal(byName.Co1!.status, "would_insert_company_and_event", "work completed before the shutdown is kept and de-duplicated");
  assert.equal(byName.Co2!.status, "aborted");
  assert.deepEqual(byName.Co2!.reasons, ["aborted:SIGTERM"]);
  assert.equal(byName.Co3!.status, "not_started");
  assert.equal(byName.Co4!.status, "not_started");
  assert.equal(s.timeouts.length, 0, "a shutdown is not a timeout");
  assert.deepEqual(s.rows_after, s.rows_before);
  assert.equal(s.db_unchanged, true);
});

test("SHUTDOWN before verification starts: every selected lead is 'not_started'", async () => {
  const shutdown = new AbortController();
  shutdown.abort(new ShutdownError("SIGINT"));
  const verifier: Verifier = { verify: async () => { throw new Error("must not be called"); } };
  const s = await run({ leads: [lead(1), lead(2)], verifier, signal: shutdown.signal });
  assert.equal(s.counts.not_started, 2);
  assert.equal(s.status, "interrupted");
  assert.equal(s.stop_reason, "shutdown:SIGINT");
});

test("per-candidate elapsed time and usage are recorded, and usage is kept even when verification fails", async () => {
  const verifier: Verifier = {
    async verify(l, ctx) {
      ctx.usage.inputTokens += 500; ctx.usage.outputTokens += 20; ctx.usage.webSearches += 2; ctx.usage.webFetches += 1; ctx.usage.apiCalls += 1;
      await new Promise((r) => setTimeout(r, 25));
      if (l.name === "Co2") throw new Error("boom after spending tokens");
      return okVerification(l);
    },
  };
  const s = await run({ leads: [lead(1), lead(2)], verifier, lanes: [laneOk("funding", 2)] });
  for (const c of s.candidates) {
    assert.ok(c.elapsed_ms >= 20, `${c.lead_name} elapsed ${c.elapsed_ms}`);
    assert.deepEqual({ in: c.usage.inputTokens, out: c.usage.outputTokens, s: c.usage.webSearches, f: c.usage.webFetches, calls: c.usage.apiCalls }, { in: 500, out: 20, s: 2, f: 1, calls: 1 });
  }
  assert.equal(s.candidates[1]!.status, "error");
  // Run total = lane discovery usage + both candidates (the failed one included).
  assert.equal(s.usage.inputTokens, 1000 + 500 + 500);
  assert.equal(s.usage.webSearches, 2 + 2 + 2);
  assert.equal(s.usage.webFetches, 1 + 1 + 1);
  assert.equal(s.usage.apiCalls, 3);
  assert.ok(s.run_elapsed_ms >= 0);
});

test("lane failures and timeouts are carried into the summary and do not stop verification of other lanes' leads", async () => {
  const lanes: LaneReport[] = [
    { lane: "funding", status: "timeout", elapsed_ms: 540_012, leads: 0, usage: emptyUsage(), error: "lane timeout", timeout: { kind: "lane", label: "funding", limit_ms: 540_000, elapsed_ms: 540_012 } },
    laneOk("launches", 1),
  ];
  const verifier: Verifier = { verify: async (l) => okVerification(l) };
  const s = await run({ leads: [lead(1, "launches")], verifier, lanes });
  assert.deepEqual(s.lanes.map((l) => [l.lane, l.status]), [["funding", "timeout"], ["launches", "ok"]]);
  assert.deepEqual(s.timeouts, [{ item: "lane:funding", kind: "lane", label: "funding", limit_ms: 540_000, elapsed_ms: 540_012 }]);
  assert.equal(s.counts.would_insert_company_and_event, 1);
});

test("a lane skipped by the run deadline marks the run stopped_at_run_deadline", async () => {
  const lanes: LaneReport[] = [laneOk("funding", 1), { lane: "launches", status: "skipped_run_deadline", elapsed_ms: 0, leads: 0, usage: emptyUsage() }];
  const s = await run({ leads: [lead(1)], verifier: { verify: async (l) => okVerification(l) }, lanes });
  assert.equal(s.status, "stopped_at_run_deadline");
});

test("TIMEOUTS AND SHUTDOWN NEVER CAUSE A DATABASE WRITE: only read methods are ever invoked", async () => {
  const called = new Set<string>();
  const inner = new FakeReader([{ id: 1, name: "Existing", domain: "existing.com" }], []);
  const spy = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v === "function" && typeof prop === "string") return (...a: unknown[]) => { called.add(prop); return (v as (...x: unknown[]) => unknown).apply(target, a); };
      return v;
    },
  });
  const shutdown = new AbortController();
  const verifier: Verifier = {
    async verify(l, ctx) {
      if (l.name === "Co1") return hangUntilAborted(ctx); // candidate deadline
      if (l.name === "Co2") { setTimeout(() => shutdown.abort(new ShutdownError("SIGTERM")), 20); return hangUntilAborted(ctx); } // shutdown
      return okVerification(l);
    },
  };
  const before = { companies: inner.companies.length, events: inner.events.length };
  const s = await run({ leads: [lead(1), lead(2), lead(3)], verifier, db: spy as FakeReader, signal: shutdown.signal, cfg: config({}, { candidateMs: 80 }) });
  assert.ok(s.counts.timeout + s.counts.aborted + s.counts.not_started >= 2);
  const readOnly = new Set(["findCompanyByDomain", "findCompaniesByName", "getEvents", "counts"]);
  for (const name of called) assert.ok(readOnly.has(name), `unexpected database call: ${name}`);
  assert.deepEqual({ companies: inner.companies.length, events: inner.events.length }, before);
  assert.equal(s.db_unchanged, true);
});

test("rows_after failing (e.g. during shutdown) still yields a summary, with rows_after and db_unchanged null", async () => {
  class Flaky extends FakeReader {
    n = 0;
    override async counts() {
      if (++this.n > 1) throw new Error("connection lost");
      return super.counts();
    }
  }
  const s = await run({ leads: [lead(1)], verifier: { verify: async (l) => okVerification(l) }, db: new Flaky() });
  assert.equal(s.rows_after, null);
  assert.equal(s.db_unchanged, null);
  assert.equal(s.counts.would_insert_company_and_event, 1);
});
