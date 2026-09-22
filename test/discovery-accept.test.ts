import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCandidate, discoveryReasonFor, evaluateCandidate } from "../src/discovery/accept.ts";
import { makeEntity, makeRankedEntity } from "./fixtures/discovery/entities.ts";

test("evaluateCandidate: rejects a non-finalist outright", () => {
  const r = makeRankedEntity({ name: "Acme", domain: "acme.com", finalist: false, evidence: [{ source_url: "https://x.com/1" }] });
  const result = evaluateCandidate(r);
  assert.deepEqual(result, { rejected: "not_finalist" });
});

test("evaluateCandidate: a finalist with an UNRESOLVED domain is rejected — 'candidate may appear in logs, must NOT be inserted'", () => {
  const r = makeRankedEntity({ name: "Acme", domain: null, finalist: true, evidence: [{ source_url: "https://x.com/1" }] });
  const result = evaluateCandidate(r);
  assert.deepEqual(result, { rejected: "unresolved_domain" });
});

test("evaluateCandidate: a finalist WITH a resolved domain is accepted", () => {
  const r = makeRankedEntity({ name: "Acme", domain: "acme.com", finalist: true, evidence: [{ source_url: "https://x.com/1" }] });
  const result = evaluateCandidate(r);
  assert.ok("accepted" in result);
});

test("buildCandidate: confidence is the funnel score normalized to 0-1, and never fabricates description/category/founded_year", () => {
  const r = makeRankedEntity({ name: "Acme", domain: "acme.com", score: 82.5, evidence: [{ source_url: "https://x.com/1" }] });
  const candidate = buildCandidate(r);
  assert.equal(candidate.company.confidence, 0.825);
  assert.equal(candidate.company.description, null);
  assert.equal(candidate.company.category, null);
  assert.equal(candidate.company.founded_year, null);
});

test("buildCandidate: discovery_source/discovery_url come from the entity's real primary evidence, never invented", () => {
  const r = makeRankedEntity({
    name: "Acme", domain: "acme.com",
    evidence: [{ provider: "tech-eu", source_name: "Tech.eu", source_url: "https://tech.eu/acme-raises", title: "Acme raises $5M" }],
  });
  const candidate = buildCandidate(r);
  assert.equal(candidate.company.discovery_source, "tech-eu");
  assert.equal(candidate.company.discovery_url, "https://tech.eu/acme-raises");
});

test("buildCandidate: preserves EVERY distinct source_url as its own event — independent corroborating evidence is never collapsed into one record", () => {
  const r = makeRankedEntity({
    name: "Acme", domain: "acme.com",
    evidence: [
      { source_url: "https://techcrunch.com/acme", source_name: "TechCrunch", title: "Acme raises $5M seed" },
      { source_url: "https://tech.eu/acme", source_name: "Tech.eu", title: "Acme lands $5M" },
    ],
  });
  const candidate = buildCandidate(r);
  assert.equal(candidate.events.length, 2);
  assert.deepEqual(candidate.events.map((e) => e.source_url).sort(), ["https://tech.eu/acme", "https://techcrunch.com/acme"]);
});

test("buildCandidate: the SAME source_url appearing twice in evidence produces only ONE event (defensive de-dup ahead of the DB's own unique constraint)", () => {
  const r = makeRankedEntity({
    name: "Acme", domain: "acme.com",
    evidence: [
      { source_url: "https://techcrunch.com/acme", title: "Acme raises $5M" },
      { source_url: "https://techcrunch.com/acme", title: "Acme raises $5M (updated)" },
    ],
  });
  const candidate = buildCandidate(r);
  assert.equal(candidate.events.length, 1);
});

test("buildCandidate: event_date is the date part of published_at, never invented when absent", () => {
  const r = makeRankedEntity({ name: "Acme", domain: "acme.com", evidence: [{ source_url: "https://x.com/1", published_at: "2026-09-15T08:30:00Z" }] });
  assert.equal(buildCandidate(r).events[0]!.event_date, "2026-09-15");
  const undated = makeRankedEntity({ name: "Acme", domain: "acme.com", evidence: [{ source_url: "https://x.com/1", published_at: null }] });
  assert.equal(buildCandidate(undated).events[0]!.event_date, null, "no published date means no event_date — never fabricated");
});

// ---- discoveryReasonFor: the real bug found and fixed during controlled replay validation ------------------------------

test("discoveryReasonFor: uses the PRIMARY evidence's OWN round/amount, never the entity-level aggregate from a DIFFERENT piece of evidence", () => {
  // A multi-lane entity: primary evidence is a YC accelerator listing (no amount); a SEPARATE,
  // later funding article is what the entity-level round/amount_usd aggregate picks up. The
  // sentence must describe the accelerator listing on its own terms, never borrow the funding
  // article's $150M as if it belonged to the accelerator event — that was a real bug this exact
  // test guards against (see the V2-1.1 report: "Nex joined an accelerator cohort of $150M").
  const entity = makeEntity({
    name: "Nex", domain: "nex.ai",
    evidence: [
      { provider: "yc-directory", source_name: "Y Combinator", source_url: "https://ycombinator.com/companies/nex", title: "Nex: joins Y Combinator Summer 2026", event_type: "accelerator", round: null, amount_usd: null },
      { provider: "techcrunch-venture", source_name: "TechCrunch", source_url: "https://techcrunch.com/nex-150m", title: "Nex raises over $150m", event_type: "funding", round: "series_b", amount_usd: 150_000_000 },
    ],
  });
  assert.equal(entity.amount_usd, 150_000_000, "sanity check: the entity-level aggregate DOES pick up the funding article's amount");
  const reason = discoveryReasonFor(entity, entity.evidence[0]!);
  assert.equal(reason, `Nex joined an accelerator cohort, per Y Combinator — "Nex: joins Y Combinator Summer 2026".`);
  assert.ok(!reason.includes("150"), `must not attribute the funding article's $150M to the accelerator headline: "${reason}"`);
});

test("discoveryReasonFor: when the primary evidence itself IS the funding event, its own round/amount ARE included", () => {
  const entity = makeEntity({ name: "Acme", domain: "acme.com", evidence: [{ source_url: "https://techcrunch.com/acme", event_type: "funding", round: "seed", amount_usd: 5_000_000, source_name: "TechCrunch", title: "Acme raises $5M" }] });
  const reason = discoveryReasonFor(entity, entity.evidence[0]!);
  assert.equal(reason, `Acme raised funding a seed round of $5.0M, per TechCrunch — "Acme raises $5M".`);
});

test("discoveryReasonFor: every event type produces a distinct, sensible action phrase, never a generic placeholder for a known type", () => {
  const cases: Array<[string, string]> = [
    ["funding", "raised funding"], ["stealth", "emerged from stealth"], ["accelerator", "joined an accelerator cohort"],
    ["product_launch", "launched a product"], ["open_source", "released an open-source project"], ["news", "was covered in the news"],
  ];
  for (const [eventType, expectedAction] of cases) {
    const entity = makeEntity({ name: "Acme", domain: "acme.com", evidence: [{ source_url: "https://x.com/1", event_type: eventType, round: null, amount_usd: null, title: "headline" }] });
    const reason = discoveryReasonFor(entity, entity.evidence[0]!);
    assert.ok(reason.includes(expectedAction), `${eventType}: "${reason}"`);
  }
});
