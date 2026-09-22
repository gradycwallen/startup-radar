import type { DerivedSignal } from "./types.ts";

/**
 * The natural key for "this is the same fired signal": a signal derived from the exact same
 * comparison (company, type, and specifically the observation it fired FROM) is the same event,
 * not a new one. This does not require a database constraint to use — the orchestrator reads
 * existing signals once per run and filters newly-derived ones against this key before inserting,
 * which is sufficient application-level idempotency for a single serial run and avoids a schema
 * migration for a DB-level unique constraint (deferred; see the V2-2A.1 report's limitations).
 */
export function signalKey(s: Pick<DerivedSignal, "company_id" | "signal_type" | "to_observation_id">): string {
  return `${s.company_id}:${s.signal_type}:${s.to_observation_id}`;
}

export function signalKeySet(signals: readonly Pick<DerivedSignal, "company_id" | "signal_type" | "to_observation_id">[]): Set<string> {
  return new Set(signals.map(signalKey));
}
