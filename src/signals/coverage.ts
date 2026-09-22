import type { DerivedSignal, Observation, SignalFamily, SignalSource, SourceType } from "./types.ts";

/**
 * V2-2B.1: Coverage — a DERIVED, read-time description of how much evidence exists for a company,
 * computed fresh from `signal_sources`/`observations`/`signals` every time it's asked for. NOT
 * persisted (no new table, no momentum_snapshot — see the V2-2B design report's explicit
 * recommendation against one): staleness risk with no benefit at this data scale, and it mirrors
 * how `signals` themselves are already documented as "derived and recomputable."
 *
 * NON-NEGOTIABLE: Coverage is DESCRIPTIVE CONTEXT ONLY. Nothing in this module feeds into, adjusts,
 * or gates signal derivation (rules/*.ts) or any future momentum computation. More observations,
 * more resolved families, or a longer observation span must never themselves increase momentum —
 * see root CLAUDE.md and the V2-2B design report's non-negotiable list. This module is read by
 * reporting/CLI code (signals-main.ts) alongside, never inside, signal derivation.
 */

const SOURCE_TYPE_FAMILY: Record<SourceType, SignalFamily> = {
  github_org: "github",
  github_repo: "github",
  greenhouse: "hiring",
  lever: "hiring",
  ashby: "hiring",
  website: "website",
};

export type HistoryClass = "early_evidence" | "developing_history" | "longitudinal_history";

/** Real-history threshold (in days of observation span) at which Coverage stops calling a
 * company's evidence "developing" and starts calling it "longitudinal." A plain, disclosed,
 * unvalidated starting value — NOT a statistical confidence level, and not intended to read as
 * one; it exists purely to give the label something concrete and explainable behind it. */
const LONGITUDINAL_HISTORY_MIN_DAYS = 30;

export interface CoverageDescriptor {
  /** Families with at least one ACTIVE resolved signal_source. */
  familiesResolved: SignalFamily[];
  /** Families with at least one OBSERVATION on record — can differ from familiesResolved if a
   * source was JUST resolved this same pass and its first collection hasn't landed yet. */
  familiesObserved: SignalFamily[];
  /** Families with at least one FIRED signal — distinct from familiesObserved, which only means
   * "we have data," not "something notable happened." */
  activeSignalFamilies: SignalFamily[];
  /** Earliest/latest `observed_at` across ALL observations — deliberately the RAW collection
   * timestamp, never source_timestamp-adjusted. Coverage describes how long WE have been watching,
   * not how far back the underlying facts' own history reaches (that's what backfilled
   * source_timestamp data is for, and it lives in velocity.ts's window math, not here) — conflating
   * the two would make Coverage claim "long history" the moment a backfill runs, which is exactly
   * the kind of "more observations = more momentum"-adjacent claim this module must never make. */
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  observationSpanDays: number | null;
  /** Raw observation row count. Explicitly descriptive only — see the module doc. */
  observationCount: number;
  historyClass: HistoryClass;
}

export function computeCoverage(sources: readonly SignalSource[], observations: readonly Observation[], signals: readonly DerivedSignal[]): CoverageDescriptor {
  const familiesResolved = [...new Set(sources.filter((s) => s.active).map((s) => SOURCE_TYPE_FAMILY[s.source_type]))];

  const sourceFamilyById = new Map<number, SignalFamily>();
  for (const s of sources) if (s.id !== null) sourceFamilyById.set(s.id, SOURCE_TYPE_FAMILY[s.source_type]);
  const familiesObserved = [...new Set(observations.map((o) => sourceFamilyById.get(o.signal_source_id)).filter((f): f is SignalFamily => f !== undefined))];

  const activeSignalFamilies = [...new Set(signals.map((s) => s.family))];

  let firstObservedAt: string | null = null;
  let lastObservedAt: string | null = null;
  for (const o of observations) {
    if (firstObservedAt === null || o.observed_at < firstObservedAt) firstObservedAt = o.observed_at;
    if (lastObservedAt === null || o.observed_at > lastObservedAt) lastObservedAt = o.observed_at;
  }
  const observationSpanDays = firstObservedAt !== null && lastObservedAt !== null ? (new Date(lastObservedAt).getTime() - new Date(firstObservedAt).getTime()) / 86_400_000 : null;

  // Determined by SPAN alone, never by raw observation count — this is the direct enforcement of
  // "more observations must never automatically equal more momentum/coverage-class": ten
  // observations collected in the same moment (e.g. a first pass, with or without backfill) is
  // still "early_evidence", exactly like one observation would be, because the real collection
  // span is the same (effectively zero) either way.
  let historyClass: HistoryClass;
  if (observationSpanDays === null || observationSpanDays < 1) historyClass = "early_evidence";
  else if (observationSpanDays < LONGITUDINAL_HISTORY_MIN_DAYS) historyClass = "developing_history";
  else historyClass = "longitudinal_history";

  return {
    familiesResolved,
    familiesObserved,
    activeSignalFamilies,
    firstObservedAt,
    lastObservedAt,
    observationSpanDays,
    observationCount: observations.length,
    historyClass,
  };
}
