import { parseArgs } from "node:util";
import { loadEnvFile, readSupabaseEnv } from "../config.ts";
import { ReadOnlyDb } from "../db.ts";
import { SignalStore } from "../signals/store.ts";
import { analyzeStaleness, formatStalenessReport, type StalenessSignalInput } from "./staleness.ts";

/**
 * Read-only CLI for src/analysis/staleness.ts. Reuses ReadOnlyDb/SignalStore like every other
 * analysis tool added this session (see corroboration-main.ts for why).
 */

const HELP = `Momentum decay report (read-only; makes zero writes, zero Anthropic calls)

Usage: npm run analyze:staleness -- [flags]

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

  const companies = await db.getCompanyNames();
  const companyIds = companies.map((c) => c.id);
  const signals = await signalStore.getSignalsForCompanies(companyIds);
  const signalInputs: StalenessSignalInput[] = signals.map((s) => ({ companyId: s.company_id, firedAt: s.fired_at }));

  const report = analyzeStaleness(companies, signalInputs);
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatStalenessReport(report));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
