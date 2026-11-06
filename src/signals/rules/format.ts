import type { DerivedSignal, Observation, SignalFamily } from "../types.ts";
import type { WindowComparison } from "../velocity.ts";

/** The slice of an already-fired signal `alreadyReportedValue`/`pushIfNew` need — deliberately
 * narrow (not the full `DerivedSignal`) so a caller can pass the orchestrator's `existingSignals`
 * straight through with no mapping. */
export type ExistingSignalRef = Pick<DerivedSignal, "company_id" | "signal_type" | "to_value" | "fired_at">;

/**
 * True when the MOST RECENT existing signal of this exact (company, type) already reported this
 * exact `toValue` — i.e. nothing new has happened since we last told the user about it.
 *
 * Why this exists: a window-based comparison (`bestAvailableWindow`) always compares the LATEST
 * observation against the oldest one still inside the lookback window. `to` is therefore a fresh
 * observation row every single day, even when the metric's actual value hasn't moved — so the
 * (company, signal_type, to_observation_id) dedup key alone can't catch "we already reported this
 * transition," since to_observation_id is different every day by construction. Without this guard,
 * a single real transition (e.g. "contributors grew from 6 to 8") would correctly keep comparing
 * `true` for as long as the OLD baseline stays inside the window (up to the window's length, e.g.
 * 30-90 days) and re-fire on every one of those days — a real, live bug found in review, not a
 * hypothetical. The fix is narrow on purpose: once a signal type's latest reported value already
 * equals the current value, there is nothing NEW to say, so nothing fires — the moment the value
 * moves again (e.g. 8 -> 11), a fresh signal fires exactly once, same as today.
 */
export function alreadyReportedValue(existingSignals: readonly ExistingSignalRef[], companyId: number, signalType: string, toValue: number | null): boolean {
  if (toValue === null) return false;
  let latest: ExistingSignalRef | null = null;
  for (const s of existingSignals) {
    if (s.company_id !== companyId || s.signal_type !== signalType) continue;
    if (!latest || s.fired_at > latest.fired_at) latest = s;
  }
  return latest !== null && latest.to_value === toValue;
}

/** Pushes a candidate signal only if `alreadyReportedValue` doesn't already cover it — the one
 * call site every velocity-rule push in github.ts/hiring.ts goes through, so the guard can't be
 * accidentally skipped at a new call site the way a copy-pasted `if` easily could be. */
export function pushIfNew(out: Omit<DerivedSignal, "id">[], existingSignals: readonly ExistingSignalRef[], candidate: Omit<DerivedSignal, "id">): void {
  if (!alreadyReportedValue(existingSignals, candidate.company_id, candidate.signal_type, candidate.to_value)) out.push(candidate);
}

export function fmtPct(relativeChange: number): string {
  return `${relativeChange >= 0 ? "+" : ""}${Math.round(relativeChange * 100)}%`;
}

export function fmtNum(n: number | null): string {
  if (n === null) return "?";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Builds a DerivedSignal (not yet persisted — id is filled by the store on insert). */
export function makeSignal(companyId: number, family: SignalFamily, signalType: string, ruleVersion: string, cmp: WindowComparison, explanation: string, metadata: Record<string, unknown> | null = null): Omit<DerivedSignal, "id"> {
  return {
    company_id: companyId,
    family,
    signal_type: signalType,
    window_days: cmp.windowDays,
    from_observation_id: cmp.from?.id ?? null,
    to_observation_id: cmp.to.id,
    from_value: cmp.from?.numeric_value ?? null,
    to_value: cmp.to.numeric_value,
    delta: cmp.delta,
    relative_change: cmp.relativeChange,
    rule_version: ruleVersion,
    explanation,
    fired_at: new Date().toISOString(),
    metadata,
  };
}

/**
 * Builds a LEVEL DerivedSignal (V2-2B.1) — from a SINGLE observation, no comparison. There is no
 * "from": `window_days` is 0, `from_observation_id`/`from_value`/`delta`/`relative_change` are all
 * null, exactly mirroring how the existing `release_activity` signal already represents "no
 * numeric delta" (see rules/github.ts). Callers (rules/hiring.ts, rules/github.ts) are responsible
 * for the "first observation" gate and for wording `explanation` as a description of the CURRENT
 * state only ("present at first observation") — this helper does not, and cannot, know whether the
 * caller has verified that gate; see each level-signal rule's own comments. */
export function makeLevelSignal(companyId: number, family: SignalFamily, signalType: string, ruleVersion: string, observation: Observation, explanation: string, metadata: Record<string, unknown> | null = null): Omit<DerivedSignal, "id"> {
  return {
    company_id: companyId,
    family,
    signal_type: signalType,
    window_days: 0,
    from_observation_id: null,
    to_observation_id: observation.id,
    from_value: null,
    to_value: observation.numeric_value,
    delta: null,
    relative_change: null,
    rule_version: ruleVersion,
    explanation,
    fired_at: new Date().toISOString(),
    metadata,
  };
}
