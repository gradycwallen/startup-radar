import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanyRow, EventRow } from "../src/dedupe.ts";
import { resolveEntityDomain } from "../src/funnel/domains.ts";
import { clusterLeads, type Entity } from "../src/funnel/entities.ts";
import { extractLeads } from "../src/funnel/extract.ts";
import { ExistingIndex } from "../src/funnel/existing.ts";
import { DEFAULT_FUNNEL_CONFIG, runFunnel, type FunnelConfig } from "../src/funnel/funnel.ts";
import { ItemLedger } from "../src/funnel/item-ledger.ts";
import { WEIGHTS, primaryLane, primaryProvider, publisherReliability, rankEntities, scoreEntity, selectFinalists, type RankedEntity } from "../src/funnel/rank.ts";
import { LeadLedger } from "../src/ledger.ts";
import { memoryLogger } from "../src/log.ts";
import type { RawLead } from "../src/schema.ts";
import { PoliteFetcher } from "../src/sources/fetcher.ts";
import { makeItem, type ItemInput } from "../src/sources/item.ts";
import type { SourceItem, SourceProvider } from "../src/sources/types.ts";
import type { HomepageCheck } from "../src/http.ts";

const ASOF = new Date("2026-09-21T23:59:59Z");
const RELIABILITY = (l: RawLead) => (l.provider === "yc" ? 0.95 : l.provider === "tc" ? 0.9 : 0.5);

const item = (over: Partial<ItemInput> & { provider?: string } = {}): SourceItem =>
  makeItem({ provider: "tc", kind: "rss", lane: "news", title: "x", url: `https://n.example.com/${Math.random().toString(36).slice(2)}`, url_kind: "article", source_name: "TechCrunch", published_at: "2026-09-20T10:00:00Z", fetchedAt: new Date(), ...over })!;
const leadOf = (over: Partial<ItemInput>): RawLead => extractLeads(item(over)).leads[0]!;
const ent = (leads: RawLead[]): Entity => {
  const [e] = clusterLeads(leads, RELIABILITY);
  e!.domain = resolveEntityDomain(e!);
  return e!;
};

// ---- clustering -----------------------------------------------------------------------------------------------------------

test("cluster: same company across providers and lanes merges; ALL evidence is preserved (nothing discarded)", () => {
  const a = leadOf({ provider: "tc", title: "Empirik launches with $21M to predict outages", source_name: "TechCrunch" });
  const b = leadOf({ provider: "google-news", title: "Empirik.ai emerges from stealth with $21M seed", source_name: "Dealroom" });
  const c = leadOf({ provider: "eu", title: "Gaia Dynamics raises $7M seed" });
  const es = clusterLeads([a, b, c], RELIABILITY);
  assert.equal(es.length, 2);
  const emp = es.find((e) => e.name.startsWith("Empirik"))!;
  assert.equal(emp.leads.length, 2);
  assert.deepEqual([emp.providers.sort(), emp.source_keys.sort(), emp.lanes.sort(), emp.evidence.length], [["google-news", "tc"], ["dealroom", "techcrunch"], ["funding", "stealth"], 2]);
  assert.equal(emp.primary_lead_id, emp.lead_ids[0], "the most reliable source is primary");
  assert.ok(emp.evidence.every((e) => e.source_url && e.provider), "each merged lead keeps its own URL and provider");
});

test("cluster: alias merge ('TypeSafe AI' ~ 'TypeSafe'), structured-domain merge, and no merge for different companies sharing a word", () => {
  const es = clusterLeads([
    leadOf({ title: "TypeSafe AI emerges from stealth with $40M" }), leadOf({ provider: "eu", title: "TypeSafe launches new model" }),
    leadOf({ title: "Gaia Dynamics raises $7M seed" }), leadOf({ title: "Gaia Labs raises $5M seed" }),
  ], RELIABILITY);
  assert.deepEqual(es.map((e) => e.leads.length).sort(), [1, 1, 2]);
  const yc = leadOf({ provider: "yc", kind: "directory", title: "Baud: YC", published_at: null, url_kind: "directory", structured: { company_name: "Baud", website: "https://baudlabs.ai", description: "chips", program: "YC", batch: "S26" } });
  const ts = leadOf({ provider: "ts", kind: "cohort-page", title: "Baud Labs: Techstars", structured: { company_name: "Baud Labs", website: "https://baudlabs.ai", description: "chips", program: "Techstars", batch: null } });
  assert.equal(clusterLeads([yc, ts], RELIABILITY).length, 1, "two structured sources naming the same website are one company");
});

test("cluster: structured leads are primary; entity id is stable regardless of input order", () => {
  const news = leadOf({ provider: "tc", title: "Baud raises $3M seed" });
  const yc = leadOf({ provider: "yc", kind: "directory", title: "Baud: YC", published_at: null, url_kind: "directory", structured: { company_name: "Baud", website: "https://baudlabs.ai", description: null, program: "YC", batch: "S26" } });
  const [a] = clusterLeads([news, yc], RELIABILITY);
  const [b] = clusterLeads([yc, news], RELIABILITY);
  assert.equal(a!.leads[0]!.provider, "yc");
  assert.equal(a!.entity_id, b!.entity_id);
});

// ---- domain resolution ----------------------------------------------------------------------------------------------------

test("domain: structured beats name-as-domain beats a linked domain; dissimilar linked domains are NEVER accepted", () => {
  const structured = ent([leadOf({ provider: "ts", kind: "cohort-page", title: "Sunzu: Techstars Boulder", structured: { company_name: "Sunzu", website: "http://sunzu.ai", description: "research", program: "Techstars", batch: null }, outbound_domains: ["sunzu.ai"] })]);
  assert.deepEqual([structured.domain.domain, structured.domain.trust], ["sunzu.ai", "structured"]);
  const nameDomain = ent([leadOf({ title: "Fin.com emerges from stealth with $20m seed", outbound_domains: ["expa.co", "fin.com"] })]);
  assert.deepEqual([nameDomain.domain.domain, nameDomain.domain.trust], ["fin.com", "name"]);
  const linked = ent([leadOf({ title: "Empirik launches with $21M", outbound_domains: ["intelligentinvestors.com", "empirik.ai"] })]);
  assert.deepEqual([linked.domain.domain, linked.domain.trust], ["empirik.ai", "linked"]);
  const none = ent([leadOf({ title: "Empirik launches with $21M", outbound_domains: ["intelligentinvestors.com", "someotherco.io"] })]);
  assert.deepEqual([none.domain.domain, none.domain.trust, none.domain.candidates.length], [null, null, 0], "links that do not resemble the company name are not its domain");
});

test("domain: multiple votes and a preferred TLD break ties; candidates are all reported with their scores", () => {
  const e = ent([leadOf({ title: "Acme raises $2M seed", outbound_domains: ["acme.xyz", "acme.com"] }), leadOf({ provider: "eu", title: "Acme raises $2M seed round", outbound_domains: ["acme.com"] })]);
  assert.equal(e.domain.domain, "acme.com");
  assert.ok(e.domain.candidates.length === 2 && e.domain.candidates[0]!.votes === 2);
});

// ---- existing companies --------------------------------------------------------------------------------------------------

const companies: CompanyRow[] = [{ id: 1, name: "Existing Co", domain: "existing.com" }, { id: 2, name: "TypeSafe", domain: "typesafe.io" }, { id: 3, name: "XDOF", domain: "xdof.ai" }];
const events: EventRow[] = [{ id: 1, company_id: 3, event_type: "funding", event_date: null, source_url: "https://techcrunch.com/2026/09/04/xdof-series-b/", headline: null, description: null }];

test("existing index: matches by resolved domain, by name, by alias; a known source is distinguished from a NEW-EVENT lead", () => {
  const idx = new ExistingIndex(companies, events);
  const byName = ent([leadOf({ title: "Existing Co raises $5M seed" })]);
  assert.deepEqual([idx.match(byName)!.via, idx.match(byName)!.event_lead, idx.match(byName)!.known_source], ["name", true, false]);
  const byDomain = ent([leadOf({ provider: "yc", kind: "directory", title: "Renamed: YC", published_at: null, structured: { company_name: "Renamed Inc", website: "https://existing.com", description: null, program: "YC", batch: "S26" } })]);
  assert.equal(idx.match(byDomain)!.via, "domain");
  const byAlias = ent([leadOf({ title: "TypeSafe AI emerges from stealth with $40M" })]);
  assert.equal(idx.match(byAlias)!.via, "alias");
  const known = ent([leadOf({ title: "XDOF raises $70M", url: "https://www.techcrunch.com/2026/09/04/xdof-series-b?utm_source=x" })]);
  assert.deepEqual([idx.match(known)!.known_source, idx.match(known)!.event_lead], [true, false]);
  assert.equal(idx.match(ent([leadOf({ title: "Brand New raises $3M seed" })])), null);
});

test("existing index: an article merely LINKING to an existing company's domain does not make its subject that company", () => {
  const idx = new ExistingIndex(companies, events);
  const other = ent([leadOf({ title: "Acme Robotics raises $3M seed", outbound_domains: ["existing.com", "acmerobotics.io"] })]);
  assert.equal(other.domain.domain, "acmerobotics.io");
  assert.equal(idx.match(other), null);
});

test("existing index: loads once from a read-only source", async () => {
  let calls = 0;
  const idx = await ExistingIndex.load({ readAllForSnapshot: async () => { calls++; return { companies, events }; } });
  assert.equal(idx.size, 3);
  assert.equal(calls, 1);
});

// ---- ranking ---------------------------------------------------------------------------------------------------------------

const CTX = { asOf: ASOF, providerReliability: (id: string) => (id === "tc" ? 0.9 : 0.5), homepage: () => undefined };

test("ranking: weights sum to 100 and every component is explained (raw, weight, points, note)", () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
  const { score, breakdown } = scoreEntity(ent([leadOf({ title: "Gaia Dynamics raises $7M seed", outbound_domains: ["gaiadynamics.ai"] })]), CTX);
  assert.deepEqual(Object.keys(breakdown).sort(), Object.keys(WEIGHTS).sort());
  // raw is rounded to 2 decimals before points are computed, so allow half a hundredth of the weight.
  for (const c of Object.values(breakdown)) assert.ok(c.raw >= 0 && c.raw <= 1 && c.note.length > 0 && Math.abs(c.points - c.raw * c.weight) <= c.weight * 0.005 + 0.01);
  assert.ok(Math.abs(score - Object.values(breakdown).reduce((a, c) => a + c.points, 0)) < 0.02);
});

test("ranking: recency halves every 3 days; corroboration, early rounds and small rounds score higher", () => {
  const at = (published: string) => scoreEntity(ent([leadOf({ title: "Gaia Dynamics raises $7M seed", published_at: published })]), CTX).breakdown.recency.raw;
  assert.ok(Math.abs(at("2026-09-21T23:59:59Z") - 1) < 0.01);
  assert.ok(Math.abs(at("2026-09-18T23:59:59Z") - 0.5) < 0.02);
  const one = scoreEntity(ent([leadOf({ title: "Gaia Dynamics raises $7M seed" })]), CTX);
  const three = scoreEntity(ent([leadOf({ title: "Gaia Dynamics raises $7M seed" }), leadOf({ provider: "g", source_name: "Dealroom", title: "Gaia Dynamics raises $7M" }), leadOf({ provider: "h", source_name: "Sifted", title: "Gaia Dynamics raises $7M seed round" })]), CTX);
  assert.ok(three.breakdown.corroboration.raw > one.breakdown.corroboration.raw);
  const big = scoreEntity(ent([leadOf({ title: "Bigco raises $400M Series B" })]), CTX);
  const small = scoreEntity(ent([leadOf({ title: "Smallco raises $4M Series A" })]), CTX);
  assert.ok(small.breakdown.stage_amount.raw > big.breakdown.stage_amount.raw);
  assert.ok(scoreEntity(ent([leadOf({ title: "Zed emerges from stealth" })]), CTX).breakdown.event_strength.raw > scoreEntity(ent([leadOf({ title: "Zed launches new app" })]), CTX).breakdown.event_strength.raw);
});

test("ranking: homepage checks feed the domain component; novelty rewards companies mainstream outlets have not covered", () => {
  const e = ent([leadOf({ title: "Empirik launches with $21M", outbound_domains: ["empirik.ai"], source_name: "Tech.eu" })]);
  const base = scoreEntity(e, CTX).breakdown.domain.raw;
  const ok = scoreEntity(e, { ...CTX, homepage: () => ({ domain: "empirik.ai", reachable: true, name_found: true }) }).breakdown.domain.raw;
  const dead = scoreEntity(e, { ...CTX, homepage: () => ({ domain: "empirik.ai", reachable: false, name_found: null }) }).breakdown.domain.raw;
  assert.ok(ok > base && base >= dead && ok <= 1);
  const tc = scoreEntity(ent([leadOf({ title: "Zed raises $3M seed", source_name: "TechCrunch" })]), CTX).breakdown.novelty.raw;
  const niche = scoreEntity(ent([leadOf({ title: "Zed raises $3M seed", source_name: "ArcticStartup" })]), CTX).breakdown.novelty.raw;
  assert.ok(niche > tc);
  assert.ok(publisherReliability("techcrunch", 0.5, "x") > publisherReliability("some blog", 0.5, "google-news"));
});

test("mature signals cap the young-company component", () => {
  const e = ent([leadOf({ title: "Oldco raises $9M seed", excerpt: "Founded in 2009, Oldco has 500 employees. Founded in 2009." })]);
  assert.ok(scoreEntity(e, CTX).breakdown.young_company.raw <= 0.1);
});

const fakeRanked = (id: string, score: number, provider: string, lane: string): RankedEntity => ({
  entity: { entity_id: id, name: id, leads: [{ provider, lane, name: id, source_url: "u", source_retrieved: true }] } as unknown as Entity,
  track: "news", score, breakdown: {} as RankedEntity["breakdown"], rank: 0, homepage: null, existing: null, finalist: false, selection: "not_selected",
});

test("selection: a high-volume provider cannot monopolize the finalists; other providers and lanes are guaranteed representation", () => {
  const A = Array.from({ length: 20 }, (_, i) => fakeRanked(`a${i}`, 90 - i, "news-a", "funding"));
  const B = [fakeRanked("b0", 60, "news-b", "stealth"), fakeRanked("b1", 55, "news-b", "stealth")];
  const C = [fakeRanked("c0", 50, "yc", "accelerator")];
  const ranked = rankEntities([...A, ...B, ...C]);
  const fin = selectFinalists(ranked, { finalists: 10, minScore: 30, reserveMinScore: 30, maxProviderShare: 0.4, maxLaneShare: 0.6 });
  assert.equal(fin.length, 10);
  const byProvider = (p: string) => fin.filter((r) => primaryProvider(r) === p).length;
  assert.ok(byProvider("news-b") === 2 && byProvider("yc") === 1, "every other provider's candidates made it");
  assert.equal(byProvider("news-a"), 7, "A fills the rest, but only after the diverse candidates");
  assert.ok(fin.find((r) => r.entity.entity_id === "c0")!.selection.startsWith("reserved_"));
  assert.equal(fin.filter((r) => r.selection === "score" && primaryProvider(r) === "news-a").length, 3, "in the score phase A is capped at ceil(10*0.4)=4 including its reserved slot");
  assert.ok(fin.some((r) => r.selection === "fill_relaxed"), "leftover slots are filled by score when the caps leave them empty");
  assert.deepEqual([...fin].sort((x, y) => y.score - x.score).map((r) => r.entity.entity_id), fin.map((r) => r.entity.entity_id), "output is ordered by score");
});

test("selection: minimum score excludes weak candidates; lane reservation picks the best of each lane; ties are deterministic", () => {
  const ranked = rankEntities([fakeRanked("w", 20, "p", "news"), fakeRanked("x", 80, "p", "funding"), fakeRanked("y", 70, "q", "stealth"), fakeRanked("z", 70, "r", "stealth")]);
  const fin = selectFinalists(ranked, { finalists: 3, minScore: 30, reserveMinScore: 30, maxProviderShare: 1, maxLaneShare: 1 });
  assert.ok(!fin.some((r) => r.entity.entity_id === "w"));
  assert.equal(ranked.find((r) => r.entity.entity_id === "w")!.selection, "below_min_score");
  assert.deepEqual(fin.map((r) => r.entity.entity_id), ["x", "y", "z"], "equal scores are ordered by entity id");
  assert.ok(primaryLane(fin[0]!) === "funding");
});

// ---- the whole funnel -----------------------------------------------------------------------------------------------------

function provider(id: string, reliability: number, items: SourceItem[] | Error, over: Partial<SourceProvider> = {}): SourceProvider {
  return { id, kind: "rss", description: id, reliability, fetchItems: async () => { if (items instanceof Error) throw items; return items; }, ...over } as SourceProvider;
}
const cfg = (over: Partial<FunnelConfig> = {}): FunnelConfig => ({ ...DEFAULT_FUNNEL_CONFIG, asOf: ASOF, ...over });

function fixtureProviders(): SourceProvider[] {
  const tc = provider("tc", 0.9, [
    item({ title: "Gaia Dynamics raises $7M seed round", url: "https://tc.example.com/gaia", outbound_domains: ["gaiadynamics.ai"] }),
    item({ title: "Sequoia-incubated Empirik launches with $21M to predict outages", url: "https://tc.example.com/empirik", published_at: "2026-09-19T10:00:00Z", outbound_domains: ["empirik.ai"] }),
    item({ title: "Existing Co raises $5M seed", url: "https://tc.example.com/existing" }),
    item({ title: "Peterson Partners raises $510 Million fund", url: "https://tc.example.com/fund" }),
    item({ title: "Old news Foo raises $1M seed", url: "https://tc.example.com/old", published_at: "2026-09-01T10:00:00Z" }),
    item({ title: "Future Bar raises $1M seed", url: "https://tc.example.com/future", published_at: "2026-09-25T10:00:00Z" }),
    item({ title: "This Week in Startups: funding roundup", url: "https://tc.example.com/digest" }),
  ]);
  const gn = provider("google-news", 0.5, [
    item({ provider: "google-news", kind: "google-news", lane: "funding", title: "Gaia Dynamics Raises $7 Million Seed Round", url: "https://news.google.com/rss/articles/g1", url_kind: "redirect", source_name: "PR Newswire" }),
    item({ provider: "google-news", kind: "google-news", lane: "stealth", title: "Empirik emerges from stealth", url: "https://news.google.com/rss/articles/g2", url_kind: "redirect", source_name: "Dealroom", published_at: "2026-09-19T12:00:00Z" }),
    item({ provider: "google-news", kind: "google-news", lane: "stealth", title: "Noetive exits stealth with $41M seed", url: "https://news.google.com/rss/articles/g3", url_kind: "redirect", source_name: "Dealroom", published_at: "2026-09-21T09:00:00Z" }),
  ], { kind: "google-news" });
  const yc = provider("yc", 0.95, [
    item({ provider: "yc", kind: "directory", lane: "accelerator", title: "Baud: joins YC", url: "https://yc.example.com/baud", url_kind: "directory", source_name: "Y Combinator", published_at: null, structured: { company_name: "Baud", website: "https://baudlabs.ai", description: "AI chips", program: "Y Combinator", batch: "S26" } }),
    item({ provider: "yc", kind: "directory", lane: "accelerator", title: "Existing Co: joins YC", url: "https://yc.example.com/existing", url_kind: "directory", source_name: "Y Combinator", published_at: null, structured: { company_name: "Existing Company Inc", website: "https://existing.com", description: "x", program: "Y Combinator", batch: "S26" } }),
  ], { kind: "directory", undated: true });
  return [tc, gn, yc, provider("broken", 0.7, new Error("boom")), provider("empty", 0.7, [])];
}

async function runFixture(over: Partial<FunnelConfig> = {}, homepage: (d: string) => HomepageCheck = (d) => ({ reachable: true, status: 200, text: `${d.split(".")[0]} home page`, finalDomain: d })) {
  const ledger = LeadLedger.inMemory();
  const items = ItemLedger.inMemory();
  const checked: string[] = [];
  const result = await runFunnel(
    {
      providers: fixtureProviders(), fetcher: new PoliteFetcher({ fetchImpl: (async () => new Response("")) as typeof fetch, minDelayMs: 0, sleep: async () => {} }),
      existing: new ExistingIndex(companies, events), checkHomepage: async (d) => { checked.push(d); return homepage(d); }, ledger, items, log: memoryLogger(), signal: new AbortController().signal,
    },
    cfg(over),
  );
  return { result, ledger, items, checked };
}

test("FUNNEL: stage counts are exact and consistent from items to finalists", async () => {
  const { result: r } = await runFixture();
  const c = r.counts;
  assert.equal(c.items_fetched, 12);
  assert.deepEqual([c.items_outside_window, r.item_drop_reasons["outside_window:stale"], r.item_drop_reasons["outside_window:after_as_of"]], [2, 1, 1], "stale and not-yet-published items are outside the window");
  assert.equal(c.items_in_window, 10);
  assert.deepEqual([c.items_without_lead, r.item_drop_reasons.roundup_or_digest], [1, 1]);
  assert.equal(c.raw_leads, 9, "8 text leads + directory leads");
  assert.deepEqual([c.prefiltered, r.prefilter_reasons.fund_or_investor_raise], [1, 1]);
  assert.equal(c.leads_after_prefilter, c.raw_leads - c.prefiltered);
  assert.equal(c.duplicate_leads_merged, c.leads_after_prefilter - c.entities, "merged leads = leads - entities");
  assert.equal(c.entities, c.existing_entities + c.new_entities);
  assert.equal(c.ranked, c.new_entities);
  assert.ok(c.finalists <= r.counts.ranked && c.finalists >= 1);
});

test("FUNNEL: duplicates are merged across providers AND lanes with evidence kept; corroborated companies outrank single-source ones", async () => {
  const { result: r } = await runFixture();
  const gaia = r.merges.find((m) => m.name === "Gaia Dynamics")!;
  assert.deepEqual([gaia.leads, gaia.providers.sort()], [2, ["google-news", "tc"]]);
  const emp = r.merges.find((m) => m.name === "Empirik")!;
  assert.deepEqual([emp.leads, emp.lanes.sort()], [2, ["funding", "stealth"]], "one company found through two different lanes");
  assert.ok(r.counts.entities_multi_provider >= 2 && r.counts.entities_multi_lane >= 1);
  const rank = (n: string) => r.ranked.find((x) => x.entity.name === n)!;
  assert.ok(rank("Gaia Dynamics").score > rank("Noetive").score, "two independent sources beat one");
  assert.equal(rank("Gaia Dynamics").entity.evidence.length, 2);
});

test("FUNNEL: existing companies are caught BEFORE selection, never take a slot, and surface as new-event leads", async () => {
  const { result: r, checked } = await runFixture();
  assert.equal(r.existing.length, 1);
  const ex = r.existing[0]!;
  assert.deepEqual([ex.match.company_id, ex.match.event_lead, ex.match.known_source, ex.providers.sort()], [1, true, false, ["tc", "yc"]]);
  assert.ok(!r.ranked.some((x) => x.entity.name.startsWith("Existing")) && !r.finalists.some((x) => x.entity.name.startsWith("Existing")));
  assert.ok(!checked.includes("existing.com"), "no homepage is fetched for a company we already have");
  assert.equal(r.counts.existing_event_leads, 1);
});

test("FUNNEL: every item and every lead is in the ledgers, and every lead ends with a disposition explaining what happened", async () => {
  const { result: r, ledger, items } = await runFixture();
  assert.equal(items.all().length, r.counts.items_fetched);
  assert.equal(items.summary().by_outcome.lead, 9, "9 of the 10 in-window items produced a lead; the digest produced none");
  assert.equal(ledger.all().length, r.counts.raw_leads);
  assert.ok(ledger.all().every((l) => l.disposition !== null));
  const by = ledger.summary().by_disposition;
  assert.equal(by.prefiltered, 1);
  assert.equal(by.merged_into_entity, r.counts.duplicate_leads_merged, "every merged duplicate lead is marked merged_into_entity");
  assert.equal(by.existing_company_event_lead, 1);
  assert.equal(by.finalist ?? 0, r.finalists.length);
  assert.equal((by.finalist ?? 0) + (by.finalist_directory ?? 0) + (by.not_selected_rank ?? 0), r.counts.new_entities);
  assert.equal(by.finalist_directory ?? 0, r.directory_finalists.length);
  const merged = ledger.all().find((l) => l.disposition === "merged_into_entity")!;
  assert.ok(merged.duplicate_of && ledger.get(merged.duplicate_of), "a merged lead points at the lead it was merged into");
  const fin = ledger.all().find((l) => l.disposition === "finalist")!;
  assert.equal(fin.stage_reached, "decided");
  assert.ok(fin.selected_at && fin.drop_reason && /rank \d+; score/.test(fin.drop_reason));
});

test("FUNNEL: provider health: a throwing provider is isolated and reported failed; an empty one is 'empty'; the rest still run", async () => {
  const { result: r } = await runFixture();
  const h = Object.fromEntries(r.providers.map((p) => [p.provider, p]));
  assert.equal(h.broken!.status, "failed");
  assert.match(h.broken!.note ?? "", /boom/);
  assert.equal(h.empty!.status, "empty");
  assert.equal(h.tc!.status, "ok");
  assert.deepEqual([h.tc!.items_fetched, h.tc!.items_in_window], [7, 5]);
  assert.equal(h.yc!.items_in_window, 2, "undated directory items are always in the window");
  assert.ok(r.finalists.length > 0);
});

test("FUNNEL: homepages are checked only for the top slice within the budget, and the result feeds ranking", async () => {
  const none = await runFixture({ homepageBudget: 0 });
  assert.deepEqual(none.checked, []);
  const two = await runFixture({ homepageBudget: 2 });
  assert.equal(two.checked.length, 2);
  const all = await runFixture({}, (d) => (d === "gaiadynamics.ai" ? { reachable: false, error: "ENOTFOUND" } : { reachable: true, status: 200, text: `${d.split(".")[0]} home`, finalDomain: d }));
  const gaia = all.result.ranked.find((r) => r.entity.name === "Gaia Dynamics")!;
  assert.equal(gaia.homepage!.reachable, false);
  assert.match(gaia.breakdown.domain.note, /unreachable/);
  const empirik = all.result.ranked.find((r) => r.entity.name === "Empirik")!;
  assert.equal(empirik.homepage!.name_found, true);
  assert.ok(empirik.breakdown.domain.raw > gaia.breakdown.domain.raw);
});

// ---- EXPERIMENTAL domain guess + stronger identity verifier (2026-09-23) -----------------------------------------
//
// OFF BY DEFAULT (domainGuessBudget: 0 — see DEFAULT_FUNNEL_CONFIG's own comment). Every test here
// explicitly opts in. "Noetive" (fixtureProviders' Google-News-redirect item, title "Noetive exits
// stealth with $41M seed", no outbound_domains) is the entity with no domain candidate at all —
// the same one used throughout this file's other domain tests.

test("DOMAIN GUESS: OFF BY DEFAULT — attempts nothing unless explicitly enabled", async () => {
  const { result, checked } = await runFixture();
  assert.equal(result.counts.domain_guesses_attempted, 0);
  assert.ok(!checked.includes("noetive.com"));
  const noetive = result.ranked.find((r) => r.entity.name === "Noetive")!;
  assert.equal(noetive.entity.domain.domain, null);
});

test("DOMAIN GUESS: STRONG evidence (funding amount from real discovery evidence found on the page) -> ACCEPTED", async () => {
  const { result } = await runFixture({ domainGuessBudget: 20 }, (d) =>
    d === "noetive.com"
      ? { reachable: true, status: 200, text: "Noetive Inc. We're proud to announce our $41M seed round to build the future of noetive computing.", finalDomain: d }
      : { reachable: true, status: 200, text: `${d.split(".")[0]} home page`, finalDomain: d },
  );
  const noetive = result.ranked.find((r) => r.entity.name === "Noetive")!;
  assert.deepEqual([noetive.entity.domain.domain, noetive.entity.domain.trust], ["noetive.com", "linked"]);
  assert.equal(result.counts.domain_guesses_accepted, 1);
  const audit = result.domain_guess_audit.find((a) => a.name === "Noetive")!;
  assert.equal(audit.accepted, true);
  assert.ok(audit.strong.some((s) => s.category === "amount"));
});

test("DOMAIN GUESS: name-only (no independent evidence) -> REJECTED, entity stays unresolved", async () => {
  const { result } = await runFixture({ domainGuessBudget: 20 }, (d) =>
    d === "noetive.com" ? { reachable: true, status: 200, text: "Noetive — welcome to our website.", finalDomain: d } : { reachable: true, status: 200, text: `${d.split(".")[0]} home page`, finalDomain: d },
  );
  const noetive = result.ranked.find((r) => r.entity.name === "Noetive")!;
  assert.equal(noetive.entity.domain.domain, null, "name-only match must never be accepted");
  assert.equal(result.counts.domain_guesses_rejected, 1);
  const audit = result.domain_guess_audit.find((a) => a.name === "Noetive")!;
  assert.equal(audit.accepted, false);
  assert.equal(audit.strong.length, 0);
});

test("DOMAIN GUESS: an unreachable guess is rejected and recorded in the audit trail, never silently dropped", async () => {
  const { result } = await runFixture({ domainGuessBudget: 20 }, (d) => (d === "noetive.com" ? { reachable: false, error: "ENOTFOUND" } : { reachable: true, status: 200, text: `${d.split(".")[0]} home page`, finalDomain: d }));
  const audit = result.domain_guess_audit.find((a) => a.name === "Noetive")!;
  assert.equal(audit.reachable, false);
  assert.equal(audit.accepted, false);
  assert.match(audit.reason, /unreachable/);
});

test("DOMAIN GUESS (J): bounded by domainGuessBudget — a budget of 0 makes zero attempts; nothing unbounded", async () => {
  const { result, checked } = await runFixture({ domainGuessBudget: 0 });
  assert.equal(result.counts.domain_guesses_attempted, 0);
  assert.equal(result.domain_guess_audit.length, 0);
  assert.ok(!checked.includes("noetive.com"));
});

test("DOMAIN GUESS (K): an entity that ALREADY has a domain is never guessed at — untouched", async () => {
  const { result, checked } = await runFixture({ domainGuessBudget: 20 });
  assert.ok(!checked.includes("empirikcom"), "empirik already has a real linked domain — never re-guessed");
  const empirik = result.ranked.find((r) => r.entity.name === "Empirik")!;
  assert.equal(empirik.entity.domain.domain, "empirik.ai");
  assert.ok(!result.domain_guess_audit.some((a) => a.name === "Empirik"), "an already-resolved entity never appears in the guess audit at all");
});

test("DOMAIN GUESS (L): existing structured/name/linked resolution methods are completely unaffected by enabling the guess budget", async () => {
  const { result } = await runFixture({ domainGuessBudget: 20 });
  const baud = result.ranked.find((r) => r.entity.name === "Baud")!;
  assert.deepEqual([baud.entity.domain.domain, baud.entity.domain.trust], ["baudlabs.ai", "structured"]);
  const empirik = result.ranked.find((r) => r.entity.name === "Empirik")!;
  assert.deepEqual([empirik.entity.domain.domain, empirik.entity.domain.trust], ["empirik.ai", "linked"]);
});

test("FUNNEL: the whole run is deterministic (same inputs, same ranked output)", async () => {
  const brief = async () => (await runFixture()).result.ranked.map((r) => [r.entity.entity_id, r.score, r.selection]);
  assert.deepEqual(await brief(), await brief());
});

test("FUNNEL: an aborted run stops collecting (shutdown-safe) and still returns a result", async () => {
  const ac = new AbortController();
  ac.abort();
  const result = await runFunnel(
    { providers: [provider("tc", 0.9, [item({ title: "Gaia Dynamics raises $7M seed" })], { fetchItems: async (c) => { if (c.signal.aborted) return []; return [item({ title: "Gaia Dynamics raises $7M seed" })]; } })], fetcher: new PoliteFetcher({ fetchImpl: fetch, minDelayMs: 0 }), existing: new ExistingIndex([], []), checkHomepage: async () => ({ reachable: false }), ledger: LeadLedger.inMemory(), items: ItemLedger.inMemory(), log: memoryLogger(), signal: ac.signal },
    cfg(),
  );
  assert.equal(result.counts.raw_leads, 0);
});
