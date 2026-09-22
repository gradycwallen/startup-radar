import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryLogger } from "../src/log.ts";
import { candidateDomains, isNonCompanyDomain } from "../src/sources/domains.ts";
import { FetchError, PoliteFetcher, type Fetcher, type FetchResult } from "../src/sources/fetcher.ts";
import { parseFeed } from "../src/sources/feed.ts";
import { extractLinks, htmlToText } from "../src/sources/html.ts";
import { GoogleNewsProvider } from "../src/sources/providers/google-news.ts";
import { FEED_REGISTRY, RssFeedProvider } from "../src/sources/providers/rss-feed.ts";
import { TechstarsProvider, parseTechstarsPage } from "../src/sources/providers/techstars.ts";
import { YcDirectoryProvider, batchRank } from "../src/sources/providers/yc.ts";
import { defaultSourceProviders, selectProviders } from "../src/sources/registry.ts";
import type { SourceContext } from "../src/sources/types.ts";

/** A Fetcher that serves canned bodies by URL (or a function), and records what was requested. */
function fakeFetcher(routes: Record<string, string | { status: number; text: string }>): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async getText(url): Promise<FetchResult> {
      urls.push(url);
      const hit = routes[url] ?? Object.entries(routes).find(([k]) => url.startsWith(k))?.[1];
      const r = typeof hit === "string" ? { status: 200, text: hit } : (hit ?? { status: 404, text: "" });
      return { url, status: r.status, text: r.text, bytes: r.text.length, elapsed_ms: 1 };
    },
  };
}
const ctx = (fetcher: Fetcher, asOf = "2026-09-21T23:59:59Z", windowDays = 3): SourceContext => ({ asOf: new Date(asOf), windowDays, fetcher, signal: new AbortController().signal, log: memoryLogger() });

const RSS = `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example Feed</title>
<item><title><![CDATA[Gaia Dynamics Raises $7M &amp; more]]></title><link>https://news.example.com/gaia?utm_source=rss</link><guid>g1</guid><pubDate>Wed, 16 Sep 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Seed round led by <a href="https://corazoncapital.com">Corazon</a>.</p>]]></description>
<content:encoded><![CDATA[<p>Gaia Dynamics (<a href="https://gaiadynamics.ai/about">site</a>) raised a seed round, said <a href="https://twitter.com/x">X</a> and <a href="https://news.example.com/other">us</a>.</p>]]></content:encoded></item>
<item><title>No date item</title><link>https://news.example.com/nodate</link></item></channel></rss>`;

test("parseFeed: RSS with CDATA, entities, content:encoded, dates; tolerates missing fields", () => {
  const { title, entries } = parseFeed(RSS);
  assert.equal(title, "Example Feed");
  assert.equal(entries.length, 2);
  // CDATA content is literal XML; HTML entities inside it are decoded later, by the provider (see the RSS provider test).
  assert.equal(entries[0]!.title, "Gaia Dynamics Raises $7M &amp; more");
  assert.equal(entries[0]!.link, "https://news.example.com/gaia?utm_source=rss");
  assert.equal(entries[0]!.published?.toISOString(), "2026-09-16T10:00:00.000Z");
  assert.match(entries[0]!.contentHtml, /gaiadynamics\.ai/);
  assert.equal(entries[1]!.published, null);
});

test("parseFeed: Atom (rel=alternate link, updated date) and Google News <source>; garbage input yields no entries, not an exception", () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>D - Pantera Fund</title><link rel="self" href="https://x.com/self"/><link rel="alternate" href="https://x.com/alt"/><updated>2026-09-21T10:00:00Z</updated><summary>s</summary></entry></feed>`;
  const a = parseFeed(atom).entries[0]!;
  assert.deepEqual([a.link, a.published?.toISOString()], ["https://x.com/alt", "2026-09-21T10:00:00.000Z"]);
  const gn = `<rss><channel><item><title>Noetive exits stealth - Dealroom</title><link>https://news.google.com/rss/articles/CBM123</link><pubDate>Mon, 21 Sep 2026 09:00:00 GMT</pubDate><source url="https://dealroom.co">Dealroom</source></item></channel></rss>`;
  assert.equal(parseFeed(gn).entries[0]!.sourceName, "Dealroom");
  assert.deepEqual(parseFeed("<<<not xml").entries, []);
  assert.deepEqual(parseFeed("").entries, []);
});

test("html helpers: text is whitespace-collapsed and capped; links are absolute http(s) only", () => {
  assert.equal(htmlToText("<p>Hello   <b>world</b></p><script>bad()</script>", 100), "Hello world");
  assert.equal(htmlToText("x".repeat(50), 10).length, 10);
  const links = extractLinks(`<a href="/rel">r</a><a href="https://a.com/x">A</a><a href="mailto:z@z.com">m</a><a href="javascript:void(0)">j</a>`, "https://base.com/p");
  assert.deepEqual(links.map((l) => l.href), ["https://base.com/rel", "https://a.com/x"]);
});

test("company-domain candidates exclude publishers, socials, investors and the item's own host, in order, without duplicates", () => {
  const links = [
    "https://techcrunch.com/x", "https://sequoiacap.com/", "https://twitter.com/a", "https://www.empirik.ai/about", "https://empirik.ai/", "https://news.example.com/y", "https://corazoncapital.com", "https://acme.io",
  ].map((href) => ({ href, text: "" }));
  assert.deepEqual(candidateDomains(links, ["news.example.com"]), ["empirik.ai", "acme.io"]);
  assert.ok(isNonCompanyDomain("techcrunch.com") && isNonCompanyDomain("sequoiacap.com") && !isNonCompanyDomain("empirik.ai"));
});

// ---- providers -----------------------------------------------------------------------------------------------------------

test("RSS provider: items carry title, normalized URL, date, excerpt and outbound company-domain candidates", async () => {
  const def = { ...FEED_REGISTRY[0]!, url: "https://feed.example.com/rss" };
  const items = await new RssFeedProvider(def).fetchItems(ctx(fakeFetcher({ [def.url]: RSS })));
  assert.equal(items.length, 2);
  const g = items[0]!;
  assert.deepEqual([g.provider, g.title, g.url, g.source_name, g.published_at], ["techcrunch-startups", "Gaia Dynamics Raises $7M & more", "https://news.example.com/gaia", "TechCrunch", "2026-09-16T10:00:00.000Z"]);
  assert.match(g.excerpt, /Gaia Dynamics/);
  assert.deepEqual(g.outbound_domains, ["gaiadynamics.ai"], "investor, twitter and the publisher's own links are removed");
  assert.match(g.item_id, /^[0-9a-f]{12}$/);
  assert.equal(items[1]!.published_at, null);
});

test("RSS provider: a non-200 response yields no items (health reports it; nothing throws)", async () => {
  const def = { ...FEED_REGISTRY[0]!, url: "https://blocked.example.com/rss" };
  assert.deepEqual(await new RssFeedProvider(def).fetchItems(ctx(fakeFetcher({ [def.url]: { status: 403, text: "Just a moment..." } }))), []);
});

test("Google News provider: builds after:/before: windows from the as-of date, strips the ' - Publisher' suffix, dedupes across queries", async () => {
  const gn = (q: string) => `<rss><channel><item><title>Noetive exits stealth with $41M seed - Dealroom</title><link>https://news.google.com/rss/articles/CBMabc</link><pubDate>Mon, 21 Sep 2026 09:00:00 GMT</pubDate><source url="https://dealroom.co">Dealroom</source></item></channel></rss>`;
  const p = new GoogleNewsProvider([{ q: "emerges from stealth", lane: "stealth" }, { q: "exits stealth mode", lane: "stealth" }]);
  const url = p.urlFor({ q: "emerges from stealth", lane: "stealth" }, new Date("2026-09-21T23:59:59Z"), 3);
  assert.match(decodeURIComponent(url), /emerges from stealth after:2026-09-18 before:2026-09-22/);
  const fetcher = fakeFetcher({ "https://news.google.com/rss/search": gn("x") });
  const items = await p.fetchItems(ctx(fetcher));
  assert.equal(fetcher.urls.length, 2);
  assert.equal(items.length, 1, "the same story from two queries is one item");
  assert.deepEqual([items[0]!.title, items[0]!.source_name, items[0]!.url_kind, items[0]!.tags.length], ["Noetive exits stealth with $41M seed", "Dealroom", "redirect", 2]);
});

test("YC provider: sorts batches by season/year, takes the latest N, skips inactive, keeps structured website + undated items", async () => {
  assert.ok(batchRank("fall-2026")! > batchRank("summer-2026")! && batchRank("summer-2026")! > batchRank("winter-2026")! && batchRank("winter-2026")! > batchRank("fall-2025")!);
  assert.equal(batchRank("nonsense"), null);
  // The mirror also lists FUTURE batches with 1-2 pre-announced companies (summer-2027): those must never be chosen.
  const meta = JSON.stringify({ batches: { "winter-2012": { name: "Winter 2012", count: 66 }, "summer-2027": { name: "Summer 2027", count: 2 }, "winter-2027": { name: "Winter 2027", count: 1 }, "summer-2026": { name: "Summer 2026", count: 232 }, "fall-2026": { name: "Fall 2026", count: 79 }, "winter-2026": { name: "Winter 2026", count: 150 } } });
  const rows = (batch: string) => JSON.stringify([
    { name: `Baud ${batch}`, website: "https://baudlabs.ai/", one_liner: "AI chips", batch, status: "Active", team_size: 3, industry: "Industrials", url: "https://www.ycombinator.com/companies/baud" },
    { name: "Dead Co", website: "https://dead.com", batch, status: "Inactive" },
  ]);
  const fetcher = fakeFetcher({ "https://yc.test/meta.json": meta, "https://yc.test/batches/fall-2026.json": rows("Fall 2026"), "https://yc.test/batches/summer-2026.json": rows("Summer 2026") });
  const items = await new YcDirectoryProvider({ baseUrl: "https://yc.test", latestBatches: 2 }).fetchItems(ctx(fetcher));
  assert.deepEqual(fetcher.urls.filter((u) => u.includes("/batches/")), ["https://yc.test/batches/fall-2026.json", "https://yc.test/batches/summer-2026.json"], "placeholder future batches are skipped");
  // A batch that has not started as of the run date is excluded too.
  const early = await new YcDirectoryProvider({ baseUrl: "https://yc.test", latestBatches: 2 }).fetchItems(ctx(fakeFetcher({ "https://yc.test/meta.json": meta, "https://yc.test/batches/summer-2026.json": rows("Summer 2026"), "https://yc.test/batches/winter-2026.json": rows("Winter 2026") }), "2026-08-01T00:00:00Z"));
  assert.deepEqual(early.map((i) => i.structured?.batch).sort(), ["Summer 2026", "Winter 2026"], "fall-2026 had not started on 2026-08-01");
  assert.equal(items.length, 2, "the inactive company is skipped");
  const i = items[0]!;
  assert.deepEqual([i.published_at, i.structured?.company_name, i.structured?.website, i.outbound_domains, i.kind, i.url_kind], [null, "Baud Fall 2026", "https://baudlabs.ai/", ["baudlabs.ai"], "directory", "directory"]);
});

const TECHSTARS_A = `<h2>Meet the Class of 2026</h2><p><strong>Aiir (</strong><a href="https://useaiir.com/" rel="noopener"><strong>useaiir.com</strong></a><strong>)</strong> — An AI platform for investor relations at asset managers, automating due diligence.</p>
<p><strong>BaseComp AI (</strong><a href="https://basecomp.ai/"><strong>basecomp.ai</strong></a><strong>)</strong> — Compensation benchmarking software for finance teams worldwide.</p><p><a href="https://apply.techstars.com">Apply Today</a></p><p><a href="https://twitter.com/techstars">Follow us</a></p>`;
const TECHSTARS_B = `<h3 id="x">Techstars Boulder</h3><ul><li value="1"><a href="http://sunzu.ai"><strong>Sunzu</strong></a> is an on-demand user research layer for product teams, using a proprietary behavioral engine.</li>
<li value="2"><a href="https://www.counselmedshealth.com/"><strong>COUNSELMEDS</strong></a> is a pharmacist-led care platform for Medicaid health plans and members.</li><li><a href="https://x.com/short"><strong>Tiny</strong></a> ok</li></ul>`;

test("Techstars parser: format A (cohort announcement: name before '(' + linked domain) and format B (class overview list); ignores CTAs, socials and description-less links", () => {
  const a = parseTechstarsPage(TECHSTARS_A);
  assert.deepEqual(a.map((c) => [c.name, c.website]), [["Aiir", "https://useaiir.com/"], ["BaseComp AI", "https://basecomp.ai/"]]);
  assert.match(a[0]!.description, /^An AI platform for investor relations/);
  const b = parseTechstarsPage(TECHSTARS_B);
  assert.deepEqual(b.map((c) => [c.name, c.website, c.program]), [["Sunzu", "http://sunzu.ai", "Techstars Boulder"], ["COUNSELMEDS", "https://www.counselmedshealth.com/", "Techstars Boulder"]]);
});

test("Techstars provider: discovers pages from the newsroom index, honors as-of and max-age, and yields structured items with the page's publish date", async () => {
  const idx = `<a href="/newsroom/the-2026-class-of-x">a</a><a href="/newsroom/introducing-fall-class">b</a><a href="/newsroom/old-news-class">c</a><a href="/newsroom/techstars-and-justworks-partnership">partner</a><a href="/about">d</a><a href="/newsroom/the-2026-class-of-x">dup</a>`;
  const page = (date: string, body: string) => `<meta property="article:published_time" content="${date}"/>${body}`;
  const fetcher = fakeFetcher({
    "https://ts.test/newsroom": idx,
    "https://ts.test/newsroom/the-2026-class-of-x": page("2026-09-18T15:48:52.019Z", TECHSTARS_A),
    "https://ts.test/newsroom/introducing-fall-class": page("2026-09-08T10:00:00.000Z", TECHSTARS_B),
    "https://ts.test/newsroom/old-news-class": page("2026-01-01T00:00:00.000Z", TECHSTARS_A),
    "https://ts.test/newsroom/techstars-and-justworks-partnership": page("2026-09-15T00:00:00.000Z", TECHSTARS_B),
  });
  const p = new TechstarsProvider({ indexUrl: "https://ts.test/newsroom", maxAgeDays: 45 });
  const now = await p.fetchItems(ctx(fetcher, "2026-09-21T23:59:59Z"));
  assert.deepEqual(now.map((i) => i.structured?.company_name).sort(), ["Aiir", "BaseComp AI", "COUNSELMEDS", "Sunzu"], "a partnership post is not a cohort page, and a page older than max-age is skipped");
  assert.equal(now.find((i) => i.structured?.company_name === "Aiir")!.published_at, "2026-09-18T15:48:52.019Z");
  const early = await p.fetchItems(ctx(fakeFetcher(Object.fromEntries(Object.entries({
    "https://ts.test/newsroom": idx, "https://ts.test/newsroom/the-2026-class-of-x": page("2026-09-18T15:48:52.019Z", TECHSTARS_A), "https://ts.test/newsroom/introducing-fall-class": page("2026-09-08T10:00:00.000Z", TECHSTARS_B), "https://ts.test/newsroom/old-news-class": page("2026-01-01T00:00:00.000Z", TECHSTARS_A),
  }))), "2026-09-10T23:59:59Z"));
  assert.deepEqual(early.map((i) => i.structured?.company_name).sort(), ["COUNSELMEDS", "Sunzu"], "a page published after the as-of date does not exist yet for that run");
});

test("registry: every default provider is independently constructible; selection validates ids (a typo must not silently drop a source)", () => {
  const all = defaultSourceProviders();
  const ids = all.map((p) => p.id);
  assert.deepEqual(ids, ["techcrunch-startups", "techcrunch-venture", "tech-eu", "eu-startups", "arcticstartup", "sifted", "prnewswire-vc", "google-news", "yc-directory", "techstars-cohorts"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(selectProviders(all, ["sifted", "yc-directory"]).map((p) => p.id), ["sifted", "yc-directory"]);
  assert.equal(selectProviders(all, undefined, ["google-news"]).length, all.length - 1);
  assert.throws(() => selectProviders(all, ["techcrunchh"]), /Unknown provider "techcrunchh"/);
  assert.ok(all.every((p) => p.reliability > 0 && p.reliability <= 1 && p.description));
  for (const later of ["sec", "github", "hackernews", "producthunt", "explor"]) assert.ok(!ids.some((i) => i.includes(later)), `${later} is a later phase`);
});

// ---- fetcher -------------------------------------------------------------------------------------------------------------

test("PoliteFetcher: per-host spacing, per-provider stats, honest User-Agent, GET only, size cap", async () => {
  const sleeps: number[] = [];
  let t = 1000;
  const seen: Array<{ url: string; method?: string; ua: string | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method, ua: new Headers(init.headers).get("user-agent") });
    return new Response(url.includes("big") ? "x".repeat(5000) : "ok", { status: url.includes("gone") ? 404 : 200 });
  }) as typeof fetch;
  const f = new PoliteFetcher({ fetchImpl, minDelayMs: 500, hostDelayMs: { "slow.example.com": 2000 }, maxBytes: 100, sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t });
  await f.getText("https://a.example.com/1", { provider: "p1" });
  await f.getText("https://a.example.com/2", { provider: "p1" });
  await f.getText("https://b.example.com/1", { provider: "p2" });
  await f.getText("https://slow.example.com/1", { provider: "p2" });
  await f.getText("https://slow.example.com/2", { provider: "p2" });
  const big = await f.getText("https://a.example.com/big", { provider: "p1" });
  await f.getText("https://a.example.com/gone", { provider: "p1" });
  assert.deepEqual(sleeps.slice(0, 1), [500], "the second request to the same host waits; other hosts do not");
  assert.ok(sleeps.includes(2000), "per-host delay override applies");
  assert.ok(big.bytes <= 5000 && big.text.length <= 5000);
  assert.ok(seen.every((s) => s.method === "GET" && /StartupRadarScout/.test(s.ua ?? "")));
  assert.deepEqual(f.stats("p1").statuses, { "200": 3, "404": 1 });
  assert.equal(f.stats("p2").requests, 3);
  assert.equal(f.stats("nobody").requests, 0);
});

test("PoliteFetcher: optional per-request headers (V2-2A) are merged in without disturbing user-agent/accept defaults", async () => {
  const seen: Headers[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const f = new PoliteFetcher({ fetchImpl, minDelayMs: 0, sleep: async () => {} });
  await f.getText("https://api.github.com/orgs/acme", { provider: "p", headers: { authorization: "Bearer test-token", "x-github-api-version": "2022-11-28" } });
  await f.getText("https://a.example.com/plain", { provider: "p" }); // no headers option: identical to before this change
  assert.equal(seen[0]!.get("authorization"), "Bearer test-token");
  assert.equal(seen[0]!.get("x-github-api-version"), "2022-11-28");
  assert.match(seen[0]!.get("user-agent") ?? "", /StartupRadarScout/, "extra headers do not clobber the honest user-agent");
  assert.equal(seen[1]!.has("authorization"), false, "a request with no headers option is unaffected");
});

test("PoliteFetcher: network failures throw FetchError and are counted in stats; invalid URLs too", async () => {
  const f = new PoliteFetcher({ fetchImpl: (async () => { throw new TypeError("fetch failed", { cause: new Error("ENOTFOUND nope.invalid") }); }) as typeof fetch, minDelayMs: 0, sleep: async () => {} });
  await assert.rejects(f.getText("https://nope.invalid/x", { provider: "p" }), (e: unknown) => e instanceof FetchError && /ENOTFOUND/.test((e as Error).message));
  await assert.rejects(f.getText("not a url", { provider: "p" }), FetchError);
  assert.deepEqual(f.stats("p").statuses, { ERR: 2 });
  assert.ok(f.stats("p").errors.length === 2);
});
