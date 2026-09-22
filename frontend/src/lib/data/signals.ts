import "server-only";
import { cache } from "react";
import { getServerSupabaseClient } from "../supabase/server-client";
import type { DerivedSignal, SignalIntelligence, SignalObservation, SignalSource } from "./types";

/**
 * V2-3A — the frontend's ONLY data-access module for Signal Intelligence
 * (public.signal_sources / observations / signals). Same posture as src/lib/data/companies.ts:
 * READ-ONLY (`.select()` only), server-only, and it degrades to an EMPTY result (never mock/
 * fabricated signal data) when Supabase isn't configured or a read fails — there is no meaningful
 * "sample" signal dataset to fall back to, and inventing one would risk being mistaken for real
 * backend intelligence. An empty result renders the same "tracking hasn't started" empty state a
 * real company with zero sources would show, which is the honest outcome either way.
 *
 * Scoped to ONE company (`.eq("company_id", id)`) rather than reusing the "fetch everything, filter
 * in memory" shortcut `companies.ts` uses for `discovery_events` — that shortcut only exists there
 * because the full company list is already loaded for the Radar feed; Company Detail's Signal
 * Intelligence has no equivalent whole-list caller, so a company-scoped read is both simpler and
 * cheaper. All three tables are read in one parallel `Promise.all`, matching the existing pattern.
 */

interface SignalSourceRow {
  id: number;
  company_id: number;
  source_type: string;
  external_id: string;
  canonical_url: string | null;
  resolution_method: string;
  active: boolean;
}

interface ObservationRow {
  id: number;
  company_id: number;
  signal_source_id: number;
  metric_name: string;
  numeric_value: number | null;
  text_value: string | null;
  observed_at: string;
  collection_version: string;
  metadata: Record<string, unknown> | null;
}

interface SignalRow {
  id: number;
  company_id: number;
  family: string;
  signal_type: string;
  window_days: number;
  from_observation_id: number | null;
  to_observation_id: number | null;
  from_value: number | null;
  to_value: number | null;
  delta: number | null;
  relative_change: number | null;
  explanation: string;
  fired_at: string;
  metadata: Record<string, unknown> | null;
}

function mapSource(row: SignalSourceRow): SignalSource {
  return { id: row.id, companyId: row.company_id, sourceType: row.source_type, externalId: row.external_id, canonicalUrl: row.canonical_url, resolutionMethod: row.resolution_method, active: row.active };
}

function mapObservation(row: ObservationRow): SignalObservation {
  return { id: row.id, companyId: row.company_id, signalSourceId: row.signal_source_id, metricName: row.metric_name, numericValue: row.numeric_value, textValue: row.text_value, observedAt: row.observed_at, collectionVersion: row.collection_version, metadata: row.metadata };
}

function mapSignal(row: SignalRow): DerivedSignal {
  return {
    id: row.id, companyId: row.company_id, family: row.family, signalType: row.signal_type, windowDays: row.window_days,
    fromObservationId: row.from_observation_id, toObservationId: row.to_observation_id, fromValue: row.from_value, toValue: row.to_value,
    delta: row.delta, relativeChange: row.relative_change, explanation: row.explanation, firedAt: row.fired_at, metadata: row.metadata,
  };
}

const EMPTY: SignalIntelligence = { sources: [], observations: [], signals: [] };

/** All Signal Intelligence Scout has for ONE company — active sources, every observation, every
 * derived signal. Memoized per request (React `cache`), same as `getAllCompaniesWithEvents`, so a
 * page and any nested component can both call this without a duplicate read. */
export const getSignalIntelligenceForCompany = cache(async (companyId: number): Promise<SignalIntelligence> => {
  const client = getServerSupabaseClient();
  if (!client) return EMPTY;

  const [sourcesRes, observationsRes, signalsRes] = await Promise.all([
    client.from("signal_sources").select("id, company_id, source_type, external_id, canonical_url, resolution_method, active").eq("company_id", companyId).eq("active", true),
    client.from("observations").select("id, company_id, signal_source_id, metric_name, numeric_value, text_value, observed_at, collection_version, metadata").eq("company_id", companyId),
    client.from("signals").select("id, company_id, family, signal_type, window_days, from_observation_id, to_observation_id, from_value, to_value, delta, relative_change, explanation, fired_at, metadata").eq("company_id", companyId),
  ]);

  if (sourcesRes.error || observationsRes.error || signalsRes.error) {
    console.error("[data/signals] Supabase read failed, returning empty Signal Intelligence:", sourcesRes.error ?? observationsRes.error ?? signalsRes.error);
    return EMPTY;
  }

  return {
    sources: ((sourcesRes.data ?? []) as SignalSourceRow[]).map(mapSource),
    observations: ((observationsRes.data ?? []) as ObservationRow[]).map(mapObservation),
    signals: ((signalsRes.data ?? []) as SignalRow[]).map(mapSignal),
  };
});
