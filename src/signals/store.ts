import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../log.ts";
import type { DerivedSignal, Observation, SignalSource } from "./types.ts";

/**
 * ============================================================================================
 * THE data-access layer for the three V2-2A tables (signal_sources, observations, signals) —
 * reads AND writes both live here, never companies or discovery_events. THE ONLY FILE UNDER src/
 * ALLOWED TO WRITE TO THE DATABASE, and only via insert/upsert into these three tables. This is
 * a deliberate, narrow exception to V2-1's "read-only" guard, not a weakening of it: see
 * test/readonly.test.ts's "V2-2A GUARD" tests, which assert (a) no other file under src/ contains
 * a write-capable call, and (b) THIS file's own writes never reference "companies" or
 * "discovery_events" as a table name, only the three new tables. (The read methods below are not
 * write-capable calls, so they don't need — and don't get — that same restriction; they exist so
 * the orchestrator (V2-2A.1) never needs a second file touching these tables at all.)
 * ============================================================================================
 *
 * `observations` and `signals` are meant to be append-only (see root CLAUDE.md's V2-2A section):
 * this class exposes no update/delete for either, only insert. `signal_sources` is the one mutable
 * table (a resolution can be corrected/deactivated later), matching its DB grants
 * (SELECT/INSERT/UPDATE vs. SELECT/INSERT-only for the other two — see the migration).
 */

export interface SignalStoreOptions {
  fetch?: typeof fetch;
  writeTimeoutMs?: number;
  log?: Logger;
}

const DEFAULT_WRITE_TIMEOUT_MS = 15_000;

export class SignalStore {
  readonly #client: SupabaseClient;
  readonly #timeoutMs: number;
  readonly #log: Logger | undefined;

  constructor(url: string, serviceRoleKey: string, options: SignalStoreOptions = {}) {
    this.#timeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.#log = options.log;
    this.#client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
    });
  }

  /**
   * Races the write against an independent deadline promise — like src/db.ts's `#read`, and for
   * the same reason: aborting the signal only helps if the underlying transport honors it. A test
   * double (or a misbehaving real transport) that ignores the abort signal must still not be able
   * to hang the caller forever; racing a real timer guarantees that regardless.
   */
  async #withDeadline<T>(op: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`signal store write "${op}" exceeded ${this.#timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.#timeoutMs);
    });
    const attempt = run(controller.signal);
    attempt.catch(() => {}); // a late failure of an abandoned attempt must not become an unhandled rejection
    try {
      return await Promise.race([attempt, deadline]);
    } catch (err) {
      this.#log?.warn("signal_store_write_failed", { message: `${op} failed: ${err instanceof Error ? err.message : String(err)}`, op });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads retry (like src/db.ts's ReadOnlyDb#read: 3 attempts, exponential backoff) because a
   * transient failure — a cold connection, one dropped packet — is a real, observed thing (this
   * exact retry was added after a live validation run hit one) and a plain SELECT is safe to
   * retry. Writes deliberately do NOT retry: insertObservations/insertSignals have no idempotency
   * key, so blindly retrying an insert risks a duplicate row if the first attempt actually
   * succeeded server-side but the client didn't see the response in time. (upsertSignalSource IS
   * idempotent via its natural key, but is kept single-attempt too for the same conservative
   * default as every other write in this codebase — retry could be added deliberately later.)
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

  /** PostgREST (Supabase's query layer) silently caps an unbounded `.select()` at a server-side
   * row limit (commonly 1000) — a `.select()` with no `.range()` does NOT throw or warn when a
   * table has more rows than that, it just returns a partial, arbitrarily-ordered slice. This was
   * found as the root cause of a real production bug: once `observations` grew past that cap, the
   * same signal (e.g. "contributor count grew from 6 to 8") re-fired on many separate days,
   * because each day's orchestrator run saw a DIFFERENT partial slice of a company's history
   * (sometimes missing the observation that would have shown the transition had already been
   * reported), rather than the complete, stable history every rule in rules/*.ts assumes it's
   * getting. The three read methods below now page through `.range()` (with an explicit
   * `.order("id")` — range-based pagination is only correct with a deterministic order) until a
   * page comes back short, which is the only way to be sure ALL matching rows were fetched
   * regardless of table size. */
  static readonly PAGE_SIZE = 1000;

  /** Insert-or-return-existing on the (company_id, source_type, external_id) natural key — a
   * source is never rediscovered as a duplicate row; resolving it again just confirms it. */
  async upsertSignalSource(source: Omit<SignalSource, "id">): Promise<SignalSource> {
    return this.#withDeadline("upsertSignalSource", async (signal) => {
      const { data, error } = await this.#client
        .from("signal_sources")
        .upsert(
          {
            company_id: source.company_id, source_type: source.source_type, external_id: source.external_id, canonical_url: source.canonical_url,
            resolution_method: source.resolution_method, resolution_confidence: source.resolution_confidence, resolution_evidence: source.resolution_evidence,
            active: source.active, metadata: source.metadata, updated_at: new Date().toISOString(),
          },
          { onConflict: "company_id,source_type,external_id" },
        )
        .select()
        .abortSignal(signal)
        .single();
      if (error) throw new Error(`upsertSignalSource: ${error.message}`);
      return data as SignalSource;
    });
  }

  /** Append-only. No update/delete method exists for observations by design.
   * Strips `id` explicitly rather than trusting the `Omit<Observation, "id">` type: TypeScript's
   * `Omit` is a compile-time-only guarantee — a caller (e.g. observe.ts, which sets `id: null`
   * before persistence) can still hand us an object where the property is literally present at
   * runtime. Sending an explicit `id: null` to Postgres for an identity column is NOT the same as
   * omitting it: the former fails the column's NOT NULL constraint instead of autogenerating. */
  async insertObservations(observations: readonly Omit<Observation, "id">[]): Promise<Observation[]> {
    if (observations.length === 0) return [];
    return this.#withDeadline("insertObservations", async (signal) => {
      const rows = observations.map((o) => ({
        company_id: o.company_id, signal_source_id: o.signal_source_id, metric_name: o.metric_name, numeric_value: o.numeric_value,
        text_value: o.text_value, observed_at: o.observed_at, source_timestamp: o.source_timestamp, collection_version: o.collection_version, raw_payload_ref: o.raw_payload_ref,
        // V2-2B.2: requires the additive `observations.metadata` migration (see the design report
        // §19) to actually persist against the live table — do not deploy this ahead of that
        // migration being applied, or every insert (including github/ats, which always send
        // `metadata: null`) will fail with "column not found." Safe to ship together because this
        // whole milestone is held back from commit/push until the migration is approved (§FINAL
        // CHECKPOINT) and applied (Phase 3/5).
        metadata: o.metadata ?? null,
      }));
      const { data, error } = await this.#client.from("observations").insert(rows).select().abortSignal(signal);
      if (error) throw new Error(`insertObservations: ${error.message}`);
      return (data ?? []) as Observation[];
    });
  }

  /** Append-only. No update/delete method exists for signals by design. Strips `id` for the same
   * reason as insertObservations above. */
  async insertSignals(signals: readonly Omit<DerivedSignal, "id">[]): Promise<DerivedSignal[]> {
    if (signals.length === 0) return [];
    return this.#withDeadline("insertSignals", async (signal) => {
      const rows = signals.map((s) => ({
        company_id: s.company_id, family: s.family, signal_type: s.signal_type, window_days: s.window_days,
        from_observation_id: s.from_observation_id, to_observation_id: s.to_observation_id, from_value: s.from_value, to_value: s.to_value,
        delta: s.delta, relative_change: s.relative_change, rule_version: s.rule_version, explanation: s.explanation, fired_at: s.fired_at, metadata: s.metadata,
      }));
      const { data, error } = await this.#client.from("signals").insert(rows).select().abortSignal(signal);
      if (error) throw new Error(`insertSignals: ${error.message}`);
      return (data ?? []) as DerivedSignal[];
    });
  }

  // ---- reads (SELECT only — orchestration needs these to decide what to resolve/collect/derive) ----

  /** Every ACTIVE signal source for the given companies. Used to know what's already resolved,
   * so resolution is only attempted for companies that genuinely have none yet. Paginated (see the
   * note above `PAGE_SIZE`) — this table is small today, but nothing here should ever again rely
   * on "small today" staying true without enforcing it. */
  async getActiveSourcesForCompanies(companyIds: readonly number[]): Promise<SignalSource[]> {
    if (companyIds.length === 0) return [];
    const out: SignalSource[] = [];
    for (let offset = 0; ; offset += SignalStore.PAGE_SIZE) {
      const page = await this.#readWithRetry(`getActiveSourcesForCompanies[offset=${offset}]`, async (signal) => {
        const { data, error } = await this.#client
          .from("signal_sources")
          .select()
          .in("company_id", companyIds as number[])
          .eq("active", true)
          .order("id", { ascending: true })
          .range(offset, offset + SignalStore.PAGE_SIZE - 1)
          .abortSignal(signal);
        if (error) throw new Error(`getActiveSourcesForCompanies: ${error.message}`);
        return (data ?? []) as SignalSource[];
      });
      out.push(...page);
      if (page.length < SignalStore.PAGE_SIZE) break;
    }
    return out;
  }

  /** Source records marked as invalid identity matches. Their rows remain stored for audit, but
   * must not be used to derive new signals; ordinary inactive sources retain valid history. */
  async getExcludedSourceIdsForCompanies(companyIds: readonly number[]): Promise<number[]> {
    if (companyIds.length === 0) return [];
    const ids: number[] = [];
    for (let offset = 0; ; offset += SignalStore.PAGE_SIZE) {
      const page = await this.#readWithRetry(`getExcludedSourceIdsForCompanies[offset=${offset}]`, async (signal) => {
        const { data, error } = await this.#client.from("signal_sources").select("id")
          .in("company_id", companyIds as number[]).eq("metadata->>history_excluded", "true")
          .order("id", { ascending: true }).range(offset, offset + SignalStore.PAGE_SIZE - 1).abortSignal(signal);
        if (error) throw new Error(`getExcludedSourceIdsForCompanies: ${error.message}`);
        return data ?? [];
      });
      ids.push(...page.map((source) => source.id as number));
      if (page.length < SignalStore.PAGE_SIZE) break;
    }
    return ids;
  }

  /** ALL observations for the given companies. This is the ONLY place observation history is
   * read, so freshness checks and signal derivation both see the exact same data — which is
   * exactly why it has to be the COMPLETE history, paginated, not whatever a single unbounded
   * `.select()` happens to return once the table outgrows PostgREST's default row cap (see the
   * note above `PAGE_SIZE` — this was a real, live bug, not a hypothetical). */
  async getObservationHistoryForCompanies(companyIds: readonly number[]): Promise<Observation[]> {
    if (companyIds.length === 0) return [];
    const out: Observation[] = [];
    for (let offset = 0; ; offset += SignalStore.PAGE_SIZE) {
      const page = await this.#readWithRetry(`getObservationHistoryForCompanies[offset=${offset}]`, async (signal) => {
        const { data, error } = await this.#client
          .from("observations")
          .select()
          .in("company_id", companyIds as number[])
          .order("id", { ascending: true })
          .range(offset, offset + SignalStore.PAGE_SIZE - 1)
          .abortSignal(signal);
        if (error) throw new Error(`getObservationHistoryForCompanies: ${error.message}`);
        return (data ?? []) as Observation[];
      });
      out.push(...page);
      if (page.length < SignalStore.PAGE_SIZE) break;
    }
    return out;
  }

  /** Every already-persisted signal for the given companies — used both to build the
   * (company_id, signal_type, to_observation_id) dedup key set before inserting newly-derived
   * signals, and (rules/*.ts) to check the last value already reported for a given signal type
   * before firing a new one over the same unchanged value. Must be complete, paginated — a
   * partial read here is exactly what let the same transition re-fire on separate days undetected
   * (see the note above `PAGE_SIZE`). */
  async getSignalsForCompanies(companyIds: readonly number[]): Promise<DerivedSignal[]> {
    if (companyIds.length === 0) return [];
    const out: DerivedSignal[] = [];
    for (let offset = 0; ; offset += SignalStore.PAGE_SIZE) {
      const page = await this.#readWithRetry(`getSignalsForCompanies[offset=${offset}]`, async (signal) => {
        const { data, error } = await this.#client
          .from("signals")
          .select()
          .in("company_id", companyIds as number[])
          .order("id", { ascending: true })
          .range(offset, offset + SignalStore.PAGE_SIZE - 1)
          .abortSignal(signal);
        if (error) throw new Error(`getSignalsForCompanies: ${error.message}`);
        return (data ?? []) as DerivedSignal[];
      });
      out.push(...page);
      if (page.length < SignalStore.PAGE_SIZE) break;
    }
    return out;
  }
}
