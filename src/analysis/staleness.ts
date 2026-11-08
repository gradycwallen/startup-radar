/**
 * Momentum decay / staleness detection — the inverse question from everything else built this
 * session. Corroboration and lead-time both ask "did something happen." This asks "did it STOP
 * happening" — a company with a hot signal early on and silence ever since is a real, VC-relevant
 * observation (did it fizzle?) that nothing else in this project currently surfaces.
 *
 * Deterministic, read-only, zero LLM calls: just the gap between "now" and a company's most
 * recent fired signal, across all three families combined (hiring/GitHub/website) — a company
 * that's quiet on GitHub but just had a hiring signal is NOT stalled, so the comparison has to be
 * against whichever family moved most recently, not any one family in isolation.
 */

export interface StalenessSignalInput {
  companyId: number;
  firedAt: string;
}

export type StalenessBucket = "active" | "cooling" | "stalled";

/** Deliberately centralized and named, matching this codebase's own convention
 * (src/signals/rules/thresholds.ts) of never burying a threshold inline. Conservative, not yet
 * backtested against real outcomes — same disclosed-starting-point posture as every other
 * threshold in this project. */
export const STALENESS_THRESHOLDS = {
  activeMaxDays: 14,
  coolingMaxDays: 45,
} as const;

export interface CompanyStaleness {
  companyId: number;
  companyName: string;
  lastSignalAt: string;
  daysSinceLastSignal: number;
  bucket: StalenessBucket;
}

export interface StalenessReport {
  /** Companies with at least one signal ever. Companies with ZERO signals are excluded entirely —
   * that's an unresolved-tracking question (see corroboration.ts), not a decay question; a
   * company that was never corroborated in the first place can't be said to have "gone quiet". */
  evaluated: number;
  buckets: Record<StalenessBucket, number>;
  /** Stalled companies only, longest-silent first — the list a human would actually want to look at. */
  stalled: CompanyStaleness[];
}

function bucketFor(days: number): StalenessBucket {
  if (days <= STALENESS_THRESHOLDS.activeMaxDays) return "active";
  if (days <= STALENESS_THRESHOLDS.coolingMaxDays) return "cooling";
  return "stalled";
}

/** Pure, deterministic, offline-testable. `now` is explicit and injectable, matching this
 * project's convention (src/signals/observe.ts's own `deriveSignalsForCompany`) rather than a
 * bare `Date.now()` buried in the computation. */
export function analyzeStaleness(companies: readonly { id: number; name: string }[], signals: readonly StalenessSignalInput[], now: Date = new Date()): StalenessReport {
  const lastSignalByCompany = new Map<number, string>();
  for (const s of signals) {
    const current = lastSignalByCompany.get(s.companyId);
    if (!current || s.firedAt > current) lastSignalByCompany.set(s.companyId, s.firedAt);
  }

  const results: CompanyStaleness[] = [];
  const buckets: Record<StalenessBucket, number> = { active: 0, cooling: 0, stalled: 0 };
  const companyNames = new Map(companies.map((c) => [c.id, c.name]));

  for (const [companyId, lastSignalAt] of lastSignalByCompany) {
    const days = Math.round((now.getTime() - new Date(lastSignalAt).getTime()) / 86_400_000);
    const bucket = bucketFor(days);
    buckets[bucket]++;
    results.push({ companyId, companyName: companyNames.get(companyId) ?? `#${companyId}`, lastSignalAt, daysSinceLastSignal: days, bucket });
  }

  return {
    evaluated: lastSignalByCompany.size,
    buckets,
    stalled: results.filter((r) => r.bucket === "stalled").sort((a, b) => b.daysSinceLastSignal - a.daysSinceLastSignal),
  };
}

export function formatStalenessReport(report: StalenessReport): string {
  const lines: string[] = [];
  lines.push("Momentum decay report");
  lines.push("======================");
  lines.push(`Companies with at least one signal ever:  ${report.evaluated}`);
  if (report.evaluated === 0) {
    lines.push("");
    lines.push("No company has had any signal fire yet -- nothing to measure decay against.");
    return lines.join("\n");
  }
  lines.push(`  active  (<=${STALENESS_THRESHOLDS.activeMaxDays}d since last signal):  ${report.buckets.active}`);
  lines.push(`  cooling (<=${STALENESS_THRESHOLDS.coolingMaxDays}d since last signal):  ${report.buckets.cooling}`);
  lines.push(`  stalled (>${STALENESS_THRESHOLDS.coolingMaxDays}d since last signal):   ${report.buckets.stalled}`);
  if (report.stalled.length === 0) {
    lines.push("");
    lines.push("No stalled companies right now.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("Stalled companies (longest-silent first):");
  for (const c of report.stalled) lines.push(`  ${String(c.daysSinceLastSignal).padStart(4)}d  ${c.companyName} (id ${c.companyId}) — last signal ${c.lastSignalAt.slice(0, 10)}`);
  return lines.join("\n");
}
