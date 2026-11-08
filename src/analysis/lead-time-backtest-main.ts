import { parseArgs } from "node:util";
import { loadEnvFile, readSupabaseEnv } from "../config.ts";
import { ReadOnlyDb } from "../db.ts";
import { SignalStore } from "../signals/store.ts";
import { backtestLeadTime, formatLeadTimeBacktestReport, type LeadTimeFundingEventInput, type LeadTimeSignalInput } from "./lead-time-backtest.ts";

/**
 * Read-only CLI for src/analysis/lead-time-backtest.ts — see that file's doc comment for why this
 * is expected to report zero qualifying pairs against the live database today, and what would
 * change that. Reuses the existing whitelisted access points (ReadOnlyDb, SignalStore); see
 * corroboration-main.ts for why that matters to test/readonly.test.ts's import guard.
 */

const HELP = `Lead-time backtest (read-only; makes zero writes, zero Anthropic calls)

Usage: npm run analyze:lead-time -- [flags]

  --gap-days <n>   Minimum day gap between funding-event dates to count as a genuinely separate
                    round, rather than multiple articles about the same raise (default 14).
  --json           Print the full report (including per-pair rows) as JSON instead of the text summary.
  -h, --help

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from .env). Reads only — no table is written to.
`;

async function main() {
  const { values } = parseArgs({ options: { json: { type: "boolean" }, "gap-days": { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const gapDays = values["gap-days"] ? Number(values["gap-days"]) : undefined;
  if (gapDays !== undefined && (!Number.isFinite(gapDays) || gapDays <= 0)) {
    console.error("--gap-days must be a positive number");
    process.exitCode = 1;
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
  // getFundingEventDates is intentionally narrow: date only, no headline/source/amount — this
  // backtest needs nothing else and a narrower read is easier to reason about as safe.
  const fundingEventDates = await db.getFundingEventDates(companyIds);
  const signals = await signalStore.getSignalsForCompanies(companyIds);

  const fundingEventInputs: LeadTimeFundingEventInput[] = fundingEventDates.map((e) => ({ companyId: e.companyId, eventDate: e.eventDate }));
  const signalInputs: LeadTimeSignalInput[] = signals
    .filter((s): s is typeof s & { family: "hiring" | "github" | "website" } => s.family === "hiring" || s.family === "github" || s.family === "website")
    .map((s) => ({ companyId: s.company_id, family: s.family, firedAt: s.fired_at }));

  const report = backtestLeadTime(fundingEventInputs, signalInputs, gapDays);
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatLeadTimeBacktestReport(report));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
