import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ABSOLUTE_BUDGET_CEILING_USD, BudgetGuard, BudgetRefusalError, DEFAULT_ASSUMPTIONS, FALLBACK_PRICE, costOf, estimateSingleShot,
  estimateWebToolRequest, priceFor,
} from "../src/budget.ts";
import { emptyUsage, repairJson, runWithWebTools } from "../src/claude.ts";
import { LIMITS, TOOL_CAPS } from "../src/config.ts";
import { memoryLogger } from "../src/log.ts";
import { createRedactor } from "../src/redact.ts";
import { z } from "zod";
import { aLead, fakeAnthropic, leadsResponse, msgEnd, msgStart, serverToolUse, type Behavior } from "./fake-anthropic.ts";
import { cheapAssumptions, testBudget } from "./helpers.ts";

const usage = (over: Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; webSearches: number; webFetches: number }> = {}) => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0, webFetches: 0, ...over,
});
const cheap = (usd: number) => ({ inputTokens: 0, outputTokens: 0, webSearches: 0, webFetches: 0, usd, basis: "test" });
const req = (label: string, usd: number, stage = "s") => ({ label, stage, model: "claude-sonnet-5", estimate: cheap(usd) });

test("the absolute ceiling is $0.75 and can never be exceeded, only lowered", () => {
  assert.equal(ABSOLUTE_BUDGET_CEILING_USD, 0.75);
  assert.equal(new BudgetGuard().ceilingUsd, 0.75);
  assert.equal(new BudgetGuard({ ceilingUsd: 0.1 }).ceilingUsd, 0.1);
  for (const bad of [0.76, 1, 100, 0, -1, Number.NaN]) assert.throws(() => new BudgetGuard({ ceilingUsd: bad }), /absolute ceiling/, String(bad));
});

test("actual cost matches Phase 1's measured usage (about $6.74 for 3,101,001 in / 53,771 out on Sonnet 5)", () => {
  const cost = costOf("claude-sonnet-5", usage({ inputTokens: 3_101_001, outputTokens: 53_771 }));
  assert.ok(Math.abs(cost - 6.7397) < 0.001, `cost ${cost}`);
  // web search fee is an explicit, configurable assumption
  assert.ok(Math.abs(costOf("claude-sonnet-5", usage({ webSearches: 65 })) - 65 * DEFAULT_ASSUMPTIONS.webSearchUsd) < 1e-9);
  assert.ok(costOf("claude-sonnet-5", usage({ cacheReadTokens: 1_000_000 })) > 0);
});

test("prices: known models by name (date suffix ignored); an UNKNOWN model is priced at the most expensive rate, never cheaper", () => {
  assert.deepEqual(priceFor("claude-haiku-4-5"), { inputPerMTok: 1, outputPerMTok: 5, known: true });
  assert.equal(priceFor("claude-haiku-4-5-20251001").known, true);
  const unknown = priceFor("claude-mystery-9");
  assert.equal(unknown.known, false);
  assert.deepEqual({ i: unknown.inputPerMTok, o: unknown.outputPerMTok }, { i: FALLBACK_PRICE.inputPerMTok, o: FALLBACK_PRICE.outputPerMTok });
  assert.ok(costOf("claude-mystery-9", usage({ inputTokens: 1e6 })) >= costOf("claude-opus-5", usage({ inputTokens: 1e6 })));
});

test("web-tool estimates are CONSERVATIVE: at or above the largest Phase 1 request of each kind", () => {
  // Phase 1 observed: largest discovery lane 584,989 input tokens (6 searches / 3 fetches); largest verification 302,861 (4 / 5).
  const lane = estimateWebToolRequest({ model: "claude-sonnet-5", promptChars: 4000, maxOutputTokens: 16000, caps: TOOL_CAPS.discovery });
  const verify = estimateWebToolRequest({ model: "claude-sonnet-5", promptChars: 8000, maxOutputTokens: 16000, caps: TOOL_CAPS.verification });
  assert.ok(lane.inputTokens >= 584_989, `discovery estimate ${lane.inputTokens}`);
  assert.ok(verify.inputTokens >= 302_861, `verification estimate ${verify.inputTokens}`);
  const observedLaneUsd = costOf("claude-sonnet-5", usage({ inputTokens: 584_989, outputTokens: 6_232, webSearches: 6, webFetches: 3 }));
  assert.ok(lane.usd >= observedLaneUsd, "estimated cost must cover the worst observed lane");
});

test("single-shot estimates are prompt-size + max_tokens bounded", () => {
  const e = estimateSingleShot({ model: "claude-haiku-4-5", promptChars: 30_000, maxOutputTokens: 4000 });
  assert.equal(e.inputTokens, 10_000);
  assert.equal(e.outputTokens, 4000);
  assert.ok(Math.abs(e.usd - (10_000 / 1e6 * 1 + 4000 / 1e6 * 5) * DEFAULT_ASSUMPTIONS.safetyMargin) < 1e-9);
});

test("a Phase 1-style request can NEVER start under the $0.75 ceiling: refused before anything is sent", () => {
  const guard = new BudgetGuard();
  const est = estimateWebToolRequest({ model: "claude-sonnet-5", promptChars: 4000, maxOutputTokens: 16000, caps: TOOL_CAPS.discovery });
  assert.ok(est.usd > 0.75);
  assert.throws(() => guard.reserve({ label: "funding#1", stage: "discover", model: "claude-sonnet-5", estimate: est }), (err: unknown) => {
    assert.ok(err instanceof BudgetRefusalError);
    assert.equal(err.why, "estimate_exceeds_remaining");
    assert.equal(err.ceilingUsd, 0.75);
    assert.match(err.message, /worst-case estimate/);
    return true;
  });
  assert.equal(guard.exhausted, true);
  assert.equal(guard.committedUsd, 0);
});

test("reservations count while in flight: two requests that fit alone but not together => the second is refused", () => {
  const guard = new BudgetGuard({ ceilingUsd: 0.5 });
  const a = guard.reserve(req("a", 0.3));
  assert.throws(() => guard.reserve(req("b", 0.3)), BudgetRefusalError);
  guard.settle(a, { kind: "ok", usage: usage({ inputTokens: 1000 }) });
  assert.ok(guard.remainingUsd > 0.49);
});

test("after ANY refusal the guard is exhausted: even a tiny request is refused for the rest of the run", () => {
  const guard = new BudgetGuard({ ceilingUsd: 0.2 });
  assert.throws(() => guard.reserve(req("big", 0.5)), BudgetRefusalError);
  assert.equal(guard.exhausted, true);
  assert.throws(() => guard.reserve(req("tiny", 0.0001)), (e: unknown) => e instanceof BudgetRefusalError && e.why === "exhausted_by_earlier_refusal");
  const snap = guard.snapshot();
  assert.equal(snap.refused_count, 2);
  assert.equal(snap.exhausted, true);
  assert.equal(snap.requests, 0, "refused requests are not counted as requests");
  assert.deepEqual(guard.entries().map((e) => [e.label, e.outcome]), [["big", "refused"], ["tiny", "refused"]]);
});

test("settling with real usage charges the ACTUAL cost and releases the unused reservation", () => {
  const guard = new BudgetGuard({ ceilingUsd: 0.5 });
  const r = guard.reserve(req("x", 0.4));
  assert.ok(Math.abs(guard.remainingUsd - 0.1) < 1e-9);
  guard.settle(r, { kind: "ok", usage: usage({ inputTokens: 10_000, outputTokens: 1_000 }), requestId: "req_1" });
  const actual = costOf("claude-sonnet-5", usage({ inputTokens: 10_000, outputTokens: 1_000 }));
  assert.ok(Math.abs(guard.committedUsd - actual) < 1e-9);
  assert.equal(guard.inFlightUsd, 0);
  assert.ok(guard.remainingUsd > 0.469, "the surplus of the reservation is available again");
  const e = guard.entries()[0]!;
  assert.deepEqual({ outcome: e.outcome, underestimated: e.underestimated, id: e.request_id }, { outcome: "ok", underestimated: false, id: "req_1" });
  assert.equal(e.estimate.usd, 0.4);
  assert.ok(e.actual && Math.abs(e.actual.usd - actual) < 1e-9);
});

test("unknown-cost outcomes (abort, timeout, mid-stream failure) are charged the FULL reservation; an HTTP rejection costs nothing", () => {
  const guard = new BudgetGuard({ ceilingUsd: 0.75 });
  const a = guard.reserve(req("aborted", 0.2));
  const b = guard.reserve(req("rejected", 0.2));
  guard.settle(a, { kind: "unknown", note: "aborted mid-stream" });
  guard.settle(b, { kind: "no_charge", note: "HTTP 400 before any output" });
  assert.ok(Math.abs(guard.committedUsd - 0.2) < 1e-9);
  assert.deepEqual(guard.entries().map((e) => [e.outcome, e.charged_usd]), [["unknown_cost_charged_reservation", 0.2], ["no_charge", 0]]);
});

test("settling twice is a no-op (a cost can never be double counted)", () => {
  const guard = new BudgetGuard();
  const r = guard.reserve(req("x", 0.1));
  guard.settle(r, { kind: "unknown", note: "a" });
  guard.settle(r, { kind: "unknown", note: "b" });
  guard.settle(r, { kind: "ok", usage: usage({ inputTokens: 5e6 }) });
  assert.ok(Math.abs(guard.committedUsd - 0.1) < 1e-9);
});

test("an UNDERESTIMATE is recorded honestly: the real cost is charged even above the reservation, and the ceiling breach is flagged", () => {
  const guard = new BudgetGuard({ ceilingUsd: 0.1 });
  const r = guard.reserve(req("optimistic", 0.05));
  guard.settle(r, { kind: "ok", usage: usage({ inputTokens: 200_000, outputTokens: 20_000 }) }); // real cost ~ $0.60
  const e = guard.entries()[0]!;
  assert.equal(e.underestimated, true);
  const snap = guard.snapshot();
  assert.equal(snap.ceiling_exceeded, true);
  assert.ok(snap.committed_usd > 0.1);
  assert.equal(snap.remaining_usd < 0, true);
  assert.throws(() => guard.reserve(req("next", 0.0001)), BudgetRefusalError, "nothing more may start once the ceiling is breached");
});

test("the estimate self-corrects: it is raised to 1.25x the largest actual cost already seen for that stage", () => {
  const guard = new BudgetGuard({ ceilingUsd: 0.75 });
  const first = guard.reserve(req("a", 0.01, "verify"));
  guard.settle(first, { kind: "ok", usage: usage({ inputTokens: 50_000 }) }); // actual $0.10
  const second = guard.reserve(req("b", 0.01, "verify"));
  assert.ok(Math.abs(second.reservedUsd - 0.125) < 1e-9, `reserved ${second.reservedUsd}`);
  assert.match(guard.entries()[1]!.estimate.basis, /raised to 1\.25x/);
  const other = guard.reserve(req("c", 0.01, "discover")); // a different stage is not affected
  assert.equal(other.reservedUsd, 0.01);
});

test("the ledger records estimated AND actual usage, persists incrementally and consolidated, and redacts secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-cost-"));
  const secret = "sk-ant-api03-SECRETSECRETSECRET1234567890";
  const guard = new BudgetGuard({ ceilingUsd: 0.75, persist: { dir, runId: "run1", redact: createRedactor([secret]) } });
  const r = guard.reserve({ label: `verify:${secret}`, stage: "verify", model: "claude-haiku-4-5", estimate: estimateSingleShot({ model: "claude-haiku-4-5", promptChars: 9000, maxOutputTokens: 1000 }) });
  const midway = readFileSync(join(dir, "run1.cost.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(midway.map((l) => l.event), ["reserved"], "the reservation is on disk before the request completes");
  guard.settle(r, { kind: "ok", usage: usage({ inputTokens: 3000, outputTokens: 400 }) });
  guard.close();
  guard.close(); // idempotent
  const lines = readFileSync(join(dir, "run1.cost.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ["reserved", "settled"]);
  const full = JSON.parse(readFileSync(join(dir, "run1.cost.json"), "utf8"));
  assert.equal(full.entries.length, 1);
  assert.ok(full.entries[0].estimate.usd > 0 && full.entries[0].actual.usd > 0, "both estimated and actual are recorded");
  assert.equal(full.summary.by_stage.verify.requests, 1);
  assert.ok(!JSON.stringify(full).includes(secret) && !readFileSync(join(dir, "run1.cost.jsonl"), "utf8").includes(secret));
  assert.equal(guard.snapshot().files.json, join(dir, "run1.cost.json"));
});

// ---- the guard at the real choke point (claude.ts), with the REAL SDK over a fake transport ----------------------

const webOpts = (budget: BudgetGuard, over: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-5", system: "s", user: "u", label: "funding", stage: "discover", budget, caps: TOOL_CAPS.discovery,
  requestTimeoutMs: 5_000, headerTimeoutMs: 5_000, fetchMaxContentTokens: LIMITS.webFetchMaxContentTokens,
  signal: new AbortController().signal, usage: emptyUsage(), log: memoryLogger(), ...over,
});

test("REFUSES BEFORE SENDING: a request whose worst case exceeds the ceiling never reaches the network", async () => {
  const { client, calls } = fakeAnthropic([leadsResponse([aLead()])]);
  const budget = new BudgetGuard(); // real (pessimistic) assumptions, real caps
  await assert.rejects(runWithWebTools(client, webOpts(budget)), BudgetRefusalError);
  assert.equal(calls.length, 0, "no HTTP request may be made");
  assert.equal(budget.entries()[0]!.outcome, "refused");
  assert.equal(budget.committedUsd, 0);
});

test("a request inside the budget runs; its ledger entry holds the estimate and the actual usage-based cost", async () => {
  const { client } = fakeAnthropic([leadsResponse([aLead()])]);
  const budget = testBudget();
  await runWithWebTools(client, webOpts(budget));
  const e = budget.entries()[0]!;
  assert.equal(e.outcome, "ok");
  assert.equal(e.stage, "discover");
  assert.equal(e.request_id, "req_test123");
  assert.ok(e.estimate.usd > e.actual!.usd);
  // fake stream reports 2000 input / 80 output tokens and one search; cheap assumptions price searches at $0
  assert.ok(Math.abs(e.actual!.usd - (2000 / 1e6 * 2 + 80 / 1e6 * 10)) < 1e-9);
  assert.equal(e.actual!.webSearches, 1);
});

test("an aborted request is charged its full reservation (its real cost is unknowable)", async () => {
  const { client } = fakeAnthropic([{ kind: "stall", events: [msgStart(1000), ...serverToolUse(0, "s", "web_search", { query: "q" })] }]);
  const budget = testBudget();
  await assert.rejects(runWithWebTools(client, webOpts(budget, { requestTimeoutMs: 150 })));
  const e = budget.entries()[0]!;
  assert.equal(e.outcome, "unknown_cost_charged_reservation");
  assert.equal(budget.committedUsd, e.reserved_usd);
  assert.equal(budget.inFlightUsd, 0);
});

test("each pause_turn continuation reserves separately and is refused if the remainder cannot cover it", async () => {
  const pause: Behavior = { kind: "sse", events: [msgStart(50_000), ...serverToolUse(0, "s1", "web_search", { query: "a" }), ...msgEnd("pause_turn", 10, 1)] };
  const { client, calls } = fakeAnthropic([pause, leadsResponse([])]);
  const budget = testBudget({ ceilingUsd: 0.2 }); // first request actually costs ~$0.10 (50K input); a second reservation (~$0.16 output) no longer fits
  await assert.rejects(runWithWebTools(client, webOpts(budget)), BudgetRefusalError);
  assert.equal(calls.length, 1, "the continuation was refused before it was sent");
  assert.deepEqual(budget.entries().map((e) => e.outcome), ["ok", "refused"]);
});

test("the JSON repair call is an API operation too: it reserves budget and is refused when exhausted", async () => {
  const { client, calls } = fakeAnthropic([{ kind: "json", body: {} }]);
  const budget = testBudget({ ceilingUsd: 0.05 }); // a 4,000-token repair reserves ~$0.04+; then pre-exhaust
  assert.throws(() => budget.reserve(req("boom", 10)), BudgetRefusalError);
  await assert.rejects(
    repairJson(client, "text", "{}", z.object({}), {
      model: "claude-sonnet-5", label: "verify:Acme", stage: "verify", budget, signal: new AbortController().signal,
      requestTimeoutMs: 1000, headerTimeoutMs: 1000, usage: emptyUsage(), log: memoryLogger(),
    }),
    BudgetRefusalError,
  );
  assert.equal(calls.length, 0);
});

test("cheapAssumptions exist only to keep plumbing tests runnable: the real defaults stay pessimistic", () => {
  assert.ok(DEFAULT_ASSUMPTIONS.perOpInputTokens > (cheapAssumptions.perOpInputTokens ?? 0));
  assert.equal(DEFAULT_ASSUMPTIONS.safetyMargin, 1.25);
  assert.equal(DEFAULT_ASSUMPTIONS.opsPerToolUse, 3);
});
