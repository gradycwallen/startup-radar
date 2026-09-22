/**
 * The only way source providers touch the network. Polite by construction:
 *  - an honest, identifying User-Agent;
 *  - a minimum delay between requests to the same host (per-host overrides);
 *  - a hard timeout and a response-size cap on every request;
 *  - no cookies, no credentials, GET only;
 *  - per-provider statistics (requests, status codes, bytes, time) that feed provider health.
 * The `fetchImpl` seam lets offline replays and tests serve recorded responses instead.
 */

export interface FetchResult {
  url: string;
  status: number;
  text: string;
  bytes: number;
  elapsed_ms: number;
  /** The response's `Content-Type` header, verbatim (may include a charset parameter), or
   * undefined when the response had none. Added for V2-2B.2's website monitoring, which needs to
   * tell a real HTML page apart from a JSON/XML/other response without guessing from content
   * alone; every other existing caller ignores this field, so it's purely additive. */
  contentType?: string;
}

export interface FetchOptions {
  accept?: string;
  signal?: AbortSignal;
  /** Provider tag for statistics. */
  provider?: string;
  /** Additional request headers (e.g. an API auth token). Never required; merged after the
   * default user-agent/accept, so a caller can override either by name. Added for V2-2A's GitHub
   * collector (optional `Authorization` for a higher rate limit) — every other caller is
   * unaffected, since this defaults to none. */
  headers?: Record<string, string>;
}

export interface Fetcher {
  getText(url: string, options?: FetchOptions): Promise<FetchResult>;
}

export interface FetchStats {
  requests: number;
  statuses: Record<string, number>;
  bytes: number;
  elapsed_ms: number;
  errors: string[];
}

export class FetchError extends Error {
  override readonly name = "FetchError";
  constructor(readonly url: string, message: string) {
    super(`${message} (${url})`);
  }
}

export interface PoliteFetcherOptions {
  fetchImpl?: typeof fetch;
  /** Minimum ms between requests to one host. */
  minDelayMs?: number;
  /** Per-host override (e.g. news.google.com is slower). */
  hostDelayMs?: Record<string, number>;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// V2-2B.2: added contact info (the project's own repo URL) so an operator on the receiving end of
// a request has somewhere to go, consistent with responsible-crawler practice. Kept as one shared
// constant so every caller (source providers, website monitoring) presents the same identity —
// see src/http.ts for the one other hardcoded UA string, updated to match.
export const DEFAULT_USER_AGENT = "StartupRadarScout/0.3 (+https://github.com/gradycwallen/startup-radar; read-only startup feed reader)";

export class PoliteFetcher implements Fetcher {
  readonly #fetch: typeof fetch;
  readonly #minDelay: number;
  readonly #hostDelay: Record<string, number>;
  readonly #timeout: number;
  readonly #maxBytes: number;
  readonly #ua: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #nextSlot = new Map<string, number>();
  readonly #stats = new Map<string, FetchStats>();

  constructor(options: PoliteFetcherOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#minDelay = options.minDelayMs ?? 600;
    this.#hostDelay = options.hostDelayMs ?? { "news.google.com": 1500 };
    this.#timeout = options.timeoutMs ?? 20_000;
    this.#maxBytes = options.maxBytes ?? 3_000_000;
    this.#ua = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = options.now ?? Date.now;
  }

  stats(provider: string): FetchStats {
    return this.#stats.get(provider) ?? { requests: 0, statuses: {}, bytes: 0, elapsed_ms: 0, errors: [] };
  }

  #stat(provider: string): FetchStats {
    let s = this.#stats.get(provider);
    if (!s) {
      s = { requests: 0, statuses: {}, bytes: 0, elapsed_ms: 0, errors: [] };
      this.#stats.set(provider, s);
    }
    return s;
  }

  /** Reserve the next allowed slot for this host, so concurrent providers never burst one host. */
  async #pace(host: string): Promise<void> {
    const delay = this.#hostDelay[host] ?? this.#minDelay;
    const now = this.#now();
    const at = Math.max(now, this.#nextSlot.get(host) ?? 0);
    this.#nextSlot.set(host, at + delay);
    if (at > now) await this.#sleep(at - now);
  }

  async getText(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const tag = options.provider ?? "unknown";
    const stat = this.#stat(tag);
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      stat.requests++;
      stat.statuses.ERR = (stat.statuses.ERR ?? 0) + 1;
      stat.errors.push(`invalid url ${url}`);
      throw new FetchError(url, "invalid URL");
    }
    await this.#pace(host);
    const started = this.#now();
    stat.requests++;
    // A plain AbortSignal.timeout() cannot be cancelled: its internal timer keeps running (and keeps the
    // process alive) for the full duration even after this request has long since settled. Use our own
    // timer instead, cleared in `finally`, so a run that completes never has to wait out stale timeouts.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new DOMException("The operation timed out.", "TimeoutError")), this.#timeout);
    try {
      const signal = options.signal ? AbortSignal.any([timeoutController.signal, options.signal]) : timeoutController.signal;
      const res = await this.#fetch(url, {
        method: "GET",
        redirect: "follow",
        signal,
        headers: {
          "user-agent": this.#ua,
          accept: options.accept ?? "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, application/json;q=0.9, */*;q=0.5",
          ...options.headers,
        },
      });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (res.body) {
        const reader = res.body.getReader();
        while (bytes < this.#maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          bytes += value.byteLength;
        }
        void reader.cancel().catch(() => {});
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
      const elapsed = this.#now() - started;
      stat.statuses[String(res.status)] = (stat.statuses[String(res.status)] ?? 0) + 1;
      stat.bytes += bytes;
      stat.elapsed_ms += elapsed;
      const contentType = res.headers.get("content-type") ?? undefined;
      return { url: res.url || url, status: res.status, text, bytes, elapsed_ms: elapsed, contentType };
    } catch (err) {
      const message = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      stat.statuses.ERR = (stat.statuses.ERR ?? 0) + 1;
      stat.errors.push(message.slice(0, 120));
      stat.elapsed_ms += this.#now() - started;
      throw new FetchError(url, message);
    } finally {
      clearTimeout(timer);
    }
  }
}
