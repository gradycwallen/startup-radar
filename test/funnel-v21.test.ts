import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ExistingIndex } from "../src/funnel/existing.ts";
import type { Entity } from "../src/funnel/entities.ts";
import { DEFAULT_FUNNEL_CONFIG, runFunnel, type FunnelConfig } from "../src/funnel/funnel.ts";
import { ItemLedger } from "../src/funnel/item-ledger.ts";
import { isDirectoryOnly, primaryProvider, rankEntities, selectDirectoryFinalists, selectFinalists, type RankedEntity } from "../src/funnel/rank.ts";
import { FUNNEL_SNAPSHOT_VERSION, loadFunnelSnapshot, writeFunnelSnapshot } from "../src/funnel/snapshot.ts";
import { LeadLedger } from "../src/ledger.ts";
import { memoryLogger } from "../src/log.ts";
import { PoliteFetcher } from "../src/sources/fetcher.ts";
import { makeItem, type ItemInput } from "../src/sources/item.ts";
import type { SourceItem, SourceProvider } from "../src/sources/types.ts";

const ASOF = new Date("2026-09-21T23:59:59Z");
const item = (over: Partial<ItemInput> = {}): SourceItem =>
  makeItem({ provider: "tc", kind: "rss", lane: "news", title: "x", url: `https://tc.example.com/${Math.random().toString(36).slice(2)}`, url_kind: "article", source_name: "TechCrunch", published_at: "2026-09-20T10:00:00Z", fetchedAt: new Date(), ...over })!;
const provider = (id: string, items: SourceItem[], over: Partial<SourceProvider> = {}): SourceProvider => ({ id, kind: "rss", description: id, reliability: 0.9, fetchItems: async () => items, ...over }) as SourceProvider;
const cfg = (over: Partial<FunnelConfig> = {}): FunnelConfig => ({ ...DEFAULT_FUNNEL_CONFIG, asOf: ASOF, ...over });

const ARTICLE = `<html><body><header><a href="https://techcrunch.com/about">About</a><a href="https://twitter.com/tc">tw</a></header>
<article><p>Empirik (<a href="https://www.empirik.ai/">site</a>) raised $21M from <a href="https://sequoiacap.com">Sequoia</a>, see <a href="https://unrelated-company.io/x">this</a>.</p></article>
<footer><a href="https://footer-empirik.example.org">footer link</a></footer></body></html>`;

function run(providers: SourceProvider[], responses: Record<string, { status: number; text: string } | Error>, over: Partial<FunnelConfig> = {}) {
  const requested: string[] = [];
  const fetchImpl = (async (url: string) => {
    requested.push(url);
    const r = responses[url];
    if (r instanceof Error) throw r;
    if (!r) return new Response("not found", { status: 404 });
    return new Response(r.text, { status: r.status });
  }) as typeof fetch;
  const ledger = LeadLedger.inMemory();
  const promise = runFunnel(
    {
      providers, fetcher: new PoliteFetcher({ fetchImpl, minDelayMs: 0, sleep: async () => {} }), existing: new ExistingIndex([{ id: 1, name: "Old Co", domain: "old.com" }], []),
      checkHomepage: async () => ({ reachable: true, status: 200, text: "Empirik home", finalDomain: "empirik.ai" }), ledger, items: ItemLedger.inMemory(), log: memoryLogger(), signal: new AbortController().signal,
    },
    cfg(over),
  );
  return { promise, requested, ledger };
}

// ---- article enrichment --------------------------------------------------------------------------------------------------

test("ENRICHMENT: an excerpt-only article lacking the company's link gets its PAGE fetched; the main-content link matching the name resolves the domain", async () => {
  const u = "https://tc.example.com/empirik";
  const { promise, requested } = run([provider("tc", [item({ title: "Sequoia-incubated Empirik launches with $21M to predict outages", url: u })])], { [u]: { status: 200, text: ARTICLE } });
  const r = await promise;
  assert.deepEqual(requested.filter((x) => x === u), [u]);
  const e = r.ranked.find((x) => x.entity.name === "Empirik")!;
  assert.deepEqual([e.entity.domain.domain, e.entity.domain.trust], ["empirik.ai", "linked"]);
  assert.deepEqual([r.counts.article_pages_attempted, r.counts.article_pages_ok, r.counts.article_domains_resolved], [1, 1, 1]);
  assert.ok(!e.entity.domain.candidates.some((c) => c.domain === "footer-empirik.example.org" || c.domain === "sequoiacap.com"), "footer, investor and publisher links never become candidates");
  assert.ok(!e.entity.domain.candidates.some((c) => c.domain === "unrelated-company.io"), "a link that does not resemble the company name is not accepted");
});

test("ENRICHMENT: aggregator redirect URLs are never fetched; blocked or failing pages are skipped; each URL is fetched at most once", async () => {
  const blocked = "https://tc.example.com/blocked";
  const broken = "https://tc.example.com/broken";
  const gn = "https://news.google.com/rss/articles/CBMabc";
  const { promise, requested } = run(
    [provider("tc", [item({ title: "Blocked Co raises $5M seed", url: blocked }), item({ title: "Broken Co raises $5M seed", url: broken })]),
     provider("google-news", [item({ provider: "google-news", kind: "google-news", title: "Redirect Co raises $5M seed", url: gn, url_kind: "redirect", source_name: "Dealroom" })])],
    { [blocked]: { status: 403, text: "Just a moment..." }, [broken]: new TypeError("fetch failed") },
  );
  const r = await promise;
  assert.ok(!requested.includes(gn), "Google News redirect links cannot be fetched and are never tried");
  assert.equal(requested.filter((x) => x === blocked).length, 1);
  assert.deepEqual([r.counts.article_pages_attempted, r.counts.article_pages_ok, r.counts.article_domains_resolved], [2, 0, 0]);
  assert.equal(r.ranked.length, 3, "the funnel is unaffected by failed enrichment");
});

test("ENRICHMENT: bounded by articleBudget, and entities that already have a domain are not fetched", async () => {
  const items = ["Aaa", "Bbb", "Ccc", "Ddd"].map((n) => item({ title: `${n} Corp raises $5M seed`, url: `https://tc.example.com/${n}` }));
  const withDomain = item({ title: "Known Co raises $5M seed", url: "https://tc.example.com/known", outbound_domains: ["knownco.com"] });
  const { promise, requested } = run([provider("tc", [...items, withDomain])], {}, { articleBudget: 2 });
  const r = await promise;
  assert.equal(r.counts.article_pages_attempted, 2);
  assert.ok(!requested.includes("https://tc.example.com/known"));
});

// ---- two-track selection --------------------------------------------------------------------------------------------------

const ycItem = (name: string, site: string, published: string | null = null) =>
  item({ provider: "yc", kind: "directory", lane: "accelerator", title: `${name}: joins Y Combinator`, url: `https://yc.example.com/${name}`, url_kind: "directory", source_name: "Y Combinator", published_at: published,
    structured: { company_name: name, website: site, description: "AI things", program: "Y Combinator", batch: "S26" } });

test("TWO TRACKS: official directory members get their own bounded slots and never consume news finalist slots", async () => {
  const news = provider("tc", Array.from({ length: 6 }, (_, i) => item({ title: `NewsCo${String.fromCharCode(65 + i)} raises $${5 + i}M seed`, url: `https://tc.example.com/n${i}` })));
  const yc = provider("yc", Array.from({ length: 12 }, (_, i) => ycItem(`Batch${String.fromCharCode(65 + i)}`, `https://batch${String.fromCharCode(97 + i)}.ai`)), { kind: "directory", undated: true, reliability: 0.95 });
  const { promise, ledger } = run([news, yc], {}, { finalists: 4, directoryFinalists: 5 });
  const r = await promise;
  assert.equal(r.finalists.length, 4);
  assert.equal(r.directory_finalists.length, 5);
  assert.ok(r.finalists.every((f) => f.track === "news") && r.directory_finalists.every((f) => f.track === "directory"));
  assert.equal(r.counts.directory_entities, 12);
  assert.equal(r.counts.new_entities, 18);
  const by = ledger.summary().by_disposition;
  assert.deepEqual([by.finalist, by.finalist_directory], [4, 5]);
  assert.equal(by.not_selected_rank, 18 - 9, "directory members beyond the cap are recorded, not lost: they reach the funnel again once earlier ones are ingested");
  assert.ok(r.directory_finalists.every((f) => f.selection.startsWith("directory_track:")));
});

test("TWO TRACKS: an entity backed by BOTH a news article and a directory row is a news-track entity (it has corroboration)", async () => {
  const news = provider("tc", [item({ title: "Baud raises $3M seed", url: "https://tc.example.com/baud" })]);
  const yc = provider("yc", [ycItem("Baud", "https://baud.ai")], { kind: "directory", undated: true });
  const r = await run([news, yc], {}).promise;
  const baud = r.ranked.find((x) => x.entity.name === "Baud")!;
  assert.equal(baud.track, "news");
  assert.equal(baud.entity.leads.length, 2);
  assert.ok(!isDirectoryOnly(baud.entity));
});

const fakeRanked = (id: string, score: number, provider: string, lane: string, track: RankedEntity["track"] = "news"): RankedEntity => ({
  entity: { entity_id: id, name: id, leads: [{ provider, lane, name: id, source_url: "u", source_retrieved: true }] } as unknown as Entity,
  track, score, breakdown: {} as RankedEntity["breakdown"], rank: 0, homepage: null, existing: null, finalist: false, selection: "not_selected",
});

test("directory selection: by score, per-provider cap so one directory cannot crowd out the other, leftovers filled, minimum score enforced", () => {
  const yc = Array.from({ length: 10 }, (_, i) => fakeRanked(`y${i}`, 70 - i, "yc-directory", "accelerator", "directory"));
  const ts = Array.from({ length: 3 }, (_, i) => fakeRanked(`t${i}`, 60 - i, "techstars-cohorts", "accelerator", "directory"));
  const weak = fakeRanked("weak", 10, "yc-directory", "accelerator", "directory");
  const fin = selectDirectoryFinalists(rankEntities([...yc, ...ts, weak]), { finalists: 8, minScore: 30, maxProviderShare: 0.6 });
  assert.equal(fin.length, 8);
  assert.equal(fin.filter((r) => primaryProvider(r) === "techstars-cohorts").length, 3, "the smaller directory is represented despite lower scores");
  assert.equal(fin.filter((r) => r.selection === "directory_track:score" && primaryProvider(r) === "yc-directory").length, 5, "yc capped at ceil(8*0.6)=5 in the score phase");
  assert.ok(!fin.some((r) => r.entity.entity_id === "weak"));
  assert.equal(rankEntities([weak])[0]!.selection, "below_min_score");
});

test("reserved lane/provider slots need a score floor: they exist for diversity, not to admit weak candidates", () => {
  const ranked = rankEntities([fakeRanked("strong", 85, "a", "funding"), fakeRanked("mid", 70, "a", "funding"), fakeRanked("weakLane", 44, "b", "launches"), fakeRanked("weakProv", 41, "c", "funding")]);
  const fin = selectFinalists(ranked, { finalists: 3, minScore: 30, reserveMinScore: 50, maxProviderShare: 1, maxLaneShare: 1 });
  assert.deepEqual(fin.map((r) => [r.entity.entity_id, r.selection.startsWith("reserved_")]), [["strong", true], ["mid", false], ["weakLane", false]]);
  assert.ok(!fin.some((r) => r.selection === "reserved_lane:launches"), "the launches lane had only a weak candidate: no reservation, though it still fills by score");
});

// ---- snapshot format --------------------------------------------------------------------------------------------------------

test("funnel snapshot: round trip; a clear error for missing dir, missing http/, bad manifest and bad db", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "scout-fsnap-")), "snap");
  const snap = { manifest: { version: FUNNEL_SNAPSHOT_VERSION as 1, kind: "funnel" as const, created_at: "2026-09-22T00:00:00Z", description: "t", now: "2026-09-22T00:00:00Z", as_of_dates: ["2026-09-21"], window_days: 3 }, db: { companies: [{ id: 1, name: "A", domain: "a.com" }], events: [] } };
  writeFunnelSnapshot(dir, snap);
  assert.throws(() => loadFunnelSnapshot(dir), /no http\/ recordings/);
  mkdirSync(join(dir, "http"));
  assert.deepEqual(loadFunnelSnapshot(dir), snap);
  assert.throws(() => loadFunnelSnapshot("/no/such/dir"), /not found/);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...snap.manifest, kind: "domain" }));
  assert.throws(() => loadFunnelSnapshot(dir), /invalid funnel snapshot manifest/);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(snap.manifest));
  writeFileSync(join(dir, "db.json"), JSON.stringify({ companies: [{ id: "x" }], events: [] }));
  assert.throws(() => loadFunnelSnapshot(dir), /invalid funnel snapshot db\.json/);
  writeFileSync(join(dir, "db.json"), "{ nope");
  assert.throws(() => loadFunnelSnapshot(dir), /not valid JSON/);
});

// ---- static guards ---------------------------------------------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : []; });
}

test("V2-1 GUARD: the deterministic funnel has NO LLM: no Anthropic SDK, model names or prompts anywhere in the funnel/source/eval code", () => {
  const files = [...sourceFiles("src/funnel"), ...sourceFiles("src/sources"), ...sourceFiles("src/eval"), "src/funnel-main.ts"];
  const offenders: string[] = [];
  for (const f of files) {
    const t = readFileSync(f, "utf8");
    if (/@anthropic-ai\/sdk|\bnew\s+Anthropic\b|claude-(?:haiku|sonnet|opus|fable)|\bmessages\.(?:create|stream)\b|ANTHROPIC_API_KEY/.test(t)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test("V2-1 GUARD: the funnel and sources never touch the database client or a write path; only the read-only db layer is used, and only by the live CLI branch", () => {
  const files = [...sourceFiles("src/funnel"), ...sourceFiles("src/sources"), ...sourceFiles("src/eval")];
  for (const f of files) // Supabase table access is `.from("table")` with a string literal; `Array.from(...)` is unrelated.
  for (const f of files) assert.ok(!/supabase-js|ReadOnlyDb|\.from\(\s*["'`]/.test(readFileSync(f, "utf8")), `${f} must not use a database client`);
  const main = readFileSync("src/funnel-main.ts", "utf8");
  const start = main.indexOf("if (values.replay) {");
  const end = main.indexOf("} else {", start);
  const replayBranch = main.slice(start, end);
  for (const forbidden of ["loadEnvFile", "readSupabaseEnv", "new ReadOnlyDb", "process.env"]) assert.ok(!replayBranch.includes(forbidden), `the --replay branch must not use ${forbidden}`);
});

test("V2-1 GUARD: every source module fetches only through the Fetcher (no raw fetch in providers)", () => {
  for (const f of sourceFiles("src/sources/providers")) assert.ok(!/(^|[^.\w])fetch\s*\(/.test(readFileSync(f, "utf8")), `${f} must use ctx.fetcher, not fetch()`);
});
