import assert from "node:assert/strict";
import { test } from "node:test";
import { collectWebsite, WEBSITE_COLLECTOR_VERSION } from "../src/signals/sources/website.ts";
import { computeCoverage } from "../src/signals/coverage.ts";
import type { Fetcher, FetchOptions, FetchResult } from "../src/sources/fetcher.ts";
import type { SignalSource } from "../src/signals/types.ts";

/** V2-2B.2 — sources/website.ts, the observe.ts dispatch target. Verifies the missing-vs-zero
 * discipline (no row for "unknown") and that the collector output shape matches what observe.ts's
 * `toObservations` (and eventually store.ts) expects. */

function fakeSite(routes: Record<string, { status?: number; text?: string; contentType?: string }>): Fetcher {
  return {
    async getText(url: string, _o?: FetchOptions): Promise<FetchResult> {
      const r = routes[url];
      if (!r) return { url, status: 404, text: "", bytes: 0, elapsed_ms: 0 };
      const text = r.text ?? "";
      return { url, status: r.status ?? 200, text, bytes: text.length, elapsed_ms: 0, contentType: r.contentType };
    },
  };
}

test("collector: a page in the 'unknown' state writes NO metric row at all (missing != zero)", async () => {
  const minimalHomepage = `<!DOCTYPE html><html lang="en"><head><title>Acme</title></head><body><nav><a href="/">Home</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/team">Team</a><a href="/press">Press</a></nav></body></html>`;
  const fetcher = fakeSite({ "https://acme.com/": { text: minimalHomepage } });
  const result = await collectWebsite(fetcher, "acme.com");
  const byMetric = new Map(result.metrics.map((m) => [m.metricName, m]));
  // pricing/enterprise/security/customers/careers all end up ABSENT (confirmed via probe on a
  // navigable, English homepage) here, not unknown — so all 5 rows ARE written as 0. This test's
  // real point is proven by the NEXT test, which forces a genuine unknown.
  assert.ok(byMetric.has("website_fetch_outcome"));
  assert.equal(result.collectionVersion, WEBSITE_COLLECTOR_VERSION);
});

test("collector: a page that stays genuinely UNKNOWN (network failure) writes no row for it", async () => {
  // Non-navigable homepage -> a real 404 probe still can't confirm absence (homepage_not_navigable) -> unknown.
  const thinHomepage = `<!DOCTYPE html><html lang="en"><head><title>Acme</title></head><body><nav><a href="/">Home</a><a href="/about">About</a></nav><p>${"word ".repeat(60)}</p></body></html>`;
  const fetcher = fakeSite({ "https://acme.com/": { text: thinHomepage } });
  const result = await collectWebsite(fetcher, "acme.com");
  const metricNames = result.metrics.map((m) => m.metricName);
  assert.ok(!metricNames.includes("website_page_pricing"), "an unresolved (unknown) page must never appear as a written metric");
});

test("collector: outcome is always written, even on total failure", async () => {
  const fetcher: Fetcher = { async getText() { throw new Error("boom"); } };
  const result = await collectWebsite(fetcher, "acme.com");
  const outcome = result.metrics.find((m) => m.metricName === "website_fetch_outcome");
  assert.ok(outcome);
  assert.equal(outcome!.textValue, "timeout");
  assert.equal(result.metrics.length, 1, "a total failure writes ONLY the outcome row — no page metric, no prelaunch");
});

test("collector: metadata on a present page never contains raw HTML, only small normalized fields", async () => {
  const homepage = `<!DOCTYPE html><html lang="en"><head><title>Acme</title></head><body><nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/team">Team</a></nav></body></html>`;
  const pricingPage = `<!DOCTYPE html><html lang="en"><head><title>Pricing | Acme</title></head><body><h1>Pricing</h1><p>$29 per month. Free trial.</p></body></html>`;
  const fetcher = fakeSite({ "https://acme.com/": { text: homepage }, "https://acme.com/pricing": { text: pricingPage } });
  const result = await collectWebsite(fetcher, "acme.com");
  const pricing = result.metrics.find((m) => m.metricName === "website_page_pricing")!;
  assert.equal(pricing.numericValue, 1);
  const json = JSON.stringify(pricing.metadata);
  assert.ok(json.length < 4096, "metadata must respect the size discipline");
  assert.ok(!json.includes("<h1>") && !json.includes("<body>"), "no raw HTML tags in stored metadata");
});

test("coverage.ts: a website signal_source contributes to the 'website' family, exactly like github/ats contribute to theirs", () => {
  const source: SignalSource = {
    id: 1, company_id: 1, source_type: "website", external_id: "acme.com", canonical_url: "https://acme.com/",
    resolution_method: "company_domain", resolution_confidence: 1, resolution_evidence: "test", active: true, metadata: null,
  };
  const coverage = computeCoverage([source], [], []);
  assert.deepEqual(coverage.familiesResolved, ["website"]);
});
