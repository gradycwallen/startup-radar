import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { ABSOLUTE_BUDGET_CEILING_USD, BudgetGuard } from "./budget.ts";
import { DEFAULTS, LIMITS, loadEnvFile, readEnv, type RunConfig } from "./config.ts";
import { RunClock } from "./deadline.ts";
import { ReadOnlyDb } from "./db.ts";
import { checkHomepage } from "./http.ts";
import { LeadLedger } from "./ledger.ts";
import { createLogger, newRunId, type Logger } from "./log.ts";
import { createDefaultRouter } from "./models.ts";
import type { RunSummary } from "./pipeline.ts";
import { ClaudeWebProvider } from "./providers/claude-web.ts";
import type { DiscoveryProvider } from "./providers/types.ts";
import { createRedactor, type Redactor } from "./redact.ts";
import { ReplayProvider, SnapshotReader, SnapshotRecorder, SnapshotVerifier, snapshotHomepageChecker } from "./replay.ts";
import { EXIT, executeRun } from "./run.ts";
import { createSdkLogger } from "./sdklog.ts";
import { installShutdown } from "./shutdown.ts";
import { loadSnapshot } from "./snapshot.ts";
import { ClaudeVerifier } from "./verify.ts";

const HELP = `Startup Radar Scout (dry-run only: database writes are not implemented)

Usage: npm run scout -- [flags]

  --dry-run               Discover, verify, validate and de-duplicate; write nothing (always the case)
  --max-new <n>           Max accepted NEW companies per run            (default ${DEFAULTS.maxNew})
  --max-candidates <n>    Max leads sent to verification               (default ${DEFAULTS.maxCandidates})
  --min-confidence <x>    Minimum confidence to accept, 0-1            (default ${DEFAULTS.minConfidence})
  --max-cost-usd <x>      API budget for this run; can only LOWER the absolute ceiling (default/max ${ABSOLUTE_BUDGET_CEILING_USD})
  --lanes <a,b,c>         Restrict discovery lanes                     (default all)
  --recency-days <n>      Recency window for discovery prompts         (default ${DEFAULTS.recencyDays})
  --leads-per-lane <n>    Max leads requested per lane                 (default ${DEFAULTS.leadsPerLane})
  --concurrency <n>       Parallel verifications                       (default ${DEFAULTS.concurrency})
  --run-deadline-minutes <n>  Soft deadline: stop STARTING new work    (default ${LIMITS.runSoftDeadlineMs / 60_000})
  --log-dir <dir>         Where logs, ledgers and the summary go       (default ./logs)
  --json                  Print the full run summary as JSON on stdout
  --replay <dir>          OFFLINE: re-run the pipeline from a recorded snapshot. No credentials, no Anthropic
                          calls, no live sources, no database. Reads no .env file.
  --record-snapshot <dir> After a LIVE run, save a replayable snapshot of what it saw to <dir>
  -h, --help

Limits (see src/config.ts): request ${LIMITS.discoveryRequestMs / 60_000}m discovery / ${LIMITS.verificationRequestMs / 60_000}m verification,
lane ${LIMITS.laneMs / 60_000}m, candidate ${LIMITS.candidateMs / 60_000}m, SDK pre-header ${LIMITS.sdkHeaderTimeoutMs / 1000}s,
database read ${LIMITS.dbReadMs / 1000}s.
Budget: every Anthropic request reserves its worst-case cost first and is refused if it could exceed the ceiling.
Exit codes: 0 ok, 1 failed, 2 usage, 3 database changed, 4 fatal API error (credit/auth/permission),
5 budget ceiling reached, 130/143 SIGINT/SIGTERM.
Ctrl-C / SIGTERM aborts in-flight work, writes a partial summary and exits; a second signal exits at once.
`;

function num(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number between ${min} and ${max}`);
  return n;
}

const secs = (msValue: number) => `${(msValue / 1000).toFixed(1)}s`;

function printSummary(s: RunSummary): void {
  const line = "-".repeat(78);
  console.log(`\n${line}\nRUN ${s.run_id}  (${s.provider}, ${s.mode.toUpperCase()}, DRY-RUN)  status: ${s.status}${s.stop_reason ? ` (${s.stop_reason})` : ""}\n${line}`);
  if (s.fatal_error) console.log(`FATAL API ERROR: ${s.fatal_error.kind}: ${s.fatal_error.detail} (request ${s.fatal_error.request_id ?? "n/a"})`);
  console.log(`total time: ${secs(s.run_elapsed_ms)}   leads discovered: ${s.leads_discovered}   selected for verification: ${s.leads_selected}`);
  console.log("lanes:");
  for (const l of s.lanes) {
    console.log(`  ${l.lane.padEnd(12)} ${l.status.padEnd(22)} ${secs(l.elapsed_ms).padStart(8)}  ${String(l.leads).padStart(2)} leads  ${l.usage.webSearches}s/${l.usage.webFetches}f  ${l.usage.inputTokens}in/${l.usage.outputTokens}out${l.error ? `  [${l.error}]` : ""}`);
  }
  console.log("candidate outcomes:");
  for (const [k, v] of Object.entries(s.counts)) if (v) console.log(`  ${k.padEnd(34)} ${v}`);
  if (Object.keys(s.rejection_reasons).length) {
    console.log("rejection reasons:");
    for (const [k, v] of Object.entries(s.rejection_reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(34)} ${v}`);
  }
  if (s.timeouts.length) {
    console.log("timeouts:");
    for (const t of s.timeouts) console.log(`  ${t.item}: ${t.kind} "${t.label}" after ${secs(t.elapsed_ms)} (limit ${secs(t.limit_ms)})`);
  }
  console.log(
    `usage: ${s.usage.apiCalls} api calls, ${s.usage.webSearches} searches, ${s.usage.webFetches} fetches, ` +
      `${s.usage.inputTokens} in / ${s.usage.outputTokens} out tokens`,
  );
  console.log(
    `cost: $${s.cost.committed_usd.toFixed(4)} charged of $${s.cost.ceiling_usd.toFixed(2)} ceiling ` +
      `(actual known $${s.cost.actual_usd_known.toFixed(4)}, ${s.cost.requests} requests, ${s.cost.refused_count} refused${s.cost.exhausted ? ", BUDGET EXHAUSTED" : ""})`,
  );
  console.log(`lead ledger: ${s.lead_ledger.total} raw leads recorded ${JSON.stringify(s.lead_ledger.by_disposition)}`);
  console.log(`rows before: ${JSON.stringify(s.rows_before)}\nrows after:  ${JSON.stringify(s.rows_after)}\ndb unchanged: ${s.db_unchanged}`);
  console.log(line);
  for (const c of s.candidates) {
    const conf = c.confidence === null ? "  -  " : c.confidence.toFixed(2);
    console.log(`${c.status.padEnd(32)} ${conf}  ${secs(c.elapsed_ms).padStart(7)}  ${(c.domain ?? "-").padEnd(24)} ${c.lead_name}${c.reasons.length ? `  [${c.reasons.join("; ")}]` : ""}`);
  }
}

function makeArtifacts(config: RunConfig, log: Logger, redact: Redactor) {
  const runId = log.runId;
  const budget = new BudgetGuard({ ceilingUsd: config.budgetUsd, persist: { dir: config.logDir, runId, redact } });
  const ledger = new LeadLedger({ dir: config.logDir, runId, redact });
  return { budget, ledger };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" }, write: { type: "boolean" }, "max-new": { type: "string" },
      "max-candidates": { type: "string" }, "min-confidence": { type: "string" }, "max-cost-usd": { type: "string" }, lanes: { type: "string" },
      "recency-days": { type: "string" }, "leads-per-lane": { type: "string" }, concurrency: { type: "string" },
      "run-deadline-minutes": { type: "string" }, "log-dir": { type: "string" }, json: { type: "boolean" },
      replay: { type: "string" }, "record-snapshot": { type: "string" }, help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return EXIT.OK;
  }
  if (values.write) {
    console.error("Refusing: database writes are not implemented in Phase 1. This build is read-only.");
    return EXIT.USAGE;
  }
  if (values.replay && values["record-snapshot"]) {
    console.error("--replay and --record-snapshot cannot be combined: replay is offline, recording needs a live run.");
    return EXIT.USAGE;
  }
  if (!values["dry-run"] && !values.replay) console.error("Note: there is no write path; running as a dry-run.");

  const config: RunConfig = {
    dryRun: true,
    maxNew: num("max-new", values["max-new"], DEFAULTS.maxNew, 0, 100),
    maxCandidates: num("max-candidates", values["max-candidates"], DEFAULTS.maxCandidates, 1, 100),
    minConfidence: num("min-confidence", values["min-confidence"], DEFAULTS.minConfidence, 0, 1),
    recencyDays: num("recency-days", values["recency-days"], DEFAULTS.recencyDays, 1, 365),
    maxEventAgeDays: DEFAULTS.maxEventAgeDays,
    concurrency: num("concurrency", values.concurrency, DEFAULTS.concurrency, 1, 8),
    leadsPerLane: num("leads-per-lane", values["leads-per-lane"], DEFAULTS.leadsPerLane, 1, 20),
    lanes: values.lanes?.split(",").map((l) => l.trim()).filter(Boolean),
    logDir: values["log-dir"] ?? "logs",
    limits: {
      ...LIMITS,
      runSoftDeadlineMs: num("run-deadline-minutes", values["run-deadline-minutes"], LIMITS.runSoftDeadlineMs / 60_000, 0.1, 24 * 60) * 60_000,
    },
    // The flag can only LOWER the absolute ceiling; values above it are rejected.
    budgetUsd: num("max-cost-usd", values["max-cost-usd"], ABSOLUTE_BUDGET_CEILING_USD, 0.0001, ABSOLUTE_BUDGET_CEILING_USD),
  };

  // ---- OFFLINE REPLAY: no .env, no credentials, no network, no database, no Anthropic ----------------
  if (values.replay) {
    let snapshot;
    try {
      snapshot = loadSnapshot(values.replay);
    } catch (err) {
      console.error(`Cannot replay: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT.USAGE;
    }
    const log = createLogger(config.logDir, newRunId(), { quiet: Boolean(values.json) });
    const shutdown = installShutdown(process, log);
    const { budget, ledger } = makeArtifacts(config, log, createRedactor([]));
    log.info("run_start", { message: `REPLAY of ${values.replay} (offline; no credentials, no network, no database)`, config, snapshot: snapshot.manifest });
    const { summary, summaryFile, exitCode } = await executeRun({
      provider: new ReplayProvider(snapshot.discovery),
      verifier: new SnapshotVerifier(snapshot.verifications),
      db: new SnapshotReader(snapshot.db),
      checkHomepage: snapshotHomepageChecker(snapshot.homepages),
      log, config, now: new Date(snapshot.manifest.now), clock: new RunClock(config.limits.runSoftDeadlineMs),
      shutdown, budget, ledger, mode: "replay",
    });
    shutdown.dispose();
    if (values.json) console.log(JSON.stringify(summary, null, 2));
    else printSummary(summary);
    console.error(`log: ${log.file}\nsummary: ${summaryFile}`);
    return exitCode;
  }

  // ---- LIVE ------------------------------------------------------------------------------------------
  loadEnvFile();
  const { supabase, missing } = readEnv();
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(", ")}\nCopy .env.example to .env and fill them in (see README).`);
    return EXIT.USAGE;
  }

  // Every log line is redacted: exact secret values plus anything shaped like a credential.
  const redact = createRedactor([process.env.ANTHROPIC_API_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY]);
  const log = createLogger(config.logDir, newRunId(), { quiet: Boolean(values.json), redact });
  const shutdown = installShutdown(process, log);
  const { budget, ledger } = makeArtifacts(config, log, redact);
  log.info("run_start", { message: `dry-run, max-new=${config.maxNew}, max-candidates=${config.maxCandidates}, budget=$${config.budgetUsd}`, config });

  // SDK: pre-header timeout lowered to 60s; retries/request ids are routed into our redacted log.
  const client = new Anthropic({ timeout: config.limits.sdkHeaderTimeoutMs, logLevel: "info", logger: createSdkLogger(log) });
  const router = createDefaultRouter();
  const now = new Date();
  const db = new ReadOnlyDb(supabase.url, supabase.serviceRoleKey, { log, readTimeoutMs: config.limits.dbReadMs });
  // Providers are pluggable: add more here; nothing downstream changes.
  let provider: DiscoveryProvider = new ClaudeWebProvider(client, router, config.limits, budget);
  let verifier = new ClaudeVerifier(client, router, budget, now, config.limits) as ClaudeVerifier | ReturnType<SnapshotRecorder["wrapVerifier"]>;
  let homepage = checkHomepage;
  const recorder = values["record-snapshot"] ? new SnapshotRecorder() : null;
  if (recorder) {
    provider = recorder.wrapProvider(provider);
    verifier = recorder.wrapVerifier(verifier);
    homepage = recorder.wrapHomepageChecker(homepage);
  }

  const { summary, summaryFile, exitCode } = await executeRun({
    provider, verifier, db, checkHomepage: homepage, log, config, now,
    clock: new RunClock(config.limits.runSoftDeadlineMs), shutdown, budget, ledger, mode: "live",
  });
  shutdown.dispose();

  if (recorder && values["record-snapshot"]) {
    try {
      // A read-only database read, subject to the same per-read deadline as every other read.
      recorder.finish(values["record-snapshot"], {
        now, runId: summary.run_id, description: `Recorded from live run ${summary.run_id}`, db: await db.readAllForSnapshot(),
      });
      log.info("snapshot_written", { message: `snapshot written to ${values["record-snapshot"]}` });
    } catch (err) {
      log.error("snapshot_failed", { message: `could not write snapshot: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  if (values.json) console.log(JSON.stringify(summary, null, 2));
  else printSummary(summary);
  console.error(`log: ${log.file}\nsummary: ${summaryFile}\nleads: ${summary.lead_ledger.files.json}\ncost: ${summary.cost.files.json}`);
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exit(EXIT.FAILED);
  },
);
