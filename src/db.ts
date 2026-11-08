import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { LIMITS } from "./config.ts";
import type { CompanyReader, CompanyRow, EventRow } from "./dedupe.ts";
import type { Logger } from "./log.ts";

/** A single database read exceeded its wall-clock limit (all attempts and backoff included). */
export class DbReadTimeoutError extends Error {
  override readonly name = "DbReadTimeoutError";
  constructor(
    readonly op: string,
    readonly limitMs: number,
    readonly elapsedMs: number,
  ) {
    super(`database read "${op}" exceeded ${limitMs}ms (ran ${elapsedMs}ms)`);
  }
}

const ATTEMPTS = 3;

/** Sleep that rejects with the signal's reason if aborted, so a backoff can never outlive the read's deadline. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RowCounts {
  companies: number;
  discovery_events: number;
}

export interface ReadOnlyDbOptions {
  /** Test seam: replaces the network transport. */
  fetch?: typeof fetch;
  /** Wall-clock limit for ONE read operation, retries and backoff included. Default 15 s. */
  readTimeoutMs?: number;
  log?: Logger;
}

/**
 * PHASE 1: READ-ONLY. The Supabase client is private and this class exposes SELECT-based
 * reads only. There is intentionally no method here that changes data or schema;
 * test/readonly.test.ts fails if any write-capable call is added anywhere under src/.
 *
 * Every read runs under one wall-clock deadline (default 15 s) that covers all of its retry
 * attempts and backoff. On expiry the request is aborted, a `db_read_timeout` error is logged,
 * and DbReadTimeoutError is thrown; a timed-out read is never retried. The deadline is also
 * enforced by racing, so a transport that ignores the abort signal still cannot hang the caller.
 */
export class ReadOnlyDb implements CompanyReader {
  readonly #client: SupabaseClient;
  readonly #readTimeoutMs: number;
  readonly #log: Logger | undefined;

  constructor(url: string, serviceRoleKey: string, options: ReadOnlyDbOptions = {}) {
    this.#readTimeoutMs = options.readTimeoutMs ?? LIMITS.dbReadMs;
    this.#log = options.log;
    this.#client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
    });
  }

  get readTimeoutMs(): number {
    return this.#readTimeoutMs;
  }

  async #read<T>(op: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new DbReadTimeoutError(op, this.#readTimeoutMs, Math.round(performance.now() - started));
        controller.abort(err);
        reject(err);
      }, this.#readTimeoutMs);
    });
    const attempts = this.#attempts(op, run, controller.signal);
    attempts.catch(() => {}); // if the deadline wins, a late failure of the abandoned attempt must not become an unhandled rejection
    try {
      return await Promise.race([attempts, deadline]);
    } catch (err) {
      const elapsed = Math.round(performance.now() - started);
      if (err instanceof DbReadTimeoutError) {
        this.#log?.error("db_read_timeout", {
          message: `database read "${op}" timed out after ${elapsed}ms (limit ${this.#readTimeoutMs}ms)`,
          op, limit_ms: this.#readTimeoutMs, elapsed_ms: elapsed,
        });
      } else {
        this.#log?.warn("db_read_failed", {
          message: `database read "${op}" failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`,
          op, elapsed_ms: elapsed,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async #attempts<T>(op: string, run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    let lastErr: unknown;
    for (let i = 1; i <= ATTEMPTS; i++) {
      try {
        return await run(signal);
      } catch (err) {
        if (signal.aborted) throw signal.reason; // deadline hit: never retry a timed-out read
        lastErr = err;
      }
      if (i < ATTEMPTS) await sleep(400 * 2 ** (i - 1), signal);
    }
    throw new Error(`${op} failed after ${ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  async findCompanyByDomain(domain: string): Promise<CompanyRow | null> {
    return this.#read("findCompanyByDomain", async (signal) => {
      const { data, error } = await this.#client
        .from("companies")
        .select("id,name,domain")
        .eq("domain", domain)
        .abortSignal(signal)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as CompanyRow | null) ?? null;
    });
  }

  async findCompaniesByName(name: string): Promise<CompanyRow[]> {
    const escaped = name.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.#read("findCompaniesByName", async (signal) => {
      const { data, error } = await this.#client.from("companies").select("id,name,domain").ilike("name", escaped).abortSignal(signal);
      if (error) throw new Error(error.message);
      return (data as CompanyRow[] | null) ?? [];
    });
  }

  async getEvents(companyId: number): Promise<EventRow[]> {
    return this.#read("getEvents", async (signal) => {
      const { data, error } = await this.#client
        .from("discovery_events")
        .select("id,company_id,event_type,event_date,source_url,headline,description")
        .eq("company_id", companyId)
        .abortSignal(signal);
      if (error) throw new Error(error.message);
      return (data as EventRow[] | null) ?? [];
    });
  }

  /**
   * Every company and event, for freezing into an offline snapshot. Read-only, paged, and subject to the same
   * per-read deadline as every other read.
   */
  async readAllForSnapshot(): Promise<{ companies: CompanyRow[]; events: EventRow[] }> {
    const page = 1000;
    const companies: CompanyRow[] = [];
    const events: EventRow[] = [];
    for (let from = 0; ; from += page) {
      const rows = await this.#read("snapshot:companies", async (signal) => {
        const { data, error } = await this.#client.from("companies").select("id,name,domain").order("id").range(from, from + page - 1).abortSignal(signal);
        if (error) throw new Error(error.message);
        return (data as CompanyRow[] | null) ?? [];
      });
      companies.push(...rows);
      if (rows.length < page) break;
    }
    for (let from = 0; ; from += page) {
      const rows = await this.#read("snapshot:events", async (signal) => {
        const { data, error } = await this.#client
          .from("discovery_events")
          .select("id,company_id,event_type,event_date,source_url,headline,description")
          .order("id")
          .range(from, from + page - 1)
          .abortSignal(signal);
        if (error) throw new Error(error.message);
        return (data as EventRow[] | null) ?? [];
      });
      events.push(...rows);
      if (rows.length < page) break;
    }
    return { companies, events };
  }

  /**
   * All companies' discovery timestamps plus which ones were discovered via a funding event —
   * the two facts src/analysis/corroboration.ts needs and nothing else. Read-only, paged, same
   * deadline/retry policy as every other read here.
   */
  async getCompanyDiscoveryInfo(): Promise<{ id: number; discoveredAt: string; hasFundingEvent: boolean }[]> {
    const page = 1000;
    const companies: { id: number; discovered_at: string }[] = [];
    for (let from = 0; ; from += page) {
      const rows = await this.#read("corroboration:companies", async (signal) => {
        const { data, error } = await this.#client.from("companies").select("id,discovered_at").order("id").range(from, from + page - 1).abortSignal(signal);
        if (error) throw new Error(error.message);
        return (data as { id: number; discovered_at: string }[] | null) ?? [];
      });
      companies.push(...rows);
      if (rows.length < page) break;
    }
    const fundingCompanyIds = new Set<number>();
    for (let from = 0; ; from += page) {
      const rows = await this.#read("corroboration:funding_events", async (signal) => {
        const { data, error } = await this.#client.from("discovery_events").select("company_id").eq("event_type", "funding").order("id").range(from, from + page - 1).abortSignal(signal);
        if (error) throw new Error(error.message);
        return (data as { company_id: number }[] | null) ?? [];
      });
      for (const r of rows) fundingCompanyIds.add(r.company_id);
      if (rows.length < page) break;
    }
    return companies.map((c) => ({ id: c.id, discoveredAt: c.discovered_at, hasFundingEvent: fundingCompanyIds.has(c.id) }));
  }

  /**
   * Every funding discovery_event's (company_id, event_date), nothing else — for
   * src/analysis/lead-time-backtest.ts, which only needs to cluster dates per company. Filters by
   * the given company ids to stay consistent with other narrow reads here, though in practice
   * every known company id is always passed. Read-only, paged.
   */
  async getFundingEventDates(companyIds: readonly number[]): Promise<{ companyId: number; eventDate: string }[]> {
    if (companyIds.length === 0) return [];
    const page = 1000;
    const out: { companyId: number; eventDate: string }[] = [];
    for (let from = 0; ; from += page) {
      const rows = await this.#read("lead_time:funding_events", async (signal) => {
        const { data, error } = await this.#client
          .from("discovery_events")
          .select("company_id,event_date")
          .eq("event_type", "funding")
          .in("company_id", companyIds as number[])
          .not("event_date", "is", null)
          .order("id")
          .range(from, from + page - 1)
          .abortSignal(signal);
        if (error) throw new Error(error.message);
        return (data as { company_id: number; event_date: string }[] | null) ?? [];
      });
      out.push(...rows.map((r) => ({ companyId: r.company_id, eventDate: r.event_date })));
      if (rows.length < page) break;
    }
    return out;
  }

  async counts(): Promise<RowCounts> {
    const count = async (table: keyof RowCounts): Promise<number> =>
      this.#read(`count(${table})`, async (signal) => {
        const { count: n, error } = await this.#client.from(table).select("*", { count: "exact", head: true }).abortSignal(signal);
        if (error) throw new Error(error.message);
        // A missing count means the request did not really succeed. Never coerce it to 0:
        // that would make a broken connection look like an empty database.
        if (n === null) throw new Error(`no row count returned for ${table}`);
        return n;
      });
    return { companies: await count("companies"), discovery_events: await count("discovery_events") };
  }
}
