import { hash } from "node:crypto";
import { leadId } from "../ledger.ts";
import type { RawLead } from "../schema.ts";
import { aliasKey, nameKey } from "./text.ts";
import type { DomainResolution } from "./domains.ts";

/** One piece of evidence for an entity: a single lead's source, kept when leads are merged (never discarded). */
export interface Evidence {
  lead_id: string;
  provider: string;
  lane: string;
  source_url: string;
  source_name: string | null;
  /** Key identifying the independent source (publisher name, or the provider for directories). */
  source_key: string;
  title: string | null;
  published_at: string | null;
  event_type: string | null;
  round: string | null;
  amount_usd: number | null;
}

export interface Entity {
  entity_id: string;
  name: string;
  keys: string[];
  leads: RawLead[];
  lead_ids: string[];
  primary_lead_id: string;
  evidence: Evidence[];
  providers: string[];
  lanes: string[];
  source_keys: string[];
  event_types: string[];
  round: string | null;
  amount_usd: number | null;
  first_published: string | null;
  last_published: string | null;
  young_signals: string[];
  mature_signals: string[];
  structured: boolean;
  domain: DomainResolution;
}

export const sourceKey = (l: Pick<RawLead, "source_name" | "provider">): string => (l.source_name ?? l.provider).toLowerCase().replace(/\s+/g, " ").trim();

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

export type Reliability = (lead: RawLead) => number;

/**
 * Cluster raw leads into entities (companies): leads are merged when they share a normalized name, an alias
 * ("TypeSafe AI" ~ "TypeSafe"), or an explicit (structured / domain-named) domain. All evidence is preserved on the
 * merged entity so corroboration can be counted and audited.
 */
export function clusterLeads(leads: readonly RawLead[], reliability: Reliability): Entity[] {
  const n = leads.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    let c = i;
    while (parent[c] !== r) {
      const next = parent[c] as number;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const owner: Record<string, number> = {};
  const keysOf = leads.map((l) => {
    const keys: string[] = [];
    const nk = nameKey(l.name);
    if (nk.length >= 2) keys.push(`n:${nk}`);
    const ak = aliasKey(l.name);
    if (ak !== nk && ak.length >= 4) keys.push(`n:${ak}`);
    if (l.domain_trust && l.domain_candidates?.[0]) keys.push(`d:${l.domain_candidates[0]}`);
    return keys;
  });
  leads.forEach((_, i) => {
    for (const k of keysOf[i] as string[]) {
      if (k in owner) union(i, owner[k] as number);
      else owner[k] = i;
    }
  });

  const groups: Record<number, number[]> = {};
  const order: number[] = [];
  leads.forEach((_, i) => {
    const r = find(i);
    if (!(r in groups)) {
      groups[r] = [];
      order.push(r);
    }
    (groups[r] as number[]).push(i);
  });

  return order.map((root) => {
    const members = (groups[root] as number[]).map((i) => leads[i] as RawLead);
    // Primary evidence: structured first, then most reliable, then earliest.
    const sorted = [...members].sort(
      (a, b) =>
        Number(!!b.domain_trust && b.extracted?.name_from === "structured") - Number(!!a.domain_trust && a.extracted?.name_from === "structured") ||
        reliability(b) - reliability(a) ||
        (a.published_at ?? "").localeCompare(b.published_at ?? ""),
    );
    const primary = sorted[0] as RawLead;
    const evidence: Evidence[] = sorted.map((l) => ({
      lead_id: leadId(l), provider: l.provider, lane: l.lane, source_url: l.source_url, source_name: l.source_name ?? null, source_key: sourceKey(l),
      title: l.headline ?? null, published_at: l.published_at ?? null, event_type: l.extracted?.event_type ?? l.event_type_hint ?? null,
      round: l.extracted?.round ?? null, amount_usd: l.extracted?.amount_usd ?? null,
    }));
    const dates = members.map((l) => l.published_at).filter((d): d is string => !!d).sort();
    const roundLead = sorted.find((l) => l.extracted?.round) ?? primary;
    const amountLead = sorted.find((l) => l.extracted?.amount_usd != null);
    const allKeys = uniq((groups[root] as number[]).flatMap((i) => keysOf[i] as string[]));
    return {
      entity_id: hash("sha1", allKeys.sort().join("|") || leadId(primary), "hex").slice(0, 12),
      name: primary.name,
      keys: allKeys,
      leads: sorted,
      lead_ids: evidence.map((e) => e.lead_id),
      primary_lead_id: leadId(primary),
      evidence,
      providers: uniq(members.map((l) => l.provider)),
      lanes: uniq(members.map((l) => l.lane)),
      source_keys: uniq(evidence.map((e) => e.source_key)),
      event_types: uniq(evidence.map((e) => e.event_type).filter((t): t is string => !!t)),
      round: roundLead.extracted?.round ?? null,
      amount_usd: amountLead?.extracted?.amount_usd ?? null,
      first_published: dates[0] ?? null,
      last_published: dates[dates.length - 1] ?? null,
      young_signals: uniq(members.flatMap((l) => l.extracted?.young_signals ?? [])),
      mature_signals: uniq(members.flatMap((l) => l.extracted?.mature_signals ?? [])),
      structured: members.some((l) => l.extracted?.name_from === "structured"),
      domain: { domain: null, trust: null, score: 0, candidates: [] },
    };
  });
}
