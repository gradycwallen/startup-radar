import { z } from "zod";

/**
 * V2-2A signal-foundation types. See root CLAUDE.md and the V2-2A report for the architecture.
 *
 * Layering (do not collapse):
 *   COMPANY FACTS     -> public.companies (unchanged, V2-1)
 *   SOURCE IDENTITY    -> SignalSource   ("where we know to observe this company")
 *   RAW OBSERVATION     -> Observation    ("what a source reported at a point in time" — append-only)
 *   DERIVED SIGNAL       -> Signal         ("a deterministic, explainable change" — recomputable from observations)
 *   NARRATIVE EVENT        -> public.discovery_events (unchanged, V2-1; not touched by V2-2A)
 */

// ---- signal sources ---------------------------------------------------------------------------------------------

// V2-2B.2: "website" added — one source per company, identity = the company's own canonical
// domain (see signals/website/source.ts). Unlike GitHub/ATS sources, a website source needs no
// link-scanning "resolution" step; see orchestrate.ts for why it's created unconditionally.
export const SOURCE_TYPES = ["github_org", "github_repo", "greenhouse", "lever", "ashby", "website"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

// V2-2B.2: "company_domain" added — the website source's resolution method. Deliberately distinct
// from "manual" (a human didn't do this) and from the homepage_link_* methods (nothing was linked
// from anywhere; the source IS the company's own domain field, already known with certainty).
export const RESOLUTION_METHODS = ["homepage_link_confirmed", "homepage_link_name_match", "ai_fallback", "manual", "company_domain"] as const;
export type ResolutionMethod = (typeof RESOLUTION_METHODS)[number];

export const SignalSourceSchema = z.object({
  id: z.number().nullable(), // null until persisted
  company_id: z.number(),
  source_type: z.enum(SOURCE_TYPES),
  external_id: z.string().min(1),
  canonical_url: z.string().nullable(),
  resolution_method: z.enum(RESOLUTION_METHODS),
  resolution_confidence: z.number().min(0).max(1),
  resolution_evidence: z.string().min(1),
  active: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type SignalSource = z.infer<typeof SignalSourceSchema>;

// ---- observations (append-only) ---------------------------------------------------------------------------------

export const ObservationSchema = z.object({
  id: z.number().nullable(),
  company_id: z.number(),
  signal_source_id: z.number(),
  metric_name: z.string().min(1),
  numeric_value: z.number().nullable(),
  text_value: z.string().nullable(),
  observed_at: z.string(), // ISO — when WE captured it
  source_timestamp: z.string().nullable(), // ISO — when the source says it changed, if known
  collection_version: z.string().min(1),
  raw_payload_ref: z.string().nullable(),
  // V2-2B.2: small, normalized evidence (resolution method, path, final URL, status, truncated
  // title/H1, verification checks, language, nav-link count, nav_fingerprint) — NEVER raw HTML,
  // body text, or screenshots. Requires the additive `observations.metadata` migration (§19 of the
  // V2-2B.2 design report) before store.ts can actually persist it; nullable/optional here so
  // every OTHER collector (github/ats), which never sets it, is unaffected.
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

// ---- signals (derived, recomputable) ------------------------------------------------------------------------------

// V2-2B.2: "website" added. See rules/website.ts for its signal types; families.ts's
// distinct-family counting means any number of website signals still count as ONE family, exactly
// like a rich GitHub history counts as one "github" — see the design report §22/§23.
export const SIGNAL_FAMILIES = ["hiring", "github", "website"] as const;
export type SignalFamily = (typeof SIGNAL_FAMILIES)[number];

export const SignalSchema = z.object({
  id: z.number().nullable(),
  company_id: z.number(),
  family: z.enum(SIGNAL_FAMILIES),
  signal_type: z.string().min(1),
  window_days: z.number().int().positive(),
  from_observation_id: z.number().nullable(),
  to_observation_id: z.number().nullable(),
  from_value: z.number().nullable(),
  to_value: z.number().nullable(),
  delta: z.number().nullable(),
  relative_change: z.number().nullable(),
  rule_version: z.string().min(1),
  explanation: z.string().min(1),
  fired_at: z.string(), // ISO
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type DerivedSignal = z.infer<typeof SignalSchema>;

// ---- company context passed into collectors/resolution ------------------------------------------------------------

/** The slice of a `companies` row the signals layer needs. Deliberately narrow and independent of
 * src/dedupe.ts's CompanyRow — V2-2A must not couple to V2-1 discovery internals. */
export interface CompanyContext {
  id: number;
  name: string;
  domain: string;
}
