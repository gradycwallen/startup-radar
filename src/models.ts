import type { RawLead } from "./schema.ts";

export type PipelineStage = "discover" | "verify";

export interface ModelRequest {
  stage: PipelineStage;
  /** Present for verify requests, so a router can escalate ambiguous/high-value leads. */
  lead?: RawLead;
  /** 1 for the first attempt; a future router may escalate on attempt > 1. */
  attempt?: number;
}

/**
 * The single place model choice is made. The pipeline only ever asks the router,
 * so routing ambiguous/high-value cases to a stronger model later is a change to
 * this file, not to the pipeline.
 */
export interface ModelRouter {
  modelFor(req: ModelRequest): string;
}

export const DEFAULT_MODEL = "claude-sonnet-5";

export function createDefaultRouter(env: NodeJS.ProcessEnv = process.env): ModelRouter {
  const base = env.SCOUT_MODEL?.trim() || DEFAULT_MODEL;
  return {
    modelFor({ stage }) {
      if (stage === "discover") return env.SCOUT_DISCOVERY_MODEL?.trim() || base;
      return env.SCOUT_VERIFY_MODEL?.trim() || base;
    },
  };
}
