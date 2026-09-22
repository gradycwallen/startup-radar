import type { FunnelResult } from "../funnel/funnel.ts";
import type { RankedEntity } from "../funnel/rank.ts";
import { evaluateCandidate, type CompanyInsert, type EventInsert } from "./accept.ts";
import { DISCOVERY_LIMITS } from "./limits.ts";

/**
 * V2-1.1 discovery orchestration: takes an ALREADY-COMPUTED FunnelResult (the CLI runs the
 * existing, unmodified `runFunnel()` and hands the result here) and decides what to persist. No
 * discovery/ranking logic lives here — only the accept/cap/persist policy layer, exactly
 * mirroring how src/signals/orchestrate.ts is a thin policy layer over the existing V2-2A
 * collectors rather than a reimplementation of them.
 */

/** The exact subset of DiscoveryStore this module needs — lets tests use a simple in-memory fake
 * instead of a real (or fetch-mocked) Supabase client. DiscoveryStore satisfies this structurally. */
export interface DiscoveryDataAccess {
  insertCompany(company: CompanyInsert): Promise<{ inserted: { id: number; name: string; domain: string } } | { conflict: true }>;
  upsertEvents(companyId: number, events: readonly EventInsert[]): Promise<{ inserted: number; skipped_duplicate: number }>;
  companyExistsByDomain(domain: string): Promise<boolean>;
}

export type CandidateOutcome =
  | "inserted"
  | "would_insert" // dry-run only — mirrors Phase 1's own "would_insert_company_and_event" convention; never used for a real write
  | "skipped_existing"
  | "deferred_candidate_cap"
  | "deferred_write_cap"
  | "unresolved_domain"
  | "not_finalist"
  | "failed";

export interface CandidateResult {
  entity_id: string;
  name: string;
  domain: string | null;
  track: "news" | "directory";
  score: number;
  outcome: CandidateOutcome;
  company_id?: number;
  discovery_reason?: string;
  events_inserted?: number;
  events_skipped_duplicate?: number;
  error?: string;
}

export interface DiscoveryRunSummary {
  as_of: string;
  dry_run: boolean;
  finalists_considered: number;
  candidates: CandidateResult[];
  new_companies_inserted: number;
  existing_companies_skipped: number;
  events_inserted: number;
  events_skipped_duplicate: number;
  failed_writes: number;
  deferred_candidate_cap: number;
  deferred_write_cap: number;
  unresolved_domain_count: number;
  elapsed_ms: number;
}

export interface OrchestrateOptions {
  dryRun: boolean;
  /** Overrides DISCOVERY_LIMITS.maxNewCompaniesPerRun — may only LOWER it, never raise it. */
  maxNewCompanies?: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runDiscoveryPass(funnelResult: FunnelResult, store: DiscoveryDataAccess, options: OrchestrateOptions): Promise<DiscoveryRunSummary> {
  const started = Date.now();
  const maxNewCompanies = Math.min(options.maxNewCompanies ?? DISCOVERY_LIMITS.maxNewCompaniesPerRun, DISCOVERY_LIMITS.maxNewCompaniesPerRun);

  // Every finalist from BOTH tracks, evaluated for visibility (an unresolved-domain finalist still
  // appears in the report — "candidate may appear in logs/report, must NOT be inserted") — sorted
  // by score so the highest-value candidates get first claim on the write cap.
  const allFinalists: RankedEntity[] = [...funnelResult.finalists, ...funnelResult.directory_finalists].sort((a, b) => b.score - a.score);

  const candidates: CandidateResult[] = [];
  let newCompaniesInserted = 0;
  let existingCompaniesSkipped = 0;
  let eventsInserted = 0;
  let eventsSkippedDuplicate = 0;
  let failedWrites = 0;
  let deferredCandidateCap = 0;
  let deferredWriteCap = 0;
  let unresolvedDomainCount = 0;
  let acceptedSoFar = 0;

  for (const r of allFinalists) {
    const evaluation = evaluateCandidate(r);
    if ("rejected" in evaluation) {
      if (evaluation.rejected === "unresolved_domain") unresolvedDomainCount++;
      candidates.push({ entity_id: r.entity.entity_id, name: r.entity.name, domain: r.entity.domain.domain, track: r.track, score: r.score, outcome: evaluation.rejected });
      continue;
    }
    const candidate = evaluation.accepted;

    if (acceptedSoFar >= DISCOVERY_LIMITS.maxAcceptedCandidates) {
      deferredCandidateCap++;
      candidates.push({ entity_id: candidate.entity_id, name: candidate.name, domain: candidate.domain, track: candidate.track, score: candidate.score, outcome: "deferred_candidate_cap" });
      continue;
    }
    acceptedSoFar++;

    if (newCompaniesInserted >= maxNewCompanies) {
      deferredWriteCap++;
      candidates.push({ entity_id: candidate.entity_id, name: candidate.name, domain: candidate.domain, track: candidate.track, score: candidate.score, outcome: "deferred_write_cap" });
      continue;
    }

    if (options.dryRun) {
      // Preview only: report exactly what WOULD be written, touch nothing. Counted against the
      // cap (so the preview reflects what a live run would actually do) but never labeled
      // "inserted" — that word is reserved for a real write.
      newCompaniesInserted++;
      eventsInserted += candidate.events.length;
      candidates.push({
        entity_id: candidate.entity_id, name: candidate.name, domain: candidate.domain, track: candidate.track, score: candidate.score,
        outcome: "would_insert", discovery_reason: candidate.company.discovery_reason, events_inserted: candidate.events.length, events_skipped_duplicate: 0,
      });
      continue;
    }

    try {
      // Defensive pre-check (§17): the ExistingIndex the funnel used was a snapshot at run start;
      // this re-verifies against the live table immediately before the write. The database's own
      // UNIQUE(domain) constraint is still the authoritative guarantee (see insertCompany) — this
      // is a cheap extra layer, not a substitute for it.
      if (await store.companyExistsByDomain(candidate.domain)) {
        existingCompaniesSkipped++;
        candidates.push({ entity_id: candidate.entity_id, name: candidate.name, domain: candidate.domain, track: candidate.track, score: candidate.score, outcome: "skipped_existing" });
        continue;
      }

      const result = await store.insertCompany(candidate.company);
      if ("conflict" in result) {
        existingCompaniesSkipped++;
        candidates.push({ entity_id: candidate.entity_id, name: candidate.name, domain: candidate.domain, track: candidate.track, score: candidate.score, outcome: "skipped_existing" });
        continue;
      }

      newCompaniesInserted++;
      const eventsToWrite = candidate.events.slice(0, DISCOVERY_LIMITS.maxNewEventsPerRun - eventsInserted);
      const eventResult = eventsToWrite.length > 0 ? await store.upsertEvents(result.inserted.id, eventsToWrite) : { inserted: 0, skipped_duplicate: 0 };
      eventsInserted += eventResult.inserted;
      eventsSkippedDuplicate += eventResult.skipped_duplicate;

      candidates.push({
        entity_id: candidate.entity_id, name: candidate.name, domain: candidate.domain, track: candidate.track, score: candidate.score,
        outcome: "inserted", company_id: result.inserted.id, discovery_reason: candidate.company.discovery_reason,
        events_inserted: eventResult.inserted, events_skipped_duplicate: eventResult.skipped_duplicate,
      });
    } catch (err) {
      failedWrites++;
      candidates.push({ entity_id: candidate.entity_id, name: candidate.name, domain: candidate.domain, track: candidate.track, score: candidate.score, outcome: "failed", error: errMessage(err) });
    }
  }

  return {
    as_of: funnelResult.as_of, dry_run: options.dryRun, finalists_considered: allFinalists.length, candidates,
    new_companies_inserted: newCompaniesInserted, existing_companies_skipped: existingCompaniesSkipped,
    events_inserted: eventsInserted, events_skipped_duplicate: eventsSkippedDuplicate, failed_writes: failedWrites,
    deferred_candidate_cap: deferredCandidateCap, deferred_write_cap: deferredWriteCap, unresolved_domain_count: unresolvedDomainCount,
    elapsed_ms: Date.now() - started,
  };
}
