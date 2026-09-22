import assert from "node:assert/strict";
import { test } from "node:test";
import { computeNavFingerprint, normalizeNavPath } from "../src/signals/website/fingerprint.ts";
import { looksLikeSoft404 } from "../src/signals/website/soft404.ts";

test("nav_fingerprint: normalizes locale prefixes, trailing slashes, and id-like segments", () => {
  assert.equal(normalizeNavPath("/en/pricing/"), "/pricing");
  assert.equal(normalizeNavPath("/de-de/pricing"), "/pricing");
  assert.equal(normalizeNavPath("/blog/123456"), "/blog");
  assert.equal(normalizeNavPath("/blog/550e8400-e29b-41d4-a716-446655440000"), "/blog");
});

test("nav_fingerprint: is order-independent and dedupes", async () => {
  const a = await computeNavFingerprint(["/pricing", "/careers", "/about"]);
  const b = await computeNavFingerprint(["/about", "/pricing", "/careers", "/careers"]);
  assert.equal(a, b);
});

test("nav_fingerprint: changes when the actual path SET changes", async () => {
  const a = await computeNavFingerprint(["/pricing", "/about"]);
  const b = await computeNavFingerprint(["/pricing", "/about", "/enterprise"]);
  assert.notEqual(a, b);
});

test("nav_fingerprint: wording-only differences never reach it (it never sees text, only paths)", async () => {
  // The fingerprint function only ever receives paths (see resolve.ts's extractPageFields), so
  // this test documents the guarantee at the unit level: two DIFFERENT path lists describing the
  // same routes normalize identically.
  const a = await computeNavFingerprint(["/EN/Pricing/", "/en/careers"]);
  const b = await computeNavFingerprint(["/pricing", "/careers/"]);
  assert.equal(a, b);
});

// ---- soft-404 ------------------------------------------------------------------------------------------------

test("soft-404: a candidate whose title/h1 matches the baseline's is flagged", () => {
  const baseline = { status: 200, title: "Page Not Found | Acme", h1: "404" };
  const candidate = { status: 200, title: "Page Not Found | Acme", h1: "404" };
  assert.equal(looksLikeSoft404(candidate, baseline), true);
});

test("soft-404: a candidate with its own distinct 'not found' wording is flagged even with no baseline", () => {
  assert.equal(looksLikeSoft404({ status: 200, title: "404 - Page could not be found", h1: null }, null), true);
});

test("soft-404: a genuinely different, real page is not flagged", () => {
  const baseline = { status: 200, title: "Page Not Found | Acme", h1: "404" };
  const candidate = { status: 200, title: "Pricing | Acme", h1: "Simple, transparent pricing" };
  assert.equal(looksLikeSoft404(candidate, baseline), false);
});

test("soft-404: a real HTTP 404/410 is not this function's concern (callers treat those as absent directly)", () => {
  assert.equal(looksLikeSoft404({ status: 404, title: "Pricing", h1: "Pricing" }, null), false);
});
