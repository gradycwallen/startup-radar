import type { DerivedSignal, Observation } from "../types.ts";
import { bestAvailableWindow, isPersistent, metricSeries } from "../velocity.ts";
import { HIRING_LEVEL_RULE_VERSION, HIRING_LEVEL_THRESHOLDS, HIRING_RULE_VERSION, HIRING_THRESHOLDS } from "./thresholds.ts";
import { type ExistingSignalRef, fmtNum, fmtPct, makeLevelSignal, makeSignal, pushIfNew } from "./format.ts";

/**
 * Deterministic hiring signals from ATS observations. No LLM decides anything here — every fired
 * signal is a threshold check over `compareWindow` output, and its `explanation` field is built
 * entirely from those same structured numbers.
 *
 * `existingSignals` (this company's already-fired signals) is required — see rules/github.ts's
 * doc comment and format.ts: alreadyReportedValue for why every push here goes through
 * `pushIfNew` rather than a bare `out.push`.
 */
export function deriveHiringSignals(companyId: number, history: readonly Observation[], existingSignals: readonly ExistingSignalRef[]): Omit<DerivedSignal, "id">[] {
  const out: Omit<DerivedSignal, "id">[] = [];

  const total = bestAvailableWindow(history, "ats_open_jobs_total");
  if (total && total.delta !== null) {
    const isSurge = (total.relativeChange !== null && total.relativeChange >= HIRING_THRESHOLDS.openJobsSurgeMinRelative) || total.delta >= HIRING_THRESHOLDS.openJobsSurgeMinAbsolute;
    if (isSurge && isPersistent(history, total)) {
      pushIfNew(
        out, existingSignals,
        makeSignal(
          companyId, "hiring", "open_jobs_surge", HIRING_RULE_VERSION, total,
          `Hiring accelerated: open positions increased from ${fmtNum(total.from?.numeric_value ?? null)} to ${fmtNum(total.to.numeric_value)} over ${Math.round(total.actualSpanDays ?? total.windowDays)} days.`,
        ),
      );
    } else if (total.delta >= HIRING_THRESHOLDS.openJobsIncreaseMinDelta) {
      pushIfNew(out, existingSignals, makeSignal(companyId, "hiring", "open_jobs_increase", HIRING_RULE_VERSION, total, `Open positions increased from ${fmtNum(total.from?.numeric_value ?? null)} to ${fmtNum(total.to.numeric_value)} over ${Math.round(total.actualSpanDays ?? total.windowDays)} days.`));
    }
  }

  const eng = bestAvailableWindow(history, "ats_open_jobs_engineering");
  if (eng && eng.delta !== null && eng.delta >= HIRING_THRESHOLDS.engineeringIncreaseMinDelta) {
    pushIfNew(out, existingSignals, makeSignal(companyId, "hiring", "engineering_hiring_increase", HIRING_RULE_VERSION, eng, `Engineering postings increased from ${fmtNum(eng.from?.numeric_value ?? null)} to ${fmtNum(eng.to.numeric_value)} over ${Math.round(eng.actualSpanDays ?? eng.windowDays)} days${eng.relativeChange !== null ? ` (${fmtPct(eng.relativeChange)})` : ""}.`));
  }

  // sales_hiring_started: the sales department goes from zero open postings to non-zero — the
  // company's own aggregate department category, distinct from the narrower enterprise-sales
  // sub-signal below (which requires a specific senior/enterprise title, not just any sales role).
  const sales = bestAvailableWindow(history, "ats_open_jobs_sales");
  if (sales && sales.from?.numeric_value === 0 && (sales.to.numeric_value ?? 0) > 0) {
    pushIfNew(out, existingSignals, makeSignal(companyId, "hiring", "sales_hiring_started", HIRING_RULE_VERSION, sales, `Sales postings appeared for the first time in the last ${Math.round(sales.actualSpanDays ?? sales.windowDays)} days (${fmtNum(sales.to.numeric_value)} open, none before).`));
  }

  for (const [metric, signalType, label] of [
    ["ats_has_enterprise_sales_role", "enterprise_sales_hiring_started", "an enterprise/strategic sales role"],
    ["ats_has_recruiting_role", "recruiting_hiring_started", "a recruiting role"],
    ["ats_has_security_compliance_role", "security_hiring_started", "a security/compliance role"],
  ] as const) {
    const cmp = bestAvailableWindow(history, metric);
    if (cmp && cmp.from?.numeric_value === 0 && cmp.to.numeric_value === 1) {
      pushIfNew(out, existingSignals, makeSignal(companyId, "hiring", signalType, HIRING_RULE_VERSION, cmp, `First appearance of ${label} in the last ${Math.round(cmp.actualSpanDays ?? cmp.windowDays)} days (none was open before).`));
    }
  }

  return out;
}

/**
 * LEVEL hiring signals (V2-2B.1) — fire from a metric's FIRST-EVER observation, when no prior
 * reading exists to compare against. This is the direct fix for the cold-start defect: without
 * these, a company observed for the first time cannot produce ANY hiring signal no matter how
 * strong its evidence is, since every rule above requires `bestAvailableWindow`/`compareWindow`,
 * which need two observations.
 *
 * Each check here is gated on `metricSeries(...).length === 1` — genuinely no prior observation
 * for that specific metric, not merely "the current value is high." This makes each of these
 * signals fire AT MOST ONCE per company per metric, ever: the moment a second observation exists,
 * the metric has real history and the velocity rules above take over instead. A company with a
 * permanently-high baseline (e.g. always 50 open roles) will NOT re-fire this every day — it fires
 * once, on day one, and never again for that metric.
 *
 * Wording is deliberately restricted to describing the CURRENT state ("present at first
 * observation") — never "started"/"appeared"/"increased"/"grew". We have zero evidence about
 * what came before a metric's first-ever reading; claiming a transition we didn't observe would
 * violate the same "unknown != zero" discipline the missing-vs-zero rules already enforce.
 */
export function deriveHiringLevelSignals(companyId: number, history: readonly Observation[]): Omit<DerivedSignal, "id">[] {
  const out: Omit<DerivedSignal, "id">[] = [];

  const totalSeries = metricSeries(history, "ats_open_jobs_total");
  if (totalSeries.length === 1) {
    const obs = totalSeries[0]!;
    if (obs.numeric_value !== null && obs.numeric_value >= HIRING_LEVEL_THRESHOLDS.openJobsHighAtFirstObservation) {
      out.push(
        makeLevelSignal(
          companyId, "hiring", "high_hiring_present_at_first_observation", HIRING_LEVEL_RULE_VERSION, obs,
          `${fmtNum(obs.numeric_value)} open positions observed at first look — notably high hiring activity present. No prior reading exists, so this is reported as the current level, not a change.`,
        ),
      );
    }
  }

  const salesSeries = metricSeries(history, "ats_open_jobs_sales");
  if (salesSeries.length === 1) {
    const obs = salesSeries[0]!;
    if (obs.numeric_value !== null && obs.numeric_value >= HIRING_LEVEL_THRESHOLDS.salesPresentMinCount) {
      out.push(
        makeLevelSignal(
          companyId, "hiring", "sales_hiring_present_at_first_observation", HIRING_LEVEL_RULE_VERSION, obs,
          `Sales hiring present at first observation (${fmtNum(obs.numeric_value)} open sales roles). No prior reading exists, so whether this is new or long-standing is unknown.`,
        ),
      );
    }
  }

  for (const [metric, signalType, label] of [
    ["ats_has_enterprise_sales_role", "enterprise_sales_role_present_at_first_observation", "An enterprise/strategic sales role is"],
    ["ats_has_recruiting_role", "recruiting_role_present_at_first_observation", "A recruiting role is"],
    ["ats_has_security_compliance_role", "security_compliance_role_present_at_first_observation", "A security/compliance role is"],
  ] as const) {
    const series = metricSeries(history, metric);
    if (series.length === 1 && series[0]!.numeric_value === 1) {
      out.push(
        makeLevelSignal(
          companyId, "hiring", signalType, HIRING_LEVEL_RULE_VERSION, series[0]!,
          `${label} present at first observation. No prior reading exists, so whether this is new or long-standing is unknown.`,
        ),
      );
    }
  }

  return out;
}
