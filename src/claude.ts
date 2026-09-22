import Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";
import { estimateSingleShot, estimateWebToolRequest, type BudgetGuard, type Reservation, type Settlement } from "./budget.ts";
import { ScoutTimeoutError, classifyAbort, timeoutScope } from "./deadline.ts";
import { normalizeUrl } from "./domain.ts";
import { classifyFatalApiError } from "./fatal.ts";
import type { Logger } from "./log.ts";

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  webSearches: number;
  webFetches: number;
  apiCalls: number;
}

export const emptyUsage = (): UsageSummary => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0, webFetches: 0, apiCalls: 0,
});

export function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    webSearches: a.webSearches + b.webSearches,
    webFetches: a.webFetches + b.webFetches,
    apiCalls: a.apiCalls + b.apiCalls,
  };
}

/** Add `delta` into `target` in place. Accumulators are passed down so usage survives a failure. */
export function accumulateUsage(target: UsageSummary, delta: UsageSummary): void {
  Object.assign(target, addUsage(target, delta));
}

export class ModelRefusalError extends Error {}
export class ModelTruncatedError extends Error {}
export class ModelOutputError extends Error {}

// ---------------------------------------------------------------------------------------------
// Instrumentation: what did each web operation do, and how long did it take?
// ---------------------------------------------------------------------------------------------

export interface WebOpReport {
  /** Server tool name: web_search, web_fetch, or a code-execution helper. */
  name: string;
  tool_use_id: string;
  /** Search query or fetched URL, when the model supplied one. */
  target: string | null;
  /** ms after request start when the model began emitting this tool call. */
  started_ms: number;
  /** ms the server spent running the tool: from the call being complete to its result arriving. */
  tool_ms: number | null;
  error_code: string | null;
  completed: boolean;
}

export interface RequestReport {
  label: string;
  request_id: string | null;
  elapsed_ms: number;
  /** ms until the first stream event arrived. */
  first_event_ms: number | null;
  event_count: number;
  /** Largest silence between two consecutive stream events, and the event it followed. Evidence for choosing an idle threshold. */
  max_gap_ms: number;
  max_gap_after: string | null;
  ops: WebOpReport[];
  slowest_op: WebOpReport | null;
  stop_reason: string | null;
  outcome: "ok" | "timeout" | "aborted" | "error";
}

interface OpState {
  report: WebOpReport;
  index: number;
  jsonBuf: string;
  stoppedAt: number | null;
}

/** Watches one streamed request's events and timestamps web-tool activity. Read-only; never affects the request. */
export class RequestObserver {
  requestId: string | null = null;
  stopReason: string | null = null;
  readonly partial = emptyUsage();
  private readonly startedAt = performance.now();
  private lastEventAt: number | null = null;
  private lastEventType: string | null = null;
  private firstEventMs: number | null = null;
  private eventCount = 0;
  private maxGap = 0;
  private maxGapAfter: string | null = null;
  private readonly ops = new Map<string, OpState>();
  private readonly byIndex = new Map<number, OpState>();

  constructor(
    readonly label: string,
    private readonly log: Logger,
  ) {}

  elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  eventCountValue(): number {
    return this.eventCount;
  }

  onEvent(ev: Anthropic.MessageStreamEvent): void {
    const now = performance.now();
    if (this.lastEventAt !== null) {
      const gap = now - this.lastEventAt;
      if (gap > this.maxGap) {
        this.maxGap = gap;
        this.maxGapAfter = this.lastEventType;
      }
    } else {
      this.firstEventMs = Math.round(now - this.startedAt);
    }
    this.lastEventAt = now;
    this.lastEventType = ev.type;
    this.eventCount++;

    switch (ev.type) {
      case "message_start":
        this.partial.inputTokens = ev.message.usage.input_tokens ?? 0;
        this.partial.cacheReadTokens = ev.message.usage.cache_read_input_tokens ?? 0;
        break;
      case "message_delta": {
        const u = ev.usage as { output_tokens?: number } | undefined;
        if (u?.output_tokens !== undefined) this.partial.outputTokens = u.output_tokens;
        if (ev.delta.stop_reason) this.stopReason = ev.delta.stop_reason;
        break;
      }
      case "content_block_start": {
        const block = ev.content_block as { type: string; id?: string; name?: string; tool_use_id?: string; content?: unknown };
        if (block.type === "server_tool_use" && block.id) {
          const state: OpState = {
            report: {
              name: block.name ?? "server_tool", tool_use_id: block.id, target: null,
              started_ms: Math.round(now - this.startedAt), tool_ms: null, error_code: null, completed: false,
            },
            index: ev.index, jsonBuf: "", stoppedAt: null,
          };
          this.ops.set(block.id, state);
          this.byIndex.set(ev.index, state);
          if (block.name === "web_search") this.partial.webSearches++;
          if (block.name === "web_fetch") this.partial.webFetches++;
        } else if (block.type.endsWith("_tool_result") && block.tool_use_id) {
          const op = this.ops.get(block.tool_use_id);
          if (op) {
            op.report.completed = true;
            op.report.tool_ms = Math.round(now - (op.stoppedAt ?? now));
            const content = block.content as { type?: string; error_code?: string } | unknown[] | undefined;
            if (content && !Array.isArray(content) && typeof content.type === "string" && content.type.endsWith("_error")) {
              op.report.error_code = content.error_code ?? content.type;
            }
            this.log.info("web_op", {
              message: `${this.label}: ${op.report.name} ${op.report.target ?? ""} ${op.report.tool_ms}ms${op.report.error_code ? ` ERROR ${op.report.error_code}` : ""}`.trim(),
              request: this.label, request_id: this.requestId, ...op.report, quiet: true,
            });
          }
        }
        break;
      }
      case "content_block_delta": {
        const op = this.byIndex.get(ev.index);
        if (op && ev.delta.type === "input_json_delta") op.jsonBuf += ev.delta.partial_json;
        break;
      }
      case "content_block_stop": {
        const op = this.byIndex.get(ev.index);
        if (op) {
          op.stoppedAt = now;
          try {
            const input = JSON.parse(op.jsonBuf || "{}") as { query?: unknown; url?: unknown };
            const target = typeof input.query === "string" ? input.query : typeof input.url === "string" ? input.url : null;
            op.report.target = target ? target.slice(0, 300) : null;
          } catch {
            /* input not JSON (e.g. code-execution helper); leave target null */
          }
        }
        break;
      }
      default:
        break;
    }
  }

  /** Operations that were started but had not returned a result yet: the suspects for a stall. */
  pendingOps(): Array<WebOpReport & { waiting_ms: number }> {
    const now = performance.now();
    return [...this.ops.values()]
      .filter((o) => !o.report.completed)
      .map((o) => ({ ...o.report, waiting_ms: Math.round(now - (o.stoppedAt ?? this.startedAt + o.report.started_ms)) }));
  }

  report(outcome: RequestReport["outcome"]): RequestReport {
    const ops = [...this.ops.values()].map((o) => o.report);
    const slowest = ops.filter((o) => o.tool_ms !== null).sort((a, b) => (b.tool_ms ?? 0) - (a.tool_ms ?? 0))[0] ?? null;
    return {
      label: this.label, request_id: this.requestId, elapsed_ms: this.elapsedMs(), first_event_ms: this.firstEventMs,
      event_count: this.eventCount, max_gap_ms: Math.round(this.maxGap), max_gap_after: this.maxGapAfter,
      ops, slowest_op: slowest, stop_reason: this.stopReason, outcome,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Web-tool runner
// ---------------------------------------------------------------------------------------------

export interface WebToolCaps {
  maxSearches: number;
  maxFetches: number;
}

export interface WebRunOptions {
  model: string;
  system: string;
  user: string;
  /** Names the caller for logs and timeout errors, e.g. "funding" or "verify:Acme". */
  label: string;
  /** Cost-ledger stage ("discover" | "verify"): estimates are calibrated per stage. */
  stage: string;
  /**
   * EVERY request reserves its worst-case cost here BEFORE it is sent and is refused (BudgetRefusalError,
   * nothing sent) if that could exceed the run's ceiling.
   */
  budget: BudgetGuard;
  caps: WebToolCaps;
  /** Hard wall-clock limit for EACH request (whole stream), enforced by abort. */
  requestTimeoutMs: number;
  /** SDK pre-header timeout per attempt. */
  headerTimeoutMs: number;
  /** Max content tokens one web_fetch may add to context. */
  fetchMaxContentTokens: number;
  /** Parent scope (lane / candidate / shutdown). Aborting it aborts the request and any SDK retry wait. */
  signal: AbortSignal;
  /** Accumulator, mutated as requests finish or fail, so usage is kept even when this throws. */
  usage: UsageSummary;
  log: Logger;
  maxTokens?: number;
  /** Max pause_turn resumptions (server-side tool loop hit its iteration cap). */
  maxContinuations?: number;
}

export interface WebRunResult {
  text: string;
  /** Normalized URLs that appeared in search results, fetched pages, or citations. */
  seenUrls: Set<string>;
  usage: UsageSummary;
  continuations: number;
  requests: RequestReport[];
}

/** Collect every `url` under server-tool result blocks and text citations. Shape-tolerant on purpose. */
export function collectUrls(blocks: ReadonlyArray<unknown>, into = new Set<string>()): Set<string> {
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (typeof rec.url === "string") {
      const u = normalizeUrl(rec.url);
      if (u) into.add(u);
    }
    for (const value of Object.values(rec)) walk(value, depth + 1);
  };
  for (const block of blocks) {
    const b = block as { type?: string; content?: unknown; citations?: unknown };
    if (typeof b.type === "string" && b.type.endsWith("_tool_result")) walk(b.content, 0);
    if (b.type === "text" && Array.isArray(b.citations)) walk(b.citations, 0);
  }
  return into;
}

/**
 * How to charge a request that did not complete. Only an HTTP error answered before any output
 * (nothing processed) is free; anything else (abort, timeout, mid-stream failure) may have been
 * billed, so its full reservation is charged.
 */
function failureSettlement(raw: unknown, eventCount: number, requestId: string | null): Settlement {
  const status = raw instanceof Anthropic.APIError ? (raw as { status?: unknown }).status : undefined;
  if (typeof status === "number" && eventCount === 0) return { kind: "no_charge", note: `HTTP ${status} before any output` };
  return { kind: "unknown", note: raw instanceof Error ? `${raw.name}: ${raw.message}`.slice(0, 200) : "failed", requestId };
}

function logTimeout(log: Logger, err: ScoutTimeoutError, extra: Record<string, unknown>): void {
  log.warn("timeout", {
    message: `${err.kind} timeout: ${err.label} after ${err.elapsedMs}ms (limit ${err.limitMs}ms)`,
    kind: err.kind, label: err.label, limit_ms: err.limitMs, elapsed_ms: err.elapsedMs, ...extra,
  });
}

/**
 * One model turn-sequence with Anthropic's server-side web_search + web_fetch tools.
 *
 * - Each request gets its own hard wall-clock deadline (whole stream), nested inside the caller's
 *   signal. The SDK's own timeout only covers time-to-headers, so this is what actually bounds a
 *   stream. Aborting also cancels SDK retry waits.
 * - Resumes pause_turn; refusal and truncation are errors.
 * - Every web operation is timestamped so a slow request can be attributed to a specific
 *   search or fetch; per-request timing and request ids are logged.
 * - Returns the URLs the model actually saw (used to reject made-up source URLs).
 */
export async function runWithWebTools(client: Anthropic, opts: WebRunOptions): Promise<WebRunResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.user }];
  const seenUrls = new Set<string>();
  const requests: RequestReport[] = [];
  const maxContinuations = opts.maxContinuations ?? 6;

  for (let continuation = 0; ; continuation++) {
    const label = `${opts.label}#${continuation + 1}`;
    // Budget guard: reserve BEFORE anything is sent. Throws BudgetRefusalError (and sends nothing) if the
    // worst-case estimate could push the run past its ceiling.
    const maxTokens = opts.maxTokens ?? 16000;
    const reservation: Reservation = opts.budget.reserve({
      label, stage: opts.stage, model: opts.model,
      estimate: estimateWebToolRequest(
        { model: opts.model, promptChars: opts.system.length + JSON.stringify(messages).length, maxOutputTokens: maxTokens, caps: opts.caps },
        opts.budget.assumptions,
      ),
    });
    const scope = timeoutScope("request", label, opts.requestTimeoutMs, opts.signal);
    const obs = new RequestObserver(label, opts.log);
    let message: Anthropic.Message;
    try {
      const stream = client.messages.stream(
        {
          model: opts.model,
          max_tokens: maxTokens,
          system: opts.system,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          tools: [
            { type: "web_search_20260209", name: "web_search", max_uses: opts.caps.maxSearches },
            { type: "web_fetch_20260209", name: "web_fetch", max_uses: opts.caps.maxFetches, max_content_tokens: opts.fetchMaxContentTokens },
          ],
          messages,
        },
        { signal: scope.signal, timeout: opts.headerTimeoutMs },
      );
      stream.on("connect", () => {
        obs.requestId = stream.request_id ?? null;
      });
      stream.on("streamEvent", (ev) => obs.onEvent(ev));
      message = await stream.finalMessage();
      obs.requestId ??= (message as { _request_id?: string | null })._request_id ?? null;
    } catch (raw) {
      let err: unknown = classifyAbort(raw, scope.signal);
      if (err === raw) {
        // Insufficient credit / authentication / permission: the whole run must stop, not just this item.
        const fatal = classifyFatalApiError(raw, obs.requestId);
        if (fatal) err = fatal;
      }
      if (err === raw && raw instanceof Anthropic.APIConnectionTimeoutError) {
        err = new ScoutTimeoutError("header", label, opts.headerTimeoutMs, scope.elapsedMs());
      }
      opts.budget.settle(reservation, failureSettlement(raw, obs.eventCountValue(), obs.requestId));
      // Keep whatever usage we observed, so a timed-out request is still costed.
      accumulateUsage(opts.usage, { ...obs.partial, apiCalls: 1 });
      const outcome = err instanceof ScoutTimeoutError ? "timeout" : (err as Error)?.name === "ShutdownError" ? "aborted" : "error";
      const report = obs.report(outcome);
      requests.push(report);
      const pending = obs.pendingOps();
      if (err instanceof ScoutTimeoutError) logTimeout(opts.log, err, { request_id: obs.requestId, pending_ops: pending, request: report });
      else opts.log.warn("anthropic_request_failed", { message: `${label}: ${err instanceof Error ? err.message : String(err)}`, request: report, pending_ops: pending });
      throw err;
    } finally {
      scope.cancel();
    }

    // Success: the final message's usage is authoritative.
    const server = message.usage.server_tool_use as { web_search_requests?: number; web_fetch_requests?: number } | null | undefined;
    accumulateUsage(opts.usage, {
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      webSearches: server?.web_search_requests ?? obs.partial.webSearches,
      webFetches: server?.web_fetch_requests ?? obs.partial.webFetches,
      apiCalls: 1,
    });
    opts.budget.settle(reservation, {
      kind: "ok", requestId: obs.requestId,
      usage: {
        inputTokens: message.usage.input_tokens ?? 0, outputTokens: message.usage.output_tokens ?? 0,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        webSearches: server?.web_search_requests ?? obs.partial.webSearches, webFetches: server?.web_fetch_requests ?? obs.partial.webFetches,
      },
    });
    collectUrls(message.content, seenUrls);
    obs.stopReason = message.stop_reason ?? obs.stopReason;
    const report = obs.report("ok");
    requests.push(report);
    opts.log.info("anthropic_request", {
      message: `${label}: ${report.elapsed_ms}ms, ${report.ops.length} web ops, stop=${report.stop_reason}`,
      request: report, quiet: true,
    });

    if (message.stop_reason === "pause_turn") {
      if (continuation >= maxContinuations) throw new ModelTruncatedError("pause_turn continuation limit reached");
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    if (message.stop_reason === "refusal") throw new ModelRefusalError("model refused the request");
    if (message.stop_reason === "max_tokens") throw new ModelTruncatedError("model hit max_tokens before finishing");

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return { text, seenUrls, usage: opts.usage, continuations: continuation, requests };
  }
}

/** Pull a JSON object out of model text (fenced ```json block, or the outermost braces). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new ModelOutputError("no JSON object found in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

export function parseModelJson<T>(text: string, schema: ZodType<T>): T {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    throw new ModelOutputError(`unparseable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ModelOutputError(`schema mismatch: ${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export interface RepairOptions {
  model: string;
  label: string;
  stage: string;
  /** Repair calls are API operations too: they reserve budget before being sent. */
  budget: BudgetGuard;
  signal: AbortSignal;
  requestTimeoutMs: number;
  headerTimeoutMs: number;
  usage: UsageSummary;
  log: Logger;
}

/** One cheap, tool-free retry that reformats prior output into valid JSON. Bounded like any request. */
export async function repairJson<T>(
  client: Anthropic,
  previousText: string,
  schemaHint: string,
  schema: ZodType<T>,
  opts: RepairOptions,
): Promise<T> {
  const label = `${opts.label}:repair`;
  const repairSystem = "You reformat text into strict JSON. Output only one JSON object, no commentary. Do not add facts that are not in the text; use null for anything missing.";
  const repairUser = `Reformat the following into JSON matching this shape:\n${schemaHint}\n\nTEXT:\n${previousText}`;
  const reservation = opts.budget.reserve({
    label, stage: `${opts.stage}_repair`, model: opts.model,
    estimate: estimateSingleShot({ model: opts.model, promptChars: repairSystem.length + repairUser.length, maxOutputTokens: 4000 }, opts.budget.assumptions),
  });
  const scope = timeoutScope("request", label, opts.requestTimeoutMs, opts.signal);
  let text: string;
  try {
    const message = await client.messages.create(
      {
        model: opts.model,
        max_tokens: 4000,
        system: repairSystem,
        messages: [{ role: "user", content: repairUser }],
      },
      { signal: scope.signal, timeout: opts.headerTimeoutMs },
    );
    opts.budget.settle(reservation, {
      kind: "ok",
      usage: { inputTokens: message.usage.input_tokens ?? 0, outputTokens: message.usage.output_tokens ?? 0, cacheReadTokens: 0, webSearches: 0, webFetches: 0 },
    });
    accumulateUsage(opts.usage, {
      inputTokens: message.usage.input_tokens ?? 0, outputTokens: message.usage.output_tokens ?? 0,
      cacheReadTokens: 0, webSearches: 0, webFetches: 0, apiCalls: 1,
    });
    text = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
  } catch (raw) {
    let err: unknown = classifyAbort(raw, scope.signal);
    if (err === raw) {
      const fatal = classifyFatalApiError(raw);
      if (fatal) err = fatal;
    }
    if (err === raw && raw instanceof Anthropic.APIConnectionTimeoutError) {
      err = new ScoutTimeoutError("header", label, opts.headerTimeoutMs, scope.elapsedMs());
    }
    // A repair call is not streamed: an HTTP error means nothing ran; a timeout/abort might have been billed.
    opts.budget.settle(reservation, failureSettlement(raw, 0, null));
    if (err instanceof ScoutTimeoutError) logTimeout(opts.log, err, {});
    throw err;
  } finally {
    scope.cancel();
  }
  return parseModelJson(text, schema);
}
