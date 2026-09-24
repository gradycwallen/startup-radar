import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvestors, normalizeInvestorName } from "../src/funnel/investors.ts";
import { verifyDomainIdentity } from "../src/funnel/domain-verify.ts";
import type { Entity } from "../src/funnel/entities.ts";

/**
 * V2-1 domain-resolution experiment (2026-09-23) — the stronger identity verifier, INDEPENDENCE
 * HARDENING pass. Every test here is a permanent regression gate per the design brief: precision
 * first, recall second. Cases G/H (Ande/Travix) use the REAL page text captured during the live
 * audit that found the first attempt's failure — these must never regress silently.
 *
 * This pass exists because a live audit of the verifier's own only real historical acceptance (kWh
 * Coffee -> kwhcoffee.com) found its "independent" evidence wasn't independent after all: the
 * phrase2 hit was just the company's own name ("kwh coffee"), and the location hit ("york") only
 * existed because the investor was named "York Angels." Cases A-D are the direct regression tests
 * for the two fixes that followed, plus the general token-overlap independence guard.
 */

// ---- parseInvestors ---------------------------------------------------------------------------------------------

test("parseInvestors: extracts a single investor after a trigger phrase, stops at a bare comma (safe under-extraction)", () => {
  assert.deepEqual(parseInvestors("Baselayer Raises $35M Series A Led by M13, Launches Identity Infrastructure"), ["M13"]);
  assert.deepEqual(parseInvestors("Travix raises seed round from Amber Group for on-chain perpetual contracts"), ["Amber Group"]);
  assert.deepEqual(parseInvestors("CatchBack raises $8M seed led by Foundation Capital"), ["Foundation Capital"]);
});

test("parseInvestors: 'X and Y' (real whitespace-connected list) extracts both independently", () => {
  assert.deepEqual(parseInvestors("Acme raises $5M seed led by Sequoia and Index Ventures"), ["Sequoia", "Index Ventures"]);
});

test("parseInvestors: never extracts generic words after the trigger", () => {
  assert.deepEqual(parseInvestors("Acme raises $5M backed by investors"), []);
  assert.deepEqual(parseInvestors("Acme raises $5M from existing investors"), []);
});

test("normalizeInvestorName: case/punctuation-insensitive, never fuzzy", () => {
  assert.equal(normalizeInvestorName("M13"), normalizeInvestorName("m13"));
  assert.equal(normalizeInvestorName("Foundation Capital"), "foundation capital");
});

// ---- fixtures -----------------------------------------------------------------------------------------------------

function entity(over: Partial<Pick<Entity, "name" | "round" | "amount_usd">> & { titles?: string[]; snippets?: string[] } = {}): Parameters<typeof verifyDomainIdentity>[0]["entity"] {
  const titles = over.titles ?? [];
  const snippets = over.snippets ?? [];
  return {
    name: over.name ?? "Acme",
    round: over.round ?? null,
    amount_usd: over.amount_usd ?? null,
    evidence: titles.map((t) => ({ lead_id: "x", provider: "p", lane: "funding", source_url: "https://x.example", source_name: "x", source_key: "x", title: t, published_at: null, event_type: null, round: null, amount_usd: null })),
    leads: snippets.map((s) => ({ snippet: s }) as never),
  };
}

// ---- A. company-name phrase alone must NOT count ------------------------------------------------------------------

test("A. COMPANY NAME PHRASE ALONE: 'kwh coffee' (the company's own name) never counts as phrase2 evidence", () => {
  const e = entity({ name: "kWh Coffee", titles: ["kWh Coffee raises seed round from York Angels for farm-to-cup platform"] });
  const page = "kWh Coffee — specialty coffee roasted on electric power. Welcome to kwh coffee.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.deepEqual(result.moderate, [], "the company's own name must never register as distinctive-phrase evidence");
  assert.equal(result.accepted, false, "this is the exact historical kWh Coffee acceptance case — it must now be rejected");
});

// ---- B. company name + a NON-generic word must also not count -----------------------------------------------------

test("B. COMPANY NAME + NON-GENERIC WORD: 'ande booking' never counts, even though 'booking' is not on the generic-word denylist", () => {
  const e = entity({ name: "Ande", titles: ["Ande booking startup announces new funding"] });
  const page = "Ande booking platform for live events. Book your Ande booking experience today.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.deepEqual(result.moderate, [], "a phrase built partly from the company's own name must never count, even with an otherwise-distinctive second word");
  assert.deepEqual(result.strong, []);
});

// ---- C. a location hidden inside an investor's name must not leak in as independent geography ----------------------

test("C. LOCATION HIDDEN INSIDE INVESTOR NAME: 'York Angels' must never independently produce location=York", () => {
  const e = entity({ name: "Acme", titles: ["Acme raises seed from York Angels for widgets"] });
  const page = "Acme Inc, based in York. We build widgets.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.ok(!result.weak.some((w) => w.category === "location"), "the ONLY source of 'York' in the discovery evidence is the investor's own name — stripping it must leave zero location evidence");
  assert.equal(result.accepted, false, "nothing else present here should be enough to accept");
});

test("C (positive control): a location that appears OUTSIDE any investor/program/company-name span still registers as WEAK evidence", () => {
  const e = entity({ name: "Acme", titles: ["Berlin-based Acme raises seed from York Angels for widgets"] });
  const page = "Acme GmbH, based in Berlin. We build widgets.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  const locationHit = result.weak.find((w) => w.category === "location");
  assert.ok(locationHit, "Berlin appears independently of the investor's name and should still be logged as weak evidence");
  assert.match(locationHit!.detail, /berlin/i);
});

// ---- D. two categories from the SAME underlying span count once, not twice -----------------------------------------

test("D. SAME UNDERLYING SPAN, TWO CATEGORIES: an investor name that also happens to form a distinctive phrase counts ONCE", () => {
  const e = entity({ name: "Acme", titles: ["Acme raises seed from Quantum Sensor Arrays for climate tech"] });
  const page = "Acme is proud to be backed by Quantum Sensor Arrays as we build climate technology.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.equal(result.strong.length, 1, `expected exactly one counted strong signal, got: ${JSON.stringify(result.strong)}`);
  assert.equal(result.strong[0]!.category, "investor", "the investor hit is pushed first and should be the one kept");
  assert.equal(result.discarded.length, 1, "the overlapping phrase3 hit must be recorded as discarded, not silently dropped or double-counted");
  assert.equal(result.discarded[0]!.category, "phrase3");
  assert.equal(result.accepted, true, "one genuine strong signal is still enough to accept — this is about not OVER-counting, not about rejecting real evidence");
});

// ---- E. real strong evidence still accepts --------------------------------------------------------------------------

test("E. STRONG POSITIVE: investor name on page -> ACCEPT", () => {
  const e = entity({ name: "Acme", titles: ["Acme raises $5M seed led by Sequoia Capital"] });
  const page = "Acme Inc — the future of widgets. Backed by Sequoia Capital and other top-tier investors.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.equal(result.accepted, true);
  assert.ok(result.strong.some((s) => s.category === "investor"));
});

test("E. STRONG POSITIVE: funding amount on page -> ACCEPT", () => {
  const e = entity({ name: "Acme", amount_usd: 21_000_000, titles: ["Acme raises $21M Series A"] });
  const page = "Acme Inc. We're thrilled to announce our $21M Series A, led by our new partners, to expand our widget platform.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.equal(result.accepted, true);
  assert.ok(result.strong.some((s) => s.category === "amount"));
});

// ---- F. two genuinely independent moderate signals still accept ------------------------------------------------------

test("F. TWO GENUINELY INDEPENDENT MODERATE SIGNALS (phrase2 + named program, non-overlapping) -> ACCEPT", () => {
  const e = entity({ name: "Acme", titles: ["Y Combinator startup: Acme raises seed for drone mapping today across the industry"] });
  const page = "Acme is a Y Combinator company building drone mapping software for surveyors.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  const categories = new Set(result.moderate.map((m) => m.category));
  assert.deepEqual([...categories].sort(), ["phrase2", "program"]);
  assert.equal(result.discarded.length, 0, "these two facts share no literal token and must both be kept");
  assert.equal(result.accepted, true);
});

test("F (negative control): only ONE moderate positive is NOT sufficient", () => {
  const e = entity({ name: "Acme", titles: ["Acme raises seed for drone mapping today across the industry"] });
  const page = "Acme Inc. We build drone mapping software.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.equal(result.accepted, false, "a single moderate signal alone must never be enough");
});

// ---- G/H. real collisions found in the live audit --------------------------------------------------------------

test("G. ANDE COLLISION (real page text from the live audit): funded entertainment-booking startup vs. the real, unrelated ANDE Rapid-DNA company -> MUST REJECT", () => {
  const e = entity({
    name: "Ande", amount_usd: 52_000_000,
    titles: [
      "Entertainment-Booking Startup Ande Raises $52 Million From Lightspeed, Redpoint",
      "Ande Raises $52M Seed and Series A to Launch The First Entertainment Operating System For Enterprises",
    ],
  });
  const page =
    "ANDE - Rapid DNA Technology. Generate a Rapid DNA identification profile, anywhere, in less than 2 hours. FBI NDIS approved. " +
    "Used around the world in public safety, investigations, disaster victim identification, sexual assault, booking, anti human trafficking, " +
    "border control, counterterrorism, and environmental protection. Products Human Identification Energy Biosurveillance ANDE UHR - " +
    "For Coroners & Medical Examiners. Technology What Is Rapid DNA FAQ Company About Careers.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.equal(result.accepted, false, `Ande must be rejected — got: ${result.reason}`);
});

test("H. TRAVIX COLLISION (real page text from the live audit): funded on-chain-perpetuals startup vs. the real, unrelated Travix International travel agency -> MUST REJECT", () => {
  const e = entity({
    name: "Travix", round: "seed",
    titles: [
      "Travix raises seed round from Amber Group for on-chain perpetual contracts",
      "Travix raises seed round led by Amber Group to build on-chain perp layer for compute and East Asian exotic assets",
    ],
  });
  const page =
    "Travix | The next journey at your fingertips. Making journeys simple and affordable. Travix is a global travel agency operating in 17 countries. " +
    "Headquartered in Amsterdam, Netherlands, Travix is a global online travel agency focusing on flights, with a strong European presence and a " +
    "leading direct brand - CheapTickets - in Belgium and the Netherlands. With five established brands - CheapTickets, Vliegwinkel, BudgetAir, " +
    "Flugladen and Vayama - we operate in 17 countries across five continents. In 2020, we strengthened our global position as a key industry " +
    "player by becoming part of the Trip.com Group. 450+ employees dedicated to making journeys simple and affordable.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.equal(result.accepted, false, `Travix must be rejected — got: ${result.reason}`);
  assert.ok(result.contradictions.some((c) => c.category === "scale" || c.category === "ownership"), "the established-company contradiction should be detected");
});

// ---- I. thin legitimate page -> unresolved ---------------------------------------------------------------------

test("I. THIN SITE: name matches, no positives, no contradictions -> unresolved (rejected)", () => {
  const e = entity({ name: "Acme", titles: ["Acme raises funding"] });
  const page = "Acme. Coming soon.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.equal(result.accepted, false);
  assert.equal(result.strong.length, 0);
  assert.equal(result.moderate.length, 0);
});

// ---- J. contradiction overrides positives ------------------------------------------------------------------------

test("J. CONTRADICTION OVERRIDES POSITIVES: a real distinctive-phrase match plus an established-company identity -> reject", () => {
  const e = entity({ name: "Acme", titles: ["Acme raises seed for thermal battery recycling"] });
  const page = "Acme thermal battery recycling division. We are part of the Global Industrial Holdings Group, employing over 5,000 people worldwide.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.equal(result.accepted, false);
  assert.ok(result.contradictions.length > 0);
  assert.ok(result.strong.length > 0 || result.moderate.length > 0, "a real positive signal should still have been found — the point is that the contradiction overrides it, not that no evidence existed");
});

// ---- supplementary coverage retained from the first hardening pass --------------------------------------------------

test("NAME ONLY: no independent corroboration -> REJECT", () => {
  const e = entity({ name: "Acme", amount_usd: 21_000_000, titles: ["Acme raises $21M Series A"] });
  const page = "Acme Inc. Welcome to our website. We are Acme, a company that does things.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.equal(result.accepted, false);
  assert.equal(result.strong.length, 0);
});

test("GENERIC VOCABULARY: name + 'AI/software/platform' alone is insufficient", () => {
  const e = entity({ name: "Acme", titles: ["Acme launches AI software platform"] });
  const page = "Acme. AI software platform for the modern enterprise. Built with AI. Powered by our platform.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.moderate, [], "generic industry words must never register as a moderate signal");
});

test("AGE ALONE is never an automatic reject — a real match with an old founding date still gets accepted on real evidence", () => {
  const e = entity({ name: "Acme", amount_usd: 21_000_000, titles: ["Acme raises $21M Series C to relaunch its platform"] });
  const page = "Acme Inc, founded in 2009. After a decade of building, we're thrilled to announce our $21M Series C to relaunch our platform for a new era.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.equal(result.accepted, true, "a real funding-amount match must not be rejected merely because the page also mentions an old founding date");
});

test("a bare old founding date with NO scale/ownership language is not itself a contradiction", () => {
  const e = entity({ name: "Acme", titles: ["Acme raises seed round"] });
  const page = "Acme Inc, founded in 2009.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.deepEqual(result.contradictions, [], "age alone, with no scale/ownership language, is not a contradiction signal");
});

test("round-stage mentions are logged as WEAK evidence only, never counted toward acceptance", () => {
  const e = entity({ name: "Acme", round: "seed", titles: ["Acme raises seed round"] });
  const page = "Acme Inc. We just closed our seed round to keep building.";
  const result = verifyDomainIdentity({ entity: e, pageText: page });
  assert.ok(result.weak.some((w) => w.category === "round"));
  assert.deepEqual(result.moderate, []);
  assert.equal(result.accepted, false);
});
