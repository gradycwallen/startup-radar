import type { Logger } from "../log.ts";
import type { Fetcher } from "../sources/fetcher.ts";
import { signalKeySet } from "./dedup.ts";
import { isFresh } from "./freshness.ts";
import { collectForSource, deriveSignalsForCompany } from "./observe.ts";
import { resolveCompanySources } from "./resolution.ts";
import type { CompanyContext, DerivedSignal, Observation, SignalSource } from "./types.ts";

/**
 * The operational orchestrator (V2-2A.1). Pure logic, no CLI/argv/env concerns — those live in
 * src/signals-main.ts. This module ONLY calls the existing V2-2A building blocks
 * (resolution.ts, observe.ts, freshness.ts, dedup.ts) — it derives nothing itself and adds no new
 * signal logic; it decides WHEN to call them and how to record what happened.
 */

/** The exact subset of SignalStore this module needs — lets tests use a simple in-memory fake
 * instead of a real (or fetch-mocked) Supabase client. `SignalStore` satisfies this structurally. */
export interface SignalDataAccess {
  getActiveSourcesForCompanies(companyIds: readonly number[]): Promise<SignalSource[]>;
  getObservationHistoryForCompanies(companyIds: readonly number[]): Promise<Observation[]>;
  getSignalsForCompanies(companyIds: readonly number[]): Promise<DerivedSignal[]>;
  upsertSignalSource(source: Omit<SignalSource, "id">): Promise<SignalSource>;
  insertObservations(observations: readonly Omit<Observation, "id">[]): Promise<Observation[]>;
  insertSignals(signals: readonly Omit<DerivedSignal, "id">[]): Promise<DerivedSignal[]>;
}

export type SourceOutcome = "collected" | "skipped_fresh" | "failed";

export interface SourceRunResult {
  source_type: string;
  external_id: string;
  outcome: SourceOutcome;
  observations_inserted: number;
  metrics_observed: string[];
  error?: string;
}

export type ResolutionOutcome = "not_attempted" | "resolved_new" | "unresolved" | "no_supported_source" | "failed";

export interface CompanyRunResult {
  company_id: number;
  company_name: string;
  resolution: ResolutionOutcome;
  newly_resolved: Array<{ source_type: string; external_id: string; resolution_method: string }>;
  sources: SourceRunResult[];
  signals_fired: Array<{ signal_type: string; explanation: string }>;
  error?: string;
}

export interface RunSummary {
  as_of: string;
  dry_run: boolean;
  force: boolean;
  freshness_hours: number;
  companies_considered: number;
  resolution: { attempted: number; resolved_new_sources: number; unresolved: number; no_supported_source: number; failed: number };
  collection: { collected: number; skipped_fresh: number; failed: number };
  observations_inserted: number;
  signals_fired: number;
  companies: CompanyRunResult[];
  elapsed_ms: number;
}

export interface OrchestrateDeps {
  fetcher: Fetcher;
  store: SignalDataAccess;
  now?: () => Date;
  githubToken?: string;
  log?: Logger;
  /** Cooperative shutdown — checked between companies; an in-flight company still finishes. */
  signal?: AbortSignal;
}

export interface OrchestrateOptions {
  dryRun: boolean;
  force: boolean;
  freshnessHours?: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs one observation pass over the given companies. Serial by design (see the V2-2A.1 report —
 * at this scale, reliability and correctness matter more than speed, and PoliteFetcher already
 * paces per host regardless). One company's failure never stops the rest; one source's failure
 * never stops the company's other sources.
 */
export async function runObservationPass(companies: readonly CompanyContext[], deps: OrchestrateDeps, options: OrchestrateOptions): Promise<RunSummary> {
  const started = Date.now();
  const now = deps.now ?? (() => new Date());
  const freshnessHours = options.freshnessHours ?? 22;
  const log = deps.log;

  const companyIds = companies.map((c) => c.id);
  const [existingSources, existingHistory, existingSignals] = await Promise.all([
    deps.store.getActiveSourcesForCompanies(companyIds),
    deps.store.getObservationHistoryForCompanies(companyIds),
    deps.store.getSignalsForCompanies(companyIds),
  ]);
  const knownSignalKeys = signalKeySet(existingSignals);
  const sourcesByCompany = new Map<number, SignalSource[]>();
  for (const s of existingSources) sourcesByCompany.set(s.company_id, [...(sourcesByCompany.get(s.company_id) ?? []), s]);

  const results: CompanyRunResult[] = [];
  const counts = {
    resolutionAttempted: 0, resolvedNewSources: 0, unresolved: 0, noSupportedSource: 0, resolutionFailed: 0,
    collected: 0, skippedFresh: 0, collectionFailed: 0, observationsInserted: 0, signalsFired: 0,
  };

  for (const company of companies) {
    if (deps.signal?.aborted) {
      log?.warn("observation_pass_aborted", { message: `shutdown requested — stopping before ${company.name}`, company_id: company.id });
      break;
    }

    const result: CompanyRunResult = { company_id: company.id, company_name: company.name, resolution: "not_attempted", newly_resolved: [], sources: [], signals_fired: [] };
    try {
      let sources = sourcesByCompany.get(company.id) ?? [];

      // A. attempt resolution only for companies that have NO active source yet.
      if (sources.length === 0) {
        counts.resolutionAttempted++;
        const resolution = await resolveCompanySources(company, deps.fetcher, deps.signal);
        if (resolution.resolved.length > 0) {
          result.resolution = "resolved_new";
          counts.resolvedNewSources += resolution.resolved.length;
          const persisted: SignalSource[] = [];
          for (const candidate of resolution.resolved) {
            result.newly_resolved.push({ source_type: candidate.source_type, external_id: candidate.external_id, resolution_method: candidate.resolution_method });
            if (!options.dryRun) persisted.push(await deps.store.upsertSignalSource(candidate));
            else persisted.push({ id: null, ...candidate }); // dry-run: simulate for this run's collection step only, never written
          }
          sources = persisted;
        } else if (resolution.unresolved.length > 0) {
          result.resolution = "unresolved";
          counts.unresolved++;
        } else {
          result.resolution = "no_supported_source";
          counts.noSupportedSource++;
        }
      }

      // B/C. collect from resolved sources (existing or just-resolved), respecting freshness; derive signals from ALL history.
      let companyHistory = existingHistory.filter((o) => o.company_id === company.id);
      for (const source of sources) {
        const sourceId = source.id;
        if (sourceId !== null && isFresh(companyHistory, sourceId, now(), options.force, freshnessHours)) {
          result.sources.push({ source_type: source.source_type, external_id: source.external_id, outcome: "skipped_fresh", observations_inserted: 0, metrics_observed: [] });
          counts.skippedFresh++;
          continue;
        }
        try {
          const collected = await collectForSource(source, deps.fetcher, { githubToken: deps.githubToken, now });
          let written: Observation[];
          if (!options.dryRun) written = await deps.store.insertObservations(collected);
          else written = collected; // dry-run: never persisted, but still used below to preview what signals WOULD derive
          companyHistory = companyHistory.concat(written);
          result.sources.push({ source_type: source.source_type, external_id: source.external_id, outcome: "collected", observations_inserted: written.length, metrics_observed: written.map((o) => o.metric_name) });
          counts.collected++;
          counts.observationsInserted += options.dryRun ? 0 : written.length;
        } catch (err) {
          result.sources.push({ source_type: source.source_type, external_id: source.external_id, outcome: "failed", observations_inserted: 0, metrics_observed: [], error: errMessage(err) });
          counts.collectionFailed++;
          log?.warn("source_collection_failed", { message: `${company.name} / ${source.source_type}:${source.external_id}: ${errMessage(err)}`, company_id: company.id, source_type: source.source_type, external_id: source.external_id });
        }
      }

      // Derive signals from the full (existing + newly collected) history, deterministic rules only.
      const derived = deriveSignalsForCompany(company.id, companyHistory);
      const newSignals = derived.filter((s) => !knownSignalKeys.has(`${s.company_id}:${s.signal_type}:${s.to_observation_id}`));
      if (newSignals.length > 0) {
        if (!options.dryRun) await deps.store.insertSignals(newSignals);
        for (const s of newSignals) result.signals_fired.push({ signal_type: s.signal_type, explanation: s.explanation });
        counts.signalsFired += newSignals.length;
      }
    } catch (err) {
      result.error = errMessage(err);
      log?.error("company_run_failed", { message: `${company.name}: ${errMessage(err)}`, company_id: company.id });
    }
    results.push(result);
  }

  return {
    as_of: now().toISOString(), dry_run: options.dryRun, force: options.force, freshness_hours: freshnessHours, companies_considered: companies.length,
    resolution: { attempted: counts.resolutionAttempted, resolved_new_sources: counts.resolvedNewSources, unresolved: counts.unresolved, no_supported_source: counts.noSupportedSource, failed: counts.resolutionFailed },
    collection: { collected: counts.collected, skipped_fresh: counts.skippedFresh, failed: counts.collectionFailed },
    observations_inserted: counts.observationsInserted, signals_fired: counts.signalsFired, companies: results, elapsed_ms: Date.now() - started,
  };
}
