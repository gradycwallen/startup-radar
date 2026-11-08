import { parseArgs } from "node:util";
import { loadEnvFile, readSupabaseEnv } from "../config.ts";
import { ReadOnlyDb } from "../db.ts";
import { SignalStore } from "../signals/store.ts";
import { analyzeCorroboration, formatCorroborationReport, type CorroborationCompanyInput, type CorroborationSignalInput } from "./corroboration.ts";

/**
 * Read-only CLI: how often, and how quickly, does the Signal Intelligence layer (hiring/GitHub/
 * website) independently corroborate a company Scout discovered via a funding event? See
 * src/analysis/corroboration.ts for the full rationale, including why this is NOT a "did a signal
 * predict a later funding round" backtest (no data for that exists yet — see CLAUDE.md §5C).
 *
 * Reuses the two existing, whitelisted database access points (ReadOnlyDb, SignalStore) rather
 * than opening a third Supabase client directly — test/readonly.test.ts asserts only a short,
 * named list of files may import the Supabase client library, and this file deliberately stays
 * outside that list. This file is argv/env/formatting only; every number comes from
 * analyzeCorroboration, which has no I/O and is fully covered by test/corroboration.test.ts offline.
 */

const HELP = `Corroboration lead-time report (read-only; makes zero writes, zero Anthropic calls)

Usage: npm run analyze:corroboration -- [flags]

  --json   Print the full report (including per-company rows) as JSON instead of the text summary.
  -h, --help

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from .env). Reads only — no table is written to.
`;

async function main() {
  const { values } = parseArgs({ options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true });
  if (values.help) {
    console.log(HELP);
    return;
  }

  loadEnvFile();
  const { supabase, missing } = readSupabaseEnv();
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const db = new ReadOnlyDb(supabase.url, supabase.serviceRoleKey);
  const signalStore = new SignalStore(supabase.url, supabase.serviceRoleKey);

  const companyInfo = await db.getCompanyDiscoveryInfo();
  const companyIds = companyInfo.map((c) => c.id);
  const [activeSources, signals] = await Promise.all([signalStore.getActiveSourcesForCompanies(companyIds), signalStore.getSignalsForCompanies(companyIds)]);

  const sourcedCompanyIds = new Set(activeSources.map((s) => s.company_id));
  const companyInputs: CorroborationCompanyInput[] = companyInfo.map((c) => ({
    id: c.id,
    discoveredAt: c.discoveredAt,
    hasFundingEvent: c.hasFundingEvent,
    hasAnySignalSource: sourcedCompanyIds.has(c.id),
  }));
  const signalInputs: CorroborationSignalInput[] = signals
    .filter((s): s is typeof s & { family: "hiring" | "github" | "website" } => s.family === "hiring" || s.family === "github" || s.family === "website")
    .map((s) => ({ companyId: s.company_id, family: s.family, firedAt: s.fired_at }));

  const report = analyzeCorroboration(companyInputs, signalInputs);
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatCorroborationReport(report));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
