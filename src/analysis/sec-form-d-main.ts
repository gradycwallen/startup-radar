import { parseArgs } from "node:util";
import { loadEnvFile, readSupabaseEnv } from "../config.ts";
import { ReadOnlyDb } from "../db.ts";
import { PoliteFetcher } from "../sources/fetcher.ts";
import { formatCandidates, matchFormDCandidates, searchFormD, type SecFormDCandidate, type SecFormDHit } from "./sec-form-d.ts";

/**
 * Read-only CLI: for companies Scout already tracks, search SEC EDGAR's full-text search index
 * (https://efts.sec.gov/LATEST/search-index) for Form D filings with a similarly-named filer. See
 * src/analysis/sec-form-d.ts's doc comment for why every result is a candidate for human review,
 * never an accepted match, and docs/2026-11-07-sec-form-d-feasibility.md for the underlying
 * research this is built on.
 *
 * Makes real network requests to sec.gov but writes NOTHING to any database and calls no LLM.
 * Reuses ReadOnlyDb (the one whitelisted read path) for the company list.
 */

const HELP = `SEC Form D corroboration check (read-only; makes zero writes, zero Anthropic calls)

Usage: npm run analyze:sec-form-d -- [flags]

  --company <id>   Only this company (numeric companies.id).
  --limit <n>      Check at most this many companies (default: all).
  --json           Print full candidate rows as JSON instead of the text summary.
  -h, --help

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from .env) to list companies, and
SEC_CONTACT_EMAIL (from .env) to build a User-Agent SEC's fair-access policy will accept -- an
undeclared/contact-less automated client gets a 403 "Undeclared Automated Tool" response (SEC's
own wording; confirmed live, not assumed). Nothing from SEC_CONTACT_EMAIL is written anywhere
except outgoing request headers to sec.gov; it is never logged, printed, or committed.

Makes real, polite requests to efts.sec.gov (SEC's own full-text search; undocumented but public
and free, no API key). Paces well under SEC's documented 10 req/s fair-access limit.
`;

async function main() {
  const { values } = parseArgs({ options: { company: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true });
  if (values.help) {
    console.log(HELP);
    return;
  }

  loadEnvFile();
  const { supabase, missing } = readSupabaseEnv();
  const secContactEmail = process.env.SEC_CONTACT_EMAIL?.trim();
  const allMissing = [...missing, ...(secContactEmail ? [] : ["SEC_CONTACT_EMAIL"])];
  if (allMissing.length > 0) {
    console.error(`Missing required environment variable(s): ${allMissing.join(", ")}`);
    if (!secContactEmail) console.error("SEC_CONTACT_EMAIL: SEC's fair-access policy requires a real contact email in the User-Agent for automated requests; see --help.");
    process.exitCode = 1;
    return;
  }
  // SEC's fair-access policy wants a real, contactable email somewhere in the UA (its own example
  // is "Sample Company Name AdminContact@sample.com") -- an undeclared/contact-less UA gets a 403
  // "Undeclared Automated Tool" response, confirmed live. The email is embedded as given, never
  // reformatted into an "AdminContact@<value>" template, since that would corrupt any address
  // that already contains an "@" (which every real email does) into an invalid double-"@" string.
  const userAgent = `StartupRadarScout/0.3 (${secContactEmail}; +https://github.com/gradycwallen/startup-radar)`;

  const db = new ReadOnlyDb(supabase.url, supabase.serviceRoleKey);
  let companies = await db.getCompanyNames();
  if (values.company) {
    const id = Number(values.company);
    companies = companies.filter((c) => c.id === id);
  }
  if (values.limit) companies = companies.slice(0, Number(values.limit));

  // Conservative pacing (~2.5 req/s) -- well under SEC's documented 10 req/s fair-access limit;
  // there is no reason for this report-only tool to push that boundary.
  const fetcher = new PoliteFetcher({ userAgent, hostDelayMs: { "efts.sec.gov": 400 }, minDelayMs: 400 });

  const allCandidates: SecFormDCandidate[] = [];
  let failed = 0;
  for (const company of companies) {
    let hits: SecFormDHit[];
    try {
      hits = await searchFormD(company.name, (url) => fetcher.getText(url, { provider: "sec-form-d", accept: "application/json" }));
    } catch (error) {
      failed++;
      const reason = error instanceof Error && /^SEC returned /.test(error.message) ? error.message : "network request failed";
      console.error(`SEC lookup failed for ${company.name} (id ${company.id}): ${reason}`);
      continue;
    }
    allCandidates.push(...matchFormDCandidates(company, hits));
  }

  if (values.json) console.log(JSON.stringify(allCandidates, null, 2));
  else console.log(formatCandidates(allCandidates));
  if (failed > 0) {
    console.error(`${failed} of ${companies.length} SEC lookups failed; results are incomplete.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
