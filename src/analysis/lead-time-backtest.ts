/**
 * Lead-time backtest — the originally-proposed question: for a company that had a genuinely
 * LATER, separate funding round, did a non-funding signal (hiring/GitHub/website) fire in advance
 * of that later round becoming public? If so, how much advance notice did it give?
 *
 * This is the real predictive claim src/analysis/corroboration.ts deliberately does NOT make (see
 * that file's doc comment). It is expected to find ZERO qualifying pairs against the live database
 * today — not because of a bug here, but because V2-1.1 (src/discovery/*) never adds a new
 * discovery_events row to an already-existing company (CLAUDE.md §5C, a disclosed scope cut), so
 * nothing in the current pipeline can produce a genuine "same company, two separate rounds months
 * apart" case yet. This module exists so that the moment that changes — either §5C is extended, or
 * enough real calendar time passes for some other mechanism to add a second round — this backtest
 * is already built, tested, and ready to run, rather than something to write under time pressure
 * once the data finally exists.
 */

export interface LeadTimeFundingEventInput {
  companyId: number;
  /** ISO date (YYYY-MM-DD) or timestamp — only the date matters here. */
  eventDate: string;
}

export interface LeadTimeSignalInput {
  companyId: number;
  family: "hiring" | "github" | "website";
  firedAt: string;
}

export interface RoundCluster {
  /** Earliest event date in this cluster — treated as when this round's announcement became public. */
  announcedAt: string;
  eventCount: number;
}

export interface CompanyLeadTimeResult {
  companyId: number;
  /** The gap between this round and the PRIOR round for this company. */
  priorRoundAnnouncedAt: string;
  nextRoundAnnouncedAt: string;
  /** The signal that fired closest before (but still before) the next round's announcement, if any. */
  precedingSignalFamily: "hiring" | "github" | "website" | null;
  precedingSignalFiredAt: string | null;
  leadTimeDays: number | null;
}

export interface LeadTimeBacktestReport {
  /** Companies with 2+ funding events in the input at all, before clustering. */
  companiesWithMultipleFundingEvents: number;
  /** Of those, companies where the events cluster into 2+ GENUINELY separate rounds
   * (announcement dates more than `roundClusterGapDays` apart) — the only real candidates
   * for this backtest. */
  companiesWithGenuineSubsequentRound: number;
  /** One row per (prior round -> next round) pair found. Empty when
   * companiesWithGenuineSubsequentRound is 0 — this is the expected, documented, current state. */
  pairs: CompanyLeadTimeResult[];
  /** Of `pairs`, how many had any signal precede the next round's announcement. */
  pairsWithPrecedingSignal: number;
  leadTimeDaysMedian: number | null;
  leadTimeDaysMean: number | null;
}

const DEFAULT_ROUND_CLUSTER_GAP_DAYS = 14;

function toDays(ms: number): number {
  return Math.round((ms / 86_400_000) * 10) / 10;
}

/** Collapse a company's funding event dates into distinct "round announcements": consecutive
 * dates within `gapDays` of each other are the same round (multiple corroborating articles about
 * one raise), a gap larger than that starts a new round. */
function clusterRounds(dates: readonly string[], gapDays: number): RoundCluster[] {
  const sorted = [...dates].map((d) => new Date(d).getTime()).sort((a, b) => a - b);
  const clusters: { start: number; count: number }[] = [];
  for (const t of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && (t - last.start) / 86_400_000 <= gapDays) {
      last.count++;
    } else {
      clusters.push({ start: t, count: 1 });
    }
  }
  return clusters.map((c) => ({ announcedAt: new Date(c.start).toISOString(), eventCount: c.count }));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

/** Pure, deterministic, offline-testable — no I/O. `gapDays` defaults to 14 and is exposed only
 * for tests; production callers should use the default. */
export function backtestLeadTime(fundingEvents: readonly LeadTimeFundingEventInput[], signals: readonly LeadTimeSignalInput[], gapDays = DEFAULT_ROUND_CLUSTER_GAP_DAYS): LeadTimeBacktestReport {
  const datesByCompany = new Map<number, string[]>();
  for (const e of fundingEvents) {
    const list = datesByCompany.get(e.companyId);
    if (list) list.push(e.eventDate);
    else datesByCompany.set(e.companyId, [e.eventDate]);
  }
  const signalsByCompany = new Map<number, LeadTimeSignalInput[]>();
  for (const s of signals) {
    const list = signalsByCompany.get(s.companyId);
    if (list) list.push(s);
    else signalsByCompany.set(s.companyId, [s]);
  }

  const companiesWithMultipleFundingEvents = [...datesByCompany.values()].filter((d) => d.length >= 2).length;

  const pairs: CompanyLeadTimeResult[] = [];
  let companiesWithGenuineSubsequentRound = 0;
  for (const [companyId, dates] of datesByCompany) {
    const clusters = clusterRounds(dates, gapDays);
    if (clusters.length < 2) continue;
    companiesWithGenuineSubsequentRound++;
    const companySignals = [...(signalsByCompany.get(companyId) ?? [])].sort((a, b) => new Date(a.firedAt).getTime() - new Date(b.firedAt).getTime());
    for (let i = 1; i < clusters.length; i++) {
      const prior = clusters[i - 1]!;
      const next = clusters[i]!;
      const nextTime = new Date(next.announcedAt).getTime();
      const priorTime = new Date(prior.announcedAt).getTime();
      // The signal that fired closest before the next round's announcement, but still after the
      // prior round — the most informative "how much advance notice did we actually have" read.
      const preceding = [...companySignals].reverse().find((s) => {
        const t = new Date(s.firedAt).getTime();
        return t > priorTime && t < nextTime;
      });
      pairs.push({
        companyId,
        priorRoundAnnouncedAt: prior.announcedAt,
        nextRoundAnnouncedAt: next.announcedAt,
        precedingSignalFamily: preceding?.family ?? null,
        precedingSignalFiredAt: preceding?.firedAt ?? null,
        leadTimeDays: preceding ? toDays(nextTime - new Date(preceding.firedAt).getTime()) : null,
      });
    }
  }

  const withSignal = pairs.filter((p) => p.leadTimeDays !== null);
  const leadTimes = withSignal.map((p) => p.leadTimeDays!);
  return {
    companiesWithMultipleFundingEvents,
    companiesWithGenuineSubsequentRound,
    pairs,
    pairsWithPrecedingSignal: withSignal.length,
    leadTimeDaysMedian: median(leadTimes),
    leadTimeDaysMean: mean(leadTimes),
  };
}

export function formatLeadTimeBacktestReport(report: LeadTimeBacktestReport): string {
  const lines: string[] = [];
  lines.push("Lead-time backtest (signal preceding a SUBSEQUENT funding round)");
  lines.push("===================================================================");
  lines.push(`Companies with 2+ funding events on record:          ${report.companiesWithMultipleFundingEvents}`);
  lines.push(`  ...clustering into 2+ genuinely separate rounds:   ${report.companiesWithGenuineSubsequentRound}`);
  if (report.companiesWithGenuineSubsequentRound === 0) {
    lines.push("");
    lines.push("No company in this dataset has a genuinely separate, later funding round yet --");
    lines.push("every multi-event company's dates cluster into one announcement. This is expected:");
    lines.push("V2-1.1 never adds a new discovery_events row to an already-existing company (see");
    lines.push("CLAUDE.md §5C). Nothing to backtest until that changes, or real calendar time");
    lines.push("produces a second round through some other path. Not a bug in this tool.");
    return lines.join("\n");
  }
  lines.push(`Round pairs found:                                    ${report.pairs.length}`);
  lines.push(`  ...with a signal preceding the next round:          ${report.pairsWithPrecedingSignal}`);
  lines.push("");
  lines.push(`Lead time (days, signal fired_at before next round's announcement):`);
  lines.push(`  median: ${report.leadTimeDaysMedian ?? "n/a"}   mean: ${report.leadTimeDaysMean ?? "n/a"}`);
  return lines.join("\n");
}
