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
import { HttpSnapshotStore, createRecordingFetch, createReplayFetch } from "./snapshot.ts";
import { ExistingIndex } from "./funnel/existing.ts";
import { DEFAULT_FUNNEL_CONFIG, runFunnel, type FunnelConfig } from "./funnel/funnel.ts";
import { ItemLedger } from "./funnel/item-ledger.ts";
import { formatBreakdown, formatFunnel, funnelToJson } from "./funnel/report.ts";
import { loadFunnelSnapshot, writeFunnelSnapshot, FUNNEL_SNAPSHOT_VERSION } from "./funnel/snapshot.ts";
import { PoliteFetcher } from "./sources/fetcher.ts";
import { defaultSourceProviders, selectProviders } from "./sources/registry.ts";

const HELP = `Startup Radar V2 discovery funnel (deterministic: NO LLM, NO Anthropic calls, NO database writes)

Usage: npm run funnel -- [flags]

  --as-of <YYYY-MM-DD[,...]>  Run as of these dates (each one is a separate run). Default: now.
  --window-days <n>           Recency window in days                     (default ${DEFAULT_FUNNEL_CONFIG.windowDays})
  --finalists <n>             Number of ranked finalists                 (default ${DEFAULT_FUNNEL_CONFIG.finalists})
  --providers <a,b>           Only these providers
  --skip-providers <a,b>      Skip these providers
  --homepage-budget <n>       Homepages to check before final ranking    (default ${DEFAULT_FUNNEL_CONFIG.homepageBudget})
  --log-dir <dir>             Where ledgers and the funnel report go     (default ./logs)
  --json                      Print the funnel report(s) as JSON
  --breakdown                 Print each finalist's score components
  --replay <dir>              OFFLINE: run from a funnel snapshot (no network, no credentials, no database)
  --record <dir>              LIVE: run and save a funnel snapshot (recorded HTTP + existing companies) to <dir>
  -h, --help

Live runs read Startup Radar's existing companies with the read-only database layer (SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY from .env). Nothing is ever written to the database.
`;

const list = (v: string | undefined) => v?.split(",").map((x) => x.trim()).filter(Boolean);

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "as-of": { type: "string" }, "window-days": { type: "string" }, finalists: { type: "string" }, providers: { type: "string" }, "skip-providers": { type: "string" },
      "homepage-budget": { type: "string" }, "log-dir": { type: "string" }, json: { type: "boolean" }, breakdown: { type: "boolean" }, replay: { type: "string" },
      record: { type: "string" }, help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.replay && values.record) {
    console.error("--replay and --record cannot be combined.");
    return 2;
  }
  const asOfDates = list(values["as-of"]);
  for (const d of asOfDates ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
      console.error(`--as-of expects YYYY-MM-DD dates (got "${d}")`);
      return 2;
    }
  }
  const num = (name: string, raw: string | undefined, fb: number, min: number, max: number) => {
    if (raw === undefined) return fb;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number between ${min} and ${max}`);
    return n;
  };
  const base = {
    windowDays: num("window-days", values["window-days"], DEFAULT_FUNNEL_CONFIG.windowDays, 1, 60),
    finalists: num("finalists", values.finalists, DEFAULT_FUNNEL_CONFIG.finalists, 1, 100),
    homepageBudget: num("homepage-budget", values["homepage-budget"], DEFAULT_FUNNEL_CONFIG.homepageBudget, 0, 200),
  };
  const logDir = values["log-dir"] ?? "logs";
  let providers;
  try {
    providers = selectProviders(defaultSourceProviders(), list(values.providers), list(values["skip-providers"]));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  // ---- transport + existing companies -------------------------------------------------------------------------------
  let fetchImpl: typeof fetch = fetch;
  let store: HttpSnapshotStore | null = null;
  let existing: ExistingIndex;
  let dbForSnapshot: { companies: ExistingIndex extends never ? never : import("./dedupe.ts").CompanyRow[]; events: import("./dedupe.ts").EventRow[] } | null = null;
  let polite = { minDelayMs: 600 };
  let now = new Date();
  let recordedManifestNow: string | null = null;
  if (values.replay) {
    // OFFLINE: never reads .env, never builds a database client, never touches the network.
    let snap;
    try {
      snap = loadFunnelSnapshot(values.replay);
    } catch (err) {
      console.error(`Cannot replay: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    store = new HttpSnapshotStore(values.replay);
    fetchImpl = createReplayFetch(store);
    existing = new ExistingIndex(snap.db.companies, snap.db.events);
    polite = { minDelayMs: 0 };
    now = new Date(snap.manifest.now);
    recordedManifestNow = snap.manifest.now;
  } else {
    loadEnvFile();
    const { supabase, missing } = readSupabaseEnv();
    if (missing.length) {
      console.error(`Missing required environment variables: ${missing.join(", ")}\nThe funnel reads existing companies (read-only) to de-duplicate; see .env.example.`);
      return 2;
    }
    const db = new ReadOnlyDb(supabase.url, supabase.serviceRoleKey);
    dbForSnapshot = await db.readAllForSnapshot();
    existing = new ExistingIndex(dbForSnapshot.companies, dbForSnapshot.events);
    if (values.record) {
      store = new HttpSnapshotStore(values.record, { compress: true });
      fetchImpl = createRecordingFetch(fetch, store);
    }
  }
  const fetcher = new PoliteFetcher({ fetchImpl, ...polite, ...(values.replay ? { hostDelayMs: {} } : {}) });
  const checkHomepage = createHomepageChecker(fetchImpl);

  const redact = createRedactor([process.env.SUPABASE_SERVICE_ROLE_KEY]);
  const baseId = newRunId();
  const shutdown = installShutdown(process, createLogger(logDir, baseId, { quiet: true, redact }));
  const targets = asOfDates?.length ? asOfDates.map((d) => ({ tag: d.replace(/-/g, ""), asOf: new Date(`${d}T23:59:59.999Z`) })) : [{ tag: "now", asOf: values.replay ? now : new Date() }];

  const results: ReturnType<typeof funnelToJson>[] = [];
  let anyOk = false;
  for (const t of targets) {
    const runId = `${baseId}-${t.tag}`;
    const log = createLogger(logDir, runId, { quiet: Boolean(values.json), redact });
    const ledger = new LeadLedger({ dir: logDir, runId, redact });
    const items = new ItemLedger({ dir: logDir, runId, redact });
    const cfg: FunnelConfig = { ...DEFAULT_FUNNEL_CONFIG, ...base, asOf: t.asOf };
    log.info("funnel_start", { message: `as of ${t.asOf.toISOString()} window ${cfg.windowDays}d, ${providers.length} providers${values.replay ? " (REPLAY)" : ""}` });
    const result = await runFunnel({ providers, fetcher, existing, checkHomepage, ledger, items, log, signal: shutdown.signal }, cfg);
    const json = funnelToJson(result);
    writeFileSync(join(logDir, `${runId}.funnel.json`), redact(JSON.stringify(json, null, 2)));
    results.push(json);
    if (result.providers.some((p) => p.status === "ok" || p.status === "degraded" || p.status === "stale")) anyOk = true;
    if (!values.json) {
      console.log(`\n${"-".repeat(100)}\n${formatFunnel(result)}`);
      if (values.breakdown) for (const r of result.finalists) console.log(`\n${r.entity.name} (${r.score}): ${formatBreakdown(r)}`);
      console.log(`artifacts: ${runId}.{leads,items,funnel}.json in ${logDir}/`);
    }
    if (shutdown.signal.aborted) break;
  }
  if (values.json) console.log(JSON.stringify(results, null, 2));
  shutdown.dispose();

  if (values.record && store && dbForSnapshot) {
    await store.settled();
    writeFunnelSnapshot(values.record, {
      manifest: {
        version: FUNNEL_SNAPSHOT_VERSION, kind: "funnel", created_at: new Date().toISOString(), now: new Date().toISOString(),
        description: `Live sources recorded ${new Date().toISOString()}`, as_of_dates: asOfDates ?? [], window_days: base.windowDays,
      },
      db: dbForSnapshot,
    });
    console.error(`snapshot written to ${values.record} (${store.list().length} recorded HTTP exchanges)`);
  }
  void recordedManifestNow;
  if (shutdown.signal.aborted) return shutdown.exitCode() ?? 130;
  return anyOk ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  },
);
