import type { Entity, Evidence } from "../../../src/funnel/entities.ts";
import type { RankedEntity, ScoreBreakdown } from "../../../src/funnel/rank.ts";
import type { RawLead } from "../../../src/schema.ts";

const EMPTY_BREAKDOWN = {} as ScoreBreakdown;

export interface EvidenceInput {
  provider?: string;
  lane?: string;
  source_url: string;
  source_name?: string | null;
  title?: string | null;
  published_at?: string | null;
  event_type?: string | null;
  round?: string | null;
  amount_usd?: number | null;
}

let nextLeadId = 1;
/** `undefined` means "use the default"; an explicit `null` means "this field really is absent" and
 * must be honored, not silently replaced — a plain `??` would get this wrong for every nullable
 * field here (`null ?? default` evaluates to `default`, which is exactly NOT what a test asking
 * for "no published date"/"no round"/etc. wants). */
function withDefault<T>(value: T | null | undefined, fallback: T): T | null {
  return value === undefined ? fallback : value;
}

function makeEvidence(input: EvidenceInput): Evidence {
  return {
    lead_id: `lead-${nextLeadId++}`,
    provider: input.provider ?? "techcrunch-startups",
    lane: input.lane ?? "funding",
    source_url: input.source_url,
    source_name: withDefault(input.source_name, "TechCrunch"),
    source_key: (input.source_name ?? input.provider ?? "techcrunch").toLowerCase(),
    title: withDefault(input.title, "A company raises funding"),
    published_at: withDefault(input.published_at, "2026-09-20T00:00:00Z"),
    event_type: withDefault(input.event_type, "funding"),
    round: withDefault(input.round, "seed"),
    amount_usd: withDefault(input.amount_usd, 5_000_000),
  };
}

export interface EntityInput {
  entityId?: string;
  name: string;
  domain?: string | null;
  domainTrust?: "structured" | "name" | "linked" | null;
  evidence: EvidenceInput[];
}

function fakeLeadFor(ev: Evidence): RawLead {
  return { provider: ev.provider, lane: ev.lane, name: "x", source_url: ev.source_url, source_name: ev.source_name, event_date: null, headline: ev.title, snippet: null, source_retrieved: true };
}

export function makeEntity(input: EntityInput): Entity {
  const evidence = input.evidence.map(makeEvidence);
  const leads = evidence.map(fakeLeadFor);
  return {
    entity_id: input.entityId ?? `e-${input.name.toLowerCase().replace(/\s+/g, "-")}`,
    name: input.name,
    keys: [],
    leads,
    lead_ids: evidence.map((e) => e.lead_id),
    primary_lead_id: evidence[0]?.lead_id ?? "lead-0",
    evidence,
    providers: [...new Set(evidence.map((e) => e.provider))],
    lanes: [...new Set(evidence.map((e) => e.lane))],
    source_keys: [...new Set(evidence.map((e) => e.source_key))],
    event_types: [...new Set(evidence.map((e) => e.event_type).filter((t): t is string => !!t))],
    round: evidence.find((e) => e.round)?.round ?? null,
    amount_usd: evidence.find((e) => e.amount_usd != null)?.amount_usd ?? null,
    first_published: evidence[0]?.published_at ?? null,
    last_published: evidence[0]?.published_at ?? null,
    young_signals: [],
    mature_signals: [],
    structured: false,
    domain: { domain: input.domain ?? null, trust: input.domainTrust ?? (input.domain ? "structured" : null), score: input.domain ? 0.9 : 0, candidates: [] },
  };
}

export interface RankedEntityInput extends EntityInput {
  track?: "news" | "directory";
  score?: number;
  finalist?: boolean;
  selection?: string;
}

export function makeRankedEntity(input: RankedEntityInput): RankedEntity {
  return {
    entity: makeEntity(input),
    track: input.track ?? "news",
    score: input.score ?? 80,
    breakdown: EMPTY_BREAKDOWN,
    rank: 1,
    homepage: null,
    existing: null,
    finalist: input.finalist ?? true,
    selection: input.selection ?? "score",
  };
}
