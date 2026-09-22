import { DEFAULTS, EVENT_TYPES, type EventType } from "./config.ts";
import { isDenylistedDomain, normalizeDomain, normalizeUrl } from "./domain.ts";
import type { HomepageChecker } from "./http.ts";
import type { NormalizedCandidate, Verification } from "./schema.ts";

export interface ValidationContext {
  now: Date;
  minConfidence: number;
  maxEventAgeDays: number;
  preferredFoundedYear: number;
  checkHomepage: HomepageChecker;
  /** Aborts an in-progress homepage check on shutdown. */
  signal?: AbortSignal;
}

export type ValidationResult =
  | { ok: true; candidate: NormalizedCandidate; confidence: number; caps: string[]; notes: string[] }
  | { ok: false; reasons: string[]; confidence: number | null; caps: string[]; notes: string[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/** Strict YYYY-MM-DD that round-trips (rejects 2026-02-31). Returns the Date or null. */
export function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function clean(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

/**
 * Deterministic checks applied to whatever the verifier model claims. The model proposes;
 * this decides. Never throws for bad input: every problem becomes a rejection reason.
 *
 * @param retrievedUrls normalized URLs the pipeline knows were actually retrieved
 *   (search results, fetched pages, or the provider-attested lead source).
 */
export async function validateCandidate(
  v: Verification,
  retrievedUrls: ReadonlySet<string>,
  ctx: ValidationContext,
): Promise<ValidationResult> {
  const reasons: string[] = [];
  const caps: string[] = [];
  const notes: string[] = [];
  let cap = 1;
  const applyCap = (limit: number, why: string) => {
    if (limit < cap) cap = limit;
    caps.push(`${why}<=${limit}`);
  };

  // 1. Real company
  if (!v.is_real_company) reasons.push(`not_a_real_company${v.rejection_reason ? `: ${v.rejection_reason}` : ""}`);
  const name = clean(v.name);
  if (!name) reasons.push("missing_name");

  // 2. Domain
  const domain = normalizeDomain(v.canonical_url);
  if (!domain) reasons.push("invalid_or_missing_domain");
  else if (isDenylistedDomain(domain)) reasons.push(`denylisted_domain:${domain}`);

  // 3. Event type (V1 allowed set only)
  const eventType = v.event_type.trim().toLowerCase();
  if (!isEventType(eventType)) reasons.push(`invalid_event_type:${v.event_type}`);

  // 4. Source URL: required, https, and actually retrieved
  const sourceUrl = normalizeUrl(v.source_url);
  if (!sourceUrl) reasons.push("missing_or_invalid_source_url");
  else if (!retrievedUrls.has(sourceUrl)) reasons.push("source_url_not_retrieved");

  // 5. Event date: NULL is fine; if present it must be real, not future, not stale
  let eventDate: string | null = null;
  const rawDate = clean(v.event_date);
  if (rawDate) {
    const d = parseIsoDate(rawDate);
    if (!d) reasons.push(`invalid_event_date:${rawDate}`);
    else if (d.getTime() > ctx.now.getTime() + DAY_MS) reasons.push(`event_date_in_future:${rawDate}`);
    else if (ctx.now.getTime() - d.getTime() > ctx.maxEventAgeDays * DAY_MS) reasons.push(`stale_event:${rawDate}`);
    else eventDate = rawDate;
  }

  // 6. founded_year: keep only when evidenced and plausible; otherwise NULL (never a rejection)
  const currentYear = ctx.now.getUTCFullYear();
  let foundedYear: number | null = null;
  if (v.founded_year !== null) {
    if (!clean(v.founded_year_evidence)) notes.push("founded_year_dropped:no_evidence");
    else if (v.founded_year < DEFAULTS.earliestFoundedYear || v.founded_year > currentYear)
      notes.push(`founded_year_dropped:implausible(${v.founded_year})`);
    else foundedYear = v.founded_year;
  }

  // 7. Emerging-company eligibility
  if (v.is_public_or_large_mature || v.stage === "established")
    reasons.push("established_or_public_company");
  else if (foundedYear !== null && foundedYear >= ctx.preferredFoundedYear) notes.push("preferred_founded_year");
  else if (v.stage === "early_stage" && clean(v.stage_evidence)) {
    notes.push(foundedYear === null ? "early_stage_evidence_unknown_year" : `early_stage_evidence_founded_${foundedYear}`);
  } else {
    reasons.push(
      foundedYear === null
        ? "insufficient_early_stage_evidence"
        : `founded_${foundedYear}_without_early_stage_evidence`,
    );
  }

  // 8. Confidence sanity
  if (!Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) reasons.push(`invalid_confidence:${v.confidence}`);
  if (!clean(v.discovery_reason)) reasons.push("missing_discovery_reason");

  // 9. Homepage checks (only when there is a usable domain)
  if (domain && !isDenylistedDomain(domain)) {
    const hp = await ctx.checkHomepage(domain, ctx.signal);
    if (!hp.reachable) {
      applyCap(0.6, "homepage_unreachable");
      reasons.push(`homepage_unreachable:${hp.error ?? "unknown"}`);
    } else {
      if (hp.finalDomain && hp.finalDomain !== domain) {
        applyCap(0.7, "homepage_redirects_to_other_domain");
        reasons.push(`homepage_redirects_to_other_domain:${hp.finalDomain}`);
      }
      if (hp.text && name && !compact(hp.text).includes(compact(name))) {
        applyCap(0.85, "name_not_found_on_homepage");
      }
    }
  }

  // 10. Source independence: a company vouching for itself is weaker evidence
  if (domain && sourceUrl) {
    const srcDomain = normalizeDomain(sourceUrl);
    const independent = v.corroborating_urls
      .map((u) => normalizeUrl(u))
      .some((u) => u && retrievedUrls.has(u) && normalizeDomain(u) !== domain);
    if (srcDomain === domain && !independent) applyCap(0.8, "self_published_source_only");
  }

  const confidence = Number.isFinite(v.confidence) ? Math.min(v.confidence, cap) : null;
  if (confidence !== null && confidence < ctx.minConfidence) reasons.push(`confidence_below_${ctx.minConfidence}:${confidence.toFixed(2)}`);

  if (reasons.length > 0 || !domain || !name || !sourceUrl || confidence === null || !isEventType(eventType)) {
    return { ok: false, reasons, confidence, caps, notes };
  }

  const discoveryReason = clean(v.discovery_reason)!;
  return {
    ok: true,
    confidence,
    caps,
    notes,
    candidate: {
      company: {
        name,
        domain,
        description: clean(v.description),
        category: clean(v.category),
        discovery_source: clean(v.source_name),
        discovery_url: sourceUrl,
        confidence,
        discovery_reason: discoveryReason,
        founded_year: foundedYear,
      },
      event: {
        event_type: eventType,
        event_date: eventDate,
        source_name: clean(v.source_name),
        source_url: sourceUrl,
        headline: clean(v.headline),
        description: discoveryReason,
        confidence,
      },
    },
  };
}
