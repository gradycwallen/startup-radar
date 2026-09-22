import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runWithWebTools, emptyUsage } from "../src/claude.ts";
import { LIMITS, TOOL_CAPS } from "../src/config.ts";
import { createLogger, memoryLogger } from "../src/log.ts";
import { createRedactor } from "../src/redact.ts";
import { createSdkLogger } from "../src/sdklog.ts";
import { CREDIT_ERROR_BODY, fakeAnthropic, leadsResponse } from "./fake-anthropic.ts";
import { testBudget } from "./helpers.ts";

const events = (log: ReturnType<typeof memoryLogger>) => log.records.map((r) => r.event);

test("REGRESSION: the exact Phase 1 messages ('not retryable' credit errors) are NOT logged as retries", () => {
  const log = memoryLogger();
  const sdk = createSdkLogger(log);
  sdk.info('[log_54906b, anthropic-workspace-id: "wrkspc_x", request-id: "req_011CfHRDYnFkX8nyuDkw7rve"] post https://api.anthropic.com/v1/messages failed with status 400 in 347ms - error; not retryable');
  sdk.info('[log_5bf6ad, request-id: "req_011CfHRDaFKEP5Q6k3Kx76vy"] post https://api.anthropic.com/v1/messages failed with status 400 in 207ms - error; not retryable');
  assert.deepEqual(events(log), ["sdk", "sdk"]);
  assert.ok(!log.records.some((r) => r.event === "sdk_retry"));
  assert.equal(log.records[0]!.request_id, "req_011CfHRDYnFkX8nyuDkw7rve");
});

test("only a SCHEDULED retry is an sdk_retry, using the SDK's real wording", () => {
  const log = memoryLogger();
  const sdk = createSdkLogger(log);
  const cases: Array<[string, string]> = [
    ['[log_a, request-id: "req_1"] post https://x failed with status 529 in 812ms - retrying, 2 attempts remaining', "sdk_retry"],
    ["[log_b] connection timed out - retrying, 1 attempts remaining", "sdk_retry"],
    ["[log_c] connection failed - retrying, 1 attempt remaining", "sdk_retry"],
    ["[log_d] connection timed out - error; no more retries left", "sdk_retries_exhausted"],
    ["[log_e] post https://x failed with status 500 in 90ms - error; no more retries left", "sdk_retries_exhausted"],
    ["[log_f] post https://x failed with status 400 in 90ms - error; not retryable", "sdk"],
    ["[log_g] post https://x succeeded with status 200 in 900ms", "sdk"],
    ["retryable errors are handled elsewhere", "sdk"],
  ];
  for (const [message] of cases) sdk.info(message);
  assert.deepEqual(events(log), cases.map(([, e]) => e));
});

test("only real retries are warnings; exhausted-retries lines are warnings; routine lines stay file-only", () => {
  const log = memoryLogger();
  const sdk = createSdkLogger(log);
  sdk.info("[l] failed - retrying, 2 attempts remaining");
  sdk.info("[l] failed - error; no more retries left");
  sdk.info("[l] succeeded with status 200 in 10ms");
  assert.deepEqual(log.records.map((r) => [r.event, r.level, r.quiet ?? false]), [["sdk_retry", "warn", false], ["sdk_retries_exhausted", "warn", false], ["sdk", "info", true]]);
});

test("through the REAL SDK: a 500 that is retried logs exactly one sdk_retry", async () => {
  const log = memoryLogger();
  const { client } = fakeAnthropic([{ kind: "status", status: 500, headers: { "retry-after-ms": "5", "request-id": "req_500" } }, leadsResponse([])], { logLevel: "info", logger: createSdkLogger(log) });
  await runWithWebTools(client, {
    model: "claude-sonnet-5", system: "s", user: "u", label: "funding", stage: "discover", budget: testBudget(), caps: TOOL_CAPS.discovery,
    requestTimeoutMs: 5000, headerTimeoutMs: 5000, fetchMaxContentTokens: LIMITS.webFetchMaxContentTokens, signal: new AbortController().signal, usage: emptyUsage(), log,
  });
  assert.equal(events(log).filter((e) => e === "sdk_retry").length, 1);
});

test("through the REAL SDK: a 400 credit error logs NO sdk_retry (it is not retryable)", async () => {
  const log = memoryLogger();
  const { client } = fakeAnthropic([{ kind: "status", status: 400, body: CREDIT_ERROR_BODY }], { logLevel: "info", logger: createSdkLogger(log) });
  await assert.rejects(
    runWithWebTools(client, {
      model: "claude-sonnet-5", system: "s", user: "u", label: "funding", stage: "discover", budget: testBudget(), caps: TOOL_CAPS.discovery,
      requestTimeoutMs: 5000, headerTimeoutMs: 5000, fetchMaxContentTokens: LIMITS.webFetchMaxContentTokens, signal: new AbortController().signal, usage: emptyUsage(), log,
    }),
  );
  assert.ok(!events(log).includes("sdk_retry"), JSON.stringify(events(log)));
  const notRetryable = log.records.find((r) => /not retryable/.test(String(r.message)));
  assert.ok(notRetryable, "the SDK's 'not retryable' line is still logged, as a plain sdk event");
});

test("a secret inside an SDK message never reaches the log file", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-sdklog-"));
  const key = "sk-ant-api03-SECRETSECRETSECRET1234567890";
  const log = createLogger(dir, "r", { quiet: true, redact: createRedactor([key]) });
  createSdkLogger(log).info(`[log_z] request with ${key} failed - retrying, 2 attempts remaining`, { headers: { "x-api-key": key } });
  const file = readFileSync(join(dir, "r.jsonl"), "utf8");
  assert.ok(!file.includes(key));
  assert.ok(file.includes("sdk_retry") && file.includes("[REDACTED]"));
});
