import type { DerivedSignal, SignalFamily } from "../types.ts";
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
