import { z } from "zod";
import { EVENT_TYPES } from "./config.ts";

export const EventTypeSchema = z.enum(EVENT_TYPES);

/**
 * What deterministic extraction learned about a lead. Every field records how it was obtained, so ranking and later
 * verification can see exactly what was inferred (nothing here comes from an LLM).
 */
export const ExtractedSchema = z.object({
  item_id: z.string(),
  company_name: z.string(),
  /** Where the company name came from: an explicit structured field, or the headline's grammatical subject. */
  name_from: z.enum(["structured", "headline"]),
  event_type: z.string(),
  round: z.string().nullable(),
  amount_usd: z.number().nullable(),
  amount_text: z.string().nullable(),
  currency: z.string().nullable(),
  young_signals: z.array(z.string()),
  mature_signals: z.array(z.string()),
  /** The extraction patterns that matched, e.g. ["stealth_verb", "amount_in_title"]. */
  patterns: z.array(z.string()),
});
export type Extracted = z.infer<typeof ExtractedSchema>;

/** What a discovery provider hands to the rest of the pipeline. Provider-agnostic. */
export const RawLeadSchema = z.object({
  provider: z.string(),
  lane: z.string(),
  name: z.string().min(1),
  homepage_hint: z.string().nullable().optional(),
  event_type_hint: z.string().nullable().optional(),
  source_url: z.string().min(1),
  source_name: z.string().nullable().optional(),
  event_date: z.string().nullable().optional(),
  headline: z.string().nullable().optional(),
  snippet: z.string().nullable().optional(),
  /** Provider attests it actually retrieved source_url (not a guess). */
  source_retrieved: z.boolean(),
  // ---- V2-1 additions (all optional so V2-0 snapshots and the Claude provider stay valid) ----
  published_at: z.string().nullable().optional(),
  /** Registrable domains that might be the company's own site (unscored). */
  domain_candidates: z.array(z.string()).optional(),
  /** How trustworthy the homepage_hint is: an explicit directory field, a domain-shaped name, or nothing. */
  domain_trust: z.enum(["structured", "name"]).nullable().optional(),
  extracted: ExtractedSchema.optional(),
});
export type RawLead = z.infer<typeof RawLeadSchema>;

/** Shape the discovery model must return per lead (provider fields are added by the provider). */
export const ModelLeadSchema = z.object({
  name: z.string().min(1),
  homepage_hint: z.string().nullable().optional(),
  event_type_hint: z.string().nullable().optional(),
  source_url: z.string().min(1),
  source_name: z.string().nullable().optional(),
  event_date: z.string().nullable().optional(),
  headline: z.string().nullable().optional(),
  snippet: z.string().nullable().optional(),
});
export const ModelLeadsSchema = z.object({ leads: z.array(ModelLeadSchema) });

export const StageSchema = z.enum(["early_stage", "established", "unknown"]);

/** What the verifier model must return for one lead. Unverified facts must be null. */
export const VerificationSchema = z.object({
  is_real_company: z.boolean(),
  rejection_reason: z.string().nullable().optional(),
  name: z.string(),
  canonical_url: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  event_type: z.string(),
  event_date: z.string().nullable(),
  source_url: z.string(),
  source_name: z.string().nullable(),
  headline: z.string().nullable(),
  founded_year: z.number().int().nullable(),
  founded_year_evidence: z.string().nullable(),
  stage: StageSchema,
  stage_evidence: z.string().nullable(),
  is_public_or_large_mature: z.boolean(),
  confidence: z.number(),
  discovery_reason: z.string(),
  corroborating_urls: z.array(z.string()).default([]),
  notes: z.string().nullable().optional(),
});
export type Verification = z.infer<typeof VerificationSchema>;

/** A candidate that passed deterministic validation, shaped for the (future) database writes. */
export interface NormalizedCandidate {
  company: {
    name: string;
    domain: string;
    description: string | null;
    category: string | null;
    discovery_source: string | null;
    discovery_url: string;
    confidence: number;
    discovery_reason: string;
    founded_year: number | null;
  };
  event: {
    event_type: z.infer<typeof EventTypeSchema>;
    event_date: string | null;
    source_name: string | null;
    source_url: string;
    headline: string | null;
    description: string;
    confidence: number;
  };
}
