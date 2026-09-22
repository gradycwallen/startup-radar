import type { Entity, Evidence } from "../funnel/entities.ts";
import { primaryProvider, publisherReliability, type RankedEntity } from "../funnel/rank.ts";

/**
 * The deterministic accept/reject rule for automated persistence, and the (also deterministic,
 * zero-AI) mapping from a ranked funnel entity to the rows that would be written.
 *
 * The rule is intentionally almost nothing new: `finalist === true` already means the entity
 * survived deterministic prefiltering (src/funnel/prefilter.ts — rejects funds/investors, known
 * large companies, programs, public companies, late rounds), deterministic ranking, and
 * diversity-constrained selection (src/funnel/rank.ts). Duplicating any of that here would be
 * exactly the "duplicate logic" the brief says not to do. The ONE thing V2-1.1 adds on top is the
 * domain gate: a wrong domain is worse than a missed company, so an unresolved domain blocks
 * persistence even for an otherwise-accepted finalist.
 */

export type RejectionReason = "not_finalist" | "unresolved_domain";

export interface CompanyInsert {
  name: string;
  domain: string;
  description: null; // no deterministic source exists for this yet — never fabricated, see accept() doc
  category: null; // same
  discovery_source: string | null;
  discovery_url: string;
  /** The funnel's own 0-100 ranking score, normalized to 0-1. NOT the same concept as Phase 1's
   * Claude-reported confidence (a probability-of-truth judgment) — this is a transparent,
   * deterministic relevance/momentum score. Disclosed explicitly, not silently conflated. */
  confidence: number;
  discovery_reason: string;
  founded_year: null; // no deterministic source for this either
}

export interface EventInsert {
  event_type: string;
  event_date: string | null;
  source_name: string | null;
  source_url: string;
  headline: string | null;
  description: string | null;
  confidence: number;
}

export interface AcceptedCandidate {
  entity_id: string;
  name: string;
  domain: string;
  track: "news" | "directory";
  score: number;
  company: CompanyInsert;
  events: EventInsert[];
}

export type CandidateEvaluation = { accepted: AcceptedCandidate } | { rejected: RejectionReason };

const ROUND_LABEL: Record<string, string> = {
  pre_seed: "a pre-seed round", seed: "a seed round", series_a: "a Series A round", pre_series_a: "a pre-Series A round",
  angel: "an angel round", series_b: "a Series B round", bridge: "a bridge round", grant: "a grant", debt: "debt financing", convertible: "a convertible round",
};

function fmtAmount(usd: number): string {
  const m = usd / 1e6;
  return m >= 1 ? `$${m.toFixed(m < 10 ? 1 : 0)}M` : `$${Math.round(usd / 1000)}K`;
}

const EVENT_LABEL: Record<string, string> = {
  funding: "raised funding", stealth: "emerged from stealth", accelerator: "joined an accelerator cohort",
  product_launch: "launched a product", open_source: "released an open-source project", news: "was covered in the news",
};

/**
 * A short, deterministic, evidence-grounded sentence — built entirely from structured fields
 * already on the entity. Never invents a fact the evidence doesn't state.
 *
 * Deliberately uses the PRIMARY evidence item's OWN round/amount (`primary.round`/
 * `primary.amount_usd`), never `entity.round`/`entity.amount_usd` (the entity-level fields, which
 * are the BEST round/amount found across ALL of the entity's merged evidence — possibly from a
 * different source/event entirely). A multi-lane entity can genuinely hold both, say, a YC
 * accelerator listing AND a separate, later funding article; quoting the funding article's amount
 * while describing the accelerator listing's headline would misattribute one fact to the other
 * ("joined an accelerator cohort of $150M" reads as if the accelerator itself were sized $150M).
 * Tying the qualifier to the SAME evidence item as the quoted headline keeps every clause
 * traceable to one real source, not a cross-evidence blend.
 */
export function discoveryReasonFor(entity: Entity, primary: Evidence): string {
  const action = EVENT_LABEL[primary.event_type ?? ""] ?? "was discovered";
  const qualifiers: string[] = [];
  if (primary.round) qualifiers.push(ROUND_LABEL[primary.round] ?? `a ${primary.round.replace(/_/g, " ")} round`);
  if (primary.amount_usd) qualifiers.push(`of ${fmtAmount(primary.amount_usd)}`);
  const qualifier = qualifiers.length ? ` ${qualifiers.join(" ")}` : "";
  const source = primary.source_name ?? primary.provider;
  const headline = primary.title ? ` — "${primary.title}"` : "";
  return `${entity.name} ${action}${qualifier}, per ${source}${headline}.`;
}

function eventDateOf(evidence: Evidence): string | null {
  // discovery_events.event_date is a DATE column; published_at is an ISO timestamp — take only the date part, never invent one.
  return evidence.published_at ? evidence.published_at.slice(0, 10) : null;
}

function eventDescriptionFor(evidence: Evidence): string | null {
  const bits: string[] = [];
  if (evidence.round) bits.push(ROUND_LABEL[evidence.round] ?? evidence.round.replace(/_/g, " "));
  if (evidence.amount_usd) bits.push(fmtAmount(evidence.amount_usd));
  return bits.length ? bits.join(", ") : null;
}

/** Builds the rows an accepted candidate WOULD produce. One event per distinct source_url in the
 * entity's evidence — corroborating sources are preserved independently, never collapsed into one
 * opaque record (per the brief; and matches discovery_events' own `unique(company_id, source_url)`). */
export function buildCandidate(r: RankedEntity): AcceptedCandidate {
  const entity = r.entity;
  const domain = entity.domain.domain as string; // caller has already checked this is non-null
  const primary = entity.evidence[0] as Evidence; // clusterLeads always sorts primary evidence first
  const provider = primaryProvider(r);
  const confidence = Math.max(0, Math.min(1, r.score / 100));

  const seenUrls = new Set<string>();
  const events: EventInsert[] = [];
  for (const ev of entity.evidence) {
    if (seenUrls.has(ev.source_url)) continue;
    seenUrls.add(ev.source_url);
    events.push({
      event_type: ev.event_type ?? "news",
      event_date: eventDateOf(ev),
      source_name: ev.source_name,
      source_url: ev.source_url,
      headline: ev.title,
      description: eventDescriptionFor(ev),
      confidence: Math.max(0, Math.min(1, publisherReliability(ev.source_key, 0.5, ev.provider))),
    });
  }

  return {
    entity_id: entity.entity_id, name: entity.name, domain, track: r.track, score: r.score,
    company: {
      name: entity.name, domain, description: null, category: null, discovery_source: provider, discovery_url: primary.source_url,
      confidence, discovery_reason: discoveryReasonFor(entity, primary), founded_year: null,
    },
    events,
  };
}

/** The one place the accept/reject decision is made. */
export function evaluateCandidate(r: RankedEntity): CandidateEvaluation {
  if (!r.finalist) return { rejected: "not_finalist" };
  if (!r.entity.domain.domain) return { rejected: "unresolved_domain" };
  return { accepted: buildCandidate(r) };
}
