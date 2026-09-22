import type { UsageSummary } from "../claude.ts";
import type { FatalApiError } from "../fatal.ts";
import type { RunClock } from "../deadline.ts";
import type { Logger } from "../log.ts";
import type { RawLead } from "../schema.ts";

export interface DiscoveryContext {
  today: Date;
  recencyDays: number;
  leadsPerLane: number;
  /** Restrict to these lane ids (provider-defined). Undefined = all lanes. */
  lanes?: string[];
  /** Total deadline for one lane (all its requests, continuations and repair). */
  laneMs: number;
  /** Aborts on shutdown. Providers must stop in-flight work and start nothing new when it fires. */
  signal: AbortSignal;
  /** Soft run deadline: once reached, providers must not START another lane (in-flight work finishes). */
  clock: RunClock;
  log: Logger;
  /**
   * Providers call this with each batch of raw leads AS SOON AS they are found (per lane), so the
   * run's lead ledger is written before selection, verification or any later failure.
   */
  onLeads?: (leads: RawLead[]) => void;
}

export interface ProviderError {
  lane: string;
  message: string;
}

export type LaneStatus =
  | "ok"
  | "failed"
  | "timeout"
  | "aborted" // cut short by shutdown
  | "skipped_run_deadline"
  | "skipped_shutdown"
  | "skipped_fatal" // an earlier fatal API error (credit/auth/permission) stopped all Anthropic work
  | "skipped_budget"; // the budget guard refused to start it, or an earlier refusal exhausted the budget

export interface LaneReport {
  lane: string;
  status: LaneStatus;
  elapsed_ms: number;
  leads: number;
  usage: UsageSummary;
  /** Present for status "timeout": exactly what timed out. */
  timeout?: { kind: string; label: string; limit_ms: number; elapsed_ms: number };
  error?: string;
}

export interface ProviderResult {
  leads: RawLead[];
  errors: ProviderError[];
  lanes: LaneReport[];
  usage?: UsageSummary;
  /** Set when a fatal API error ended discovery; the run must stop and exit non-zero. */
  fatal?: FatalApiError;
}

/**
 * A source of raw startup leads. The rest of the pipeline (verification, validation,
 * de-duplication, persistence) depends only on this interface and on RawLead, never on how
 * a provider finds leads. Future providers (news feeds, accelerator lists, GitHub, Product Hunt,
 * funding APIs) implement this and are registered in main.ts; nothing downstream changes.
 *
 * Lanes run SERIALLY. A provider must honor `signal` (shutdown), `laneMs` and `clock`.
 */
export interface DiscoveryProvider {
  readonly name: string;
  /** Lane ids this provider understands, for --lanes validation and help text. */
  readonly lanes: readonly string[];
  discover(ctx: DiscoveryContext): Promise<ProviderResult>;
}
