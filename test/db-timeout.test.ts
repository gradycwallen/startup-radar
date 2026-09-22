import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage } from "../src/claude.ts";
import { DEFAULTS, LIMITS, type RunConfig } from "../src/config.ts";
import { RunClock, ShutdownError } from "../src/deadline.ts";
import { DbReadTimeoutError, ReadOnlyDb } from "../src/db.ts";
import { memoryLogger } from "../src/log.ts";
import { runPipeline } from "../src/pipeline.ts";
import type { DiscoveryProvider } from "../src/providers/types.ts";
import type { RawLead } from "../src/schema.ts";
import type { Verifier } from "../src/verify.ts";
import { FakeReader, NOW, okHomepage, testBudget, testLedger, verification } from "./helpers.ts";

const URL = "https://abc.supabase.co";
const KEY = "test-key-not-a-real-secret";
const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/** Never answers, but DOES honor the abort signal (like real fetch). */
const stuckFetch = (seen?: { aborted: number }): typeof fetch =>
  ((_u: unknown, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => { if (seen) seen.aborted++; reject(abortError()); }, { once: true });
    })) as typeof fetch;

const countOk = (): Response => new Response(null, { status: 200, headers: { "content-range": "*/10" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- ReadOnlyDb: the deadline itself --------------------------------------------------------------

test("default database read limit is 15 seconds", () => {
  assert.equal(LIMITS.dbReadMs, 15_000);
  assert.equal(new ReadOnlyDb(URL, KEY).readTimeoutMs, 15_000);
});

test("a stuck READ is aborted at the limit, throws DbReadTimeoutError naming the operation, and logs it clearly", async () => {
  const seen = { aborted: 0 };
  const log = memoryLogger();
  const db = new ReadOnlyDb(URL, KEY, { fetch: stuckFetch(seen), readTimeoutMs: 150, log });
  const t0 = performance.now();
  await assert.rejects(db.findCompanyByDomain("acme.ai"), (err: unknown) => {
    assert.ok(err instanceof DbReadTimeoutError, String(err));
    assert.equal(err.op, "findCompanyByDomain");
    assert.equal(err.limitMs, 150);
    assert.ok(err.elapsedMs >= 140, `elapsed ${err.elapsedMs}`);
    return true;
  });
  assert.ok(performance.now() - t0 < 2_000, "must fail at the limit, not hang");
  assert.equal(seen.aborted, 1, "the in-flight request must actually be aborted");
  const rec = log.records.find((r) => r.event === "db_read_timeout") as any;
  assert.ok(rec, "timeout must be logged");
  assert.equal(rec.level, "error");
  assert.equal(rec.op, "findCompanyByDomain");
  assert.equal(rec.limit_ms, 150);
  assert.ok(rec.elapsed_ms >= 140);
  assert.match(rec.message, /database read "findCompanyByDomain" timed out after \d+ms \(limit 150ms\)/);
});

test("every read operation is covered: name lookup, event lookup and row counts all time out", async () => {
  const log = memoryLogger();
  const db = new ReadOnlyDb(URL, KEY, { fetch: stuckFetch(), readTimeoutMs: 100, log });
  for (const [op, call] of [
    ["findCompaniesByName", () => db.findCompaniesByName("Acme")],
    ["getEvents", () => db.getEvents(1)],
    ["count(companies)", () => db.counts()],
  ] as const) {
    await assert.rejects(call(), (err: unknown) => err instanceof DbReadTimeoutError && err.op === op, op);
  }
  assert.deepEqual(log.records.filter((r) => r.event === "db_read_timeout").map((r) => (r as any).op), ["findCompaniesByName", "getEvents", "count(companies)"]);
});

test("the deadline holds even if the transport IGNORES the abort signal, and a late failure is not an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const ignoring = (() => new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("socket hang up")), 400))) as typeof fetch;
    const db = new ReadOnlyDb(URL, KEY, { fetch: ignoring, readTimeoutMs: 100 });
    const t0 = performance.now();
    await assert.rejects(db.getEvents(1), DbReadTimeoutError);
    assert.ok(performance.now() - t0 < 300, "caller must be released at the deadline, not when the transport gives up");
    await sleep(700); // let the abandoned request fail late
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("the limit covers ALL retry attempts and backoff, and a timed-out read is never retried", async () => {
  let calls = 0;
  const failing = (async () => {
    calls++;
    await sleep(60);
    return new Response(JSON.stringify({ message: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const db = new ReadOnlyDb(URL, KEY, { fetch: failing, readTimeoutMs: 250 });
  const t0 = performance.now();
  await assert.rejects(db.findCompaniesByName("Acme"), DbReadTimeoutError); // attempt 1 fails at ~60ms; the 400ms backoff crosses the 250ms limit
  assert.ok(performance.now() - t0 < 1_000, `took ${Math.round(performance.now() - t0)}ms: the backoff must not outlive the deadline`);
  assert.equal(calls, 1, "no attempt may start after the deadline");
});

test("transient failures inside the limit are still retried and succeed; non-timeout failures are logged as db_read_failed", async () => {
  let call = 0;
  const flaky = (async () => (++call === 1 ? new Response(JSON.stringify({ message: "transient" }), { status: 500, headers: { "content-type": "application/json" } }) : countOk())) as typeof fetch;
  const db = new ReadOnlyDb(URL, KEY, { fetch: flaky, readTimeoutMs: 5_000 });
  assert.deepEqual(await db.counts(), { companies: 10, discovery_events: 10 });
  assert.equal(call, 3, "one failed attempt, then a success for each table");

  const log = memoryLogger();
  const alwaysBad = (async () => new Response(JSON.stringify({ message: "permission denied" }), { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch;
  await assert.rejects(new ReadOnlyDb(URL, KEY, { fetch: alwaysBad, readTimeoutMs: 5_000, log }).getEvents(1), /failed after 3 attempts/);
  const failed = log.records.find((r) => r.event === "db_read_failed") as any;
  assert.equal(failed.level, "warn");
  assert.equal(failed.op, "getEvents");
  assert.ok(!log.records.some((r) => r.event === "db_read_timeout"), "an ordinary failure is not a timeout");
});

// ---- pipeline behavior: which reads are required, which are optional -----------------------------

const config = (over: Partial<RunConfig> = {}): RunConfig => ({
  dryRun: true, maxNew: DEFAULTS.maxNew, maxCandidates: 50, minConfidence: 0.75, recencyDays: 14, maxEventAgeDays: 45,
  concurrency: 1, leadsPerLane: 6, lanes: undefined, logDir: "logs", limits: { ...LIMITS }, budgetUsd: 0.75, ...over,
});
const lead = (n: number): RawLead => ({
  provider: "fake", lane: "funding", name: `Co${n}`, homepage_hint: `https://co${n}.ai`, event_type_hint: "funding",
  source_url: `https://news.example.com/co${n}`, source_name: "News", event_date: "2026-09-10", headline: `Co${n} raises`, snippet: null, source_retrieved: true,
});
const spyProvider = (leads: RawLead[]) => {
  const state = { discoverCalls: 0 };
  const provider: DiscoveryProvider = { name: "fake", lanes: ["funding"], discover: async () => { state.discoverCalls++; return { leads, errors: [], lanes: [], usage: emptyUsage() }; } };
  return { provider, state };
};
const okVerifier = (state = { calls: 0 }): Verifier & { state: { calls: number } } => ({
  state,
  async verify(l) {
    state.calls++;
    const n = l.name.replace("Co", "");
    return { verification: verification({ name: l.name, canonical_url: `https://co${n}.ai`, source_url: l.source_url, headline: `${l.name} raises $${Number(n) + 1}M`, discovery_reason: `${l.name} raised $${Number(n) + 1}M.` }), retrievedUrls: new Set([l.source_url]) };
  },
});
const timeoutErr = () => new DbReadTimeoutError("findCompanyByDomain", 15_000, 15_002);

class Scripted extends FakeReader {
  findCalls = 0;
  countCalls = 0;
  constructor(private readonly behavior: { find?: (n: number) => Promise<void> | void; count?: (n: number) => Promise<void> | void } = {}) { super(); }
  override async findCompanyByDomain(d: string) { await this.behavior.find?.(++this.findCalls); return super.findCompanyByDomain(d); }
  override async counts() { await this.behavior.count?.(++this.countCalls); return super.counts(); }
}

function run(leads: RawLead[], db: Scripted | ReadOnlyDb, verifier: Verifier, extra: { signal?: AbortSignal; log?: ReturnType<typeof memoryLogger> } = {}) {
  const { provider, state } = spyProvider(leads);
  const log = extra.log ?? memoryLogger();
  const promise = runPipeline({
    provider, verifier, db, checkHomepage: okHomepage("Co1 Co2 Co3 Co4"), log, config: config(), now: NOW, budget: testBudget(), ledger: testLedger(),
    signal: extra.signal ?? new AbortController().signal, clock: new RunClock(LIMITS.runSoftDeadlineMs),
  });
  return { promise, state, log };
}

test("REQUIRED starting row count: a database timeout fails the run BEFORE any discovery or Anthropic spend", async () => {
  const log = memoryLogger();
  const db = new ReadOnlyDb(URL, KEY, { fetch: stuckFetch(), readTimeoutMs: 100, log });
  const verifier = okVerifier();
  const { promise, state } = run([lead(1)], db, verifier, { log });
  await assert.rejects(promise, (err: unknown) => err instanceof DbReadTimeoutError && err.op === "count(companies)");
  assert.equal(state.discoverCalls, 0, "discovery must not start if the row count cannot be established");
  assert.equal(verifier.state.calls, 0);
  assert.ok(log.records.some((r) => r.event === "db_read_timeout"));
});

test("OPTIONAL duplicate pre-check: a timeout is logged and the candidate still goes on to verification; later pre-checks are skipped", async () => {
  const db = new Scripted({ find: () => { throw timeoutErr(); } });
  const verifier = okVerifier();
  const { promise, log } = run([lead(1), lead(2), lead(3)], db, verifier);
  const s = await promise;
  assert.equal(verifier.state.calls, 3, "all three candidates were still verified");
  assert.equal(log.records.filter((r) => r.event === "pre_verify_check_skipped").length, 1, "only the first pre-check is attempted; the rest are skipped");
  assert.ok(s.candidates.every((c) => c.status !== "timeout"), "an optional read must not fail a candidate as a timeout");
});

test("REQUIRED de-duplication: a timeout fails that candidate (never accepted with unknown duplicate status) and the rest fail fast", async () => {
  const db = new Scripted({ find: () => { throw timeoutErr(); } });
  const verifier = okVerifier();
  const { promise, log } = run([lead(1), lead(2), lead(3)], db, verifier);
  const s = await promise;

  assert.deepEqual(s.candidates.map((c) => c.status), ["error", "error", "error"]);
  assert.ok(!s.candidates.some((c) => c.status.startsWith("would_insert")), "no candidate may be accepted without a successful duplicate check");
  const reasons = s.candidates.map((c) => c.reasons.join("|"));
  assert.match(reasons.find((r) => r.startsWith("dedupe_failed:")) ?? "", /exceeded 15000ms/);
  assert.equal(reasons.filter((r) => r === "dedupe_skipped:db_read_timed_out").length, 2);
  // 1 pre-check attempt + 1 dedupe attempt, then fail-fast; NOT 3 + 3 reads at 15 s each.
  assert.equal(db.findCalls, 2);
  assert.equal(log.records.filter((r) => r.event === "dedupe_skipped").length, 2);
  assert.equal(s.status, "completed", "the run continues and reports; it does not crash");
  assert.equal(s.db_unchanged, true);
});

test("a NON-timeout error in the pre-check is tolerated: the candidate is still verified and later pre-checks still run", async () => {
  // Reads happen in this order with concurrency 1: pre-check Co1 (1), pre-check Co2 (2), dedupe (3, 4).
  const db = new Scripted({ find: (n) => { if (n === 2) throw new Error("connection reset"); } });
  const verifier = okVerifier();
  const { promise, log } = run([lead(1), lead(2)], db, verifier);
  const s = await promise;
  assert.equal(verifier.state.calls, 2);
  assert.deepEqual(s.candidates.map((c) => c.status), ["would_insert_company_and_event", "would_insert_company_and_event"]);
  assert.equal(log.records.filter((r) => r.event === "pre_verify_check_skipped").length, 1);
  assert.equal(db.findCalls, 4, "an ordinary error must not trip the breaker: every read was still attempted");
});

test("a NON-timeout database error in the REQUIRED dedupe fails only that candidate and does not trip the fail-fast breaker", async () => {
  const db = new Scripted({ find: (n) => { if (n === 3) throw new Error("connection reset"); } }); // call 3 = first dedupe read
  const { promise } = run([lead(1), lead(2)], db, okVerifier());
  const s = await promise;
  const cands = s.candidates;
  assert.deepEqual(cands.map((c) => c.status).sort(), ["error", "would_insert_company_and_event"], "exactly one candidate fails; the other is deduped normally");
  assert.ok(cands.some((c) => c.reasons.some((r) => r.startsWith("dedupe_failed:") && r.includes("connection reset"))));
  assert.ok(!cands.some((c) => c.reasons.includes("dedupe_skipped:db_read_timed_out")));
  assert.equal(db.findCalls, 4);
});

test("BEST-EFFORT final row count: a timeout still yields a complete summary with rows_after and db_unchanged null", async () => {
  const db = new Scripted({ count: (n) => { if (n === 2) throw new DbReadTimeoutError("count(companies)", 15_000, 15_001); } });
  const { promise, log } = run([lead(1)], db, okVerifier());
  const s = await promise;
  assert.equal(s.rows_after, null);
  assert.equal(s.db_unchanged, null);
  assert.equal(s.status, "completed");
  assert.deepEqual(s.rows_before, { companies: 0, discovery_events: 0 });
  assert.ok(log.records.some((r) => r.event === "rows_after_unavailable"));
});

test("GRACEFUL SHUTDOWN cannot be held hostage by a stuck database: dedupe is bounded to one read, then fail-fast", async () => {
  const shutdown = new AbortController();
  const db = new Scripted({ find: async (n) => { if (n > 0) throw timeoutErr(); } });
  const verifier: Verifier = {
    async verify(l, ctx) {
      if (l.name === "Co3") {
        setTimeout(() => shutdown.abort(new ShutdownError("SIGTERM")), 20);
        await new Promise<never>((_, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
      }
      return okVerifier().verify(l, ctx);
    },
  };
  const { promise } = run([lead(1), lead(2), lead(3), lead(4)], db, verifier, { signal: shutdown.signal });
  const t0 = performance.now();
  const s = await promise;
  assert.ok(performance.now() - t0 < 2_000);
  assert.equal(s.status, "interrupted");
  assert.equal(s.stop_reason, "shutdown:SIGTERM");
  // pre-check: 1 read (then skipped for the others); dedupe: 1 read (then fail-fast for the remaining validated candidate)
  assert.equal(db.findCalls, 2);
  assert.equal(s.counts.aborted, 1);
  assert.equal(s.counts.not_started, 1);
  assert.deepEqual(s.rows_after, s.rows_before, "the final count still works after the shutdown");
});

test("END TO END with the real ReadOnlyDb: a database that goes stuck mid-run degrades gracefully within the limit", async () => {
  let call = 0;
  const seen = { aborted: 0 };
  const stuck = stuckFetch(seen);
  // Calls 1-2 are the starting row counts (succeed); every later read hangs.
  const transport = ((u: unknown, init: RequestInit) => (++call <= 2 ? Promise.resolve(countOk()) : stuck(u as RequestInfo, init))) as typeof fetch;
  const log = memoryLogger();
  const db = new ReadOnlyDb(URL, KEY, { fetch: transport, readTimeoutMs: 100, log });
  const { promise } = run([lead(1), lead(2)], db, okVerifier(), { log });
  const t0 = performance.now();
  const s = await promise;
  assert.ok(performance.now() - t0 < 3_000, `took ${Math.round(performance.now() - t0)}ms`);
  assert.deepEqual(s.rows_before, { companies: 10, discovery_events: 10 });
  assert.equal(s.rows_after, null, "the final count timed out too");
  assert.ok(s.candidates.every((c) => c.status === "error"), "no candidate is accepted without a duplicate check");
  const timeouts = log.records.filter((r) => r.event === "db_read_timeout").map((r) => (r as any).op);
  assert.ok(timeouts.includes("findCompanyByDomain") && timeouts.includes("count(companies)"), JSON.stringify(timeouts));
  assert.ok(seen.aborted >= 3, "every stuck request was actually aborted");
});
