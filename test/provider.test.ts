import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, TOOL_CAPS, type Limits } from "../src/config.ts";
import { RunClock, ShutdownError } from "../src/deadline.ts";
import { memoryLogger } from "../src/log.ts";
import { createDefaultRouter } from "../src/models.ts";
import { ClaudeWebProvider } from "../src/providers/claude-web.ts";
import type { DiscoveryContext } from "../src/providers/types.ts";
import { ClaudeVerifier } from "../src/verify.ts";
import { emptyUsage } from "../src/claude.ts";
import { aLead, fakeAnthropic, leadsResponse, msgStart, serverToolUse, type Behavior } from "./fake-anthropic.ts";
import { NOW, testBudget } from "./helpers.ts";

const stall = (): Behavior => ({ kind: "stall", events: [msgStart(700), ...serverToolUse(0, "srv_x", "web_search", { query: "slow one" })] });

function ctx(over: Partial<DiscoveryContext> = {}): DiscoveryContext & { log: ReturnType<typeof memoryLogger> } {
  const log = memoryLogger();
  return {
    today: NOW, recencyDays: 14, leadsPerLane: 6, lanes: ["funding", "launches"], laneMs: 5_000,
    signal: new AbortController().signal, clock: new RunClock(LIMITS.runSoftDeadlineMs), log, ...over,
  } as DiscoveryContext & { log: ReturnType<typeof memoryLogger> };
}
const limits = (over: Partial<Limits> = {}): Limits => ({ ...LIMITS, discoveryRequestMs: 5_000, ...over });

test("LANE DEADLINE: a lane that overruns is marked timed out, says exactly what timed out, and the NEXT lane still runs", async () => {
  const { client, calls } = fakeAnthropic([stall(), leadsResponse([aLead()])]);
  const c = ctx({ laneMs: 250 });
  const res = await new ClaudeWebProvider(client, createDefaultRouter({}), limits(), testBudget()).discover(c);

  const [funding, launches] = res.lanes;
  assert.equal(funding!.status, "timeout");
  assert.deepEqual({ kind: funding!.timeout!.kind, label: funding!.timeout!.label, limit: funding!.timeout!.limit_ms }, { kind: "lane", label: "funding", limit: 250 });
  assert.ok(funding!.elapsed_ms >= 200 && funding!.elapsed_ms < 3_000, `lane elapsed ${funding!.elapsed_ms}`);
  assert.equal(funding!.usage.inputTokens, 700, "usage of the aborted lane is still recorded");
  assert.match(funding!.error!, /lane timeout: "funding"/);

  assert.equal(launches!.status, "ok", "the run continues after a failed lane");
  assert.equal(launches!.leads, 1);
  assert.equal(res.leads.length, 1);
  assert.equal(res.leads[0]!.lane, "launches");
  assert.equal(res.leads[0]!.source_retrieved, true);
  assert.deepEqual(res.errors.map((e) => e.lane), ["funding"]);
  assert.equal(calls.length, 2);

  const t = c.log.records.find((r) => r.event === "timeout") as any;
  assert.equal(t.kind, "lane");
  assert.equal(t.label, "funding");
  assert.equal(t.pending_ops[0].target, "slow one", "the web operation that was pending is named");
  assert.ok(c.log.records.some((r) => r.event === "lane_failed" && (r as any).status === "timeout"));
});

test("REQUEST DEADLINE inside a lane: reported as a request timeout with the request label", async () => {
  const { client } = fakeAnthropic([stall(), leadsResponse([])]);
  const res = await new ClaudeWebProvider(client, createDefaultRouter({}), limits({ discoveryRequestMs: 200 }), testBudget()).discover(ctx({ laneMs: 5_000 }));
  assert.equal(res.lanes[0]!.status, "timeout");
  assert.deepEqual({ kind: res.lanes[0]!.timeout!.kind, label: res.lanes[0]!.timeout!.label, limit: res.lanes[0]!.timeout!.limit_ms }, { kind: "request", label: "funding#1", limit: 200 });
  assert.equal(res.lanes[1]!.status, "ok");
});

test("lanes run SERIALLY: the next lane's request starts only after the previous lane finished", async () => {
  const slowOk = (): Behavior => ({ ...(leadsResponse([]) as any), events: [...(leadsResponse([]) as any).events.slice(0, 1), { wait: 90 }, ...(leadsResponse([]) as any).events.slice(1)] });
  const { client, calls } = fakeAnthropic([slowOk(), slowOk(), slowOk()]);
  await new ClaudeWebProvider(client, createDefaultRouter({}), limits(), testBudget()).discover(ctx({ lanes: ["funding", "launches", "stealth"] }));
  assert.equal(calls.length, 3);
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i]!.startedAt - calls[i - 1]!.startedAt >= 85, `call ${i + 1} started ${Math.round(calls[i]!.startedAt - calls[i - 1]!.startedAt)}ms after call ${i}: overlapping lanes`);
  }
});

test("RUN SOFT DEADLINE: once reached, no NEW lane starts (the in-flight lane still finishes)", async () => {
  let now = 0;
  const clock = new RunClock(1_000, () => now);
  const { client, calls } = fakeAnthropic((call) => {
    if (call.n === 1) now = 5_000; // the first lane is in flight when the soft deadline passes
    return leadsResponse([aLead()]);
  });
  const c = ctx({ lanes: ["funding", "launches", "stealth"], clock });
  const res = await new ClaudeWebProvider(client, createDefaultRouter({}), limits(), testBudget()).discover(c);
  assert.deepEqual(res.lanes.map((l) => l.status), ["ok", "skipped_run_deadline", "skipped_run_deadline"]);
  assert.equal(res.leads.length, 1, "the in-flight lane's results are kept");
  assert.equal(calls.length, 1);
  assert.ok(c.log.records.some((r) => r.event === "lane_skipped" && (r as any).reason === "run_soft_deadline"));
});

test("SHUTDOWN mid-lane: the lane is aborted, later lanes are skipped, no new request is made", async () => {
  const { client, calls } = fakeAnthropic([stall(), leadsResponse([])]);
  const parent = new AbortController();
  setTimeout(() => parent.abort(new ShutdownError("SIGINT")), 100);
  const res = await new ClaudeWebProvider(client, createDefaultRouter({}), limits(), testBudget()).discover(ctx({ signal: parent.signal, lanes: ["funding", "launches", "stealth"] }));
  assert.deepEqual(res.lanes.map((l) => l.status), ["aborted", "skipped_shutdown", "skipped_shutdown"]);
  assert.equal(calls.length, 1);
  assert.equal(res.errors.length, 0, "a shutdown is not a lane failure");
});

test("per-lane elapsed time, token usage and search/fetch counts are recorded", async () => {
  const { client } = fakeAnthropic([leadsResponse([aLead()])]);
  const res = await new ClaudeWebProvider(client, createDefaultRouter({}), limits(), testBudget()).discover(ctx({ lanes: ["funding"] }));
  const lane = res.lanes[0]!;
  assert.equal(lane.status, "ok");
  assert.ok(lane.elapsed_ms > 0);
  assert.deepEqual({ calls: lane.usage.apiCalls, in: lane.usage.inputTokens, out: lane.usage.outputTokens, searches: lane.usage.webSearches, fetches: lane.usage.webFetches }, { calls: 1, in: 2000, out: 80, searches: 1, fetches: 0 });
  assert.deepEqual(res.usage, lane.usage);
});

test("discovery requests carry the unchanged caps and the 20K fetch-content cap", async () => {
  const { client, calls } = fakeAnthropic([leadsResponse([])]);
  await new ClaudeWebProvider(client, createDefaultRouter({}), limits(), testBudget()).discover(ctx({ lanes: ["funding"] }));
  const tools = calls[0]!.body.tools as Array<Record<string, any>>;
  assert.equal(tools.find((t) => t.name === "web_search")!.max_uses, TOOL_CAPS.discovery.maxSearches);
  assert.equal(tools.find((t) => t.name === "web_fetch")!.max_uses, TOOL_CAPS.discovery.maxFetches);
  assert.equal(tools.find((t) => t.name === "web_fetch")!.max_content_tokens, 20_000);
  assert.equal(calls[0]!.body.model, "claude-sonnet-5");
});

// ---- verifier ---------------------------------------------------------------------------------

const lead = { provider: "t", lane: "funding", name: "Acme", homepage_hint: "https://acme.ai", event_type_hint: "funding", source_url: "https://news.example.com/a", source_name: "News", event_date: null, headline: null, snippet: null, source_retrieved: true };

test("VERIFIER: a request that exceeds the 5-minute-class limit times out as a request timeout, keeping partial usage", async () => {
  const { client } = fakeAnthropic([stall()]);
  const log = memoryLogger();
  const usage = emptyUsage();
  const verifier = new ClaudeVerifier(client, createDefaultRouter({}), testBudget(), NOW, { ...LIMITS, verificationRequestMs: 200 });
  await assert.rejects(verifier.verify(lead, { signal: new AbortController().signal, usage, log }), (err: any) => err.name === "ScoutTimeoutError" && err.kind === "request" && err.label === "verify:Acme#1" && err.limitMs === 200);
  assert.equal(usage.inputTokens, 700);
  assert.equal(usage.apiCalls, 1);
});

test("VERIFIER: requests carry the unchanged verification caps (4 searches / 5 fetches) and the 20K fetch cap", async () => {
  assert.equal(LIMITS.verificationRequestMs, 5 * 60_000);
  assert.equal(LIMITS.discoveryRequestMs, 6 * 60_000);
  const { client, calls } = fakeAnthropic([leadsResponse([])]);
  const verifier = new ClaudeVerifier(client, createDefaultRouter({}), testBudget(), NOW);
  // The reply is not a valid verification, so the verifier attempts one repair; that is fine, we only inspect request 1.
  await verifier.verify(lead, { signal: new AbortController().signal, usage: emptyUsage(), log: memoryLogger() }).catch(() => {});
  const tools = calls[0]!.body.tools as Array<Record<string, any>>;
  assert.equal(tools.find((t) => t.name === "web_search")!.max_uses, 4);
  assert.equal(tools.find((t) => t.name === "web_fetch")!.max_uses, 5);
  assert.equal(tools.find((t) => t.name === "web_fetch")!.max_content_tokens, 20_000);
});

test("configured limits match the requested values", () => {
  assert.deepEqual(
    { ...LIMITS },
    {
      discoveryRequestMs: 360_000, verificationRequestMs: 300_000, repairRequestMs: 60_000, sdkHeaderTimeoutMs: 60_000,
      laneMs: 540_000, candidateMs: 420_000, runSoftDeadlineMs: 2_700_000, webFetchMaxContentTokens: 20_000, dbReadMs: 15_000,
    },
  );
});
