import type { DerivedSignal, Observation } from "../types.ts";
import { bestAvailableWindow, isPersistent } from "../velocity.ts";
import { HIRING_RULE_VERSION, HIRING_THRESHOLDS } from "./thresholds.ts";
import { fmtNum, fmtPct, makeSignal } from "./format.ts";

/**
 * Deterministic hiring signals from ATS observations. No LLM decides anything here — every fired
 * signal is a threshold check over `compareWindow` output, and its `explanation` field is built
 * entirely from those same structured numbers.
 */
export function deriveHiringSignals(companyId: number, history: readonly Observation[]): Omit<DerivedSignal, "id">[] {
  const out: Omit<DerivedSignal, "id">[] = [];

  const total = bestAvailableWindow(history, "ats_open_jobs_total");
  if (total && total.delta !== null) {
    const isSurge = (total.relativeChange !== null && total.relativeChange >= HIRING_THRESHOLDS.openJobsSurgeMinRelative) || total.delta >= HIRING_THRESHOLDS.openJobsSurgeMinAbsolute;
    if (isSurge && isPersistent(history, total)) {
      out.push(
        makeSignal(
          companyId, "hiring", "open_jobs_surge", HIRING_RULE_VERSION, total,
          `Hiring accelerated: open positions increased from ${fmtNum(total.from?.numeric_value ?? null)} to ${fmtNum(total.to.numeric_value)} over ${Math.round(total.actualSpanDays ?? total.windowDays)} days.`,
        ),
      );
    } else if (total.delta >= HIRING_THRESHOLDS.openJobsIncreaseMinDelta) {
      out.push(makeSignal(companyId, "hiring", "open_jobs_increase", HIRING_RULE_VERSION, total, `Open positions increased from ${fmtNum(total.from?.numeric_value ?? null)} to ${fmtNum(total.to.numeric_value)} over ${Math.round(total.actualSpanDays ?? total.windowDays)} days.`));
    }
  }

  const eng = bestAvailableWindow(history, "ats_open_jobs_engineering");
  if (eng && eng.delta !== null && eng.delta >= HIRING_THRESHOLDS.engineeringIncreaseMinDelta) {
    out.push(makeSignal(companyId, "hiring", "engineering_hiring_increase", HIRING_RULE_VERSION, eng, `Engineering postings increased from ${fmtNum(eng.from?.numeric_value ?? null)} to ${fmtNum(eng.to.numeric_value)} over ${Math.round(eng.actualSpanDays ?? eng.windowDays)} days${eng.relativeChange !== null ? ` (${fmtPct(eng.relativeChange)})` : ""}.`));
  }

  // sales_hiring_started: the sales department goes from zero open postings to non-zero — the
  // company's own aggregate department category, distinct from the narrower enterprise-sales
  // sub-signal below (which requires a specific senior/enterprise title, not just any sales role).
  const sales = bestAvailableWindow(history, "ats_open_jobs_sales");
  if (sales && sales.from?.numeric_value === 0 && (sales.to.numeric_value ?? 0) > 0) {
    out.push(makeSignal(companyId, "hiring", "sales_hiring_started", HIRING_RULE_VERSION, sales, `Sales postings appeared for the first time in the last ${Math.round(sales.actualSpanDays ?? sales.windowDays)} days (${fmtNum(sales.to.numeric_value)} open, none before).`));
  }

  for (const [metric, signalType, label] of [
    ["ats_has_enterprise_sales_role", "enterprise_sales_hiring_started", "an enterprise/strategic sales role"],
    ["ats_has_recruiting_role", "recruiting_hiring_started", "a recruiting role"],
    ["ats_has_security_compliance_role", "security_hiring_started", "a security/compliance role"],
  ] as const) {
    const cmp = bestAvailableWindow(history, metric);
    if (cmp && cmp.from?.numeric_value === 0 && cmp.to.numeric_value === 1) {
      out.push(makeSignal(companyId, "hiring", signalType, HIRING_RULE_VERSION, cmp, `First appearance of ${label} in the last ${Math.round(cmp.actualSpanDays ?? cmp.windowDays)} days (none was open before).`));
    }
  }

  return out;
}
