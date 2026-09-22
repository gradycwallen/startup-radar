import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { runWithWebTools, emptyUsage } from "../src/claude.ts";
import { TOOL_CAPS, LIMITS } from "../src/config.ts";
import { ScoutTimeoutError } from "../src/deadline.ts";
import { FatalApiError, classifyFatalApiError } from "../src/fatal.ts";
import { memoryLogger } from "../src/log.ts";
import { CREDIT_ERROR_BODY, fakeAnthropic, msgStart, serverToolUse } from "./fake-anthropic.ts";
import { testBudget } from "./helpers.ts";

const api = (status: number | undefined, body: object, headers?: Record<string, string>) =>
  // Real HTTP responses always carry headers; without them the SDK returns a status-less connection error.
  Anthropic.APIError.generate(status, body, undefined, new Headers(headers ?? {}));
const body = (type: string, message: string) => ({ type: "error", error: { type, message } });

test("insufficient credit is fatal: the exact Phase 1 400 body, with the request id and status kept", () => {
  const f = classifyFatalApiError(api(400, CREDIT_ERROR_BODY, { "request-id": "req_credit_1" }));
  assert.ok(f instanceof FatalApiError);
  assert.equal(f.kind, "insufficient_credit");
  assert.equal(f.status, 400);
  assert.equal(f.requestId, "req_credit_1");
  assert.match(f.detail, /credit balance is too low/i);
  assert.ok(f.detail.length <= 200);
});

test("insufficient credit arriving MID-STREAM (a status-less APIError whose only signal is the body) is fatal too", () => {
  // Phase 1: candidates #10 and #11 failed this way, after streaming had already started.
  const midStream = new Anthropic.APIError(undefined, CREDIT_ERROR_BODY, undefined, undefined);
  const f = classifyFatalApiError(midStream, "req_from_observer");
  assert.ok(f instanceof FatalApiError && f.kind === "insufficient_credit" && f.status === null);
  assert.equal(f!.requestId, "req_from_observer");
});

test("authentication, permission and billing errors are fatal", () => {
  assert.equal(classifyFatalApiError(api(401, body("authentication_error", "invalid x-api-key")))?.kind, "authentication");
  assert.equal(classifyFatalApiError(api(403, body("permission_error", "Your API key does not have permission")))?.kind, "permission");
  assert.equal(classifyFatalApiError(api(402, body("billing_error", "There is a problem with your billing details")))?.kind, "insufficient_credit");
  // status-less mid-stream variants classify by the body's error type
  assert.equal(classifyFatalApiError(new Anthropic.APIError(undefined, body("authentication_error", "x"), undefined, undefined))?.kind, "authentication");
  assert.equal(classifyFatalApiError(new Anthropic.APIError(undefined, body("permission_error", "x"), undefined, undefined))?.kind, "permission");
});

test("everything else keeps its normal per-item handling: rate limits, overload, server errors, bad requests, timeouts, non-API errors", () => {
  const notFatal: unknown[] = [
    api(429, body("rate_limit_error", "slow down")),
    api(500, body("api_error", "internal error")),
    api(529, body("overloaded_error", "overloaded")),
    api(404, body("not_found_error", "model: x")),
    api(400, body("invalid_request_error", "max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens")),
    new Anthropic.APIConnectionTimeoutError(),
    new Anthropic.APIUserAbortError(),
    new ScoutTimeoutError("request", "x", 1, 1),
    new Error("Your credit balance is too low"), // right words, but not an API error: must not be misread as fatal
    "credit balance is too low",
    null, undefined,
  ];
  for (const e of notFatal) assert.equal(classifyFatalApiError(e), null, String(e));
});

test("an existing FatalApiError passes through unchanged", () => {
  const f = new FatalApiError("permission", "no", 403, "req_1");
  assert.equal(classifyFatalApiError(f), f);
});

test("through the REAL SDK: a 400 credit error becomes FatalApiError immediately, is not retried, and costs nothing", async () => {
  const { client, calls } = fakeAnthropic([{ kind: "status", status: 400, headers: { "request-id": "req_credit_2" }, body: CREDIT_ERROR_BODY }]);
  const budget = testBudget();
  const log = memoryLogger();
  await assert.rejects(
    runWithWebTools(client, {
      model: "claude-sonnet-5", system: "s", user: "u", label: "funding", stage: "discover", budget, caps: TOOL_CAPS.discovery,
      requestTimeoutMs: 5_000, headerTimeoutMs: 5_000, fetchMaxContentTokens: LIMITS.webFetchMaxContentTokens,
      signal: new AbortController().signal, usage: emptyUsage(), log,
    }),
    (err: unknown) => err instanceof FatalApiError && err.kind === "insufficient_credit" && err.requestId === "req_credit_2" && err.status === 400,
  );
  assert.equal(calls.length, 1, "a fatal error must not be retried");
  assert.equal(budget.committedUsd, 0, "an HTTP error answered before any output is not billed");
  assert.equal(budget.inFlightUsd, 0);
  assert.equal(budget.entries()[0]!.outcome, "no_charge");
});

test("through the REAL SDK: an SSE error event mid-stream is classified fatal, and its (unknown) cost is charged conservatively", async () => {
  const { client } = fakeAnthropic([
    { kind: "sse", events: [msgStart(5000), ...serverToolUse(0, "srv_1", "web_search", { query: "q" }), { type: "error", error: CREDIT_ERROR_BODY.error }] },
  ]);
  const budget = testBudget();
  await assert.rejects(
    runWithWebTools(client, {
      model: "claude-sonnet-5", system: "s", user: "u", label: "verify:Acme", stage: "verify", budget, caps: TOOL_CAPS.verification,
      requestTimeoutMs: 5_000, headerTimeoutMs: 5_000, fetchMaxContentTokens: LIMITS.webFetchMaxContentTokens,
      signal: new AbortController().signal, usage: emptyUsage(), log: memoryLogger(),
    }),
    (err: unknown) => err instanceof FatalApiError && err.kind === "insufficient_credit" && err.status === null,
  );
  const e = budget.entries()[0]!;
  assert.equal(e.outcome, "unknown_cost_charged_reservation");
  assert.ok(budget.committedUsd > 0 && budget.committedUsd === e.reserved_usd, "output had started, so the full reservation is charged");
});
