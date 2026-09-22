import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSubject, extractHeadline, extractLeads, isLateRound, matureSignals, parseAmount, parseRound, youngSignals, laneForEvent } from "../src/funnel/extract.ts";
import { aliasKey, domainInName, nameDomainSimilarity, nameKey, similarity } from "../src/funnel/text.ts";
import { prefilterLead } from "../src/funnel/prefilter.ts";
import type { RawLead } from "../src/schema.ts";
import { makeItem } from "../src/sources/item.ts";
import type { SourceItem } from "../src/sources/types.ts";

const item = (over: Partial<Parameters<typeof makeItem>[0]> = {}): SourceItem =>
  makeItem({ provider: "p", kind: "rss", lane: "news", title: "x", url: "https://n.example.com/a", url_kind: "article", source_name: "News", published_at: "2026-09-16T10:00:00Z", fetchedAt: new Date(), ...over })!;

// [headline, company, event type, round, amount usd]
const HEADLINES: Array<[string, string, string, string | null, number | null]> = [
  ["Sequoia-incubated Empirik launches with $21M to predict outages before they happen", "Empirik", "funding", null, 21_000_000],
  ["Payments infrastructure provider Fin.com emerges from stealth with $20m in seed funding led by Expa and Garrett Camp", "Fin.com", "stealth", "seed", 20_000_000],
  ["Gaia Dynamics Raises $7M to Expand AI Platform Keeping Businesses Ahead of Tariffs and Trade Risk", "Gaia Dynamics", "funding", null, 7_000_000],
  ["TypeSafe AI Emerges From Stealth With $40M in Funding With New Model for Composable AI", "TypeSafe AI", "stealth", null, 40_000_000],
  ["TigerByte Cyber Emerges From Stealth With $3 Million in Funding", "TigerByte Cyber", "stealth", null, 3_000_000],
  ["Noetive exits stealth with $41M seed to bring AI to the physical economy", "Noetive", "stealth", "seed", 41_000_000],
  ["Ravel Raises $8.2 Million Seed Round to Scale Blended Textile Recycling", "Ravel", "funding", "seed", 8_200_000],
  ["10x Banking raises $45m to fuel expansion efforts", "10x Banking", "funding", null, 45_000_000],
  ["AI Startup Gaia Dynamics Raises $7M Seed Round", "Gaia Dynamics", "funding", "seed", 7_000_000],
  ["DeepMind Offshoot Emulate Closes In on $700 Million Seed Round", "Emulate", "funding", "seed", 700_000_000],
  ["heylogin raises €3M seed round", "heylogin", "funding", "seed", 3_240_000],
  ["ScrollEd wants to turn textbooks into TikTok", "ScrollEd", "product_launch", null, null],
  ["Berlin-based Acme Robotics secures pre-seed funding", "Acme Robotics", "funding", "pre_seed", null],
  ["London’s Metris Energy raises €4.35 million to scale AI platform", "Metris Energy", "funding", null, 4_698_000],
  ["Estonian Creem raises €5 million seed to expand billing", "Creem", "funding", "seed", 5_400_000],
  ["Fluxnium, Inc. Raises $7M Seed to Advance Seawater Uranium", "Fluxnium", "funding", "seed", 7_000_000],
];

test("headline extraction: real announcement headlines give the right company, event, round and amount", () => {
  for (const [title, company, event, round, usd] of HEADLINES) {
    const r = extractHeadline(title, "");
    assert.ok(!("drop" in r), `${title} -> ${JSON.stringify(r)}`);
    assert.deepEqual([r.company_name, r.event_type, r.round, r.amount.usd], [company, event, round, usd], title);
  }
});

test("headline extraction drops digests, questions, M&A, event promos and headlines with no company subject", () => {
  const drops: Array<[string, string]> = [
    ["Discover what's next: 5 days left to save up to $200 on your TechCrunch Disrupt pass", "roundup_or_digest"],
    ["London Demo Day 2026: startups to watch", "roundup_or_digest"],
    ["This Week in Startups: three funding rounds", "roundup_or_digest"],
    ["Why founders should raise less", "not_an_announcement"],
    ["Is this the end of seed rounds?", "not_an_announcement"],
    ["Apple acquires AI startup for $200M", "m_and_a"],
    ["The 20 European investors funding NATO's defence and innovation", "no_event_pattern"],
    ["Whipsaw's \"The Workshop\" Kicks Off New Cohort of Breakthrough Hardware Startups", "no_event_pattern"],
    ["Startup raises $10M seed round", "no_company_subject"],
    ["SparkLabs and Mirae Asset Launch a Venture Capital Fund for Central Asian Startups", "no_company_subject"],
    ["Uzbek Startup Joins Constructor Start Cohort", "no_company_subject"],
    ["Luma page. raises $5M seed", "no_company_subject"],
    ["5 startups raise seed rounds", "roundup_or_digest"],
  ];
  for (const [title, reason] of drops) assert.deepEqual(extractHeadline(title, ""), { drop: reason }, title);
});

test("weak funding verbs need real funding evidence: 'gets sued' is not a funding round", () => {
  assert.ok("drop" in extractHeadline("Acme gets sued by former employee", ""));
  const r = extractHeadline("Acme lands $12M Series A", "");
  assert.ok(!("drop" in r) && r.round === "series_a" && r.event_type === "funding");
});

test("cleanSubject: descriptors, hyphenated modifiers, appositives, connectors and generic subjects", () => {
  const cases: Array<[string, string | null]> = [
    ["Sequoia-incubated Empirik", "Empirik"], ["Payments infrastructure provider Fin.com", "Fin.com"], ["AI Startup Gaia Dynamics", "Gaia Dynamics"],
    ["DeepMind Offshoot Emulate", "Emulate"], ["Acme, a Berlin-based startup", "Acme"], ["Exclusive: Foo Bar", "Foo Bar"], ["heylogin", "heylogin"],
    ["Bank of Sound", "Bank of Sound"], ["the startup", null], ["Startup", null], ["5", null], ["This cybersecurity startup with a very long descriptive sentence here", null],
    ["lowercase multiword name", null], ["Costs $5M", null],
  ];
  for (const [raw, want] of cases) assert.equal(cleanSubject(raw), want, raw);
});

test("amounts: currencies convert, valuations and small numbers are ignored, 'multi-million' is text only", () => {
  assert.deepEqual(parseAmount("raises $20m in seed"), { usd: 20_000_000, text: "$20m", currency: "USD" });
  assert.equal(parseAmount("raises €1.5 million").usd, 1_620_000);
  assert.equal(parseAmount("raises £2M").usd, 2_540_000);
  assert.equal(parseAmount("raises 12 million dollars").usd, 12_000_000);
  assert.equal(parseAmount("emerges at a $1.2B valuation with $180M Series A").usd, 180_000_000, "the valuation is skipped, the round is kept");
  assert.equal(parseAmount("save up to $200 today").usd, null);
  assert.deepEqual(parseAmount("multi-million-euro seed round"), { usd: null, text: "multi-million-euro", currency: "EUR" });
  assert.deepEqual(parseAmount("no money here"), { usd: null, text: null, currency: null });
});

test("rounds normalize; late rounds are recognized", () => {
  const cases: Array<[string, string | null]> = [["a pre-seed round", "pre_seed"], ["Pre Seed", "pre_seed"], ["Seed funding", "seed"], ["Series A", "series_a"], ["series c", "series_c"], ["angel investors", "angel"], ["venture debt facility", "debt"], ["no round", null]];
  for (const [t, want] of cases) assert.equal(parseRound(t), want, t);
  assert.ok(isLateRound("series_c") && isLateRound("series_h") && !isLateRound("series_b") && !isLateRound(null));
});

test("young / mature signals", () => {
  assert.deepEqual(youngSignals("Founded in 2024 by ex-Google engineers; spun out of MIT", "funding", "seed").sort(), ["early_round", "founded_2024", "spinout"]);
  assert.ok(youngSignals("x", "stealth", null).includes("stealth_exit") && youngSignals("x", "accelerator", null).includes("accelerator_cohort"));
  assert.ok(!youngSignals("Founded in 2015", "funding", null).some((s) => s.startsWith("founded_")));
  assert.deepEqual(matureSignals("Founded in 2009. NASDAQ: ACME. Plans an IPO.", "series_d"), ["late_round", "public_company", "ipo", "founded_2009"]);
  assert.deepEqual(matureSignals("Founded in 2024", "seed"), []);
});

test("name helpers: keys ignore TLDs, legal suffixes and punctuation; alias drops generic trailing words; domain-shaped names", () => {
  assert.equal(nameKey("Empirik.ai"), "empirik");
  assert.equal(nameKey("Gaia Dynamics"), "gaiadynamics");
  assert.equal(nameKey("Project-S"), "projects");
  assert.equal(nameKey("Acme Inc."), "acme");
  assert.equal(nameKey("Café Ünï GmbH"), "cafeuni");
  assert.equal(aliasKey("TypeSafe AI"), "typesafe");
  assert.equal(aliasKey("Metris Energy"), "metris", "sector words are generic tails, so Metris and Metris Energy merge");
  assert.equal(aliasKey("Gaia Dynamics"), "gaiadynamics");
  assert.equal(aliasKey("AI"), "ai", "a name that is only a generic word is kept");
  assert.equal(domainInName("Fin.com"), "fin.com");
  assert.equal(domainInName("Gaia Dynamics"), null);
  assert.equal(similarity("aiir", "aiir"), 1);
  assert.ok(similarity("scrolled", "scrolld") > 0.8);
  // domain similarity: exact label, marketing prefix, containment, unrelated
  assert.equal(nameDomainSimilarity(["empirik"], "empirik.ai"), 1);
  assert.equal(nameDomainSimilarity(["aiir"], "useaiir.com"), 0.95);
  assert.equal(nameDomainSimilarity(["gaiadynamics"], "gaiadynamics.ai"), 1);
  assert.ok(nameDomainSimilarity(["sunzu"], "sunzu.ai") === 1);
  assert.ok(nameDomainSimilarity(["empirik"], "sequoiacap.com") < 0.5);
});

test("extractLeads: a text item becomes one lead carrying the extraction record, lane by event, and name-as-domain trust", () => {
  const r = extractLeads(item({ title: "Payments infrastructure provider Fin.com emerges from stealth with $20m in seed funding", excerpt: "Fin.com was founded in 2025.", outbound_domains: ["expa.co", "fin.com"] }));
  assert.equal(r.dropped, null);
  const l = r.leads[0]!;
  assert.deepEqual([l.name, l.lane, l.event_type_hint, l.event_date, l.homepage_hint, l.domain_trust, l.source_retrieved], ["Fin.com", "stealth", "stealth", "2026-09-16", "https://fin.com", "name", true]);
  assert.deepEqual(l.domain_candidates, ["fin.com", "expa.co"], "the name-as-domain candidate comes first and is not duplicated");
  assert.deepEqual([l.extracted!.round, l.extracted!.amount_usd, l.extracted!.name_from], ["seed", 20_000_000, "headline"]);
  assert.ok(l.extracted!.young_signals.includes("founded_2025") && l.extracted!.patterns.includes("stealth_verb") && l.extracted!.patterns.includes("amount_in_title"));
});

test("extractLeads: a structured directory item becomes a lead with an explicit name and TRUSTED website; a dropped item explains why", () => {
  const s = item({ provider: "yc-directory", kind: "directory", lane: "accelerator", title: "Baud: joins Y Combinator Summer 2026", published_at: null, url_kind: "directory",
    structured: { company_name: "Baud", website: "https://baudlabs.ai/", description: "AI chips", program: "Y Combinator", batch: "Summer 2026" } });
  const l = extractLeads(s).leads[0]!;
  assert.deepEqual([l.name, l.lane, l.homepage_hint, l.domain_trust, l.extracted!.name_from, l.event_date], ["Baud", "accelerator", "https://baudlabs.ai", "structured", "structured", null]);
  assert.ok(l.extracted!.young_signals.includes("accelerator_cohort"));
  assert.deepEqual(extractLeads(item({ title: "Why founders should raise less" })), { leads: [], dropped: "not_an_announcement" });
  assert.equal(laneForEvent("product_launch", "news"), "launches");
  assert.equal(laneForEvent("weird", "news"), "news");
});

test("prefilter: fund raises, public companies, late rounds and big companies are dropped with a reason; ordinary startups pass", () => {
  const lead = (title: string, excerpt = ""): RawLead => extractLeads(item({ title, excerpt })).leads[0]!;
  assert.equal(prefilterLead(lead("Peterson Partners Raises $510 Million Continuation Vehicle for Assets")), "fund_or_investor_raise");
  assert.equal(prefilterLead(lead("Acme raises $300M Series D")), "late_round");
  assert.equal(prefilterLead(lead("Acme raises $20M seed", "Acme (NASDAQ: ACME) announced")), "public_company");
  assert.equal(prefilterLead(lead("Nvidia unveils new chip")), "known_large_company");
  assert.equal(prefilterLead(lead("Belgium’s NewSchool VC closes maiden fund at €10 million to back B2B technology")), "fund_or_investor_raise", "a fund named in the headline");
  assert.equal(prefilterLead(lead("MedTech Innovator raises $1M to expand its accelerator program")), "program_not_company");
  assert.equal(prefilterLead(lead("Gaia Dynamics raises $7M seed")), null);
  assert.equal(prefilterLead(lead("Glow emerges from stealth with $180M Series A")), null, "a big early round is a ranking matter, not a prefilter drop");
});
