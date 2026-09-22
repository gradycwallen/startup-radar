import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

/**
 * The real CLI (src/discover-main.ts), offline: no credentials, every network primitive trapped
 * for the credential-check tests, and a real --replay run against the already-committed V2-1
 * funnel fixture for the full end-to-end offline proof (matching test/eval.test.ts's and
 * test/signals-cli.test.ts's established pattern).
 */
const ROOT = resolve(".");
const FIXTURE = resolve("test/fixtures/snapshots/funnel-eval-2026-09-21");

function cli(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scout-discover-cli-"));
  const trace = join(dir, "network-attempts.log");
  const res = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(join(ROOT, "test/fixtures/no-network.mjs")).href, join(ROOT, "src/discover-main.ts"), ...args, "--log-dir", dir],
    { cwd: dir, env: { PATH: process.env.PATH ?? "", NO_NETWORK_LOG: trace, ...env }, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
  );
  return { ...res, dir, trace, attempts: existsSync(trace) ? readFileSync(trace, "utf8") : "" };
}

test("CLI --help: prints usage, touches neither network nor environment", () => {
  const r = cli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Startup Radar V2-1\.1 operational discovery run/);
  assert.match(r.stdout, /NO Anthropic calls/);
  assert.equal(r.attempts, "");
});

test("CLI live mode requires Supabase credentials only (no Anthropic key) and reports missing NAMES only, never touching the network", () => {
  const r = cli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(r.attempts, "");
});

test("CLI: --dry-run alone still requires credentials for a LIVE dry-run — dry-run means 'no writes', not 'no credentials needed'", () => {
  const r = cli(["--dry-run"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Missing required environment variables/);
});

test("CLI usage errors exit 2 without touching the network: a non-numeric --max-writes", () => {
  const r = cli(["--max-writes", "not-a-number"], { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--max-writes must be a non-negative integer/);
  assert.equal(r.attempts, "");
});

test("CLI usage errors exit 2: a negative --max-writes is rejected", () => {
  // Node's own util.parseArgs treats a bare "-1" right after a string option as ambiguous (it
  // could be read as another flag) and suggests the "=" form instead — using that form here so
  // this test actually reaches our own --max-writes validation, not Node's argv parser.
  const r = cli(["--max-writes=-1"], { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--max-writes must be a non-negative integer/);
});

test("CLI usage errors exit 2: --as-of without --replay is rejected — a live run is always as of now", () => {
  const r = cli(["--as-of", "2026-09-21"], { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--as-of is only valid with --replay/);
  assert.equal(r.attempts, "");
});

test("CLI usage errors exit 2: a malformed --as-of date is rejected even with --replay", () => {
  const r = cli(["--replay", FIXTURE, "--as-of", "not-a-date"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--as-of expects YYYY-MM-DD/);
});

test("CLI: an unrecognized flag is a strict usage error, not silently ignored", () => {
  const r = cli(["--not-a-real-flag"], { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.notEqual(r.status, 0);
  assert.equal(r.attempts, "");
});

test("CLI --replay: runs the REAL funnel end-to-end against the committed V2-1 fixture with NO network, NO credentials, and NO database — and never writes (replay always implies dry-run)", () => {
  const r = cli(["--replay", FIXTURE, "--as-of", "2026-09-21", "--json"]);
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  assert.equal(r.attempts, "", `replay must never touch the network directly (the funnel's own replay fetch is separate and does not use real sockets): ${r.attempts}`);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.dry_run, true, "replay must always behave as dry-run — there is no live database to write to");
  assert.ok(summary.finalists_considered > 0, "the real funnel ran and produced real finalists");
  assert.ok(Array.isArray(summary.candidates));
  const files = readdirSync(r.dir);
  assert.ok(files.some((f) => f.endsWith(".discovery.json")), "a run artifact is written even in replay mode");
});

test("CLI --replay prints a readable, non-JSON summary by default", () => {
  const r = cli(["--replay", FIXTURE, "--as-of", "2026-09-21"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DISCOVERY RUN as of/);
  assert.match(r.stdout, /\[DRY RUN/);
  assert.match(r.stdout, /providers:/);
  assert.match(r.stdout, /persistence:/);
  assert.match(r.stdout, /cost: Anthropic calls 0/);
});

test("CLI --replay: an unreadable snapshot directory is a clean usage error, not a crash", () => {
  const r = cli(["--replay", "/no/such/snapshot"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Cannot replay/);
  assert.equal(r.attempts, "");
});
