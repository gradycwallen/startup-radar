import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPipeline, type PipelineDeps, type RunSummary } from "./pipeline.ts";
import type { ShutdownHandle } from "./shutdown.ts";

export type RunDeps = Omit<PipelineDeps, "signal"> & { shutdown: ShutdownHandle };

export interface RunOutcome {
  summary: RunSummary;
  summaryFile: string;
  exitCode: number;
}

/** Process exit codes. Signals use 130 (SIGINT) / 143 (SIGTERM). */
export const EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  DB_CHANGED: 3,
  /** Insufficient credit, authentication or permission failure: nothing was retried or continued. */
  FATAL_API_ERROR: 4,
  /** The per-run budget ceiling stopped further API operations; results are partial. */
  BUDGET_CEILING: 5,
} as const;

export function exitCodeFor(summary: RunSummary, shutdown: ShutdownHandle): number {
  if (summary.status === "interrupted") return shutdown.exitCode() ?? 130;
  if (summary.fatal_error) return EXIT.FATAL_API_ERROR;
  if (summary.db_unchanged === false) return EXIT.DB_CHANGED;
  if (summary.status === "failed") return EXIT.FAILED;
  if (summary.status === "stopped_at_budget") return EXIT.BUDGET_CEILING;
  if (summary.leads_discovered === 0 && summary.provider_errors.length > 0) return EXIT.FAILED;
  return EXIT.OK;
}

/**
 * Runs the pipeline, ALWAYS writes the summary plus the lead and cost ledgers (complete or partial),
 * and decides the exit code. Phase 1 / V2-0: read-only. There is no write path.
 */
export async function executeRun(deps: RunDeps): Promise<RunOutcome> {
  const { shutdown, ...pipelineDeps } = deps;
  try {
    const summary = await runPipeline({ ...pipelineDeps, signal: shutdown.signal });
    const summaryFile = join(deps.config.logDir, `${summary.run_id}.summary.json`);
    writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
    deps.log.info("run_end", {
      message: `${summary.status} in ${summary.run_elapsed_ms}ms${summary.stop_reason ? ` (${summary.stop_reason})` : ""}, cost $${summary.cost.committed_usd.toFixed(4)} of $${summary.cost.ceiling_usd.toFixed(2)}`,
      status: summary.status, stop_reason: summary.stop_reason, elapsed_ms: summary.run_elapsed_ms,
      counts: summary.counts, usage: summary.usage, cost: summary.cost, lead_ledger: summary.lead_ledger,
      timeouts: summary.timeouts, summary_file: summaryFile,
    });
    return { summary, summaryFile, exitCode: exitCodeFor(summary, shutdown) };
  } finally {
    // Even if the pipeline threw before it could build a summary, leave the audit files complete on disk.
    deps.ledger.finalizeOpen("run_aborted_unexpectedly");
    deps.ledger.close();
    deps.budget.close();
  }
}
