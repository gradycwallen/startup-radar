import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

/**
 * The real CLI (src/signals-main.ts), offline, exactly like test/replay.test.ts and
 * test/eval.test.ts's CLI tests: no credentials, every network primitive trapped, an EMPTY temp
 * directory as cwd (so a developer's real .env can never be loaded), and every assertion proves
 * zero network was attempted. There is no --replay mode for this CLI (a deliberate scope decision
 * — see the V2-2A.1 report), so everything exercised here is the argv/env layer, which is exactly
 * what needs to be offline-testable without a live Supabase connection.
 */
const ROOT = resolve(".");

function cli(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scout-signals-cli-"));
  const trace = join(dir, "network-attempts.log");
  const res = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(join(ROOT, "test/fixtures/no-network.mjs")).href, join(ROOT, "src/signals-main.ts"), ...args, "--log-dir", dir],
    { cwd: dir, env: { PATH: process.env.PATH ?? "", NO_NETWORK_LOG: trace, ...env }, encoding: "utf8", timeout: 30_000 },
  );
  return { ...res, dir, trace, attempts: existsSync(trace) ? readFileSync(trace, "utf8") : "" };
}

test("CLI --help: prints usage and touches neither the network nor the environment", () => {
  const r = cli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Startup Radar V2-2A\.1 signal observation run/);
  assert.match(r.stdout, /--dry-run/);
  assert.match(r.stdout, /NO LLM calls/);
  assert.equal(r.attempts, "");
});

test("CLI live mode requires Supabase credentials only (no Anthropic key) and reports missing NAMES only, never touching the network", () => {
  const r = cli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(r.attempts, "", "failing the credentials check must not touch the network");
});

test("CLI: --dry-run alone still requires credentials — dry-run means 'no writes', not 'no credentials needed'", () => {
  const r = cli(["--dry-run"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Missing required environment variables/);
});

test("CLI usage errors exit 2 without touching the network: a non-numeric --limit", () => {
  const r = cli(["--limit", "not-a-number"], { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--limit must be a positive integer/);
  assert.equal(r.attempts, "");
});

test("CLI usage errors exit 2: --limit 0 or negative is rejected", () => {
  const r = cli(["--limit", "0"], { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--limit must be a positive integer/);
});

test("CLI: an unrecognized flag is a strict usage error, not silently ignored", () => {
  const r = cli(["--not-a-real-flag"], { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.notEqual(r.status, 0);
  assert.equal(r.attempts, "");
});
