import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ModelTruncatedError, emptyUsage, repairJson, runWithWebTools, type WebRunOptions } from "../src/claude.ts";
import { LIMITS, TOOL_CAPS } from "../src/config.ts";
import { ScoutTimeoutError, ShutdownError } from "../src/deadline.ts";
import { memoryLogger } from "../src/log.ts";
import { createSdkLogger } from "../src/sdklog.ts";
import {
  fakeAnthropic, fetchError, leadsResponse, msgEnd, msgStart, searchResult, serverToolUse, textBlock, type Behavior,
} from "./fake-anthropic.ts";
import { testBudget } from "./helpers.ts";

function opts(over: Partial<WebRunOptions> = {}): WebRunOptions & { log: ReturnType<typeof memoryLogger> } {
  const log = memoryLogger();
  return {
    model: "claude-sonnet-5", system: "s", user: "u", label: "funding", stage: "discover", budget: testBudget(), caps: TOOL_CAPS.discovery,
    requestTimeoutMs: 5_000, headerTimeoutMs: 5_000, fetchMaxContentTokens: LIMITS.webFetchMaxContentTokens,
    signal: new AbortController().signal, usage: emptyUsage(), log, ...over,
  } as WebRunOptions & { log: ReturnType<typeof memoryLogger> };
}

/** A request that sent a web_fetch call, never got its result, and then stalled. */
const stalledOnFetch = (): Behavior => ({
  kind: "stall",
  events: [msgStart(1234), ...serverToolUse(0, "srvtoolu_slow", "web_fetch", { url: "https://very-slow.example.com/page" })],
});

test("REQUEST TIMEOUT: a stalled stream is aborted at the wall-clock limit and reported precisely", async () => {
  const { client, calls } = fakeAnthropic([stalledOnFetch()]);
  const o = opts({ requestTimeoutMs: 250 });
  const t0 = performance.now();
  await assert.rejects(runWithWebTools(client, o), (err: unknown) => {
    assert.ok(err instanceof ScoutTimeoutError, String(err));
    assert.equal(err.kind, "request");
    assert.equal(err.label, "funding#1");
    assert.equal(err.limitMs, 250);
    assert.ok(err.elapsedMs >= 200, `elapsed ${err.elapsedMs}`);
    return true;
  });
  assert.ok(performance.now() - t0 < 3_000, "must fail at the limit, not hang");
  assert.notEqual(calls[0]!.abortedAt, null, "the abort must reach the transport (the connection is actually cancelled)");

  // Logged: exactly what timed out, and which web operation was still pending.
  const t = o.log.records.find((r) => r.event === "timeout") as any;
  assert.ok(t, "timeout must be logged");
  assert.equal(t.kind, "request");
  assert.equal(t.label, "funding#1");
  assert.equal(t.limit_ms, 250);
  assert.equal(t.pending_ops.length, 1);
  assert.equal(t.pending_ops[0].name, "web_fetch");
  assert.equal(t.pending_ops[0].target, "https://very-slow.example.com/page");
  assert.ok(t.pending_ops[0].waiting_ms >= 0);
  // Usage survives the failure (it still cost money).
  assert.equal(o.usage.apiCalls, 1);
  assert.equal(o.usage.inputTokens, 1234);
  assert.equal(o.usage.webFetches, 1);
});

test("RETRY WAITS ARE ABORTED: a huge Retry-After cannot hold the request past its deadline", async () => {
  const { client, calls } = fakeAnthropic([{ kind: "status", status: 429, headers: { "retry-after": "3600" } }]);
  const t0 = performance.now();
  await assert.rejects(runWithWebTools(client, opts({ requestTimeoutMs: 300 })), (err: unknown) => {
    assert.ok(err instanceof ScoutTimeoutError && err.kind === "request", String(err));
    return true;
  });
  assert.ok(performance.now() - t0 < 3_000, `should abort the 1-hour retry sleep, took ${Math.round(performance.now() - t0)}ms`);
  assert.equal(calls.length, 1, "no further attempt may be made after the abort");
});

test("SHUTDOWN aborts an in-flight request and its transport, and is reported as a shutdown, not a timeout", async () => {
  const { client, calls } = fakeAnthropic([stalledOnFetch()]);
  const parent = new AbortController();
  const o = opts({ signal: parent.signal });
  setTimeout(() => parent.abort(new ShutdownError("SIGTERM")), 80);
  await assert.rejects(runWithWebTools(client, o), (err: unknown) => err instanceof ShutdownError && err.signalName === "SIGTERM");
  assert.notEqual(calls[0]!.abortedAt, null);
  const failed = o.log.records.find((r) => r.event === "anthropic_request_failed") as any;
  assert.equal(failed.request.outcome, "aborted");
  assert.ok(!o.log.records.some((r) => r.event === "timeout"), "a shutdown must not be logged as a timeout");
});

test("SDK retries still work when nothing aborts: a 500 is retried, and the retry is logged without secrets", async () => {
  const log = memoryLogger();
  const { client, calls } = fakeAnthropic(
    [{ kind: "status", status: 500, headers: { "retry-after-ms": "5", "request-id": "req_failed_1" } }, leadsResponse([])],
    { logLevel: "info", logger: createSdkLogger(log) },
  );
  const result = await runWithWebTools(client, opts({ log }));
  assert.equal(calls.length, 2);
  assert.equal(result.requests.length, 1);
  const retry = log.records.find((r) => r.event === "sdk_retry") as any;
  assert.ok(retry, "the retry must be logged");
  assert.match(String(retry.message), /retrying, 2 attempts remaining/);
  assert.equal(retry.request_id, "req_failed_1");
  assert.ok(!JSON.stringify(log.records).includes("sk-ant-test-key"), "the API key must never appear in logs");
});

test("SDK PRE-HEADER TIMEOUT: no headers within the limit is reported as a 'header' timeout", async () => {
  const { client } = fakeAnthropic([{ kind: "no-headers" }], { maxRetries: 0 });
  const o = opts({ headerTimeoutMs: 120, requestTimeoutMs: 10_000 });
  await assert.rejects(runWithWebTools(client, o), (err: unknown) => {
    assert.ok(err instanceof ScoutTimeoutError, String(err));
    assert.equal(err.kind, "header");
    assert.equal(err.limitMs, 120);
    return true;
  });
  assert.ok(o.log.records.some((r) => r.event === "timeout" && (r as any).kind === "header"));
});

test("SDK pre-header timeout is 60 seconds on the wire (lowered from the 10-minute default)", async () => {
  assert.equal(LIMITS.sdkHeaderTimeoutMs, 60_000);
  const { client, calls } = fakeAnthropic([leadsResponse([])]);
  await runWithWebTools(client, opts({ headerTimeoutMs: LIMITS.sdkHeaderTimeoutMs }));
  assert.equal(calls[0]!.headers.get("x-stainless-timeout"), "60");
});

test("COST CONTROL: web_fetch is capped at 20,000 content tokens; search/fetch use caps are exactly the originals", async () => {
  assert.equal(LIMITS.webFetchMaxContentTokens, 20_000);
  assert.deepEqual(TOOL_CAPS, { discovery: { maxSearches: 6, maxFetches: 3 }, verification: { maxSearches: 4, maxFetches: 5 } });
  const { client, calls } = fakeAnthropic([leadsResponse([])]);
  await runWithWebTools(client, opts());
  const tools = calls[0]!.body.tools as Array<Record<string, unknown>>;
  const search = tools.find((t) => t.name === "web_search")!;
  const fetchTool = tools.find((t) => t.name === "web_fetch")!;
  assert.equal(search.type, "web_search_20260209", "must keep the current web tool versions");
  assert.equal(fetchTool.type, "web_fetch_20260209", "must keep the current web tool versions");
  assert.equal(search.max_uses, 6);
  assert.equal(fetchTool.max_uses, 3);
  assert.equal(fetchTool.max_content_tokens, 20_000);
  assert.equal(tools.length, 2, "no extra tools (e.g. a separate code_execution tool)");
});

test("PAUSE_TURN continuations each get their own request deadline and label; usage accumulates", async () => {
  const pause: Behavior = { kind: "sse", events: [msgStart(500), ...serverToolUse(0, "s1", "web_search", { query: "a" }), ...msgEnd("pause_turn", 10, 1)] };
  const { client, calls } = fakeAnthropic([pause, leadsResponse([])]);
  const o = opts();
  const result = await runWithWebTools(client, o);
  assert.equal(calls.length, 2);
  assert.equal(result.continuations, 1);
  assert.deepEqual(result.requests.map((r) => r.label), ["funding#1", "funding#2"]);
  assert.equal(o.usage.apiCalls, 2);
  assert.equal(o.usage.inputTokens, 500 + 2000);
  assert.equal(o.usage.webSearches, 2);
});

test("PAUSE_TURN loop is bounded", async () => {
  const pause: Behavior = { kind: "sse", events: [msgStart(10), ...msgEnd("pause_turn", 1, 0)] };
  const { client, calls } = fakeAnthropic([pause]);
  await assert.rejects(runWithWebTools(client, opts({ maxContinuations: 2 })), ModelTruncatedError);
  assert.equal(calls.length, 3);
});

test("INSTRUMENTATION: request id, per-operation timing, tool errors and stream gaps are captured and logged", async () => {
  const { client } = fakeAnthropic([
    {
      kind: "sse",
      events: [
        msgStart(3000),
        ...serverToolUse(0, "srvtoolu_a", "web_search", { query: "ai startup seed round" }),
        { wait: 70 }, // the search takes ~70ms server-side
        ...searchResult(1, "srvtoolu_a", ["https://news.example.com/a"]),
        ...serverToolUse(2, "srvtoolu_b", "web_fetch", { url: "https://blocked.example.com/x" }),
        { wait: 20 },
        ...fetchError(3, "srvtoolu_b", "url_not_accessible"),
        ...textBlock(4, JSON.stringify({ leads: [] })),
        ...msgEnd("end_turn", 90, 1, 1),
      ],
    },
  ]);
  const o = opts();
  const result = await runWithWebTools(client, o);
  const report = result.requests[0]!;
  assert.equal(report.request_id, "req_test123");
  assert.equal(report.outcome, "ok");
  assert.equal(report.stop_reason, "end_turn");
  assert.ok(report.first_event_ms !== null && report.event_count > 10);
  assert.ok(report.max_gap_ms >= 60, `max gap ${report.max_gap_ms}`);
  assert.equal(report.max_gap_after, "content_block_stop");

  const [search, fetched] = report.ops;
  assert.equal(search!.name, "web_search");
  assert.equal(search!.target, "ai startup seed round");
  assert.ok(search!.tool_ms! >= 60 && search!.tool_ms! < 1000, `search tool_ms ${search!.tool_ms}`);
  assert.equal(fetched!.name, "web_fetch");
  assert.equal(fetched!.target, "https://blocked.example.com/x");
  assert.equal(fetched!.error_code, "url_not_accessible");
  assert.equal(report.slowest_op!.tool_ms, search!.tool_ms, "the slowest web operation is identified");

  // Each operation is also logged as its own event, so a later stall can be attributed.
  const ops = o.log.records.filter((r) => r.event === "web_op") as any[];
  assert.equal(ops.length, 2);
  assert.equal(ops[0].request_id, "req_test123");
  assert.equal(ops[0].target, "ai startup seed round");
  assert.equal(ops[1].error_code, "url_not_accessible");
  const done = o.log.records.find((r) => r.event === "anthropic_request") as any;
  assert.equal(done.request.request_id, "req_test123");
  // Authoritative usage from the final message.
  assert.equal(o.usage.inputTokens, 3000);
  assert.equal(o.usage.outputTokens, 90);
  assert.equal(o.usage.webSearches, 1);
  assert.equal(o.usage.webFetches, 1);
});

test("REPAIR call is bounded too: a stalled repair times out as a request timeout labelled ':repair'", async () => {
  const { client } = fakeAnthropic([{ kind: "no-headers" }], { maxRetries: 0 });
  const usage = emptyUsage();
  await assert.rejects(
    repairJson(client, "not json", "{}", z.object({}), {
      model: "m", label: "verify:Acme", stage: "verify", budget: testBudget(), signal: new AbortController().signal, requestTimeoutMs: 150, headerTimeoutMs: 10_000, usage, log: memoryLogger(),
    }),
    (err: unknown) => err instanceof ScoutTimeoutError && err.kind === "request" && err.label === "verify:Acme:repair" && err.limitMs === 150,
  );
});

test("SDK plumbing sanity: the fake transport is exercised by the real SDK (guards against a vacuous test suite)", async () => {
  const { client } = fakeAnthropic([leadsResponse([])]);
  assert.ok(client instanceof Anthropic);
  const result = await runWithWebTools(client, opts());
  assert.equal(result.text, JSON.stringify({ leads: [] }));
  assert.ok(result.seenUrls.has("https://news.example.com/a"));
});
