/**
 * Deadlines and cancellation.
 *
 * Every scoped limit (request, lane, candidate) is an AbortSignal that carries a typed
 * *reason*. When something aborts, the reason says exactly what: which limit, which
 * lane/candidate, how long it had run. Scopes nest by passing the parent's signal, so a
 * shutdown or an outer deadline aborts everything inside it, including SDK retry waits
 * (the SDK's retry sleep is cancelled by the request signal).
 */

export type TimeoutKind =
  | "request" // one Anthropic request exceeded its wall-clock limit
  | "header" // no response headers within the SDK pre-header timeout (after SDK retries)
  | "lane" // a whole discovery lane exceeded its deadline
  | "candidate"; // a whole candidate verification exceeded its deadline

export class ScoutTimeoutError extends Error {
  override readonly name = "ScoutTimeoutError";
  constructor(
    readonly kind: TimeoutKind,
    readonly label: string,
    readonly limitMs: number,
    readonly elapsedMs: number,
  ) {
    super(`${kind} timeout: "${label}" exceeded ${limitMs}ms (ran ${elapsedMs}ms)`);
  }
}

export class ShutdownError extends Error {
  override readonly name = "ShutdownError";
  constructor(readonly signalName: string) {
    super(`shutdown requested (${signalName})`);
  }
}

/**
 * Aborts every in-flight and future piece of Anthropic work for a RUN-LEVEL reason: a fatal API
 * error (insufficient credit, authentication, permission). `reason` carries the underlying error.
 */
export class RunAbortError extends Error {
  override readonly name = "RunAbortError";
  constructor(readonly reason: Error) {
    super(`run aborted: ${reason.message}`);
  }
}

export interface TimeoutScope {
  /** Aborts when the limit elapses OR the parent aborts. `signal.reason` says which. */
  readonly signal: AbortSignal;
  elapsedMs(): number;
  /** Always call (finally): clears the timer so nothing keeps the process alive. */
  cancel(): void;
}

export function timeoutScope(kind: TimeoutKind, label: string, limitMs: number, parent?: AbortSignal): TimeoutScope {
  const controller = new AbortController();
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const timer = setTimeout(() => controller.abort(new ScoutTimeoutError(kind, label, limitMs, elapsed())), limitMs);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  return { signal, elapsedMs: elapsed, cancel: () => clearTimeout(timer) };
}

/**
 * If `signal` was aborted with one of our typed reasons, return that reason (it explains
 * the abort precisely); otherwise return the original error untouched.
 */
export function classifyAbort(err: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof ScoutTimeoutError || reason instanceof ShutdownError || reason instanceof RunAbortError) return reason;
  }
  return err;
}

/** Wall-clock for the whole run. The soft deadline stops NEW work; it never aborts in-flight work. */
export class RunClock {
  readonly startedAt: number;
  constructor(
    readonly softDeadlineMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }
  elapsedMs(): number {
    return this.now() - this.startedAt;
  }
  softDeadlineReached(): boolean {
    return this.elapsedMs() >= this.softDeadlineMs;
  }
}
