import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIsoDate, validateCandidate } from "../src/validate.ts";
import { RETRIEVED, ctx, okHomepage, verification } from "./helpers.ts";

const run = (v = verification(), retrieved = RETRIEVED, c = ctx()) => validateCandidate(v, retrieved, c);

test("accepts a well-evidenced candidate and normalizes fields", async () => {
  const r = await run();
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.candidate.company.domain, "acme.ai");
  assert.equal(r.candidate.company.discovery_url, "https://news.example.com/acme-raises-5m");
  assert.equal(r.candidate.company.founded_year, 2024);
  assert.equal(r.candidate.event.event_type, "funding");
  assert.equal(r.candidate.event.event_date, "2026-09-10");
  assert.equal(r.candidate.event.description, r.candidate.company.discovery_reason);
  assert.equal(r.confidence, 0.9);
});

test("rejects: not a real company, missing name, bad/denylisted domain", async () => {
  assert.equal((await run(verification({ is_real_company: false, rejection_reason: "no site" }))).ok, false);
  const noName = await run(verification({ name: "  " }));
  assert.ok(!noName.ok && noName.reasons.includes("missing_name"));
  const noDomain = await run(verification({ canonical_url: null }));
  assert.ok(!noDomain.ok && noDomain.reasons.includes("invalid_or_missing_domain"));
  const deny = await run(verification({ canonical_url: "https://techcrunch.com/x" }));
  assert.ok(!deny.ok && deny.reasons.some((r) => r.startsWith("denylisted_domain")));
});

test("event_type must be one of the six V1 values", async () => {
  for (const ok of ["funding", "product_launch", "accelerator", "news", "open_source", "stealth"]) {
    assert.equal((await run(verification({ event_type: ok }))).ok, true, ok);
  }
  for (const bad of ["hiring", "open_source_activity", "partnership", "other", ""]) {
    const r = await run(verification({ event_type: bad }));
    assert.ok(!r.ok && r.reasons.some((x) => x.startsWith("invalid_event_type")), bad);
  }
});

test("source_url is required, must be valid, and must have been retrieved", async () => {
  const missing = await run(verification({ source_url: "" }));
  assert.ok(!missing.ok && missing.reasons.includes("missing_or_invalid_source_url"));
  const invented = await run(verification({ source_url: "https://news.example.com/never-fetched" }));
  assert.ok(!invented.ok && invented.reasons.includes("source_url_not_retrieved"));
});

test("event_date: NULL allowed; invalid, future and stale are rejected", async () => {
  assert.equal((await run(verification({ event_date: null }))).ok, true);
  const bad = await run(verification({ event_date: "2026-02-31" }));
  assert.ok(!bad.ok && bad.reasons.some((r) => r.startsWith("invalid_event_date")));
  const future = await run(verification({ event_date: "2026-12-01" }));
  assert.ok(!future.ok && future.reasons.some((r) => r.startsWith("event_date_in_future")));
  const stale = await run(verification({ event_date: "2026-01-01" }));
  assert.ok(!stale.ok && stale.reasons.some((r) => r.startsWith("stale_event")));
});

test("parseIsoDate is strict", () => {
  assert.ok(parseIsoDate("2026-09-21"));
  for (const bad of ["2026-9-21", "2026-02-30", "21/09/2026", "", "2026-13-01"]) assert.equal(parseIsoDate(bad), null, bad);
});

test("founded_year: kept only with evidence and plausibility; never a rejection by itself", async () => {
  const noEvidence = await run(verification({ founded_year: 2024, founded_year_evidence: null }));
  assert.ok(noEvidence.ok && noEvidence.candidate.company.founded_year === null);
  assert.ok(noEvidence.ok && noEvidence.notes.includes("founded_year_dropped:no_evidence"));
  const future = await run(verification({ founded_year: 2031, founded_year_evidence: "typo" }));
  assert.ok(future.ok && future.candidate.company.founded_year === null);
  const ancient = await run(verification({ founded_year: 1850, founded_year_evidence: "x" }));
  assert.ok(ancient.ok && ancient.candidate.company.founded_year === null);
});

test("eligibility: unknown founding year is allowed with early-stage evidence", async () => {
  const r = await run(verification({ founded_year: null, founded_year_evidence: null, stage: "early_stage", stage_evidence: "Emerged from stealth this month." }));
  assert.ok(r.ok && r.candidate.company.founded_year === null);
});

test("eligibility: unknown year AND no early-stage evidence is rejected", async () => {
  const r = await run(verification({ founded_year: null, founded_year_evidence: null, stage: "unknown", stage_evidence: null }));
  assert.ok(!r.ok && r.reasons.includes("insufficient_early_stage_evidence"));
});

test("eligibility: pre-2021 company needs early-stage evidence (recently commercialized), else rejected", async () => {
  const noEvidence = await run(verification({ founded_year: 2015, founded_year_evidence: "Founded 2015", stage: "unknown", stage_evidence: null }));
  assert.ok(!noEvidence.ok && noEvidence.reasons.some((r) => r.startsWith("founded_2015_without_early_stage_evidence")));
  const withEvidence = await run(verification({ founded_year: 2015, founded_year_evidence: "Founded 2015", stage: "early_stage", stage_evidence: "Commercial launch of its open-source project this month." }));
  assert.equal(withEvidence.ok, true);
});

test("eligibility: established/public/large companies are always rejected", async () => {
  const est = await run(verification({ stage: "established" }));
  assert.ok(!est.ok && est.reasons.includes("established_or_public_company"));
  const pub = await run(verification({ is_public_or_large_mature: true }));
  assert.ok(!pub.ok && pub.reasons.includes("established_or_public_company"));
});

test("confidence: threshold 0.75, range check, and caps", async () => {
  assert.equal((await run(verification({ confidence: 0.75 }))).ok, true);
  const low = await run(verification({ confidence: 0.74 }));
  assert.ok(!low.ok && low.reasons.some((r) => r.startsWith("confidence_below_")));
  for (const bad of [-0.1, 1.2, Number.NaN]) {
    const r = await run(verification({ confidence: bad }));
    assert.ok(!r.ok && r.reasons.some((x) => x.startsWith("invalid_confidence")), String(bad));
  }
});

test("homepage: unreachable is rejected; cross-domain redirect is rejected; missing name is capped not rejected", async () => {
  const dead = await run(verification(), RETRIEVED, ctx({ checkHomepage: async () => ({ reachable: false, error: "ENOTFOUND" }) }));
  assert.ok(!dead.ok && dead.reasons.some((r) => r.startsWith("homepage_unreachable")));

  const moved = await run(verification(), RETRIEVED, ctx({
    checkHomepage: async () => ({ reachable: true, status: 200, finalUrl: "https://other.com/", finalDomain: "other.com", text: "Acme" }),
  }));
  assert.ok(!moved.ok && moved.reasons.some((r) => r.startsWith("homepage_redirects_to_other_domain")));

  const noName = await run(verification({ confidence: 0.95 }), RETRIEVED, ctx({ checkHomepage: okHomepage("Totally different site") }));
  assert.ok(noName.ok && noName.confidence === 0.85 && noName.caps.includes("name_not_found_on_homepage<=0.85"));

  const blocked = await run(verification(), RETRIEVED, ctx({ checkHomepage: async (d) => ({ reachable: true, status: 403, finalDomain: d }) }));
  assert.equal(blocked.ok, true); // bot walls do not sink real companies
});

test("self-published source with no independent corroboration is capped at 0.80", async () => {
  const own = "https://acme.ai/blog/we-raised";
  const r = await run(verification({ source_url: own, confidence: 0.95 }), new Set([own]));
  assert.ok(r.ok && r.confidence === 0.8);
  const corroborated = await run(
    verification({ source_url: own, confidence: 0.95, corroborating_urls: ["https://news.example.com/acme-raises-5m"] }),
    new Set([own, "https://news.example.com/acme-raises-5m"]),
  );
  assert.ok(corroborated.ok && corroborated.confidence === 0.95);
});

test("rejections never throw and list every reason", async () => {
  const r = await run(verification({ name: "", canonical_url: null, event_type: "nope", source_url: "", confidence: 5 }));
  assert.ok(!r.ok && r.reasons.length >= 4);
});
