import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { noRedaction, type Redactor } from "./redact.ts";

/**
 * Per-run API cost ledger and hard budget guard.
 *
 * The guard is CONSERVATIVE by construction:
 *  - every Anthropic request must `reserve()` its estimated worst-case cost BEFORE it is sent;
 *    if committed spend + in-flight reservations + this estimate would exceed the ceiling, the request
 *    is refused and never sent;
 *  - estimates use pessimistic assumptions (see DEFAULT_ASSUMPTIONS) and a safety margin;
 *  - requests whose true cost is unknown (aborted, timed out, failed mid-stream) are charged their
 *    full reservation;
 *  - after any refusal the guard is `exhausted` and refuses everything else for the rest of the run.
 * The ceiling can never exceed ABSOLUTE_BUDGET_CEILING_USD.
 */

export const ABSOLUTE_BUDGET_CEILING_USD = 0.75;

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** USD per million tokens. From the Anthropic API reference cached 2026-06-24: verify against your billing page. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
};

/** A model missing from the table is priced at the MOST EXPENSIVE known rate, never a cheaper guess. */
export const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 10, outputPerMTok: 50 };

export function priceFor(model: string): ModelPrice & { known: boolean } {
  const base = model.replace(/-\d{8}$/, ""); // drop a date suffix such as -20251001
  const hit = MODEL_PRICES[base];
  return hit ? { ...hit, known: true } : { ...FALLBACK_PRICE, known: false };
}

export interface CostAssumptions {
  /** ASSUMPTION: per web_search charge. Historically $10 per 1,000 searches; verify against your billing. */
  webSearchUsd: number;
  webFetchUsd: number;
  /** Cache-read tokens are billed at this fraction of the input rate. */
  cacheReadFraction: number;
  /** Multiplier applied to every PRE-FLIGHT estimate (never to actual costs). */
  safetyMargin: number;
  charsPerToken: number;
  /**
   * Input tokens re-sent per server-side operation. Phase 1 measured 8K-24K (max 23.7K); 30K is the
   * pessimistic value used for estimates.
   */
  perOpInputTokens: number;
  /** Server-side operations per search/fetch use (dynamic filtering adds code-execution steps; Phase 1 saw up to 3.2). */
  opsPerToolUse: number;
}

export const DEFAULT_ASSUMPTIONS: Readonly<CostAssumptions> = {
  webSearchUsd: 0.01,
  webFetchUsd: 0,
  cacheReadFraction: 0.1,
  safetyMargin: 1.25,
  charsPerToken: 3,
  perOpInputTokens: 30_000,
  opsPerToolUse: 3,
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  webSearches: number;
  webFetches: number;
}

/** Actual cost of known usage (no safety margin). */
export function costOf(model: string, usage: TokenUsage, a: CostAssumptions = DEFAULT_ASSUMPTIONS): number {
  const p = priceFor(model);
  return (
    (usage.inputTokens / 1e6) * p.inputPerMTok +
    (usage.outputTokens / 1e6) * p.outputPerMTok +
    (usage.cacheReadTokens / 1e6) * p.inputPerMTok * a.cacheReadFraction +
    usage.webSearches * a.webSearchUsd +
    usage.webFetches * a.webFetchUsd
  );
}

export interface Estimate {
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  webFetches: number;
  /** Worst-case cost including the safety margin. */
  usd: number;
  basis: string;
}

/** A single request with no tools: cost is bounded by prompt size and max_tokens. */
export function estimateSingleShot(
  args: { model: string; promptChars: number; maxOutputTokens: number },
  a: CostAssumptions = DEFAULT_ASSUMPTIONS,
): Estimate {
  const inputTokens = Math.ceil(args.promptChars / a.charsPerToken);
  const usage = { inputTokens, outputTokens: args.maxOutputTokens, cacheReadTokens: 0, webSearches: 0, webFetches: 0 };
  return { ...usage, usd: costOf(args.model, usage, a) * a.safetyMargin, basis: "single-shot: prompt chars/3 + max_tokens" };
}

/**
 * A request using server-side web tools. The tool loop re-sends its growing context on every step,
 * so input scales with the number of operations, not with the prompt. Calibrated against Phase 1
 * (max 585K input for a 6-search/3-fetch lane; 303K for a 4/5 verification).
 */
export function estimateWebToolRequest(
  args: { model: string; promptChars: number; maxOutputTokens: number; caps: { maxSearches: number; maxFetches: number } },
  a: CostAssumptions = DEFAULT_ASSUMPTIONS,
): Estimate {
  const promptTokens = Math.ceil(args.promptChars / a.charsPerToken);
  const ops = Math.ceil(a.opsPerToolUse * (args.caps.maxSearches + args.caps.maxFetches));
  const inputTokens = (ops + 1) * promptTokens + ops * a.perOpInputTokens;
  const usage = {
    inputTokens, outputTokens: args.maxOutputTokens, cacheReadTokens: 0,
    webSearches: args.caps.maxSearches, webFetches: args.caps.maxFetches,
  };
  return { ...usage, usd: costOf(args.model, usage, a) * a.safetyMargin, basis: `web-tool loop: ${ops} ops x ${a.perOpInputTokens} tokens` };
}

// ---------------------------------------------------------------------------------------------

export class BudgetRefusalError extends Error {
  override readonly name = "BudgetRefusalError";
  constructor(
    readonly label: string,
    readonly estimatedUsd: number,
    readonly remainingUsd: number,
    readonly ceilingUsd: number,
    readonly why: "estimate_exceeds_remaining" | "exhausted_by_earlier_refusal",
  ) {
    super(
      why === "estimate_exceeds_remaining"
        ? `budget refused "${label}": worst-case estimate $${estimatedUsd.toFixed(4)} exceeds remaining $${remainingUsd.toFixed(4)} of the $${ceilingUsd.toFixed(2)} ceiling`
        : `budget refused "${label}": an earlier request was refused, so no further API operations are started this run`,
    );
  }
}

export interface ReserveRequest {
  label: string;
  stage: string;
  model: string;
  estimate: Estimate;
}

export interface Reservation {
  readonly seq: number;
  readonly label: string;
  readonly stage: string;
  readonly model: string;
  readonly reservedUsd: number;
}

export type Settlement =
  /** The response reported its usage: charge exactly that. */
  | { kind: "ok"; usage: TokenUsage; requestId?: string | null }
  /** The API rejected the request before doing any work (HTTP error, no stream started): charge nothing. */
  | { kind: "no_charge"; note: string }
  /** Cost cannot be known (aborted, timed out, failed mid-stream): charge the full reservation. */
  | { kind: "unknown"; note: string; requestId?: string | null };

export interface CostEntry {
  seq: number;
  label: string;
  stage: string;
  model: string;
  reserved_at: string;
  settled_at: string | null;
  estimate: Estimate;
  reserved_usd: number;
  outcome: "in_flight" | "ok" | "no_charge" | "unknown_cost_charged_reservation" | "refused";
  actual: (TokenUsage & { usd: number }) | null;
  charged_usd: number;
  /** True when the real cost exceeded what we reserved (the estimate was too low). */
  underestimated: boolean;
  request_id: string | null;
  note: string | null;
}

export interface CostSummary {
  ceiling_usd: number;
  committed_usd: number;
  in_flight_usd: number;
  remaining_usd: number;
  ceiling_exceeded: boolean;
  exhausted: boolean;
  refused_count: number;
  requests: number;
  estimated_usd_total: number;
  actual_usd_known: number;
  by_stage: Record<string, { requests: number; charged_usd: number; actual_usd: number }>;
  files: { jsonl: string | null; json: string | null };
  price_note: string;
}

export interface BudgetOptions {
  ceilingUsd?: number;
  assumptions?: Partial<CostAssumptions>;
  persist?: { dir: string; runId: string; redact?: Redactor };
  now?: () => Date;
}

const USD_EPS = 1e-9;

export class BudgetGuard {
  readonly ceilingUsd: number;
  readonly assumptions: Readonly<CostAssumptions>;
  readonly #entries: CostEntry[] = [];
  readonly #observedMaxActual = new Map<string, number>();
  readonly #now: () => Date;
  readonly #redact: Redactor;
  readonly #jsonlPath: string | null;
  readonly #jsonPath: string | null;
  readonly #runId: string;
  #committed = 0;
  #inFlight = 0;
  #exhausted = false;
  #closed = false;

  constructor(options: BudgetOptions = {}) {
    const ceiling = options.ceilingUsd ?? ABSOLUTE_BUDGET_CEILING_USD;
    if (!(ceiling > 0) || ceiling > ABSOLUTE_BUDGET_CEILING_USD) {
      throw new Error(`budget ceiling must be > 0 and at most the absolute ceiling of $${ABSOLUTE_BUDGET_CEILING_USD.toFixed(2)} (got ${ceiling})`);
    }
    this.ceilingUsd = ceiling;
    this.assumptions = { ...DEFAULT_ASSUMPTIONS, ...options.assumptions };
    this.#now = options.now ?? (() => new Date());
    this.#redact = options.persist?.redact ?? noRedaction;
    this.#runId = options.persist?.runId ?? "unsaved";
    if (options.persist) {
      mkdirSync(options.persist.dir, { recursive: true });
      this.#jsonlPath = join(options.persist.dir, `${options.persist.runId}.cost.jsonl`);
      this.#jsonPath = join(options.persist.dir, `${options.persist.runId}.cost.json`);
      appendFileSync(this.#jsonlPath, ""); // the artifact exists even for a run that never makes an API request
    } else {
      this.#jsonlPath = null;
      this.#jsonPath = null;
    }
  }

  get committedUsd(): number { return this.#committed; }
  get inFlightUsd(): number { return this.#inFlight; }
  get remainingUsd(): number { return this.ceilingUsd - this.#committed - this.#inFlight; }
  /** True once any request was refused: no further API operation may start this run. */
  get exhausted(): boolean { return this.#exhausted; }

  #persist(event: string, entry: CostEntry): void {
    if (!this.#jsonlPath) return;
    appendFileSync(this.#jsonlPath, this.#redact(JSON.stringify({ ts: this.#now().toISOString(), event, ...entry })) + "\n");
  }

  /** Estimate raised to the highest actual cost already observed for this stage (x1.25), so a bad static estimate self-corrects. */
  #calibrate(stage: string, est: Estimate): Estimate {
    const seen = this.#observedMaxActual.get(stage);
    if (seen === undefined) return est;
    const floor = seen * 1.25;
    return floor > est.usd ? { ...est, usd: floor, basis: `${est.basis}; raised to 1.25x the largest ${stage} cost seen this run` } : est;
  }

  reserve(req: ReserveRequest): Reservation {
    const estimate = this.#calibrate(req.stage, req.estimate);
    const seq = this.#entries.length + 1;
    const base = {
      seq, label: req.label, stage: req.stage, model: req.model, reserved_at: this.#now().toISOString(),
      settled_at: null, estimate, actual: null, underestimated: false, request_id: null, note: null,
    };
    const remaining = this.remainingUsd;
    const refuse = (why: "estimate_exceeds_remaining" | "exhausted_by_earlier_refusal"): never => {
      this.#exhausted = true;
      const entry: CostEntry = { ...base, reserved_usd: 0, outcome: "refused", charged_usd: 0, settled_at: base.reserved_at, note: why };
      this.#entries.push(entry);
      this.#persist("refused", entry);
      throw new BudgetRefusalError(req.label, estimate.usd, remaining, this.ceilingUsd, why);
    };
    if (this.#exhausted) refuse("exhausted_by_earlier_refusal");
    if (estimate.usd > remaining + USD_EPS) refuse("estimate_exceeds_remaining");

    const entry: CostEntry = { ...base, reserved_usd: estimate.usd, outcome: "in_flight", charged_usd: 0 };
    this.#entries.push(entry);
    this.#inFlight += estimate.usd;
    this.#persist("reserved", entry);
    return { seq, label: req.label, stage: req.stage, model: req.model, reservedUsd: estimate.usd };
  }

  settle(res: Reservation, settlement: Settlement): void {
    const entry = this.#entries[res.seq - 1];
    if (!entry || entry.outcome !== "in_flight") return; // settling twice is a no-op
    let charged: number;
    switch (settlement.kind) {
      case "ok": {
        const usd = costOf(res.model, settlement.usage, this.assumptions);
        entry.actual = { ...settlement.usage, usd };
        entry.outcome = "ok";
        entry.request_id = settlement.requestId ?? null;
        entry.underestimated = usd > res.reservedUsd + USD_EPS;
        charged = usd; // the real cost, even if it exceeds what was reserved
        this.#observedMaxActual.set(res.stage, Math.max(this.#observedMaxActual.get(res.stage) ?? 0, usd));
        break;
      }
      case "no_charge":
        entry.outcome = "no_charge";
        entry.note = settlement.note;
        charged = 0;
        break;
      case "unknown":
        entry.outcome = "unknown_cost_charged_reservation";
        entry.note = settlement.note;
        entry.request_id = settlement.requestId ?? null;
        charged = res.reservedUsd;
        break;
    }
    entry.charged_usd = charged;
    entry.settled_at = this.#now().toISOString();
    this.#inFlight = Math.max(0, this.#inFlight - res.reservedUsd);
    this.#committed += charged;
    this.#persist("settled", entry);
  }

  entries(): readonly CostEntry[] {
    return this.#entries;
  }

  snapshot(): CostSummary {
    const by_stage: CostSummary["by_stage"] = {};
    let estimated = 0;
    let actual = 0;
    for (const e of this.#entries) {
      const s = (by_stage[e.stage] ??= { requests: 0, charged_usd: 0, actual_usd: 0 });
      if (e.outcome !== "refused") {
        s.requests++;
        s.charged_usd += e.charged_usd;
        estimated += e.estimate.usd;
      }
      if (e.actual) {
        s.actual_usd += e.actual.usd;
        actual += e.actual.usd;
      }
    }
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    for (const s of Object.values(by_stage)) {
      s.charged_usd = round(s.charged_usd);
      s.actual_usd = round(s.actual_usd);
    }
    return {
      ceiling_usd: this.ceilingUsd,
      committed_usd: round(this.#committed),
      in_flight_usd: round(this.#inFlight),
      remaining_usd: round(this.remainingUsd),
      ceiling_exceeded: this.#committed > this.ceilingUsd + USD_EPS,
      exhausted: this.#exhausted,
      refused_count: this.#entries.filter((e) => e.outcome === "refused").length,
      requests: this.#entries.filter((e) => e.outcome !== "refused").length,
      estimated_usd_total: round(estimated),
      actual_usd_known: round(actual),
      by_stage,
      files: { jsonl: this.#jsonlPath, json: this.#jsonPath },
      price_note: "Model prices from the Anthropic API reference cached 2026-06-24; web search fee is an assumption. Verify against billing.",
    };
  }

  /** Write the consolidated ledger. Idempotent; safe to call from a shutdown path. */
  close(): void {
    if (!this.#jsonPath) return;
    const body = { run_id: this.#runId, assumptions: this.assumptions, summary: this.snapshot(), entries: this.#entries };
    writeFileSync(this.#jsonPath, this.#redact(JSON.stringify(body, null, 2)));
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }
}
