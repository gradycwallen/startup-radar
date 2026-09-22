import assert from "node:assert/strict";
import { test } from "node:test";
import { RunRegistry, classifyCandidate, extractAmounts, isSameUnderlyingEvent } from "../src/dedupe.ts";
import type { NormalizedCandidate } from "../src/schema.ts";
import { FakeReader } from "./helpers.ts";

function cand(over: { domain?: string; name?: string; url?: string; type?: NormalizedCandidate["event"]["event_type"]; headline?: string; desc?: string } = {}): NormalizedCandidate {
  return {
    company: { name: over.name ?? "Glow", domain: over.domain ?? "glow.io", description: null, category: null, discovery_source: "TechCrunch", discovery_url: over.url ?? "https://a.com/x", confidence: 0.9, discovery_reason: "r", founded_year: null },
    event: { event_type: over.type ?? "funding", event_date: null, source_name: "TechCrunch", source_url: over.url ?? "https://a.com/x", headline: over.headline ?? "Glow raises $180M Series A", description: over.desc ?? "Emerged from stealth with a $180M Series A at a $1.2B valuation.", confidence: 0.9 },
  };
}

const glow = { id: 9, name: "Glow", domain: "glow.io" };
const seedEvent = { id: 6, company_id: 9, event_type: "funding", event_date: "2026-09-21", source_url: "https://techcrunch.com/2026/07/22/glow-emerges", headline: "Glow (Cybersecurity): discovered via TechCrunch", description: "Emerged from stealth on 22 Jul 2026 with a $180M Series A at a $1.2B valuation." };

test("new domain, no name match => new company", async () => {
  const out = await classifyCandidate(cand({ domain: "newco.ai", name: "NewCo" }), new FakeReader(), new RunRegistry());
  assert.equal(out.kind, "new_company");
});

test("same normalized source_url for a known company => duplicate (primary key)", async () => {
  const reader = new FakeReader([glow], [seedEvent]);
  const out = await classifyCandidate(cand({ url: "https://techcrunch.com/2026/07/22/glow-emerges" }), reader, new RunRegistry());
  assert.ok(out.kind === "duplicate_event" && out.reason === "same_source_url");
});

test("stored URL spelled differently still matches after normalization", async () => {
  const reader = new FakeReader([glow], [{ ...seedEvent, source_url: "http://www.techcrunch.com/2026/07/22/glow-emerges/?utm_source=x" }]);
  const out = await classifyCandidate(cand({ url: "https://techcrunch.com/2026/07/22/glow-emerges" }), reader, new RunRegistry());
  assert.ok(out.kind === "duplicate_event" && out.reason === "same_source_url");
});

test("different outlet covering the SAME funding event (same amount) => duplicate coverage", async () => {
  const reader = new FakeReader([glow], [seedEvent]);
  const out = await classifyCandidate(cand({ url: "https://fortune.com/glow-unicorn", headline: "Glow launches at $1.2B valuation with $180 million", desc: "Sequoia-backed Glow raised $180 million." }), reader, new RunRegistry());
  assert.ok(out.kind === "duplicate_event" && out.reason === "same_underlying_event");
});

test("a genuinely different event for a known company is allowed, even days apart", async () => {
  const reader = new FakeReader([glow], [seedEvent]);
  const series = await classifyCandidate(cand({ url: "https://b.com/glow-series-b", headline: "Glow raises $400M Series B", desc: "Glow closed a $400M Series B." }), reader, new RunRegistry());
  assert.equal(series.kind, "existing_company_new_event");
  const launch = await classifyCandidate(cand({ url: "https://b.com/glow-launch", type: "product_launch", headline: "Glow launches agent console", desc: "Glow launched a new console for security teams." }), reader, new RunRegistry());
  assert.equal(launch.kind, "existing_company_new_event");
});

test("same name under a new domain is held as a possible rebrand", async () => {
  const reader = new FakeReader([{ id: 1, name: "Liquid Compute", domain: "liquidcompute.com" }]);
  const out = await classifyCandidate(cand({ name: "Liquid Compute", domain: "pluto.trade" }), reader, new RunRegistry());
  assert.equal(out.kind, "name_collision");
});

test("within one run: same domain twice => second is a distinct event or a duplicate, never a second company", async () => {
  const reader = new FakeReader();
  const reg = new RunRegistry();
  const first = cand({ domain: "newco.ai", name: "NewCo", url: "https://a.com/1", headline: "NewCo raises $5M seed", desc: "NewCo raised $5M." });
  assert.equal((await classifyCandidate(first, reader, reg)).kind, "new_company");
  reg.record(first);
  const dupCoverage = cand({ domain: "newco.ai", name: "NewCo", url: "https://b.com/2", headline: "NewCo lands $5 million seed", desc: "$5M seed for NewCo." });
  assert.equal((await classifyCandidate(dupCoverage, reader, reg)).kind, "duplicate_event");
  const different = cand({ domain: "newco.ai", name: "NewCo", url: "https://b.com/3", type: "product_launch", headline: "NewCo ships v1", desc: "NewCo shipped its first product." });
  assert.equal((await classifyCandidate(different, reader, reg)).kind, "same_run_new_event");
});

test("amount extraction and event similarity primitives", () => {
  assert.deepEqual([...extractAmounts("raised $15M seed")], ["15m"]);
  assert.deepEqual([...extractAmounts("€1.5 million pre-seed")], ["1.5m"]);
  assert.deepEqual([...extractAmounts("$1.2B valuation and $180 million")].sort(), ["1.2b", "180m"]);
  const a = { event_type: "accelerator", headline: "Waddle Labs joins YC Summer 2026", description: "Part of the Y Combinator Summer 2026 batch" };
  const b = { event_type: "accelerator", headline: "Waddle Labs at YC Summer 2026 Demo Day", description: "Y Combinator Summer 2026 batch Demo Day" };
  assert.equal(isSameUnderlyingEvent(a, b), true);
  assert.equal(isSameUnderlyingEvent({ ...a, event_type: "funding" }, b), false);
});
