import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyUsage } from "../src/claude.ts";
import { DEFAULTS, LIMITS, type RunConfig } from "../src/config.ts";
import { RunClock, ShutdownError } from "../src/deadline.ts";
import { memoryLogger, nullLogger } from "../src/log.ts";
import type { DiscoveryProvider } from "../src/providers/types.ts";
import { exitCodeFor, executeRun } from "../src/run.ts";
import { installShutdown, SHUTDOWN_EXIT_CODE, type ProcessLike } from "../src/shutdown.ts";
import { FakeReader, NOW, okHomepage, testBudget, testLedger } from "./helpers.ts";

function fakeProcess() {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const proc: ProcessLike = {
    on: (e, l) => emitter.on(e, l),
    removeListener: (e, l) => emitter.removeListener(e, l),
    exit: (code) => { exits.push(code ?? 0); },
  };
  return { emitter, exits, proc };
}

test("SIGTERM aborts the shared signal with a ShutdownError, records who asked, and does not exit", () => {
  const { emitter, exits, proc } = fakeProcess();
  const log = memoryLogger();
  const h = installShutdown(proc, log);
  assert.equal(h.signal.aborted, false);
  assert.equal(h.exitCode(), null);
  emitter.emit("SIGTERM");
  assert.equal(h.signal.aborted, true);
  assert.ok(h.signal.reason instanceof ShutdownError && h.signal.reason.signalName === "SIGTERM");
  assert.equal(h.requestedBy(), "SIGTERM");
  assert.equal(h.exitCode(), 143);
  assert.deepEqual(exits, [], "the first signal must be cooperative, not an immediate exit");
  assert.ok(log.records.some((r) => r.event === "shutdown_requested"));
  h.dispose();
});

test("SIGINT maps to 130; a SECOND signal forces an immediate exit", () => {
  const { emitter, exits, proc } = fakeProcess();
  const log = memoryLogger();
  const h = installShutdown(proc, log);
  emitter.emit("SIGINT");
  assert.equal(h.exitCode(), 130);
  assert.deepEqual(exits, []);
  emitter.emit("SIGINT");
  assert.deepEqual(exits, [130]);
  assert.ok(log.records.some((r) => r.event === "shutdown_forced"));
  assert.equal(SHUTDOWN_EXIT_CODE.SIGTERM, 143);
});

test("dispose() removes the signal listeners", () => {
  const { emitter, proc } = fakeProcess();
  const h = installShutdown(proc, nullLogger());
  assert.equal(emitter.listenerCount("SIGINT") + emitter.listenerCount("SIGTERM"), 2);
  h.dispose();
  assert.equal(emitter.listenerCount("SIGINT") + emitter.listenerCount("SIGTERM"), 0);
});

const config = (logDir: string): RunConfig => ({
  dryRun: true, maxNew: 10, maxCandidates: 14, minConfidence: 0.75, recencyDays: 14, maxEventAgeDays: 45,
  concurrency: 1, leadsPerLane: 6, lanes: undefined, logDir, limits: { ...LIMITS }, budgetUsd: 0.75,
});

const hangingProvider: DiscoveryProvider = {
  name: "hang",
  lanes: ["funding"],
  async discover(ctx) {
    await new Promise<void>((res) => ctx.signal.addEventListener("abort", () => res(), { once: true }));
    return { leads: [], errors: [], lanes: [{ lane: "funding", status: "aborted", elapsed_ms: 5, leads: 0, usage: emptyUsage() }] };
  },
};

test("executeRun on shutdown: writes a partial summary, reports interrupted, returns 143, DB untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-run-"));
  const { emitter, proc } = fakeProcess();
  const log = memoryLogger();
  const shutdown = installShutdown(proc, log);
  const db = new FakeReader([{ id: 1, name: "A", domain: "a.com" }], []);
  const run = executeRun({
    provider: hangingProvider, verifier: { verify: async () => { throw new Error("unused"); } }, db,
    checkHomepage: okHomepage(), log, config: config(dir), now: NOW, clock: new RunClock(LIMITS.runSoftDeadlineMs), shutdown, budget: testBudget(), ledger: testLedger(),
  });
  setTimeout(() => emitter.emit("SIGTERM"), 40);
  const out = await run;
  assert.equal(out.exitCode, 143);
  assert.equal(out.summary.status, "interrupted");
  assert.equal(out.summary.stop_reason, "shutdown:SIGTERM");
  assert.deepEqual(out.summary.rows_after, out.summary.rows_before);
  assert.equal(out.summary.db_unchanged, true);
  assert.ok(existsSync(out.summaryFile), "partial summary file must be written");
  const written = JSON.parse(readFileSync(out.summaryFile, "utf8"));
  assert.equal(written.status, "interrupted");
  assert.equal(written.lanes[0].status, "aborted");
  assert.ok(log.records.some((r) => r.event === "run_end"));
  shutdown.dispose();
});

test("exitCodeFor: interrupted uses the signal code; db change and failures are non-zero; a clean run is 0", () => {
  const base = { status: "completed", db_unchanged: true, leads_discovered: 3, provider_errors: [] } as any;
  const sh = (code: number | null) => ({ exitCode: () => code }) as any;
  assert.equal(exitCodeFor(base, sh(null)), 0);
  assert.equal(exitCodeFor({ ...base, status: "interrupted" }, sh(143)), 143);
  assert.equal(exitCodeFor({ ...base, status: "interrupted" }, sh(null)), 130);
  assert.equal(exitCodeFor({ ...base, db_unchanged: false }, sh(null)), 3);
  assert.equal(exitCodeFor({ ...base, status: "failed" }, sh(null)), 1);
  assert.equal(exitCodeFor({ ...base, leads_discovered: 0, provider_errors: [{ lane: "x", message: "y" }] }, sh(null)), 1);
  assert.equal(exitCodeFor({ ...base, status: "stopped_at_run_deadline" }, sh(null)), 0);
});

// A real process, a real signal: proves the handlers work end to end, not just in isolation.
for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
  test(`child process: ${sig} while a lane is in flight exits ${code} after writing a partial summary`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-child-"));
    const child = spawn(process.execPath, ["--import", "tsx", "test/fixtures/shutdown-child.ts", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`child never became ready. stderr: ${stderr}`)), 15_000);
      child.stdout.on("data", (d) => {
        stdout += d;
        if (stdout.includes("READY")) { clearTimeout(t); resolve(); }
      });
    });
    await ready;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    child.kill(sig);
    const result = await Promise.race([exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("child did not exit within 10s of the signal")), 10_000))]);
    assert.deepEqual(result, { code, signal: null }, `exit: ${JSON.stringify(result)} stderr: ${stderr}`);
    const summaryFile = readdirSync(dir).find((f) => f.endsWith(".summary.json"));
    assert.ok(summaryFile, "partial summary must exist");
    const summary = JSON.parse(readFileSync(join(dir, summaryFile!), "utf8"));
    assert.equal(summary.status, "interrupted");
    assert.equal(summary.stop_reason, `shutdown:${sig}`);
    assert.deepEqual(summary.rows_before, summary.rows_after);
  });
}
