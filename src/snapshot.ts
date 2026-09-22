import { hash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { normalizeUrl } from "./domain.ts";
import type { HomepageCheck } from "./http.ts";
import type { CompanyRow, EventRow } from "./dedupe.ts";
import type { LaneReport } from "./providers/types.ts";
import { RawLeadSchema, VerificationSchema, type RawLead, type Verification } from "./schema.ts";

/**
 * Offline snapshots: capture what live runs saw (source responses, discovery results, verification
 * results, homepage checks, database rows) once, then replay them forever with NO Anthropic calls,
 * NO live sources and NO database. Two layers:
 *
 *  1. HTTP layer: record/replay of raw HTTP exchanges (RSS/HTML/API bodies, and even Anthropic
 *     responses) keyed by method + URL + request body. Replay never touches the network: a request with
 *     no recording throws SnapshotMissError. Request headers (credentials) are never stored.
 *  2. Domain layer: a snapshot directory holding a run's discovery leads, verifications, homepage
 *     results and database rows, consumed by the replay provider/verifier/reader (see replay.ts).
 */

export const SNAPSHOT_VERSION = 1;

export class SnapshotMissError extends Error {
  override readonly name = "SnapshotMissError";
}

// ---------------------------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------------------------

/** Response headers worth keeping: they change client behavior (retries, content type, counts). Cookies and credentials are dropped. */
const KEEP_HEADERS = new Set(["content-type", "content-range", "retry-after", "retry-after-ms", "x-should-retry", "request-id", "etag", "last-modified", "link"]);
const TEXT_TYPES = /^(text\/|application\/(json|xml|rss\+xml|atom\+xml|xhtml\+xml|javascript|x-ndjson)|.*\+(json|xml))/i;

export interface HttpRecord {
  method: string;
  url: string;
  body_sha256: string | null;
  status: number;
  status_text: string;
  headers: Record<string, string>;
  body_encoding: "utf8" | "base64";
  body: string;
  recorded_at: string;
}

/** Stable JSON: object keys sorted, so key order in a request body never changes its identity. */
function stableJson(text: string): string {
  try {
    const canon = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v;
    return JSON.stringify(canon(JSON.parse(text)));
  } catch {
    return text;
  }
}

function keyFromParts(method: string, url: string, bodySha256: string | null): string {
  return `${method.toUpperCase()}-${bodySha256 ? bodySha256.slice(0, 12) : "nobody"}-${hash("sha256", normalizeUrl(url) ?? url, "hex").slice(0, 12)}`;
}

/** Identity of an HTTP exchange: method + normalized URL + canonical request body. Headers never take part. */
export function requestKey(method: string, url: string, body?: string | null): string {
  return keyFromParts(method, url, body ? hash("sha256", stableJson(body), "hex") : null);
}

export class HttpSnapshotStore {
  readonly #dir: string;
  readonly #compress: boolean;
  readonly #pending: Promise<void>[] = [];
  /** `compress` writes .json.gz (smaller fixtures); loading accepts either form. */
  constructor(dir: string, options: { compress?: boolean } = {}) {
    this.#dir = join(dir, "http");
    this.#compress = options.compress ?? false;
  }

  save(rec: HttpRecord): void {
    mkdirSync(this.#dir, { recursive: true });
    const base = join(this.#dir, keyFromParts(rec.method, rec.url, rec.body_sha256));
    const json = JSON.stringify(rec, null, this.#compress ? 0 : 2);
    if (this.#compress) writeFileSync(`${base}.json.gz`, gzipSync(json));
    else writeFileSync(`${base}.json`, json);
  }

  load(key: string): HttpRecord | null {
    const plain = join(this.#dir, `${key}.json`);
    if (existsSync(plain)) return JSON.parse(readFileSync(plain, "utf8")) as HttpRecord;
    const gz = join(this.#dir, `${key}.json.gz`);
    return existsSync(gz) ? (JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8")) as HttpRecord) : null;
  }

  list(): string[] {
    return existsSync(this.#dir) ? readdirSync(this.#dir).filter((f) => /\.json(\.gz)?$/.test(f)).map((f) => f.replace(/\.json(\.gz)?$/, "")) : [];
  }

  track(p: Promise<void>): void {
    this.#pending.push(p);
  }

  /** Resolves when every in-flight recording (streamed bodies are saved after they finish) is on disk. */
  async settled(): Promise<void> {
    while (this.#pending.length) await Promise.allSettled(this.#pending.splice(0));
  }
}

async function bodyText(init?: RequestInit): Promise<string | null> {
  const b = init?.body;
  if (b === undefined || b === null) return null;
  if (typeof b === "string") return b;
  if (b instanceof URLSearchParams) return b.toString();
  if (b instanceof Uint8Array) return new TextDecoder().decode(b);
  return null; // streams/forms are not supported request bodies for snapshots
}

const urlOf = (input: RequestInfo | URL): string => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/**
 * Wrap a real fetch so every exchange is also written to the store. The caller still gets the live
 * response (its body is teed, so streams keep streaming); the copy is saved when the body finishes.
 * Request headers are never recorded.
 */
export function createRecordingFetch(real: typeof fetch, store: HttpSnapshotStore, options: { maxBodyBytes?: number; now?: () => Date } = {}): typeof fetch {
  const max = options.maxBodyBytes ?? 5_000_000;
  const now = options.now ?? (() => new Date());
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = urlOf(input);
    const reqBody = await bodyText(init);
    const res = await real(input, init);
    if (!res.body) return res;
    const [forCaller, forStore] = res.body.tee();
    store.track(
      (async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = forStore.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size <= max) chunks.push(value);
          }
        } catch {
          return; // aborted mid-stream: not a complete exchange, do not record it
        }
        if (size > max) return; // too large to keep; replay will report a miss rather than serve a partial body
        const buf = Buffer.concat(chunks);
        const type = res.headers.get("content-type") ?? "";
        const isText = TEXT_TYPES.test(type) || /event-stream/i.test(type);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          if (KEEP_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
        });
        store.save({
          method, url, body_sha256: reqBody ? hash("sha256", stableJson(reqBody), "hex") : null,
          status: res.status, status_text: res.statusText, headers,
          body_encoding: isText ? "utf8" : "base64", body: isText ? buf.toString("utf8") : buf.toString("base64"),
          recorded_at: now().toISOString(),
        });
      })(),
    );
    return new Response(forCaller, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

/**
 * A fetch that serves ONLY recorded exchanges. It never touches the network: an unrecorded request
 * throws SnapshotMissError. Honors abort signals so deadline behavior can be tested offline.
 */
export function createReplayFetch(store: HttpSnapshotStore, options: { chunkDelayMs?: number } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = urlOf(input);
    const reqBody = await bodyText(init);
    const rec = store.load(requestKey(method, url, reqBody));
    if (!rec) throw new SnapshotMissError(`no recorded response for ${method} ${url}`);
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const data = rec.body_encoding === "base64" ? Buffer.from(rec.body, "base64") : new TextEncoder().encode(rec.body);
    const delay = options.chunkDelayMs ?? 0;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let aborted = false;
        signal?.addEventListener("abort", () => {
          aborted = true;
          try { controller.error(new DOMException("The operation was aborted.", "AbortError")); } catch { /* already closed */ }
        }, { once: true });
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (aborted) return;
        controller.enqueue(data);
        controller.close();
      },
    });
    return new Response(rec.status === 204 || rec.status === 304 ? null : body, { status: rec.status, statusText: rec.status_text, headers: rec.headers });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------
// Domain layer
// ---------------------------------------------------------------------------------------------

const LaneReportSchema = z.object({
  lane: z.string(), status: z.string(), elapsed_ms: z.number(), leads: z.number(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), webSearches: z.number(), webFetches: z.number(), apiCalls: z.number() }),
  timeout: z.object({ kind: z.string(), label: z.string(), limit_ms: z.number(), elapsed_ms: z.number() }).optional(),
  error: z.string().optional(),
});

const HomepageCheckSchema = z.object({
  reachable: z.boolean(), status: z.number().optional(), finalUrl: z.string().optional(), finalDomain: z.string().nullable().optional(),
  text: z.string().optional(), error: z.string().optional(),
});

export const SnapshotSchema = z.object({
  manifest: z.object({
    version: z.literal(SNAPSHOT_VERSION),
    created_at: z.string(),
    description: z.string(),
    source_run_id: z.string().nullable(),
    /** The clock replays use, so date-dependent rules (event freshness) behave exactly as they did originally. */
    now: z.string(),
  }),
  discovery: z.object({ provider: z.string(), lanes: z.array(LaneReportSchema), leads: z.array(RawLeadSchema) }),
  verifications: z.record(z.string(), z.object({ verification: VerificationSchema, retrieved_urls: z.array(z.string()) })),
  homepages: z.record(z.string(), HomepageCheckSchema),
  db: z.object({
    companies: z.array(z.object({ id: z.number(), name: z.string(), domain: z.string() })),
    events: z.array(z.object({ id: z.number(), company_id: z.number(), event_type: z.string(), event_date: z.string().nullable(), source_url: z.string().nullable(), headline: z.string().nullable(), description: z.string().nullable() })),
  }),
});

export interface Snapshot {
  manifest: { version: typeof SNAPSHOT_VERSION; created_at: string; description: string; source_run_id: string | null; now: string };
  discovery: { provider: string; lanes: LaneReport[]; leads: RawLead[] };
  verifications: Record<string, { verification: Verification; retrieved_urls: string[] }>;
  homepages: Record<string, HomepageCheck>;
  db: { companies: CompanyRow[]; events: EventRow[] };
}

const FILES = { manifest: "manifest.json", discovery: "discovery.json", verifications: "verifications.json", homepages: "homepages.json", db: "db.json" } as const;

export function writeSnapshot(dir: string, snap: Snapshot): void {
  mkdirSync(dir, { recursive: true });
  const w = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data, null, 2));
  w(FILES.manifest, snap.manifest);
  w(FILES.discovery, snap.discovery);
  w(FILES.verifications, snap.verifications);
  w(FILES.homepages, snap.homepages);
  w(FILES.db, snap.db);
}

/** Load and VALIDATE a snapshot directory. Throws a clear error for a missing file, bad JSON, wrong version or bad shape. */
export function loadSnapshot(dir: string): Snapshot {
  if (!existsSync(dir)) throw new Error(`snapshot directory not found: ${dir}`);
  const read = (name: string): unknown => {
    const file = join(dir, name);
    if (!existsSync(file)) throw new Error(`snapshot is missing ${name} (${dir})`);
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`snapshot file ${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const raw = { manifest: read(FILES.manifest), discovery: read(FILES.discovery), verifications: read(FILES.verifications), homepages: read(FILES.homepages), db: read(FILES.db) };
  const version = (raw.manifest as { version?: unknown } | null)?.version;
  if (version !== SNAPSHOT_VERSION) throw new Error(`unsupported snapshot version ${String(version)} (expected ${SNAPSHOT_VERSION})`);
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid snapshot: ${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data as Snapshot;
}
