import { z } from "zod";
import type { CompanyContext, ResolutionMethod } from "./types.ts";

/**
 * ============================================================================================
 * ARCHITECTED, NOT WIRED IN. Nothing in V2-2A calls this. There is no code path anywhere in this
 * milestone that constructs an Anthropic client or spends budget — the static guard test
 * (test/signals.test.ts) asserts that directly. This file exists only to show where and how a
 * bounded AI fallback for entity resolution WOULD plug in later, per the V2-2A brief: "If a live
 * AI call is not necessary to prove V2-2A, do not make one merely to demonstrate it."
 * ============================================================================================
 *
 * When deterministic resolution (resolution.ts) finds a candidate that is linked from the
 * company's own site but neither independently confirmed nor a close enough name match — i.e. it
 * lands in `unresolved`, not a false positive — a genuinely ambiguous case might one day warrant
 * asking a model to look at the SAME evidence a human reviewer would (the candidate's public
 * profile text, the company's homepage text) and decide. Rules this must follow when built:
 *
 *  1. Deterministic resolution ALWAYS runs first and is authoritative when it succeeds; this is
 *     invoked only for the leftover `unresolved` cases resolution.ts already isolates.
 *  2. Exactly one call per (company, candidate) pair, ever — the result is written back to
 *     `signal_sources` (resolution_method: "ai_fallback") so the same ambiguity is never
 *     re-asked. Caching is a correctness requirement, not an optimization.
 *  3. The call is bounded and stateless: one non-streaming, tool-free completion (same shape as
 *     `repairJson` in src/claude.ts — reserve, timeout-scope, settle, no web_search/web_fetch),
 *     classifying a single candidate, not browsing or searching for more evidence itself.
 *  4. It NEVER collects a signal metric and NEVER computes a signal — only
 *     "is candidate X the same entity as company Y, yes/no/unsure, in one sentence why."
 *  5. It goes through the existing `BudgetGuard`/`ModelRouter`/`claude.ts` choke point like every
 *     other Anthropic call in this codebase — never a parallel client, never a bypassed reservation.
 *  6. Prefer the cheapest configured model (today: Haiku-class via ModelRouter) — this is a
 *     narrow classification task, not a task that benefits from a stronger model.
 *  7. A "yes" from this fallback is recorded at LOWER confidence than a deterministic
 *     "homepage_link_confirmed" match and should be visually/programmatically distinguishable
 *     downstream (resolution_method: "ai_fallback").
 */

export const AiResolutionVerdictSchema = z.object({
  is_same_entity: z.enum(["yes", "no", "unsure"]),
  reason: z.string(),
});
export type AiResolutionVerdict = z.infer<typeof AiResolutionVerdictSchema>;

export interface AiResolutionRequest {
  company: CompanyContext;
  candidateSourceType: string;
  candidateExternalId: string;
  /** Short, already-fetched public text about the candidate (e.g. a GitHub org's bio) — this
   * fallback must not itself go fetch more evidence; resolution.ts supplies exactly what a human
   * reviewer would see. */
  candidateEvidenceText: string;
}

/**
 * NOT IMPLEMENTED. Documents the eventual signature and the resolution_method it would produce.
 * Calling this throws — it exists so the type/shape is real and reviewable, not so it can run.
 */
export function resolveAmbiguousEntityWithAi(_req: AiResolutionRequest): Promise<{ verdict: AiResolutionVerdict; resolutionMethod: Extract<ResolutionMethod, "ai_fallback"> }> {
  throw new Error("resolveAmbiguousEntityWithAi is architected for a later milestone and is intentionally not implemented in V2-2A");
}
