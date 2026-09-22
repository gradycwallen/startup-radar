import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { hash } from "node:crypto";
import { join } from "node:path";
import { normalizeDomain, normalizeUrl } from "./domain.ts";
import { noRedaction, type Redactor } from "./redact.ts";
import type { RawLead } from "./schema.ts";

/**
 * The raw-lead ledger: an audit trail with ONE record per raw lead, written the moment a lane
 * finishes (before selection, dedupe or verification) and updated as the lead moves through the
 * pipeline, so that a crash or kill still leaves every discovered lead on disk.
 *
 * Files (local, per run; the database is not involved):
 *   <run>.leads.jsonl  append-only event stream ("discovered" then "change" lines)
 *   <run>.leads.json   consolidated final state, written by close()
 */

export type LeadStage = "discovered" | "selected" | "verification_started" | "verified" | "validated" | "deduped" | "decided";

/** Dispositions reuse the candidate statuses, plus the lead-level ones below. */
export type LeadDisposition =
  | "dropped_duplicate_lead" // same company already present among this run's leads
  | "not_selected_verification_limit" // beyond the verification budget
  | "not_processed" // the run ended before this lead was decided
  | string; // candidate statuses: would_insert_company_and_event, rejected, error, timeout, ...

export interface LeadRecord {
  lead_id: string;
  provider: string;
  lane: string;
  name: string;
  title: string | null;
  source_url: string;
  source_name: string | null;
  homepage_hint: string | null;
  domain_hint: string | null;
  event_type_hint: string | null;
  event_date: string | null;
  snippet: string | null;
  source_retrieved: boolean;
  discovered_at: string;
  stage_reached: LeadStage;
  /** null until decided (or until finalizeOpen at the end of the run). */
  disposition: LeadDisposition | null;
  drop_reason: string | null;
  duplicate_of: string | null;
  selected_at: string | null;
  verification_started_at: string | null;
  decided_at: string | null;
  candidate_domain: string | null;
  confidence: number | null;
  event_type: string | null;
}

/** Stable identifier: the same lead (provider + source + name) always gets the same id. */
export function leadId(lead: Pick<RawLead, "provider" | "lane" | "source_url" | "name">): string {
  const key = `${lead.provider}|${lead.lane}|${normalizeUrl(lead.source_url) ?? lead.source_url}|${lead.name.trim().toLowerCase()}`;
  return hash("sha1", key, "hex").slice(0, 12);
}

export interface LedgerSummary {
  total: number;
  by_disposition: Record<string, number>;
  by_stage: Record<string, number>;
  files: { jsonl: string | null; json: string | null };
}

export interface LedgerOptions {
  /** Directory for the files; omit for an in-memory ledger (tests). */
  dir?: string;
  runId: string;
  redact?: Redactor;
  now?: () => Date;
}

export class LeadLedger {
  readonly #records = new Map<string, LeadRecord>();
  readonly #jsonl: string | null;
  readonly #json: string | null;
  readonly #redact: Redactor;
  readonly #now: () => Date;
  readonly #runId: string;

  constructor(options: LedgerOptions) {
    this.#runId = options.runId;
    this.#redact = options.redact ?? noRedaction;
    this.#now = options.now ?? (() => new Date());
    if (options.dir) {
      mkdirSync(options.dir, { recursive: true });
      this.#jsonl = join(options.dir, `${options.runId}.leads.jsonl`);
      this.#json = join(options.dir, `${options.runId}.leads.json`);
    } else {
      this.#jsonl = null;
      this.#json = null;
    }
  }

  static inMemory(runId = "test", now?: () => Date): LeadLedger {
    return new LeadLedger({ runId, ...(now ? { now } : {}) });
  }

  #append(line: Record<string, unknown>): void {
    if (this.#jsonl) appendFileSync(this.#jsonl, this.#redact(JSON.stringify(line)) + "\n");
  }

  /** Record raw leads exactly as discovered. Idempotent per lead_id. Returns the records for the given leads. */
  recordDiscovered(leads: readonly RawLead[]): LeadRecord[] {
    const out: LeadRecord[] = [];
    for (const lead of leads) {
      const id = leadId(lead);
      let rec = this.#records.get(id);
      if (!rec) {
        rec = {
          lead_id: id, provider: lead.provider, lane: lead.lane, name: lead.name,
          title: lead.headline ?? null, source_url: lead.source_url, source_name: lead.source_name ?? null,
          homepage_hint: lead.homepage_hint ?? null, domain_hint: normalizeDomain(lead.homepage_hint),
          event_type_hint: lead.event_type_hint ?? null, event_date: lead.event_date ?? null, snippet: lead.snippet ?? null,
          source_retrieved: lead.source_retrieved, discovered_at: this.#now().toISOString(), stage_reached: "discovered",
          disposition: null, drop_reason: null, duplicate_of: null, selected_at: null, verification_started_at: null,
          decided_at: null, candidate_domain: null, confidence: null, event_type: null,
        };
        this.#records.set(id, rec);
        this.#append({ ts: rec.discovered_at, type: "discovered", ...rec });
      }
      out.push(rec);
    }
    return out;
  }

  get(id: string): LeadRecord | undefined {
    return this.#records.get(id);
  }

  all(): LeadRecord[] {
    return [...this.#records.values()];
  }

  /** Change a record and append the change to the event stream. */
  change(id: string, changes: Partial<Omit<LeadRecord, "lead_id">>): void {
    const rec = this.#records.get(id);
    if (!rec) return;
    Object.assign(rec, changes);
    this.#append({ ts: this.#now().toISOString(), type: "change", lead_id: id, ...changes });
  }

  stage(id: string, stage: LeadStage, extra: Partial<Omit<LeadRecord, "lead_id">> = {}): void {
    const ts = this.#now().toISOString();
    const stamp: Partial<LeadRecord> =
      stage === "selected" ? { selected_at: ts } : stage === "verification_started" ? { verification_started_at: ts } : {};
    this.change(id, { stage_reached: stage, ...stamp, ...extra });
  }

  /** Final decision for a lead. */
  decide(id: string, disposition: LeadDisposition, dropReason: string | null = null, extra: Partial<Omit<LeadRecord, "lead_id">> = {}): void {
    this.change(id, {
      stage_reached: "decided", disposition, drop_reason: dropReason, decided_at: this.#now().toISOString(), ...extra,
    });
  }

  /** Any lead still without a disposition when the run ends is marked not_processed, with the reason. */
  finalizeOpen(reason: string): number {
    let n = 0;
    for (const rec of this.#records.values()) {
      if (rec.disposition === null) {
        this.decide(rec.lead_id, "not_processed", reason);
        n++;
      }
    }
    return n;
  }

  summary(): LedgerSummary {
    const by_disposition: Record<string, number> = {};
    const by_stage: Record<string, number> = {};
    for (const r of this.#records.values()) {
      by_disposition[r.disposition ?? "open"] = (by_disposition[r.disposition ?? "open"] ?? 0) + 1;
      by_stage[r.stage_reached] = (by_stage[r.stage_reached] ?? 0) + 1;
    }
    return { total: this.#records.size, by_disposition, by_stage, files: { jsonl: this.#jsonl, json: this.#json } };
  }

  /** Write the consolidated file. Idempotent; safe from a shutdown path. */
  close(): void {
    if (!this.#json) return;
    writeFileSync(
      this.#json,
      this.#redact(JSON.stringify({ run_id: this.#runId, generated_at: this.#now().toISOString(), total: this.#records.size, leads: this.all() }, null, 2)),
    );
  }
}
