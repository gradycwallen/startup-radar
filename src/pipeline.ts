import { BudgetRefusalError, type BudgetGuard, type CostSummary } from "./budget.ts";
import { addUsage, emptyUsage, type UsageSummary } from "./claude.ts";
import { DEFAULTS, type RunConfig } from "./config.ts";
import { RunAbortError, RunClock, ScoutTimeoutError, ShutdownError, classifyAbort, timeoutScope } from "./deadline.ts";
import { classifyCandidate, RunRegistry, type CompanyReader, type DedupeOutcome } from "./dedupe.ts";
import { DbReadTimeoutError, type RowCounts } from "./db.ts";
import { normalizeDomain, normalizeUrl } from "./domain.ts";
import { FatalApiError } from "./fatal.ts";
import type { HomepageChecker } from "./http.ts";
import { leadId, type LeadLedger, type LedgerSummary } from "./ledger.ts";
import type { Logger } from "./log.ts";
import type { DiscoveryProvider, LaneReport } from "./providers/types.ts";
import type { NormalizedCandidate, RawLead } from "./schema.ts";
import { validateCandidate } from "./validate.ts";
import type { Verifier } from "./verify.ts";

export type Reader = CompanyReader & { counts(): Promise<RowCounts> };

export interface PipelineDeps {
  provider: DiscoveryProvider;
  verifier: Verifier;
  db: Reader;
  checkHomepage: HomepageChecker;
  log: Logger;
  config: RunConfig;
  now: Date;
  /** Aborts on SIGINT/SIGTERM: in-flight Anthropic work is cancelled and nothing new starts. */
  signal: AbortSignal;
  /** Soft run deadline: past it, nothing NEW starts; in-flight work finishes under its own limits. */
  clock: RunClock;
  /** Cost ledger + hard budget guard shared by every component that talks to Anthropic. */
  budget: BudgetGuard;
  /** Audit trail of every raw lead and what became of it. */
  ledger: LeadLedger;
  /** "replay" runs use recorded snapshots only: no Anthropic, no database, no network. */
  mode?: "live" | "replay";
}

export type CandidateStatus =
  | "would_insert_company_and_event"
  | "would_insert_event_only"
  | "skipped_duplicate_event"
  | "skipped_name_collision"
  | "deferred_max_new"
  | "rejected"
  | "error"
  | "timeout" // a request/candidate deadline fired; the candidate failed
  | "aborted" // cut short by shutdown or a run-level fatal error while in flight
  | "not_started"; // never started: run soft deadline, shutdown, fatal error or budget

export type RunStatus = "completed" | "stopped_at_run_deadline" | "stopped_at_budget" | "interrupted" | "failed";

export interface TimeoutRecord {
  /** Which lane/candidate this belongs to. */
  item: string;
  kind: string;
  label: string;
  limit_ms: number;
  elapsed_ms: number;
}

export interface CandidateRecord {
  index: number;
  lead_id: string;
  lane: string;
  lead_name: string;
  lead_source_url: string;
  status: CandidateStatus;
  reasons: string[];
  confidence: number | null;
  domain: string | null;
  event_type: string | null;
  caps: string[];
  notes: string[];
  elapsed_ms: number;
  usage: UsageSummary;
  timeout?: TimeoutRecord;
  candidate?: NormalizedCandidate;
  dedupe?: DedupeOutcome;
}

export interface FatalErrorRecord {
  kind: string;
  detail: string;
  status: number | null;
  request_id: string | null;
  at: string;
}

export interface RunSummary {
  run_id: string;
  provider: string;
  mode: "live" | "replay";
  dry_run: true;
  status: RunStatus;
  /** Why the run ended early, when it did: "shutdown:SIGTERM", "fatal_api_error:insufficient_credit", "budget_ceiling", "run_soft_deadline"... */
  stop_reason: string | null;
  /** Set when insufficient credit, authentication or permission failure ended the run. */
  fatal_error: FatalErrorRecord | null;
  started_at: string;
  finished_at: string;
  run_elapsed_ms: number;
  config: RunConfig;
  leads_discovered: number;
  leads_selected: number;
  counts: Record<CandidateStatus, number>;
  rejection_reasons: Record<string, number>;
  lanes: LaneReport[];
  provider_errors: Array<{ lane: string; message: string }>;
  timeouts: TimeoutRecord[];
  usage: UsageSummary;
  /** Estimated and actual API cost, refusals, and the budget guard's final state. */
  cost: CostSummary;
  /** Where every raw lead was recorded, and how many ended in each disposition. */
  lead_ledger: LedgerSummary;
  rows_before: RowCounts;
  /** null only if the counts could not be read after the run (e.g. during shutdown). */
  rows_after: RowCounts | null;
  db_unchanged: boolean | null;
  candidates: CandidateRecord[];
}

export interface DroppedLead {
  lead: RawLead;
  reason: "duplicate_lead" | "over_verification_limit";
  /** For duplicate_lead: the lead that was kept instead. */
  duplicateOf?: RawLead;
}

/**
 * De-duplicate leads (same hinted domain, name, or source URL), balance lanes round-robin, and honor the
 * verification budget; returns what was dropped and why so the ledger can record it.
 */
export function selectLeadsDetailed(leads: RawLead[], limit: number): { selected: RawLead[]; dropped: DroppedLead[] } {
  const owner = new Map<string, RawLead>();
  const unique: RawLead[] = [];
  const dropped: DroppedLead[] = [];
  for (const lead of [...leads].sort((a, b) => Number(b.source_retrieved) - Number(a.source_retrieved))) {
    const key = normalizeDomain(lead.homepage_hint) ?? `name:${lead.name.trim().toLowerCase()}`;
    const urlKey = `url:${normalizeUrl(lead.source_url) ?? lead.source_url}`;
    const kept = owner.get(key) ?? owner.get(urlKey);
    if (kept) {
      dropped.push({ lead, reason: "duplicate_lead", duplicateOf: kept });
      continue;
    }
    owner.set(key, lead);
    owner.set(urlKey, lead);
    unique.push(lead);
  }
  const lanes = new Map<string, RawLead[]>();
  for (const lead of unique) lanes.set(lead.lane, [...(lanes.get(lead.lane) ?? []), lead]);
  const selected: RawLead[] = [];
  while (selected.length < limit && [...lanes.values()].some((q) => q.length)) {
    for (const queue of lanes.values()) {
      if (selected.length >= limit) break; // check BEFORE taking a lead: shifting first would silently lose it
      const next = queue.shift();
      if (next) selected.push(next);
    }
  }
  for (const queue of lanes.values()) for (const lead of queue) dropped.push({ lead, reason: "over_verification_limit" });
  return { selected, dropped };
}

/** Round-robin across lanes so one chatty lane can't consume the whole verification budget. */
export function selectLeads(leads: RawLead[], limit: number): RawLead[] {
  return selectLeadsDetailed(leads, limit).selected;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

interface Verified {
  lead: RawLead;
  index: number;
  record: CandidateRecord;
  candidate?: NormalizedCandidate;
}

const ms = (start: number) => Math.round(performance.now() - start);

const emptyCounts = (): Record<CandidateStatus, number> => ({
  would_insert_company_and_event: 0, would_insert_event_only: 0, skipped_duplicate_event: 0,
  skipped_name_collision: 0, deferred_max_new: 0, rejected: 0, error: 0, timeout: 0, aborted: 0, not_started: 0,
});

export async function runPipeline(deps: PipelineDeps): Promise<RunSummary> {
  const { provider, verifier, db, checkHomepage, log, config, now, signal, clock, budget, ledger } = deps;
  const startedAt = new Date().toISOString();
  let usage = emptyUsage();
  let lanes: LaneReport[] = [];
  let providerErrors: Array<{ lane: string; message: string }> = [];
  let leadsDiscovered = 0;
  let selected: RawLead[] = [];
  let verified: Verified[] = [];
  let fatal: string | null = null;
  // A fatal API error (insufficient credit, authentication, permission) stops ALL remaining Anthropic work.
  let fatalErr: FatalApiError | null = null;
  const fatalAt = () => new Date().toISOString();
  let fatalAtTs: string | null = null;
  const runAbort = new AbortController();
  const runSignal = AbortSignal.any([signal, runAbort.signal]);
  const raiseFatal = (err: FatalApiError): boolean => {
    if (fatalErr) return false; // not the origin
    fatalErr = err;
    fatalAtTs = fatalAt();
    log.error("fatal_api_error", {
      message: `${err.kind}: ${err.detail}. Aborting all remaining Anthropic work; the run will fail.`,
      kind: err.kind, status: err.status, request_id: err.requestId,
    });
    runAbort.abort(new RunAbortError(err));
    return true;
  };
  // Set once the optional pre-check read times out: the database is presumed unhealthy, so later
  // candidates skip the (optional) pre-check instead of each waiting 15 s.
  let preCheckDbDown = false;

  // Row counts must be readable, or we could not prove the run changed nothing: fail fast.
  const rowsBefore = await db.counts();
  log.info("rows_before", { message: JSON.stringify(rowsBefore), ...rowsBefore });

  try {
    // 1. Discovery (provider-agnostic, lanes serial). Leads are written to the ledger AS THEY ARE FOUND.
    const discovery = await provider.discover({
      today: now,
      recencyDays: config.recencyDays,
      leadsPerLane: config.leadsPerLane,
      lanes: config.lanes,
      laneMs: config.limits.laneMs,
      signal: runSignal,
      clock,
      log,
      onLeads: (found) => {
        ledger.recordDiscovered(found);
      },
    });
    ledger.recordDiscovered(discovery.leads); // idempotent safety net for providers that do not stream leads
    lanes = discovery.lanes;
    providerErrors = discovery.errors;
    leadsDiscovered = discovery.leads.length;
    if (discovery.usage) usage = addUsage(usage, discovery.usage);
    if (discovery.fatal) raiseFatal(discovery.fatal);
    log.info("discovery_done", {
      message: `${discovery.leads.length} raw leads, ${discovery.errors.length} lane failures`,
      lanes: lanes.map((l) => ({ lane: l.lane, status: l.status, elapsed_ms: l.elapsed_ms, leads: l.leads })),
    });

    if (!fatalErr) {
      // 2. Lead selection (dedupe leads, balance lanes, honor the verification budget)
      const choice = selectLeadsDetailed(discovery.leads, config.maxCandidates);
      selected = choice.selected;
      for (const d of choice.dropped) {
        const id = leadId(d.lead);
        if (d.reason === "duplicate_lead") {
          ledger.decide(id, "dropped_duplicate_lead", "same company as another lead in this run", { duplicate_of: d.duplicateOf ? leadId(d.duplicateOf) : null });
        } else {
          ledger.decide(id, "not_selected_verification_limit", `verification_limit:${config.maxCandidates}`);
        }
      }
      for (const lead of selected) ledger.stage(leadId(lead), "selected");

      // 3. Verification + deterministic validation, bounded concurrency, per-candidate deadline
      verified = await pool<RawLead, Verified>(selected, config.concurrency, async (lead, index) => {
        const id = leadId(lead);
        const base: CandidateRecord = {
          index, lead_id: id, lane: lead.lane, lead_name: lead.name, lead_source_url: lead.source_url,
          status: "rejected", reasons: [], confidence: null, domain: null, event_type: null,
          caps: [], notes: [], elapsed_ms: 0, usage: emptyUsage(),
        };
        const notStarted = (reason: string): Verified => {
          ledger.decide(id, "not_started", reason);
          return { lead, index, record: { ...base, status: "not_started", reasons: [reason] } };
        };

        // Nothing new starts after shutdown, a fatal API error, an exhausted budget, or the soft run deadline.
        if (signal.aborted) return notStarted("not_started:shutdown");
        if (fatalErr) return notStarted(`not_started:fatal_api_error:${(fatalErr as FatalApiError).kind}`);
        if (budget.exhausted) return notStarted("not_started:budget_exhausted");
        if (clock.softDeadlineReached()) {
          log.warn("candidate_skipped", { message: `${lead.name}: not started (run soft deadline reached)`, lead: lead.name, reason: "run_soft_deadline" });
          return notStarted("not_started:run_soft_deadline");
        }

        const started = performance.now();
        const candUsage = emptyUsage();
        const finish = (record: CandidateRecord, decide = true): Verified => {
          record.elapsed_ms = ms(started);
          record.usage = candUsage;
          usage = addUsage(usage, candUsage);
          if (decide) {
            ledger.decide(id, record.status, record.reasons.join(" | ") || null, {
              candidate_domain: record.domain, confidence: record.confidence, event_type: record.event_type,
            });
          }
          return { lead, index, record };
        };

        try {
          // Cheap, OPTIONAL pre-check: the hinted company is already known AND we already hold this exact
          // source. It only saves the cost of verification, and the authoritative de-duplication runs
          // later, so a failed or timed-out read here must not fail the candidate: log it and continue.
          const hinted = normalizeDomain(lead.homepage_hint);
          if (hinted && !preCheckDbDown) {
            try {
              const existing = await db.findCompanyByDomain(hinted);
              const leadUrl = normalizeUrl(lead.source_url);
              if (existing && leadUrl) {
                const events = await db.getEvents(existing.id);
                if (events.some((e) => normalizeUrl(e.source_url) === leadUrl)) {
                  log.info("pre_verify_duplicate", { message: `${lead.name}: source already recorded`, domain: hinted });
                  return finish({ ...base, status: "skipped_duplicate_event", domain: hinted, reasons: ["pre_verify:source_url_already_recorded"] });
                }
              }
            } catch (err) {
              if (err instanceof DbReadTimeoutError) preCheckDbDown = true;
              log.warn("pre_verify_check_skipped", {
                message: `${lead.name}: duplicate pre-check unavailable (${err instanceof Error ? err.message : String(err)}); continuing to verification`,
                lead: lead.name,
              });
            }
          }

          // The candidate deadline covers verification only (its requests, continuations and repair).
          ledger.stage(id, "verification_started");
          const scope = timeoutScope("candidate", lead.name, config.limits.candidateMs, runSignal);
          let out;
          try {
            out = await verifier.verify(lead, { signal: scope.signal, usage: candUsage, log });
          } catch (raw) {
            throw classifyAbort(raw, scope.signal);
          } finally {
            scope.cancel();
          }
          ledger.stage(id, "verified");
          const result = await validateCandidate(out.verification, out.retrievedUrls, {
            now,
            minConfidence: config.minConfidence,
            maxEventAgeDays: config.maxEventAgeDays,
            preferredFoundedYear: DEFAULTS.preferredFoundedYear,
            checkHomepage,
            signal: runSignal,
          });
          if (!result.ok) {
            const record: CandidateRecord = {
              ...base, status: "rejected", reasons: result.reasons, confidence: result.confidence,
              domain: normalizeDomain(out.verification.canonical_url), event_type: out.verification.event_type,
              caps: result.caps, notes: result.notes,
            };
            const v = finish(record);
            log.info("candidate_rejected", { message: `${lead.name}: ${result.reasons.join(", ")}`, ...v.record });
            return v;
          }
          const record: CandidateRecord = {
            ...base, status: "would_insert_company_and_event", confidence: result.confidence,
            domain: result.candidate.company.domain, event_type: result.candidate.event.event_type,
            caps: result.caps, notes: result.notes, candidate: result.candidate,
          };
          const v = finish(record, false); // the final disposition is decided after de-duplication
          ledger.stage(id, "validated", { candidate_domain: record.domain, confidence: record.confidence, event_type: record.event_type });
          log.info("candidate_validated", { message: `${lead.name} -> ${record.domain} (${record.elapsed_ms}ms)`, ...v.record });
          return { ...v, candidate: result.candidate };
        } catch (err) {
          if (err instanceof FatalApiError) {
            const origin = raiseFatal(err);
            const v = finish({ ...base, status: origin ? "error" : "aborted", reasons: [`${origin ? "" : "aborted:"}fatal_api_error:${err.kind}`] });
            log.warn("candidate_failed", { message: `${lead.name}: fatal API error (${err.kind})`, ...v.record });
            return v;
          }
          if (err instanceof RunAbortError) {
            const kind = err.reason instanceof FatalApiError ? err.reason.kind : "unknown";
            const v = finish({ ...base, status: "aborted", reasons: [`aborted:fatal_api_error:${kind}`] });
            log.warn("candidate_failed", { message: `${lead.name}: aborted after a fatal API error elsewhere in the run`, ...v.record });
            return v;
          }
          if (err instanceof BudgetRefusalError) {
            // Nothing was sent for the refused request. If this candidate never reached the API it simply did not start.
            const untouched = candUsage.apiCalls === 0;
            const v = finish({ ...base, status: untouched ? "not_started" : "error", reasons: [`budget_refused:${err.label}`] });
            log.warn("candidate_failed", { message: `${lead.name}: ${err.message}`, ...v.record });
            return v;
          }
          if (err instanceof ScoutTimeoutError) {
            const timeout: TimeoutRecord = { item: lead.name, kind: err.kind, label: err.label, limit_ms: err.limitMs, elapsed_ms: err.elapsedMs };
            const v = finish({ ...base, status: "timeout", reasons: [`timeout:${err.kind}:${err.label}`], timeout });
            log.warn("candidate_failed", { message: `${lead.name}: ${err.message}`, ...v.record });
            return v;
          }
          if (err instanceof ShutdownError) {
            const v = finish({ ...base, status: "aborted", reasons: [`aborted:${err.signalName}`] });
            log.warn("candidate_failed", { message: `${lead.name}: aborted by shutdown after ${v.record.elapsed_ms}ms`, ...v.record });
            return v;
          }
          const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          const v = finish({ ...base, status: "error", reasons: [message] });
          log.warn("candidate_failed", { message: `${lead.name}: ${message}`, ...v.record });
          return v;
        }
      });
    }

    // 4. De-duplication against Supabase (reads only) + within the run; enforce --max-new.
    // Cheap, so it still runs after a shutdown or fatal error to keep the partial summary accurate.
    const registry = new RunRegistry();
    let newCompanies = 0;
    // The dedupe stage gets its own fresh attempt (the database may have recovered since the pre-check).
    // After ITS first read timeout, the remaining candidates fail fast instead of each waiting 15 s; this
    // also keeps graceful shutdown from waiting on a stuck database.
    let dedupeDbDown = false;
    const validated = verified
      .filter((v) => v.candidate)
      .sort((a, b) => (b.record.confidence ?? 0) - (a.record.confidence ?? 0) || a.index - b.index);

    for (const v of validated) {
      const c = v.candidate!;
      const decide = () => {
        ledger.stage(v.record.lead_id, "deduped");
        ledger.decide(v.record.lead_id, v.record.status, v.record.reasons.join(" | ") || null, {
          candidate_domain: v.record.domain, confidence: v.record.confidence, event_type: v.record.event_type,
        });
      };
      // De-duplication is REQUIRED for correctness: a candidate whose duplicate status is unknown
      // must never be treated as new. After one read timeout, the rest fail fast instead of each waiting 15 s.
      if (dedupeDbDown) {
        v.record.status = "error";
        v.record.reasons.push("dedupe_skipped:db_read_timed_out");
        log.warn("dedupe_skipped", { message: `${c.company.name}: not de-duplicated (an earlier database read timed out)`, index: v.record.index });
        decide();
        continue;
      }
      try {
        const outcome = await classifyCandidate(c, db, registry);
        v.record.dedupe = outcome;
        switch (outcome.kind) {
          case "new_company":
            if (newCompanies >= config.maxNew) {
              v.record.status = "deferred_max_new";
              v.record.reasons.push(`max_new_reached:${config.maxNew}`);
            } else {
              newCompanies++;
              v.record.status = "would_insert_company_and_event";
              registry.record(c);
            }
            break;
          case "existing_company_new_event":
          case "same_run_new_event":
            v.record.status = "would_insert_event_only";
            registry.record(c);
            break;
          case "duplicate_event":
            v.record.status = "skipped_duplicate_event";
            v.record.reasons.push(`${outcome.reason}:${outcome.matched}`);
            break;
          case "name_collision":
            v.record.status = "skipped_name_collision";
            v.record.reasons.push(`same_name_as_existing:${outcome.companies.map((x) => x.domain).join(",")}`);
            break;
        }
      } catch (err) {
        if (err instanceof DbReadTimeoutError) dedupeDbDown = true;
        v.record.status = "error";
        v.record.reasons.push(`dedupe_failed:${err instanceof Error ? err.message : String(err)}`);
      }
      decide();
      log.info("candidate_decided", { message: `${c.company.name}: ${v.record.status}`, index: v.record.index, status: v.record.status, dedupe: v.record.dedupe?.kind });
    }
  } catch (err) {
    fatal = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log.error("run_failed", { message: fatal });
  }

  // 5. Prove nothing changed. Best effort: a shutdown or fatal error must still yield a summary.
  let rowsAfter: RowCounts | null = null;
  let dbUnchanged: boolean | null = null;
  try {
    rowsAfter = await db.counts();
    dbUnchanged = rowsBefore.companies === rowsAfter.companies && rowsBefore.discovery_events === rowsAfter.discovery_events;
    log.info("rows_after", { message: JSON.stringify(rowsAfter), ...rowsAfter, db_unchanged: dbUnchanged });
    if (!dbUnchanged) log.error("db_changed_during_dry_run", { message: "row counts differ before/after" });
  } catch (err) {
    log.error("rows_after_unavailable", { message: err instanceof Error ? err.message : String(err) });
  }

  const records = verified.map((v) => v.record).sort((a, b) => a.index - b.index);
  const counts = emptyCounts();
  const rejectionReasons: Record<string, number> = {};
  const timeouts: TimeoutRecord[] = [];
  for (const l of lanes) {
    if (l.timeout) timeouts.push({ item: `lane:${l.lane}`, ...l.timeout });
  }
  for (const r of records) {
    counts[r.status]++;
    if (r.timeout) timeouts.push(r.timeout);
    if (r.status === "rejected") for (const reason of r.reasons) {
      const key = reason.split(":")[0] ?? reason;
      rejectionReasons[key] = (rejectionReasons[key] ?? 0) + 1;
    }
  }

  const fe = fatalErr as FatalApiError | null;
  let status: RunStatus = "completed";
  let stopReason: string | null = null;
  if (signal.aborted) {
    status = "interrupted";
    const reason: unknown = signal.reason;
    stopReason = reason instanceof ShutdownError ? `shutdown:${reason.signalName}` : "shutdown";
  } else if (fe) {
    status = "failed";
    stopReason = `fatal_api_error:${fe.kind}`;
  } else if (fatal) {
    status = "failed";
    stopReason = fatal;
  } else if (budget.exhausted) {
    status = "stopped_at_budget";
    stopReason = "budget_ceiling";
  } else if (
    lanes.some((l) => l.status === "skipped_run_deadline") ||
    records.some((r) => r.reasons.includes("not_started:run_soft_deadline"))
  ) {
    status = "stopped_at_run_deadline";
    stopReason = "run_soft_deadline";
  }

  // Every raw lead must end with a disposition, even when the run stopped early.
  ledger.finalizeOpen(`run_ended:${stopReason ?? status}`);
  ledger.close();
  budget.close();

  return {
    run_id: log.runId, provider: provider.name, mode: deps.mode ?? "live", dry_run: true, status, stop_reason: stopReason,
    fatal_error: fe ? { kind: fe.kind, detail: fe.detail, status: fe.status, request_id: fe.requestId, at: fatalAtTs ?? fatalAt() } : null,
    started_at: startedAt, finished_at: new Date().toISOString(), run_elapsed_ms: clock.elapsedMs(), config,
    leads_discovered: leadsDiscovered, leads_selected: selected.length,
    counts, rejection_reasons: rejectionReasons, lanes, provider_errors: providerErrors, timeouts,
    usage, cost: budget.snapshot(), lead_ledger: ledger.summary(),
    rows_before: rowsBefore, rows_after: rowsAfter, db_unchanged: dbUnchanged, candidates: records,
  };
}
