import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLogger, memoryLogger } from "../src/log.ts";
import { createRedactor } from "../src/redact.ts";
import { createSdkLogger } from "../src/sdklog.ts";

const KEY = "sk-ant-api03-SECRETSECRETSECRET1234567890";
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijk";

test("redactor removes exact secret values and anything shaped like a credential", () => {
  const redact = createRedactor(["custom-secret-value-123"]);
  const out = redact(`a ${KEY} b ${JWT} c custom-secret-value-123 d Bearer abcdefghijklmnopqrstuvwxyz e sb_secret_abcdefghijklmnop`);
  for (const leaked of [KEY, JWT, "custom-secret-value-123", "abcdefghijklmnopqrstuvwxyz", "sb_secret_abcdefghijklmnop"]) {
    assert.ok(!out.includes(leaked), `leaked: ${leaked}`);
  }
  assert.equal((out.match(/\[REDACTED\]/g) ?? []).length, 5);
  assert.equal(createRedactor(["short"])("a short b"), "a short b"); // too short to be a safe literal match
});

test("the file logger redacts every record and honors quiet:true (file only, no console line)", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-log-"));
  const lines: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const log = createLogger(dir, "r1", { redact: createRedactor([KEY]) });
    log.info("loud", { message: `visible ${KEY}` });
    log.info("silent", { message: "file only", quiet: true, note: KEY });
    log.warn("nested", { deep: { token: KEY } });
  } finally {
    console.error = original;
  }
  const file = readFileSync(join(dir, "r1.jsonl"), "utf8");
  assert.ok(!file.includes(KEY), "secret written to the log file");
  assert.ok(!lines.join("\n").includes(KEY), "secret written to the console");
  assert.equal(file.trim().split("\n").length, 3);
  assert.equal(lines.length, 2, "only the quiet:true line is file-only; the other two reach the console");
  assert.match(lines[0]!, /\[info\] loud visible \[REDACTED\]/);
  assert.ok(!lines.some((l) => l.includes("silent")), "the quiet:true line must not reach the console");
  assert.ok(file.includes("[REDACTED]"));
});

test("SDK logger adapter: retries become sdk_retry warnings with the request id; extra args and debug are dropped", () => {
  const log = memoryLogger();
  const sdk = createSdkLogger(log);
  sdk.info('[log_ab12, request-id: "req_011CX"] POST https://api.anthropic.com/v1/messages failed with status 529 in 812ms - retrying, 2 attempts remaining', { headers: { "x-api-key": KEY } });
  sdk.info('[log_ab12, request-id: "req_011CY"] POST https://api.anthropic.com/v1/messages succeeded with status 200 in 900ms');
  sdk.info("[log_cd34] connection timed out - retrying, 1 attempts remaining");
  sdk.debug("headers: " + KEY, { authorization: KEY });
  sdk.error("[log_ef56] connection failed - error; no more retries left");

  const events = log.records.map((r) => r.event);
  assert.deepEqual(events, ["sdk_retry", "sdk", "sdk_retry", "sdk_retries_exhausted"]);
  const first = log.records[0]!;
  assert.equal(first.level, "warn");
  assert.equal(first.request_id, "req_011CX");
  assert.match(String(first.message), /retrying, 2 attempts remaining/);
  assert.equal(log.records[1]!.quiet, true); // routine success lines: file only
  assert.equal(log.records[2]!.request_id, null); // no id available: null, not invented
  assert.ok(!JSON.stringify(log.records).includes(KEY), "extra SDK arguments (headers) must never be recorded");
});
