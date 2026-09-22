import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvFile, readSupabaseEnv } from "./config.ts";
import { ReadOnlyDb } from "./db.ts";
import { createLogger, newRunId } from "./log.ts";
import { createRedactor } from "./redact.ts";
import { installShutdown } from "./shutdown.ts";
import { runObservationPass, type RunSummary } from "./signals/orchestrate.ts";
import { SignalStore } from "./signals/store.ts";
import type { CompanyContext } from "./signals/types.ts";
import { PoliteFetcher } from "./sources/fetcher.ts";

/**
 * Startup Radar V2-2A.1 — automated observation runs.
 *
 * Orchestrates the EXISTING V2-2A building blocks (src/signals/resolution.ts, observe.ts,
 * freshness.ts, dedup.ts) against real companies: resolve sources where missing, collect from
 * sources that aren't fresh, derive deterministic signals, persist. No logic lives in this file —
 * see src/signals/orchestrate.ts for the actual policy; this file is argv/env/logging only,
 * matching src/funnel-main.ts's and src/main.ts's shape.
 */

const DEFAULT_FRESHNESS_HOURS = 22;

const HELP = `Startup Radar V2-2A.1 signal observation run (deterministic collection: NO LLM calls; writes ONLY
to signal_sources/observations/signals — companies and discovery_events are never touched)

Usage: npm run signals -- [flags]

  --dry-run              Resolve/collect for real (real network reads) but write NOTHING to the database.
  --company <id|domain>  Only this company (numeric id, or an exact domain/name match).
  --limit <n>             Process at most this many companies.
  --force                 Bypass the ${DEFAULT_FRESHNESS_HOURS}h freshness cooldown and re-collect anyway.
                          Never the default — for manual testing only.
  --log-dir <dir>         Where the run artifact goes                    (default ./logs)
  --json                  Print the run summary as JSON
  -h, --help

Live runs need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from .env). GITHUB_TOKEN is optional
(raises the GitHub API rate limit; the collector works unauthenticated at this project's current
scale). No Anthropic key is read or needed — this CLI never calls the Anthropic API.
`;

function parseCompanyFilter(raw: string, companies: readonly CompanyContext[]): CompanyContext[] {
  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    return companies.filter((c) => c.id === id);
  }
  const needle = raw.trim().toLowerCase();
  return companies.filter((c) => c.domain.toLowerCase() === needle || c.name.toLowerCase() === needle);
}

function printSummary(summary: RunSummary): void {
  console.log(`\nSIGNAL OBSERVATION RUN as of ${summary.as_of}${summary.dry_run ? " [DRY RUN — nothing written]" : ""}${summary.force ? " [FORCE]" : ""}`);
  console.log(`companies considered: ${summary.companies_considered}  (freshness cooldown: ${summary.freshness_hours}h)`);
  console.log(`resolution: ${summary.resolution.resolved_new_sources} new source(s) resolved, ${summary.resolution.unresolved} unresolved, ${summary.resolution.no_supported_source} no-supported-source, ${summary.resolution.failed} failed`);
  console.log(`collection: ${summary.collection.collected} collected, ${summary.collection.skipped_fresh} skipped (fresh), ${summary.collection.failed} failed`);
  console.log(`observations inserted: ${summary.observations_inserted}   signals fired: ${summary.signals_fired}`);
  for (const c of summary.companies) {
    const bits: string[] = [];
    if (c.resolution !== "not_attempted") bits.push(`resolution=${c.resolution}`);
    for (const s of c.sources) bits.push(`${s.source_type}:${s.external_id}=${s.outcome}${s.outcome === "collected" ? `(${s.observations_inserted} obs)` : ""}`);
    if (c.signals_fired.length) bits.push(`${c.signals_fired.length} signal(s): ${c.signals_fired.map((s) => s.signal_type).join(", ")}`);
    if (c.error) bits.push(`ERROR: ${c.error}`);
    if (bits.length) console.log(`  ${c.company_name}: ${bits.join("; ")}`);
  }
  console.log(`elapsed: ${(summary.elapsed_ms / 1000).toFixed(1)}s`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" }, company: { type: "string" }, limit: { type: "string" }, force: { type: "boolean" },
      "log-dir": { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const logDir = values["log-dir"] ?? "logs";
  let limit: number | undefined;
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (!Number.isInteger(n) || n < 1) {
      console.error("--limit must be a positive integer");
      return 2;
    }
    limit = n;
  }

  loadEnvFile();
  const { supabase, missing } = readSupabaseEnv();
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(", ")}\nSee .env.example.`);
    return 2;
  }
  const githubToken = process.env.GITHUB_TOKEN?.trim() || undefined;

  const redact = createRedactor([process.env.SUPABASE_SERVICE_ROLE_KEY, githubToken]);
  const runId = newRunId();
  const log = createLogger(logDir, runId, { quiet: Boolean(values.json), redact });
  const shutdown = installShutdown(process, log);

  const db = new ReadOnlyDb(supabase.url, supabase.serviceRoleKey);
  const { companies: allCompanies } = await db.readAllForSnapshot();
  let companies: CompanyContext[] = allCompanies;
  if (values.company) {
    companies = parseCompanyFilter(values.company, allCompanies);
    if (companies.length === 0) {
      console.error(`No company matches --company "${values.company}" (expected a numeric id or an exact domain/name).`);
      return 2;
    }
  }
  if (limit !== undefined) companies = companies.slice(0, limit);

  const fetcher = new PoliteFetcher({ minDelayMs: 600 });
  // V2-2B.2: a SEPARATE, more conservative fetcher for website structural monitoring — company
  // homepages are many small, arbitrary third-party sites (not a handful of well-known APIs), so
  // this errs slightly more polite than the shared default: ~1s per-host pacing, a shorter 15s
  // timeout (bounded further by the website pass's own request cap), and a smaller 1MB response
  // cap (a marketing homepage never legitimately needs more). See the design report §10.
  const websiteFetcher = new PoliteFetcher({ minDelayMs: 1000, timeoutMs: 15_000, maxBytes: 1_000_000 });
  const store = new SignalStore(supabase.url, supabase.serviceRoleKey, { log });

  log.info("signals_run_start", { message: `${companies.length} companies, dry_run=${Boolean(values["dry-run"])}, force=${Boolean(values.force)}` });
  const summary = await runObservationPass(companies, { fetcher, websiteFetcher, store, githubToken, log, signal: shutdown.signal }, { dryRun: Boolean(values["dry-run"]), force: Boolean(values.force) });

  writeFileSync(join(logDir, `${runId}.signals.json`), redact(JSON.stringify(summary, null, 2)));
  shutdown.dispose();

  if (values.json) console.log(JSON.stringify(summary, null, 2));
  else {
    printSummary(summary);
    console.log(`artifact: ${runId}.signals.json in ${logDir}/`);
  }

  if (shutdown.signal.aborted) return shutdown.exitCode() ?? 130;
  const anyFailed = summary.resolution.failed > 0 || summary.collection.failed > 0 || summary.companies.some((c) => c.error);
  return anyFailed && summary.collection.collected === 0 && summary.resolution.resolved_new_sources === 0 ? 1 : 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exitCode = 1;
  },
);
