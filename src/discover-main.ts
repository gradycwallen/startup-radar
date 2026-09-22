import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvFile, readSupabaseEnv } from "./config.ts";
import { ReadOnlyDb } from "./db.ts";
import { createHomepageChecker } from "./http.ts";
import { LeadLedger } from "./ledger.ts";
import { createLogger, newRunId } from "./log.ts";
import { createRedactor } from "./redact.ts";
import { installShutdown } from "./shutdown.ts";
import { HttpSnapshotStore, createReplayFetch } from "./snapshot.ts";
import { DISCOVERY_LIMITS } from "./discovery/limits.ts";
import { runDiscoveryPass, type DiscoveryRunSummary } from "./discovery/orchestrate.ts";
import { DiscoveryStore } from "./discovery/store.ts";
import { ExistingIndex } from "./funnel/existing.ts";
import { DEFAULT_FUNNEL_CONFIG, runFunnel, type FunnelConfig, type FunnelResult } from "./funnel/funnel.ts";
import { ItemLedger } from "./funnel/item-ledger.ts";
import { loadFunnelSnapshot } from "./funnel/snapshot.ts";
import { PoliteFetcher } from "./sources/fetcher.ts";
import { defaultSourceProviders } from "./sources/registry.ts";

/**
 * Startup Radar V2-1.1 — operational discovery run.
 *
 * Orchestrates the EXISTING, UNMODIFIED V2-1 funnel (src/funnel/funnel.ts: runFunnel — same
 * providers, extraction, clustering, dedupe, domain resolution, ranking, and finalist selection
 * src/funnel-main.ts already uses for exploration) and then, unlike funnel-main.ts, actually
 * decides what to persist (src/discovery/orchestrate.ts) and writes it (src/discovery/store.ts —
 * the only file under src/ allowed to write to companies/discovery_events). No discovery/ranking
 * logic lives in this file or in discovery/orchestrate.ts; only the accept/cap/persist policy.
 */

const HELP = `Startup Radar V2-1.1 operational discovery run (deterministic funnel; writes ONLY new
companies + their discovery events — never modifies an existing company row, never touches the
signal tables, makes NO Anthropic calls)

Usage: npm run discover -- [flags]

  --dry-run              Run the real funnel and preview exactly what WOULD be persisted — writes NOTHING.
  --max-writes <n>        Cap on new companies inserted this run (default/ceiling: ${DISCOVERY_LIMITS.maxNewCompaniesPerRun}).
                          May only LOWER this cap, never raise it.
  --log-dir <dir>         Where the run artifact goes                    (default ./logs)
  --json                  Print the run summary as JSON
  --replay <dir>          OFFLINE: run the funnel from a funnel snapshot (no network, no credentials,
                          no database) — always behaves as --dry-run; there is no live database to write to.
  --as-of <YYYY-MM-DD>    REPLAY ONLY: which of the snapshot's recorded as-of dates to run (default:
                          the snapshot's own recording time — fine for most providers, but Google
                          News' recordings are keyed to specific as-of date windows, so pick one of
                          the snapshot's actual as_of_dates to exercise it too). Rejected in live mode
                          — a live run is always "as of now," by design.
  -h, --help

Live runs need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from .env). No Anthropic key is read or
needed — this CLI never calls the Anthropic API. A company is only ever persisted when it is a
funnel finalist AND has a deterministically resolved domain; zero new companies is a valid result.
`;

function printSummary(summary: DiscoveryRunSummary, funnel: FunnelResult): void {
  const verb = summary.dry_run ? "would be inserted" : "inserted";
  console.log(`\nDISCOVERY RUN as of ${summary.as_of}${summary.dry_run ? " [DRY RUN — nothing written]" : ""}`);
  console.log("providers:");
  for (const p of funnel.providers) console.log(`  ${p.provider.padEnd(20)} ${p.status.padEnd(9)} ${p.items_fetched} items, ${p.items_in_window} in window`);
  console.log("funnel:");
  console.log(`  ${funnel.counts.items_fetched} raw items -> ${funnel.counts.items_in_window} in window -> ${funnel.counts.raw_leads} leads -> ${funnel.counts.entities} entities` +
    ` (${funnel.counts.existing_entities} existing DB matches, ${funnel.counts.new_entities} new) -> ${funnel.counts.finalists + funnel.counts.directory_finalists} finalists`);
  console.log("persistence:");
  console.log(`  ${summary.new_companies_inserted} companies ${verb}, ${summary.existing_companies_skipped} existing skipped, ${summary.unresolved_domain_count} unresolved-domain (never persisted)`);
  console.log(`  ${summary.events_inserted} events ${verb}, ${summary.events_skipped_duplicate} duplicate events skipped, ${summary.failed_writes} failed writes`);
  if (summary.deferred_candidate_cap || summary.deferred_write_cap) console.log(`  deferred: ${summary.deferred_candidate_cap} by candidate cap, ${summary.deferred_write_cap} by write cap`);
  const accepted = summary.candidates.filter((c) => c.outcome === "inserted" || c.outcome === "would_insert");
  if (accepted.length) {
    console.log(`\n${summary.dry_run ? "would accept" : "accepted"}:`);
    for (const c of accepted) console.log(`  ${c.name} (${c.domain}) [${c.track}, score ${c.score}]${c.discovery_reason ? ` — ${c.discovery_reason}` : ""}`);
  }
  console.log(`\ncost: Anthropic calls 0, external API cost ~$0`);
  console.log(`elapsed: ${(summary.elapsed_ms / 1000).toFixed(1)}s`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" }, "max-writes": { type: "string" }, "log-dir": { type: "string" },
      json: { type: "boolean" }, replay: { type: "string" }, "as-of": { type: "string" }, help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values["as-of"] && !values.replay) {
    console.error("--as-of is only valid with --replay — a live run is always as of now.");
    return 2;
  }
  if (values["as-of"] && !/^\d{4}-\d{2}-\d{2}$/.test(values["as-of"])) {
    console.error("--as-of expects YYYY-MM-DD");
    return 2;
  }
  const logDir = values["log-dir"] ?? "logs";
  let maxWrites: number | undefined;
  if (values["max-writes"] !== undefined) {
    const n = Number(values["max-writes"]);
    if (!Number.isInteger(n) || n < 0) {
      console.error("--max-writes must be a non-negative integer");
      return 2;
    }
    maxWrites = n;
  }

  const dryRun = Boolean(values["dry-run"]) || Boolean(values.replay);
  const providers = defaultSourceProviders();

  let fetchImpl: typeof fetch = fetch;
  let existing: ExistingIndex;
  let now = new Date();
  let redactExtra: (string | undefined)[] = [];
  let store: DiscoveryStore | null = null;

  if (values.replay) {
    let snap;
    try {
      snap = loadFunnelSnapshot(values.replay);
    } catch (err) {
      console.error(`Cannot replay: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    fetchImpl = createReplayFetch(new HttpSnapshotStore(values.replay));
    existing = new ExistingIndex(snap.db.companies, snap.db.events);
    now = values["as-of"] ? new Date(`${values["as-of"]}T23:59:59.999Z`) : new Date(snap.manifest.now);
  } else {
    loadEnvFile();
    const { supabase, missing } = readSupabaseEnv();
    if (missing.length) {
      console.error(`Missing required environment variables: ${missing.join(", ")}\nSee .env.example.`);
      return 2;
    }
    redactExtra = [process.env.SUPABASE_SERVICE_ROLE_KEY];
    const db = new ReadOnlyDb(supabase.url, supabase.serviceRoleKey);
    const { companies, events } = await db.readAllForSnapshot();
    existing = new ExistingIndex(companies, events);
    if (!dryRun) store = new DiscoveryStore(supabase.url, supabase.serviceRoleKey);
  }

  const redact = createRedactor(redactExtra);
  const runId = newRunId();
  const log = createLogger(logDir, runId, { quiet: Boolean(values.json), redact });
  const shutdown = installShutdown(process, log);

  const fetcher = new PoliteFetcher({ fetchImpl, minDelayMs: values.replay ? 0 : 600, ...(values.replay ? { hostDelayMs: {} } : {}) });
  const checkHomepage = createHomepageChecker(fetchImpl);
  const cfg: FunnelConfig = { ...DEFAULT_FUNNEL_CONFIG, asOf: now };

  log.info("discovery_run_start", { message: `dry_run=${dryRun}${values.replay ? " (REPLAY)" : ""}` });
  const funnelResult = await runFunnel(
    { providers, fetcher, existing, checkHomepage, ledger: LeadLedger.inMemory(), items: new ItemLedger({ dir: logDir, runId, redact }), log, signal: shutdown.signal },
    cfg,
  );

  // A dry run in DB-backed (non-replay) mode still needs a store to preview against, but a
  // no-op-writes one is unnecessary here: orchestrate.ts never calls a store method at all when
  // dryRun is true (see the dry-run branch in runDiscoveryPass) — `store` staying null is safe
  // exactly because of that, not despite it.
  const summary = await runDiscoveryPass(funnelResult, store ?? NULL_STORE, { dryRun, maxNewCompanies: maxWrites });

  writeFileSync(join(logDir, `${runId}.discovery.json`), redact(JSON.stringify({ funnel_counts: funnelResult.counts, providers: funnelResult.providers, summary }, null, 2)));
  shutdown.dispose();

  if (values.json) console.log(JSON.stringify(summary, null, 2));
  else {
    printSummary(summary, funnelResult);
    console.log(`artifact: ${runId}.discovery.json in ${logDir}/`);
  }

  if (shutdown.signal.aborted) return shutdown.exitCode() ?? 130;
  return summary.failed_writes > 0 && summary.new_companies_inserted === 0 ? 1 : 0;
}

/** Never called (runDiscoveryPass short-circuits before touching the store when dryRun is true) —
 * exists only so the type of `store ?? NULL_STORE` is satisfied without a real client in dry-run/
 * replay mode. Each method throws loudly if it is ever somehow reached, rather than silently
 * pretending to succeed. */
const NULL_STORE = {
  async insertCompany(): Promise<never> {
    throw new Error("NULL_STORE.insertCompany should never be called in dry-run/replay mode");
  },
  async upsertEvents(): Promise<never> {
    throw new Error("NULL_STORE.upsertEvents should never be called in dry-run/replay mode");
  },
  async companyExistsByDomain(): Promise<never> {
    throw new Error("NULL_STORE.companyExistsByDomain should never be called in dry-run/replay mode");
  },
};

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exitCode = 1;
  },
);
