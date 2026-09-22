import type { Entity } from "./entities.ts";
import type { ExistingMatch } from "./existing.ts";

/**
 * Deterministic, fully transparent ranking (no LLM). Every entity gets eight components in [0,1], each multiplied by a
 * fixed weight (weights sum to 100). The per-component raw value, weight, points and a one-line reason are all kept, so
 * "why did A outrank B" is answerable from the output alone.
 */

export const WEIGHTS = {
  recency: 15,
  event_strength: 20,
  source_reliability: 10,
  corroboration: 15,
  domain: 10,
  young_company: 10,
  stage_amount: 10,
  novelty: 10,
} as const;
export type ComponentName = keyof typeof WEIGHTS;

export interface ScoreComponent {
  raw: number;
  weight: number;
  points: number;
  note: string;
}
export type ScoreBreakdown = Record<ComponentName, ScoreComponent>;

export interface DomainCheck {
  domain: string;
  reachable: boolean;
  /** The company name was found on the homepage; null when the homepage gave no text (blocked or unavailable). */
  name_found: boolean | null;
  status?: number;
  error?: string;
}

/** Publisher (or directory) reliability priors, matched by substring of the lowercased source key. */
export const PUBLISHER_RELIABILITY: ReadonlyArray<readonly [string, number]> = [
  ["y combinator", 0.95], ["techstars", 0.9], ["techcrunch", 0.9], ["reuters", 0.9], ["wall street journal", 0.9], ["wsj", 0.9], ["financial times", 0.9],
  ["the information", 0.9], ["bloomberg", 0.85], ["fortune", 0.85], ["axios", 0.85], ["sifted", 0.85], ["pr newswire", 0.85], ["business wire", 0.85],
  ["tech.eu", 0.8], ["eu-startups", 0.8], ["geekwire", 0.8], ["venturebeat", 0.8], ["crunchbase", 0.8], ["globenewswire", 0.8], ["arcticstartup", 0.75],
  ["securityweek", 0.75], ["dealroom", 0.75], ["fintech futures", 0.75], ["fintechfutures", 0.75], ["hpcwire", 0.7], ["aiwire", 0.7], ["forbes", 0.7],
  ["finsmes", 0.7], ["yahoo", 0.6],
];
const MAINSTREAM = ["techcrunch", "fortune", "bloomberg", "reuters", "wall street journal", "wsj", "financial times", "forbes", "cnbc", "axios", "business insider", "the information", "venturebeat", "wired", "the verge", "new york times", "washington post"];
const DIRECTORY_SOURCES = ["y combinator", "techstars"];

export function publisherReliability(sourceKey: string, providerReliability: number, provider: string): number {
  const hit = PUBLISHER_RELIABILITY.find(([k]) => sourceKey.includes(k));
  if (hit) return hit[1];
  return provider === "google-news" ? 0.45 : providerReliability;
}

export interface ScoreContext {
  asOf: Date;
  providerReliability: (providerId: string) => number;
  homepage: (domain: string) => DomainCheck | undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const comp = (name: ComponentName, raw: number, note: string): ScoreComponent => {
  const r = Math.max(0, Math.min(1, raw));
  return { raw: round2(r), weight: WEIGHTS[name], points: round2(r * WEIGHTS[name]), note };
};

const FUNDING_ROUND_STRENGTH: Record<string, number> = { pre_seed: 1, seed: 1, series_a: 0.9, pre_series_a: 0.9, angel: 0.7, series_b: 0.6, bridge: 0.5, grant: 0.5, debt: 0.4, convertible: 0.5 };

function eventStrength(e: Entity): { raw: number; note: string } {
  let best = 0;
  let why = "no event";
  for (const ev of e.evidence) {
    let s = 0;
    let w = "";
    switch (ev.event_type) {
      case "stealth": s = 0.95; w = "stealth exit"; break;
      case "funding": s = ev.round ? (FUNDING_ROUND_STRENGTH[ev.round] ?? 0.55) : 0.6; w = ev.round ? `funding ${ev.round}` : "funding (round unstated)"; break;
      case "accelerator": s = 0.7; w = "accelerator cohort"; break;
      case "product_launch": s = 0.5; w = "product launch"; break;
      default: s = 0.3; w = "news mention"; break;
    }
    if (s > best) {
      best = s;
      why = w;
    }
  }
  return { raw: best, note: why };
}

function amountFit(e: Entity): { raw: number; note: string } {
  const funding = e.event_types.some((t) => t === "funding" || t === "stealth");
  if (!funding) return { raw: 0.5, note: "no funding event: neutral" };
  const a = e.amount_usd;
  if (a === null) return { raw: e.round && FUNDING_ROUND_STRENGTH[e.round] !== undefined && FUNDING_ROUND_STRENGTH[e.round]! >= 0.9 ? 0.8 : 0.5, note: "amount unstated" };
  const m = a / 1e6;
  if (m < 0.25) return { raw: 0.5, note: `$${m.toFixed(2)}M: very small` };
  if (m <= 40) return { raw: 1, note: `$${m.toFixed(1)}M: early-stage sweet spot` };
  if (m <= 100) return { raw: 0.6, note: `$${m.toFixed(0)}M: large for early stage` };
  if (m <= 250) return { raw: 0.3, note: `$${m.toFixed(0)}M: growth-stage size` };
  return { raw: 0.1, note: `$${m.toFixed(0)}M: not an emerging-company round` };
}

export function scoreEntity(e: Entity, ctx: ScoreContext): { score: number; breakdown: ScoreBreakdown } {
  // recency
  let recency: ScoreComponent;
  if (e.last_published) {
    const days = Math.max(0, (ctx.asOf.getTime() - Date.parse(e.last_published)) / 86_400_000);
    recency = comp("recency", Math.pow(0.5, days / 3), `${days.toFixed(1)}d old (half-life 3d)`);
  } else recency = comp("recency", 0.5, "undated directory membership: neutral");

  const ev = eventStrength(e);
  const strength = comp("event_strength", ev.raw, ev.note);

  const rel = Math.max(...e.evidence.map((x) => publisherReliability(x.source_key, ctx.providerReliability(x.provider), x.provider)));
  const reliability = comp("source_reliability", rel, `best source prior ${rel.toFixed(2)}`);

  const n = e.source_keys.length;
  const corroboration = comp("corroboration", n >= 4 ? 1 : n === 3 ? 0.85 : n === 2 ? 0.6 : 0.2, `${n} independent source${n === 1 ? "" : "s"}: ${e.source_keys.slice(0, 4).join(", ")}`);

  // domain
  let domainRaw = 0;
  let domainNote = "no domain resolved";
  if (e.domain.domain) {
    domainRaw = e.domain.trust === "structured" ? 0.6 : e.domain.trust === "name" ? 0.55 : 0.5;
    domainNote = `${e.domain.domain} (${e.domain.trust})`;
    const hp = ctx.homepage(e.domain.domain);
    if (hp) {
      if (hp.reachable) domainRaw += 0.25;
      if (hp.name_found) domainRaw += 0.15;
      domainNote += hp.reachable ? `, reachable${hp.name_found ? ", name on page" : hp.name_found === false ? ", name NOT on page" : ""}` : ", homepage unreachable";
    } else domainNote += ", homepage not checked";
  }
  const domain = comp("domain", domainRaw, domainNote);

  // young company
  const foundedRecent = e.young_signals.find((s) => /^founded_20(2[1-9]|3\d)$/.test(s));
  let youngRaw = 0.4;
  let youngNote = "no age signal: neutral";
  if (foundedRecent) { youngRaw = 1; youngNote = foundedRecent; }
  else if (e.young_signals.some((s) => ["stealth_exit", "early_round", "spinout", "accelerator_cohort", "debut"].includes(s))) {
    youngRaw = 0.8;
    youngNote = e.young_signals.filter((s) => ["stealth_exit", "early_round", "spinout", "accelerator_cohort", "debut"].includes(s)).join("+");
  } else if (e.young_signals.includes("incubated")) { youngRaw = 0.7; youngNote = "incubated"; }
  if (e.mature_signals.length) { youngRaw = Math.min(youngRaw, 0.1); youngNote = `mature signals: ${e.mature_signals.join(",")}`; }
  const young = comp("young_company", youngRaw, youngNote);

  const af = amountFit(e);
  const stage = comp("stage_amount", af.raw, af.note);

  // novelty: fewer mainstream outlets => more likely to be missed by ordinary lists
  const mainstream = e.source_keys.filter((k) => MAINSTREAM.some((m) => k.includes(m))).length;
  const directoryOnly = e.source_keys.length > 0 && e.source_keys.every((k) => DIRECTORY_SOURCES.some((d) => k.includes(d)));
  const novelty = directoryOnly
    ? comp("novelty", 0.9, "directory/cohort only: no news coverage")
    : comp("novelty", mainstream === 0 ? 1 : mainstream === 1 ? 0.6 : 0.3, `${mainstream} mainstream outlet${mainstream === 1 ? "" : "s"}`);

  const breakdown: ScoreBreakdown = {
    recency, event_strength: strength, source_reliability: reliability, corroboration, domain, young_company: young, stage_amount: stage, novelty,
  };
  const score = round2(Object.values(breakdown).reduce((a, c) => a + c.points, 0));
  return { score, breakdown };
}

// ---- ranking and diversity-constrained selection -------------------------------------------------------------------------

export interface RankedEntity {
  entity: Entity;
  /** "directory": every lead comes from an official structured source (YC, Techstars): the company and website are stated, not inferred. */
  track: "news" | "directory";
  score: number;
  breakdown: ScoreBreakdown;
  /** 1-based position by score among the ranked (non-existing) entities. */
  rank: number;
  homepage: DomainCheck | null;
  existing: ExistingMatch | null;
  finalist: boolean;
  /** Why it was (or was not) selected: "reserved_lane:funding", "score", "fill_relaxed", "below_min_score", "not_selected". */
  selection: string;
}

export function rankEntities(entities: readonly RankedEntity[]): RankedEntity[] {
  const sorted = [...entities].sort((a, b) => b.score - a.score || a.entity.entity_id.localeCompare(b.entity.entity_id));
  sorted.forEach((r, i) => (r.rank = i + 1));
  return sorted;
}

export interface SelectConfig {
  finalists: number;
  minScore: number;
  /** Reserved (lane/provider) slots exist for diversity, not to admit weak candidates: they need at least this score. */
  reserveMinScore: number;
  /** No provider may hold more than this share of the finalists (unless there are too few candidates to fill them). */
  maxProviderShare: number;
  maxLaneShare: number;
}

export const primaryProvider = (r: RankedEntity): string => r.entity.leads[0]?.provider ?? "unknown";
export const primaryLane = (r: RankedEntity): string => r.entity.leads[0]?.lane ?? "news";

/**
 * Pick finalists by score under diversity constraints, so one high-volume provider cannot monopolize them:
 *  1. reserve the best entity of every lane, then of the best-scoring providers (at most half the slots);
 *  2. fill by score while respecting per-provider and per-lane caps;
 *  3. if slots remain because of the caps, fill the rest by score (`fill_relaxed`).
 * Only entities at or above `minScore` are eligible.
 */
export function selectFinalists(ranked: readonly RankedEntity[], cfg: SelectConfig): RankedEntity[] {
  const eligible = ranked.filter((r) => r.score >= cfg.minScore);
  for (const r of ranked) {
    r.finalist = false;
    r.selection = r.score < cfg.minScore ? "below_min_score" : "not_selected";
  }
  const providerCap = Math.max(1, Math.ceil(cfg.finalists * cfg.maxProviderShare));
  const laneCap = Math.max(1, Math.ceil(cfg.finalists * cfg.maxLaneShare));
  const picked: RankedEntity[] = [];
  const perProvider: Record<string, number> = {};
  const perLane: Record<string, number> = {};
  const take = (r: RankedEntity, why: string) => {
    r.finalist = true;
    r.selection = why;
    picked.push(r);
    perProvider[primaryProvider(r)] = (perProvider[primaryProvider(r)] ?? 0) + 1;
    perLane[primaryLane(r)] = (perLane[primaryLane(r)] ?? 0) + 1;
  };

  const reservable = eligible.filter((r) => r.score >= cfg.reserveMinScore);
  const lanes: string[] = [];
  for (const r of reservable) if (!lanes.includes(primaryLane(r))) lanes.push(primaryLane(r));
  for (const lane of lanes) {
    if (picked.length >= cfg.finalists) break;
    const best = reservable.find((r) => !r.finalist && primaryLane(r) === lane);
    if (best) take(best, `reserved_lane:${lane}`);
  }
  const providers: string[] = [];
  for (const r of reservable) if (!providers.includes(primaryProvider(r))) providers.push(primaryProvider(r));
  let reservedProviders = 0;
  for (const p of providers) {
    if (picked.length >= cfg.finalists || reservedProviders >= Math.floor(cfg.finalists / 2)) break;
    if ((perProvider[p] ?? 0) > 0) continue; // already represented (e.g. by a lane reservation): do not spend a second reserved slot on it
    const best = reservable.find((r) => !r.finalist && primaryProvider(r) === p);
    if (best) {
      take(best, `reserved_provider:${p}`);
      reservedProviders++;
    }
  }
  const deferred: RankedEntity[] = [];
  for (const r of eligible) {
    if (picked.length >= cfg.finalists) break;
    if (r.finalist) continue;
    if ((perProvider[primaryProvider(r)] ?? 0) >= providerCap || (perLane[primaryLane(r)] ?? 0) >= laneCap) {
      deferred.push(r);
      continue;
    }
    take(r, "score");
  }
  for (const r of deferred) {
    if (picked.length >= cfg.finalists) break;
    take(r, "fill_relaxed");
  }
  return picked.sort((a, b) => b.score - a.score || a.entity.entity_id.localeCompare(b.entity.entity_id));
}

/** True when every lead of the entity comes from an official structured source (its name and website are stated, not inferred). */
export function isDirectoryOnly(e: Pick<Entity, "leads">): boolean {
  return e.leads.length > 0 && e.leads.every((l) => l.extracted?.name_from === "structured");
}

export interface DirectorySelectConfig {
  finalists: number;
  minScore: number;
  /** No single directory may take more than this share (a 79-company cohort must not crowd out a batch, and vice versa). */
  maxProviderShare: number;
}

/**
 * Directory-track selection. Official cohort/batch members are already known to be real companies with a stated website, so
 * they do not compete with news events for the (expensive) news finalist slots; they get their own bounded slots. Anything
 * beyond the cap is NOT lost: it stays new, and reaches the funnel again on a later day once earlier members have been
 * ingested and become "existing".
 */
export function selectDirectoryFinalists(ranked: readonly RankedEntity[], cfg: DirectorySelectConfig): RankedEntity[] {
  const eligible = ranked.filter((r) => r.score >= cfg.minScore);
  const cap = Math.max(1, Math.ceil(cfg.finalists * cfg.maxProviderShare));
  const perProvider: Record<string, number> = {};
  const picked: RankedEntity[] = [];
  const deferred: RankedEntity[] = [];
  for (const r of ranked) {
    r.finalist = false;
    r.selection = r.score < cfg.minScore ? "below_min_score" : "not_selected";
  }
  for (const r of eligible) {
    if (picked.length >= cfg.finalists) break;
    const p = primaryProvider(r);
    if ((perProvider[p] ?? 0) >= cap) {
      deferred.push(r);
      continue;
    }
    perProvider[p] = (perProvider[p] ?? 0) + 1;
    r.finalist = true;
    r.selection = "directory_track:score";
    picked.push(r);
  }
  for (const r of deferred) {
    if (picked.length >= cfg.finalists) break;
    r.finalist = true;
    r.selection = "directory_track:fill_relaxed";
    picked.push(r);
  }
  return picked.sort((a, b) => b.score - a.score || a.entity.entity_id.localeCompare(b.entity.entity_id));
}
