import type { DerivedSignal, Observation, SignalFamily } from "../types.ts";
import type { WindowComparison } from "../velocity.ts";

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
