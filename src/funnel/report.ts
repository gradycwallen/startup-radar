import type { FunnelResult } from "./funnel.ts";
import type { RankedEntity } from "./rank.ts";

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Plain-JSON view of a ranked entity (no raw lead bodies), for artifacts and evaluation. */
export function summarizeRanked(r: RankedEntity) {
  const e = r.entity;
  return {
    entity_id: e.entity_id, name: e.name, track: r.track, rank: r.rank, score: r.score, finalist: r.finalist, selection: r.selection,
    domain: e.domain.domain, domain_trust: e.domain.trust, domain_candidates: e.domain.candidates.slice(0, 4).map((c) => `${c.domain}(${c.via} ${c.score.toFixed(2)})`),
    homepage: r.homepage, providers: e.providers, lanes: e.lanes, source_keys: e.source_keys, event_types: e.event_types, round: e.round, amount_usd: e.amount_usd,
    published: [e.first_published, e.last_published], young_signals: e.young_signals, mature_signals: e.mature_signals,
    breakdown: Object.fromEntries(Object.entries(r.breakdown).map(([k, c]) => [k, { raw: c.raw, weight: c.weight, points: c.points, note: c.note }])),
    evidence: e.evidence.map((x) => ({ provider: x.provider, source: x.source_key, title: x.title, url: x.source_url, published: x.published_at, event: x.event_type })),
  };
}

export function funnelToJson(result: FunnelResult) {
  return {
    as_of: result.as_of, window_days: result.window_days, elapsed_ms: result.elapsed_ms, providers: result.providers, counts: result.counts,
    item_drop_reasons: result.item_drop_reasons, prefilter_reasons: result.prefilter_reasons, merges: result.merges, existing: result.existing,
    finalists: result.finalists.map(summarizeRanked), directory_finalists: result.directory_finalists.map(summarizeRanked), ranked: result.ranked.map(summarizeRanked), prefiltered: result.prefiltered,
  };
}

export function formatFunnel(result: FunnelResult, options: { ranked?: number } = {}): string {
  const c = result.counts;
  const L: string[] = [];
  L.push(`FUNNEL as of ${result.as_of.slice(0, 10)} (window ${result.window_days}d) in ${secs(result.elapsed_ms)}`);
  L.push("providers:");
  for (const p of result.providers) {
    L.push(`  ${p.provider.padEnd(20)} ${p.status.padEnd(9)} ${String(p.items_fetched).padStart(4)} items ${String(p.items_in_window).padStart(4)} in window  ${p.requests} req ${JSON.stringify(p.http_statuses)}${p.note ? `  [${p.note}]` : ""}`);
  }
  L.push("stages:");
  L.push(`  source items fetched              ${c.items_fetched}`);
  L.push(`    outside the time window         -${c.items_outside_window}`);
  L.push(`    in window                       ${c.items_in_window}`);
  L.push(`    yielded no company              -${c.items_without_lead}  ${JSON.stringify(Object.fromEntries(Object.entries(result.item_drop_reasons).filter(([k]) => !k.startsWith("outside"))))}`);
  L.push(`  raw leads (in ledger)             ${c.raw_leads}`);
  L.push(`    prefiltered                     -${c.prefiltered}  ${JSON.stringify(result.prefilter_reasons)}`);
  L.push(`  leads after prefilter             ${c.leads_after_prefilter}`);
  L.push(`  entities (companies)              ${c.entities}   (${c.duplicate_leads_merged} duplicate leads merged; ${c.entities_multi_provider} multi-provider, ${c.entities_multi_lane} multi-lane, ${c.entities_multi_source} multi-source)`);
  L.push(`    already in Startup Radar        -${c.existing_entities}  (${c.existing_event_leads} potential new-event leads, ${c.existing_known_source} already-known sources)`);
  L.push(`  new entities ranked               ${c.new_entities}   (${c.directory_entities} directory-only, ${c.new_entities - c.directory_entities} news-derived)`);
  L.push(`  enrichment                        ${c.article_pages_ok}/${c.article_pages_attempted} article pages fetched, ${c.article_domains_resolved} domains resolved; ${c.homepage_checked} homepages checked`);
  L.push(`  finalists                         ${c.finalists} news + ${c.directory_finalists} directory`);
  L.push("news finalists:");
  for (const r of result.finalists) {
    const e = r.entity;
    L.push(`  #${String(r.rank).padStart(3)} ${r.score.toFixed(1).padStart(5)}  ${e.name.padEnd(26).slice(0, 26)} ${(e.domain.domain ?? "-").padEnd(24)} ${e.event_types.join("+").padEnd(16)} ${e.providers.join(",").slice(0, 40)}  [${r.selection}]`);
  }
  L.push("directory finalists (official cohort/batch members):");
  for (const r of result.directory_finalists) L.push(`  #${String(r.rank).padStart(3)} ${r.score.toFixed(1).padStart(5)}  ${r.entity.name.padEnd(26).slice(0, 26)} ${(r.entity.domain.domain ?? "-").padEnd(24)} ${r.entity.providers.join(",")}`);
  const extra = options.ranked ?? 0;
  if (extra > 0) {
    L.push(`next ${extra} ranked (not finalists):`);
    for (const r of result.ranked.filter((x) => !x.finalist).slice(0, extra)) L.push(`  #${String(r.rank).padStart(3)} ${r.score.toFixed(1).padStart(5)}  ${r.entity.name.padEnd(26).slice(0, 26)} ${r.selection}`);
  }
  return L.join("\n");
}

export function formatBreakdown(r: RankedEntity): string {
  return Object.entries(r.breakdown).map(([k, c]) => `${k}=${c.points.toFixed(1)}/${c.weight} (${c.note})`).join("; ");
}
