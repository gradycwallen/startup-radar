import { normalizeDomain } from "../domain.ts";
import type { Entity } from "./entities.ts";
import { aliasKey, nameDomainSimilarity, nameKey } from "./text.ts";

export type DomainTrust = "structured" | "name" | "linked";

export interface DomainCandidate {
  domain: string;
  via: DomainTrust;
  score: number;
  /** Number of leads that offered this domain. */
  votes: number;
}

export interface DomainResolution {
  domain: string | null;
  trust: DomainTrust | null;
  score: number;
  candidates: DomainCandidate[];
}

/** Minimum name-similarity for a linked (unstructured) domain to be accepted as the company's own. */
export const LINKED_DOMAIN_MIN_SIMILARITY = 0.75;

const TLD_PREFERENCE: Record<string, number> = { com: 0.03, ai: 0.03, io: 0.02, co: 0.02, app: 0.01, dev: 0.01 };
const tldBonus = (d: string) => TLD_PREFERENCE[d.split(".").slice(1).join(".")] ?? 0;

/**
 * Pick the entity's own domain WITHOUT touching the network. Precedence:
 *  structured (an explicit website field from YC/Techstars) > name-is-a-domain ("Fin.com") > a linked domain whose
 *  name resembles the company's. A linked domain that does not resemble the company name is never accepted, because
 *  article bodies link mostly to investors, publishers and unrelated companies.
 * Reachability and homepage-name checks are separate (they need the network) and feed ranking, not this choice.
 */
export function resolveEntityDomain(entity: Pick<Entity, "leads" | "name">): DomainResolution {
  const keys = [nameKey(entity.name), aliasKey(entity.name)].filter(Boolean);
  const byDomain: Record<string, DomainCandidate> = {};
  const add = (domain: string, via: DomainTrust, score: number) => {
    const cur = byDomain[domain];
    if (!cur) byDomain[domain] = { domain, via, score, votes: 1 };
    else {
      cur.votes++;
      if (score > cur.score) {
        cur.score = score;
        cur.via = via;
      }
    }
  };
  for (const lead of entity.leads) {
    const hint = lead.homepage_hint ? normalizeDomain(lead.homepage_hint) : null;
    if (hint && lead.domain_trust === "structured") add(hint, "structured", 1);
    else if (hint && lead.domain_trust === "name") add(hint, "name", 0.95);
    for (const d of lead.domain_candidates ?? []) {
      if (d === hint) continue;
      const sim = nameDomainSimilarity(keys, d);
      if (sim >= LINKED_DOMAIN_MIN_SIMILARITY) add(d, "linked", sim * 0.9);
    }
  }
  const candidates = Object.values(byDomain)
    .map((c) => ({ ...c, score: Math.min(1, c.score + (c.votes > 1 ? 0.05 : 0) + tldBonus(c.domain)) }))
    .sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));
  const best = candidates[0];
  return best ? { domain: best.domain, trust: best.via, score: best.score, candidates } : { domain: null, trust: null, score: 0, candidates: [] };
}
