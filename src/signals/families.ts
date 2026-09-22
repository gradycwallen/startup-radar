import type { DerivedSignal, SignalFamily } from "./types.ts";

/**
 * V2-2B.1: the multi-family FOUNDATION — the pieces a future multi-family momentum computation
 * would read from. Deliberately stops short of combining these into any score: per the V2-2B
 * design report and the approved scope, "do not build a final multi-family momentum score yet."
 *
 * The one rule every function here exists to enforce: FIVE signals from ONE family must never look
 * like five independent families. Everything below counts DISTINCT families, never raw signal
 * count — the direct fix for source-richness bias (a GitHub-heavy company's many GitHub signals
 * must not outweigh a company with one hiring signal and one GitHub signal).
 */

export interface FamilyActivity {
  family: SignalFamily;
  signalCount: number;
  distinctSignalTypes: number;
  firstFiredAt: string;
  lastFiredAt: string;
}

/** Groups fired signals by family — answers "which families, how much (and how varied) within
 * each, and when did each first/last fire." One entry per family that has fired at least once. */
export function summarizeFamilyActivity(signals: readonly DerivedSignal[]): FamilyActivity[] {
  const byFamily = new Map<SignalFamily, DerivedSignal[]>();
  for (const s of signals) byFamily.set(s.family, [...(byFamily.get(s.family) ?? []), s]);

  return [...byFamily.entries()].map(([family, group]) => {
    const firedTimes = group.map((s) => s.fired_at).sort();
    return {
      family,
      signalCount: group.length,
      distinctSignalTypes: new Set(group.map((s) => s.signal_type)).size,
      firstFiredAt: firedTimes[0]!,
      lastFiredAt: firedTimes[firedTimes.length - 1]!,
    };
  });
}

/** Distinct families with at least one signal fired within `windowDays` of `now` — the actual
 * answer to "how many INDEPENDENT signal families are active right now." Counting DISTINCT
 * families here (a Set), never total signal count, is what makes five GitHub signals count as ONE
 * family, exactly like one GitHub signal would. */
export function activeFamiliesWithinWindow(signals: readonly DerivedSignal[], windowDays: number, now: Date): SignalFamily[] {
  const cutoffMs = now.getTime() - windowDays * 86_400_000;
  const families = new Set<SignalFamily>();
  for (const s of signals) {
    if (new Date(s.fired_at).getTime() >= cutoffMs) families.add(s.family);
  }
  return [...families];
}

/** Whether 2+ independent families are active within the window — the concrete, checkable form of
 * "multiple independent signal families activating close together" (V2-2B design report §10),
 * without yet deciding how much that should be worth. */
export function areFamiliesClustered(signals: readonly DerivedSignal[], windowDays: number, now: Date): boolean {
  return activeFamiliesWithinWindow(signals, windowDays, now).length >= 2;
}
