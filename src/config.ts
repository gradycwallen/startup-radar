import { existsSync } from "node:fs";

/** The only event types V1 may produce. The database does not enforce this; the scout does. */
export const EVENT_TYPES = [
  "funding",
  "product_launch",
  "accelerator",
  "news",
  "open_source",
  "stealth",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const DEFAULTS = {
  /** Minimum confidence required before a candidate may be accepted. */
  minConfidence: 0.75,
  /** Maximum accepted NEW companies per run. */
  maxNew: 10,
  /** Maximum leads sent to (paid) verification per run. */
  maxCandidates: 20,
  /** Recency window given to discovery prompts. */
  recencyDays: 14,
  /** Events older than this are rejected as stale. */
  maxEventAgeDays: 45,
  concurrency: 2,
  leadsPerLane: 6,
  /** Founding years at or after this are preferred; earlier years need early-stage evidence. */
  preferredFoundedYear: 2021,
  /** Sanity floor for founded_year. */
  earliestFoundedYear: 1990,
} as const;

/**
 * Time and cost limits. Values come from the timeout diagnosis of the first live run, where a
 * single lane took 20.5 minutes. SDK timeouts only cover the wait for response headers, so every
 * wall-clock limit below is enforced by us with abort signals.
 */
export const LIMITS = {
  /** Hard wall-clock limit for ONE discovery Anthropic request (entire stream). */
  discoveryRequestMs: 6 * 60_000,
  /** Hard wall-clock limit for ONE verification Anthropic request (entire stream). */
  verificationRequestMs: 5 * 60_000,
  /** Cap for the tool-free JSON repair call. */
  repairRequestMs: 60_000,
  /** SDK pre-header timeout (time to first response headers, per attempt). */
  sdkHeaderTimeoutMs: 60_000,
  /** Total deadline for one discovery lane (all requests, continuations, repair). */
  laneMs: 9 * 60_000,
  /** Total deadline for one candidate's verification (all requests, continuations, repair). */
  candidateMs: 7 * 60_000,
  /** Soft deadline for the whole run: stop STARTING new work, let in-flight work finish. */
  runSoftDeadlineMs: 45 * 60_000,
  /** Cap on the content a single web_fetch may put into context (cost + latency control). */
  webFetchMaxContentTokens: 20_000,
  /** Wall-clock limit for ONE Supabase read (retries and backoff included). */
  dbReadMs: 15_000,
} as const;

export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

/** Maximum number of server-side tool uses per model request. Deliberately unchanged; do not raise. */
export const TOOL_CAPS = {
  discovery: { maxSearches: 6, maxFetches: 3 },
  verification: { maxSearches: 4, maxFetches: 5 },
} as const;

/**
 * Registrable domains that are sources/aggregators/platforms, never a company's canonical domain.
 * A candidate whose canonical domain lands here is rejected.
 */
export const DOMAIN_DENYLIST: ReadonlySet<string> = new Set([
  "techcrunch.com", "venturebeat.com", "crunchbase.com", "pitchbook.com", "dealroom.co",
  "linkedin.com", "twitter.com", "x.com", "facebook.com", "instagram.com", "youtube.com",
  "reddit.com", "medium.com", "substack.com", "wikipedia.org", "github.com", "gitlab.com",
  "ycombinator.com", "producthunt.com", "prnewswire.com", "businesswire.com",
  "globenewswire.com", "morningstar.com", "yahoo.com", "msn.com", "fortune.com",
  "bloomberg.com", "reuters.com", "forbes.com", "wired.com", "theinformation.com",
  "sifted.eu", "eu-startups.com", "arcticstartup.com", "geekwire.com", "axios.com",
  "google.com", "apple.com", "bebeez.eu", "wowtale.net", "citybiz.co",
]);

/** Load ./.env if present (Node's built-in loader; no dotenv dependency). */
export function loadEnvFile(path = ".env"): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

export interface SupabaseEnv {
  url: string;
  serviceRoleKey: string;
}

/**
 * Reduce a Supabase project URL to its origin. Users commonly paste it with a trailing slash or
 * an API path (".../", ".../rest/v1"); either breaks request URLs ("Invalid path specified").
 * Returns "" when the value is not an http(s) URL.
 */
export function normalizeSupabaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch {
    return "";
  }
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): {
  supabase: SupabaseEnv;
  missing: string[];
} {
  const missing: string[] = [];
  for (const name of ["ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!env[name]?.trim()) missing.push(name);
  }
  const url = normalizeSupabaseUrl(env.SUPABASE_URL);
  if (env.SUPABASE_URL?.trim() && !url) missing.push("SUPABASE_URL (not a valid http(s) URL)");
  return {
    supabase: {
      url,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "",
    },
    missing,
  };
}

/** Supabase-only credentials (the V2 funnel makes no Anthropic calls, so it does not need ANTHROPIC_API_KEY). */
export function readSupabaseEnv(env: NodeJS.ProcessEnv = process.env): { supabase: SupabaseEnv; missing: string[] } {
  const missing: string[] = [];
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!env[name]?.trim()) missing.push(name);
  const url = normalizeSupabaseUrl(env.SUPABASE_URL);
  if (env.SUPABASE_URL?.trim() && !url) missing.push("SUPABASE_URL (not a valid http(s) URL)");
  return { supabase: { url, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "" }, missing };
}

export interface RunConfig {
  dryRun: true; // Phase 1: always true. Writes do not exist yet.
  maxNew: number;
  maxCandidates: number;
  minConfidence: number;
  recencyDays: number;
  maxEventAgeDays: number;
  concurrency: number;
  leadsPerLane: number;
  lanes: string[] | undefined;
  logDir: string;
  limits: Limits;
  /** Per-run API budget ceiling in USD (never above ABSOLUTE_BUDGET_CEILING_USD). */
  budgetUsd: number;
}
