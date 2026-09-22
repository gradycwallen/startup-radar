import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { RunClock } from "../src/deadline.ts";
import { memoryLogger } from "../src/log.ts";
import { runPipeline, type RunSummary } from "../src/pipeline.ts";
import { ReplayProvider, SnapshotReader, SnapshotVerifier, snapshotHomepageChecker } from "../src/replay.ts";
import { loadSnapshot } from "../src/snapshot.ts";
import { testBudget, testLedger } from "./helpers.ts";
import { stubConfig } from "./replay-helpers.ts";

const FIXTURE = resolve("test/fixtures/snapshots/phase1-2026-09-21");
const ACCEPTED = ["project-s.space", "heylogin.com", "fin.com", "useaiir.com", "empirik.ai", "gaiadynamics.ai", "scrolled.org", "typesafe.ai", "sunzu.com"];

async function replayFixture(): Promise<{ summary: RunSummary; ledger: ReturnType<typeof testLedger> }> {
  const snap = loadSnapshot(FIXTURE);
  const ledger = testLedger();
  const summary = await runPipeline({
    provider: new ReplayProvider(snap.discovery), verifier: new SnapshotVerifier(snap.verifications), db: new SnapshotReader(snap.db),
    checkHomepage: snapshotHomepageChecker(snap.homepages), log: memoryLogger(), config: stubConfig({ maxCandidates: 14 }), now: new Date(snap.manifest.now),
    signal: new AbortController().signal, clock: new RunClock(1e9), budget: testBudget(), ledger, mode: "replay",
  });
  return { summary, ledger };
}

test("FIXTURE: the real Phase 1 run replays offline to its known outcomes (9 accepted, 1 stale rejection, 4 with no recording)", async () => {
  const { summary: s, ledger } = await replayFixture();
  assert.equal(s.mode, "replay");
  assert.equal(s.leads_discovered, 14);
  assert.deepEqual(
    { accepted: s.counts.would_insert_company_and_event, rejected: s.counts.rejected, errors: s.counts.error },
    { accepted: 9, rejected: 1, errors: 4 },
  );
  assert.deepEqual(s.candidates.filter((c) => c.status === "would_insert_company_and_event").map((c) => c.domain).sort(), [...ACCEPTED].sort());
  const ollama = s.candidates.find((c) => c.lead_name === "Ollama")!;
  assert.equal(ollama.status, "rejected");
  assert.match(ollama.reasons.join(), /stale_event:2026-07-09/, "the clock is fixed by the snapshot, so date rules behave as they did live");
  for (const name of ["Langfuse", "Ferry Health", "PrismML", "TigerByte Cyber"]) {
    const c = s.candidates.find((x) => x.lead_name === name)!;
    assert.equal(c.status, "error", name);
    assert.match(c.reasons.join(), /SnapshotMissError/, `${name}: a missing recording must fail loudly`);
  }
  assert.equal(s.status, "completed");
  assert.equal(s.db_unchanged, true);
  assert.deepEqual(s.rows_before, { companies: 10, discovery_events: 10 });
});

test("FIXTURE: replay costs nothing and makes no API calls; every raw lead is in the ledger with a disposition", async () => {
  const { summary: s, ledger } = await replayFixture();
  assert.equal(s.cost.committed_usd, 0);
  assert.equal(s.cost.requests, 0);
  assert.equal(s.usage.apiCalls, 0);
  assert.equal(s.usage.inputTokens, 0);
  assert.equal(s.lead_ledger.total, 14);
  assert.ok(ledger.all().every((l) => l.disposition !== null && l.name && l.source_url && l.provider && l.lane && l.discovered_at));
  assert.equal(ledger.all().filter((l) => l.disposition === "would_insert_company_and_event").length, 9);
  // Hinted domains recorded by Phase 1 are preserved in the ledger
  assert.equal(ledger.all().find((l) => l.name === "Aiir")!.domain_hint, "useaiir.com");
  assert.equal(ledger.all().find((l) => l.name === "Project-S")!.domain_hint, null, "no hint is stored as null, not invented");
});

test("FIXTURE: replay is deterministic (two runs give identical outcomes)", async () => {
  const brief = (s: RunSummary) => s.candidates.map((c) => [c.lead_name, c.status, c.domain, c.confidence, c.reasons.join("|")]);
  assert.deepEqual(brief((await replayFixture()).summary), brief((await replayFixture()).summary));
});

// ---- the real CLI, offline ---------------------------------------------------------------------------------

const ROOT = resolve(".");

/**
 * Runs the real CLI in a child process with: NO credentials, every network primitive trapped, and an EMPTY
 * temp directory as its cwd, so a developer's real .env in the repo root can never be loaded by a test.
 */
function cli(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scout-cli-"));
  const trace = join(dir, "network-attempts.log");
  const res = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(join(ROOT, "test/fixtures/no-network.mjs")).href, join(ROOT, "src/main.ts"), ...args, "--log-dir", dir],
    { cwd: dir, env: { PATH: process.env.PATH ?? "", NO_NETWORK_LOG: trace, ...env }, encoding: "utf8", timeout: 60_000 },
  );
  return { ...res, dir, trace, attempts: existsSync(trace) ? readFileSync(trace, "utf8") : "" };
}

test("CLI --replay: runs the whole pipeline with NO credentials, NO network attempt, and writes summary + ledgers", () => {
  const r = cli(["--replay", FIXTURE, "--json"]);
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  assert.equal(r.attempts, "", `the replay tried to use the network:\n${r.attempts}`);
  const s = JSON.parse(r.stdout) as RunSummary;
  assert.equal(s.mode, "replay");
  assert.equal(s.status, "completed");
  assert.equal(s.counts.would_insert_company_and_event, 9);
  assert.equal(s.cost.committed_usd, 0);
  const files = readdirSync(r.dir);
  for (const suffix of [".summary.json", ".leads.json", ".leads.jsonl", ".cost.json", ".cost.jsonl", ".jsonl"]) assert.ok(files.some((f) => f.endsWith(suffix)), `missing ${suffix}: ${files.join()}`);
  const leads = JSON.parse(readFileSync(join(r.dir, files.find((f) => f.endsWith(".leads.json"))!), "utf8"));
  assert.equal(leads.total, 14);
});

test("CLI --replay prints a readable report (mode, cost, ledger) without --json", () => {
  const r = cli(["--replay", FIXTURE]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /REPLAY, DRY-RUN/);
  assert.match(r.stdout, /cost: \$0\.0000 charged of \$0\.75 ceiling/);
  assert.match(r.stdout, /lead ledger: 14 raw leads recorded/);
});

test("CLI: --max-cost-usd can LOWER the ceiling but never raise it above $0.75", () => {
  assert.equal((JSON.parse(cli(["--replay", FIXTURE, "--json", "--max-cost-usd", "0.1"]).stdout) as RunSummary).cost.ceiling_usd, 0.1);
  const raised = cli(["--replay", FIXTURE, "--max-cost-usd", "0.76"]);
  assert.notEqual(raised.status, 0);
  assert.match(raised.stderr, /--max-cost-usd must be a number between/);
  const zero = cli(["--replay", FIXTURE, "--max-cost-usd", "0"]);
  assert.notEqual(zero.status, 0);
});

test("CLI usage errors exit 2: replay+record together, an unreadable snapshot, and --write", () => {
  const both = cli(["--replay", FIXTURE, "--record-snapshot", "/tmp/x"]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /cannot be combined/);
  const missing = cli(["--replay", "/no/such/snapshot"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Cannot replay: snapshot directory not found/);
  const write = cli(["--replay", FIXTURE, "--write"]);
  assert.equal(write.status, 2);
  assert.match(write.stderr, /database writes are not implemented/);
  assert.equal(both.attempts + missing.attempts + write.attempts, "");
});

test("CLI live mode still requires credentials and reports the missing NAMES only (never a value)", () => {
  const r = cli(["--dry-run"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Missing required environment variables: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(r.attempts, "", "failing the credentials check must not touch the network");
});
