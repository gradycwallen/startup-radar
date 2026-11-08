/**
 * Corroboration lead-time analysis — read-only, offline-computable, zero LLM calls.
 *
 * Question: once a company is discovered (via a funding event), how long does it take for the
 * Signal Intelligence layer (hiring/GitHub/website) to independently corroborate that the company
 * is real and active, and how often does that happen at all?
 *
 * This is deliberately NOT the originally-proposed "did a signal predict a SUBSEQUENT funding
 * round" backtest — that needs a second, later, independently-detected funding event for an
 * already-tracked company, and V2-1.1 (src/discovery/*) explicitly never adds new discovery_events
 * to an existing company (see CLAUDE.md §5C "Scope cut, explicitly disclosed"). No such pair exists
 * in the data yet, by design, not by accident. This measures something the data CAN answer today:
 * how quickly and how often the signal layer backs up a funding-based discovery with independent
 * evidence from a completely different source family.
 */

export interface CorroborationCompanyInput {
  id: number;
  /** When Scout first wrote this company to the database (companies.discovered_at). */
  discoveredAt: string;
  /** True if this company's discovery includes at least one `funding` discovery_event. */
  hasFundingEvent: boolean;
  /** True if at least one signal_sources row has ever been resolved for this company (github/ats/website). */
  hasAnySignalSource: boolean;
}

export interface CorroborationSignalInput {
  companyId: number;
  family: "hiring" | "github" | "website";
  firedAt: string;
}

export interface CompanyCorroborationResult {
  companyId: number;
  hasAnySignalSource: boolean;
  /** null when no non-funding signal has ever fired for this company. */
  firstSignalFamily: "hiring" | "github" | "website" | null;
  firstSignalFiredAt: string | null;
  /** Days from discoveredAt to the first signal, rounded to 1 decimal. null when no signal fired. */
  leadTimeDays: number | null;
}

export interface CorroborationReport {
  /** Companies discovered via a funding event, regardless of whether a signal source was ever resolved. */
  totalFundingDiscoveries: number;
  /** Of those, how many have at least one resolved signal source (github/ats/website) — i.e. were
   * even eligible to produce a corroborating signal. A company with zero resolved sources is
   * excluded from the rate/lead-time stats below, not counted as "no corroboration" — no evidence
   * was ever possible to collect, so this is unknown, not a negative result. */
  eligibleForCorroboration: number;
  /** Of the eligible companies, how many have had at least one non-funding signal fire, ever. */
  corroboratedCount: number;
  /** corroboratedCount / eligibleForCorroboration, as a fraction in [0, 1]. null if eligibleForCorroboration is 0. */
  corroborationRate: number | null;
  /** Lead-time stats (days from discovery to first corroborating signal) over corroborated companies only. */
  leadTimeDaysMedian: number | null;
  leadTimeDaysMean: number | null;
  leadTimeDaysMin: number | null;
  leadTimeDaysMax: number | null;
  /** Count of first-corroborating-signal by family, over corroborated companies only. */
  firstSignalFamilyCounts: Record<"hiring" | "github" | "website", number>;
  perCompany: CompanyCorroborationResult[];
}

function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Math.round((ms / 86_400_000) * 10) / 10;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const result = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return Math.round(result * 10) / 10;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

/**
 * Pure, deterministic, offline-testable. All rows must already be filtered/joined by the caller —
 * this function does no I/O and makes no assumption about where the rows came from (live Supabase
 * or a fixture).
 */
export function analyzeCorroboration(companies: readonly CorroborationCompanyInput[], signals: readonly CorroborationSignalInput[]): CorroborationReport {
  const signalsByCompany = new Map<number, CorroborationSignalInput[]>();
  for (const s of signals) {
    const list = signalsByCompany.get(s.companyId);
    if (list) list.push(s);
    else signalsByCompany.set(s.companyId, [s]);
  }

  const fundingCompanies = companies.filter((c) => c.hasFundingEvent);
  const eligible = fundingCompanies.filter((c) => c.hasAnySignalSource);

  const perCompany: CompanyCorroborationResult[] = eligible.map((c) => {
    const companySignals = [...(signalsByCompany.get(c.id) ?? [])].sort((a, b) => new Date(a.firedAt).getTime() - new Date(b.firedAt).getTime());
    const first = companySignals[0];
    return {
      companyId: c.id,
      hasAnySignalSource: true,
      firstSignalFamily: first?.family ?? null,
      firstSignalFiredAt: first?.firedAt ?? null,
      leadTimeDays: first ? daysBetween(c.discoveredAt, first.firedAt) : null,
    };
  });

  const corroborated = perCompany.filter((r) => r.leadTimeDays !== null);
  const leadTimes = corroborated.map((r) => r.leadTimeDays!);
  const familyCounts: Record<"hiring" | "github" | "website", number> = { hiring: 0, github: 0, website: 0 };
  for (const r of corroborated) if (r.firstSignalFamily) familyCounts[r.firstSignalFamily]++;

  return {
    totalFundingDiscoveries: fundingCompanies.length,
    eligibleForCorroboration: eligible.length,
    corroboratedCount: corroborated.length,
    corroborationRate: eligible.length > 0 ? Math.round((corroborated.length / eligible.length) * 1000) / 1000 : null,
    leadTimeDaysMedian: median(leadTimes),
    leadTimeDaysMean: mean(leadTimes),
    leadTimeDaysMin: leadTimes.length > 0 ? Math.min(...leadTimes) : null,
    leadTimeDaysMax: leadTimes.length > 0 ? Math.max(...leadTimes) : null,
    firstSignalFamilyCounts: familyCounts,
    perCompany,
  };
}

export function formatCorroborationReport(report: CorroborationReport): string {
  const lines: string[] = [];
  lines.push("Corroboration lead-time report");
  lines.push("===============================");
  lines.push(`Companies discovered via a funding event:        ${report.totalFundingDiscoveries}`);
  lines.push(`  ...with at least one resolved signal source:   ${report.eligibleForCorroboration}`);
  lines.push(`  ...of those, ever corroborated by a signal:    ${report.corroboratedCount}` + (report.corroborationRate !== null ? ` (${(report.corroborationRate * 100).toFixed(1)}%)` : ""));
  if (report.eligibleForCorroboration === 0) {
    lines.push("");
    lines.push("No company discovered via funding has a resolved signal source yet — nothing to report.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("Lead time to first corroborating signal (days from discovery):");
  lines.push(`  median: ${report.leadTimeDaysMedian ?? "n/a"}   mean: ${report.leadTimeDaysMean ?? "n/a"}   min: ${report.leadTimeDaysMin ?? "n/a"}   max: ${report.leadTimeDaysMax ?? "n/a"}`);
  lines.push("");
  lines.push("First corroborating signal, by family:");
  for (const family of ["hiring", "github", "website"] as const) lines.push(`  ${family.padEnd(8)}: ${report.firstSignalFamilyCounts[family]}`);
  return lines.join("\n");
}
