import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../log.ts";
import type { CompanyInsert, EventInsert } from "./accept.ts";

/**
 * ============================================================================================
 * THE ONLY FILE UNDER src/ ALLOWED TO WRITE TO companies/discovery_events. This is the FIRST
 * write path to these two tables anywhere in this codebase — see root CLAUDE.md's V2-1.1
 * section for the full context on why this is a deliberate, explicit, heavily-guarded exception,
 * not a casual addition. It writes to NOTHING else: not signal_sources/observations/signals
 * (that remains src/signals/store.ts's exclusive concern), no other table.
 *
 * Companies are INSERT-only — never UPDATE, never upsert. A domain collision is treated as "this
 * company already exists, do nothing" (a benign, expected outcome under normal operation, backed
 * up by the caller's own pre-check against a freshly-loaded ExistingIndex), never as license to
 * silently modify an existing row. Events are inserted via upsert-with-ignore-duplicates on the
 * database's own `unique(company_id, source_url)` constraint — that constraint IS the
 * idempotency guarantee; there is no separate check-then-insert race to reason about.
 * ============================================================================================
 */

export interface DiscoveryStoreOptions {
  fetch?: typeof fetch;
  writeTimeoutMs?: number;
  log?: Logger;
}

const DEFAULT_WRITE_TIMEOUT_MS = 15_000;
/** Postgres unique_violation. https://www.postgresql.org/docs/current/errcodes-appendix.html */
const UNIQUE_VIOLATION = "23505";

export interface InsertedCompany {
  id: number;
  name: string;
  domain: string;
}

export type InsertCompanyResult = { inserted: InsertedCompany } | { conflict: true };

export interface UpsertEventsResult {
  inserted: number;
  skipped_duplicate: number;
}

export class DiscoveryStore {
  readonly #client: SupabaseClient;
  readonly #timeoutMs: number;
  readonly #log: Logger | undefined;

  constructor(url: string, serviceRoleKey: string, options: DiscoveryStoreOptions = {}) {
    this.#timeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.#log = options.log;
    this.#client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
    });
  }

  /** Same deadline-racing pattern as src/signals/store.ts, for the same reason: a transport that
   * ignores the abort signal must still not be able to hang the caller forever. */
  async #withDeadline<T>(op: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`discovery store write "${op}" exceeded ${this.#timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.#timeoutMs);
    });
    const attempt = run(controller.signal);
    attempt.catch(() => {});
    try {
      return await Promise.race([attempt, deadline]);
    } catch (err) {
      this.#log?.warn("discovery_store_write_failed", { message: `${op} failed: ${err instanceof Error ? err.message : String(err)}`, op });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Insert-only. A unique-constraint violation on `domain` is reported as `{ conflict: true }`,
   * not thrown — this is the expected, benign outcome when a company was inserted by a concurrent
   * or prior run between when the caller's ExistingIndex was loaded and now; the caller treats it
   * as "already exists, skip," never as a reason to fail the run.
   */
  async insertCompany(company: CompanyInsert): Promise<InsertCompanyResult> {
    return this.#withDeadline("insertCompany", async (signal) => {
      const { data, error } = await this.#client
        .from("companies")
        .insert({
          name: company.name, domain: company.domain, description: company.description, category: company.category,
          discovery_source: company.discovery_source, discovery_url: company.discovery_url, confidence: company.confidence,
          discovery_reason: company.discovery_reason, founded_year: company.founded_year,
        })
        .select("id, name, domain")
        .abortSignal(signal)
        .single();
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return { conflict: true };
        throw new Error(`insertCompany: ${error.message}`);
      }
      return { inserted: data as InsertedCompany };
    });
  }

  /** Upsert-with-ignore-duplicates on (company_id, source_url) — the database's own constraint is
   * the idempotency mechanism. PostgREST's ignore-duplicates + return=representation returns ONLY
   * the rows actually inserted, so `data.length` is the true insert count without a second query. */
  async upsertEvents(companyId: number, events: readonly EventInsert[]): Promise<UpsertEventsResult> {
    if (events.length === 0) return { inserted: 0, skipped_duplicate: 0 };
    return this.#withDeadline("upsertEvents", async (signal) => {
      const rows = events.map((e) => ({
        company_id: companyId, event_type: e.event_type, event_date: e.event_date, source_name: e.source_name,
        source_url: e.source_url, headline: e.headline, description: e.description, confidence: e.confidence,
      }));
      const { data, error } = await this.#client
        .from("discovery_events")
        .upsert(rows, { onConflict: "company_id,source_url", ignoreDuplicates: true })
        .select("id")
        .abortSignal(signal);
      if (error) throw new Error(`upsertEvents: ${error.message}`);
      const inserted = (data ?? []).length;
      return { inserted, skipped_duplicate: events.length - inserted };
    });
  }

  /**
   * Reads retry (matches src/db.ts and src/signals/store.ts's read methods): 3 attempts,
   * exponential backoff. Used only for the defensive pre-insert domain check below — a plain
   * SELECT, safe to retry.
   */
  async #readWithRetry<T>(op: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const attempts = 3;
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await this.#withDeadline(op, run);
      } catch (err) {
        lastErr = err;
        if (i < attempts) await new Promise((r) => setTimeout(r, 400 * 2 ** (i - 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`${op} failed after ${attempts} attempts`);
  }

  /** Defensive, belt-and-suspenders check immediately before an insert — the caller's
   * ExistingIndex was loaded once at the start of the run and could theoretically be stale by the
   * time a given candidate is reached; this closes that gap without needing a transaction. */
  async companyExistsByDomain(domain: string): Promise<boolean> {
    return this.#readWithRetry("companyExistsByDomain", async (signal) => {
      const { data, error } = await this.#client.from("companies").select("id").eq("domain", domain).abortSignal(signal).maybeSingle();
      if (error) throw new Error(`companyExistsByDomain: ${error.message}`);
      return data !== null;
    });
  }
}
