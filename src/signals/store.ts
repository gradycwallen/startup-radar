import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../log.ts";
import type { DerivedSignal, Observation, SignalSource } from "./types.ts";

/**
 * ============================================================================================
 * THE ONLY FILE UNDER src/ ALLOWED TO WRITE TO THE DATABASE — and only to the three V2-2A
 * tables (signal_sources, observations, signals), never companies or discovery_events. This is
 * a deliberate, narrow exception to V2-1's "read-only" guard, not a weakening of it: see
 * test/signals.test.ts's "V2-2A GUARD" tests, which assert (a) no other file under src/ contains
 * a write-capable call, and (b) THIS file's own writes never reference "companies" or
 * "discovery_events" as a table name, only the three new tables.
 * ============================================================================================
 *
 * `observations` and `signals` are meant to be append-only (see root CLAUDE.md's V2-2A section
 * once written): this class exposes no update/delete for either, only insert. `signal_sources`
 * is the one mutable table (a resolution can be corrected/deactivated later), matching its DB
 * grants (SELECT/INSERT/UPDATE vs. SELECT/INSERT-only for the other two — see the migration).
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
}
