import assert from "node:assert/strict";
import { test } from "node:test";
import { runWebsitePass, MAX_REQUESTS_PER_PASS } from "../src/signals/website/resolve.ts";
import type { Fetcher, FetchOptions, FetchResult } from "../src/sources/fetcher.ts";

/**
 * V2-2B.2 Phase 1 — the pure website-monitoring library's own test suite. Offline only: a fake
 * Fetcher serves fixed routes, no real network, no database, no Anthropic calls. Covers the design
 * report's cases A/D/E/F/G/H (J) plus SPA/blocked/robots/off-domain/non-English/known-host/budget —
 * cases B/C/I (which need a SECOND observation pass and the derived rules) are covered in
 * test/website-rules.test.ts once Phase 2's rules exist.
 */

interface RouteSpec {
  status?: number;
  text?: string;
  contentType?: string;
  finalUrl?: string;
  error?: "timeout" | "dns_failure";
}

function fakeSite(routes: Record<string, RouteSpec>): { fetcher: Fetcher; requested: string[] } {
  const requested: string[] = [];
  const fetcher: Fetcher = {
    async getText(url: string, _options?: FetchOptions): Promise<FetchResult> {
      requested.push(url);
      const r = routes[url];
      if (!r) return { url, status: 404, text: "", bytes: 0, elapsed_ms: 0 };
      if (r.error === "timeout") throw new Error(`The operation timed out. (${url})`);
      if (r.error === "dns_failure") throw new Error(`getaddrinfo ENOTFOUND ${new URL(url).hostname}`);
      const text = r.text ?? "";
      return { url: r.finalUrl ?? url, status: r.status ?? 200, text, bytes: text.length, elapsed_ms: 0, contentType: r.contentType };
    },
  };
  return { fetcher, requested };
}

const HTML = (title: string, body: string, lang = "en") => `<!DOCTYPE html><html lang="${lang}"><head><title>${title}</title></head><body>${body}</body></html>`;

// A homepage with 5+ internal links but NO page-type matches — real, navigable, but minimal.
const NAVIGABLE_MINIMAL_HOMEPAGE = HTML(
  "Acme - Home",
  `<nav><a href="/">Home</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/contact">Contact</a><a href="/team">Team</a><a href="/press">Press</a></nav><h1>Acme</h1><p>We build things.</p>`,
);

// A homepage with real links to all 5 page types (careers via a known ATS host, zero extra requests).
const MATURE_HOMEPAGE = HTML(
  "Acme - Home",
  `<nav>
    <a href="/">Home</a><a href="/pricing">Pricing</a><a href="/enterprise">Enterprise</a>
    <a href="/security">Security</a><a href="/customers">Customers</a>
    <a href="https://boards.greenhouse.io/acme">Careers</a><a href="/about">About</a><a href="/blog">Blog</a>
  </nav><h1>Welcome to Acme</h1><p>Acme helps teams build great products, trusted by thousands.</p>`,
);

const PRICING_PAGE = HTML("Pricing | Acme", `<h1>Simple, transparent pricing</h1><p>Starter $29 per month. Contact sales for Enterprise. Free trial available.</p>`);
const ENTERPRISE_PAGE = HTML("Enterprise | Acme", `<h1>Enterprise</h1><p>Enterprise-grade security, SSO, and a dedicated support team with a custom contract.</p>`);
const SECURITY_PAGE = HTML("Security | Acme", `<h1>Security &amp; Trust</h1><p>SOC 2 Type II certified. GDPR compliant. Data encryption at rest and in transit.</p>`);
const CUSTOMERS_PAGE = HTML("Customers | Acme", `<h1>Customer stories</h1><p>Read our case studies. Trusted by thousands of customers worldwide.</p>`);

test("minimal site: homepage-only pass resolves to ok with every page absent or unknown, never fabricated present", async () => {
  const { fetcher } = fakeSite({ "https://acme.com/": { text: NAVIGABLE_MINIMAL_HOMEPAGE } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "ok");
  for (const page of Object.values(result.pages)) assert.notEqual(page.state, "present", `no page type should verify as present on a minimal site: got ${JSON.stringify(page)}`);
  // Every probe hit a real 404 on a navigable, English homepage — a genuine confirmed absence.
  assert.equal(result.pages.pricing.state, "absent");
  assert.equal(result.pages.pricing.how, "probe");
});

test("mature footprint: all 5 page types verify present, careers via known host costs zero extra requests", async () => {
  const { fetcher, requested } = fakeSite({
    "https://acme.com/": { text: MATURE_HOMEPAGE },
    "https://acme.com/pricing": { text: PRICING_PAGE },
    "https://acme.com/enterprise": { text: ENTERPRISE_PAGE },
    "https://acme.com/security": { text: SECURITY_PAGE },
    "https://acme.com/customers": { text: CUSTOMERS_PAGE },
  });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "ok");
  assert.equal(result.pages.pricing.state, "present");
  assert.equal(result.pages.enterprise.state, "present");
  assert.equal(result.pages.security.state, "present");
  assert.equal(result.pages.customers.state, "present");
  assert.equal(result.pages.careers.state, "present");
  assert.equal(result.pages.careers.how, "known_host");
  assert.ok(!requested.some((u) => u.includes("greenhouse")), "a known-host careers match must never be fetched — the link itself is the confirmation");
  assert.ok(result.requestsUsed <= MAX_REQUESTS_PER_PASS, `requests used (${result.requestsUsed}) must stay within the hard cap`);
});

test("timeout on the homepage: outcome is 'timeout', every page stays unknown, no further requests attempted", async () => {
  const { fetcher, requested } = fakeSite({ "https://acme.com/": { error: "timeout" } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "timeout");
  for (const page of Object.values(result.pages)) assert.equal(page.state, "unknown");
  assert.equal(requested.length, 2, "only robots.txt + the homepage attempt — a homepage failure must never trigger page-level probing");
});

test("DNS failure is classified distinctly from a generic timeout", async () => {
  const { fetcher } = fakeSite({ "https://acme.com/": { error: "dns_failure" } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "dns_failure");
});

test("a real HTTP 500 homepage response is classified http_5xx, never 'ok'", async () => {
  const { fetcher } = fakeSite({ "https://acme.com/": { status: 500, text: "Internal Server Error" } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "http_5xx");
});

test("URL migration (/pricing -> /plans): a differently-named nav link still resolves pricing as present", async () => {
  const homepage = HTML("Acme", `<nav><a href="/">Home</a><a href="/plans">Pricing</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/team">Team</a></nav><h1>Acme</h1>`);
  const { fetcher } = fakeSite({ "https://acme.com/": { text: homepage }, "https://acme.com/plans": { text: PRICING_PAGE } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.pages.pricing.state, "present");
  assert.equal(result.pages.pricing.path, "/plans", "the resolved path reflects reality, not the old conventional guess");
});

test("soft 404: a linked candidate returns HTTP 200 but is really a not-found page — never counted as present", async () => {
  const softNotFound = HTML("Page Not Found | Acme", `<h1>404</h1><p>We couldn't find that page.</p>`);
  const homepage = HTML("Acme", `<nav><a href="/">Home</a><a href="/security">Security</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/team">Team</a></nav>`);
  const { fetcher } = fakeSite({ "https://acme.com/": { text: homepage }, "https://acme.com/security": { text: softNotFound } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.pages.security.state, "unknown", "a soft-404-shaped response must never verify as present");
  assert.ok(result.pages.security.checks.includes("soft_404_match") || result.pages.security.checks.length > 0);
});

test("soft 404 via baseline: a PROBE hitting the same generic-CMS 404 template as the baseline counts as a genuine confirmed absence (not present, and distinguishable from a real 404)", async () => {
  // Both the probe target and the deliberate baseline path return the SAME generic template —
  // this specifically exercises baseline-vs-candidate title/h1 matching, not the direct-text case.
  // Per the design report §6, a probe matching the soft-404 baseline is one of the three valid
  // absence conditions (alongside a real 404/410 and a redirect-to-homepage) — it is NOT "present"
  // (the page doesn't really exist), and it is NOT left "unknown" (this IS a probe, with a clean
  // navigable/English homepage backing it, exactly like the redirect-to-homepage probe case).
  const genericTemplate = HTML("Oops", `<h1>Whoops!</h1><p>Nothing here.</p>`);
  const homepage = HTML("Acme", `<nav><a href="/">Home</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/team">Team</a><a href="/press">Press</a></nav>`);
  const { fetcher } = fakeSite({
    "https://acme.com/": { text: homepage },
    "https://acme.com/startup-radar-soft-404-check-9f3d1a": { text: genericTemplate },
    "https://acme.com/security": { status: 200, text: genericTemplate },
  });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.pages.security.state, "absent");
  assert.equal(result.pages.security.how, "probe");
  assert.ok(result.pages.security.checks.includes("probe_soft_404"));
});

test("soft 404 via NAV-LINK candidate (not a probe): matching the baseline leaves the page unknown, never absent — a real link existed, we just couldn't confirm it", async () => {
  const genericTemplate = HTML("Oops", `<h1>Whoops!</h1><p>Nothing here.</p>`);
  const homepage = HTML("Acme", `<nav><a href="/">Home</a><a href="/security">Security</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/team">Team</a></nav>`);
  const { fetcher } = fakeSite({
    "https://acme.com/": { text: homepage },
    "https://acme.com/startup-radar-soft-404-check-9f3d1a": { text: genericTemplate },
    "https://acme.com/security": { status: 200, text: genericTemplate },
  });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.pages.security.state, "unknown");
});

test("redirect-to-homepage: a candidate link that actually redirects back to '/' is never counted as present", async () => {
  const homepage = HTML("Acme", `<nav><a href="/">Home</a><a href="/customers">Customers</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/team">Team</a></nav>`);
  const { fetcher } = fakeSite({ "https://acme.com/": { text: homepage }, "https://acme.com/customers": { status: 200, text: homepage, finalUrl: "https://acme.com/" } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.pages.customers.state, "unknown");
});

test("redirect-to-homepage via PROBE (no candidate link at all) counts as a genuine confirmed absence", async () => {
  const { fetcher } = fakeSite({
    "https://acme.com/": { text: NAVIGABLE_MINIMAL_HOMEPAGE },
    "https://acme.com/customers": { status: 200, text: NAVIGABLE_MINIMAL_HOMEPAGE, finalUrl: "https://acme.com/" },
  });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.pages.customers.state, "absent");
});

test("SPA shell: a near-empty, near-linkless homepage response is classified spa_shell, not ok — every page unknown", async () => {
  const shell = `<!DOCTYPE html><html lang="en"><head><title>Acme</title></head><body><div id="root"></div></body></html>`;
  const { fetcher } = fakeSite({ "https://acme.com/": { text: shell } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "spa_shell");
  for (const page of Object.values(result.pages)) assert.equal(page.state, "unknown");
});

test("Cloudflare/bot challenge is classified 'blocked', never misread as a real (thin) homepage", async () => {
  const challenge = HTML("Just a moment...", `<p>Checking your browser before accessing acme.com.</p>`);
  const { fetcher } = fakeSite({ "https://acme.com/": { status: 503, text: challenge } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "blocked");
});

test("robots.txt disallowing '/' produces robots_denied and makes ZERO further requests (never 'absent')", async () => {
  const { fetcher, requested } = fakeSite({ "https://acme.com/robots.txt": { text: "User-agent: *\nDisallow: /\n" } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "robots_denied");
  assert.equal(requested.length, 1, "only robots.txt itself is fetched");
  for (const page of Object.values(result.pages)) assert.equal(page.state, "unknown");
});

test("locale redirect (same registrable domain) is still a valid 'ok' homepage, not off-domain", async () => {
  const { fetcher } = fakeSite({ "https://acme.com/": { text: MATURE_HOMEPAGE.replace('lang="en"', 'lang="en"'), finalUrl: "https://acme.com/en/" } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "ok");
});

test("off-domain redirect (acquisition/rebrand) is detected and treated as unreachable, never followed", async () => {
  const { fetcher, requested } = fakeSite({ "https://acme.com/": { text: MATURE_HOMEPAGE, finalUrl: "https://acquirer.com/" } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "offdomain_redirect");
  assert.equal(requested.length, 2, "robots.txt + the homepage attempt only — no page-level requests once off-domain is detected");
});

test("non-English homepage: a real 404 probe never becomes a confirmed absence (conservatism)", async () => {
  const deHomepage = HTML("Acme", `<nav><a href="/">Home</a><a href="/uber-uns">Über uns</a><a href="/blog">Blog</a><a href="/kontakt">Kontakt</a><a href="/team">Team</a></nav>`, "de");
  const { fetcher } = fakeSite({ "https://acme.com/": { text: deHomepage } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.lang, "de");
  assert.equal(result.pages.pricing.state, "unknown", "a real 404 on a non-English site must not be read as confirmed absence");
  assert.ok(result.pages.pricing.checks.includes("non_english_conservatism"));
});

test("a network failure while verifying a candidate page yields unknown, never absent or present", async () => {
  const homepage = HTML("Acme", `<nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/team">Team</a></nav>`);
  const { fetcher } = fakeSite({ "https://acme.com/": { text: homepage }, "https://acme.com/pricing": { error: "timeout" } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.pages.pricing.state, "unknown");
});

test("a network failure during a probe (no candidate found) yields unknown, never a false absence", async () => {
  const { fetcher } = fakeSite({ "https://acme.com/": { text: NAVIGABLE_MINIMAL_HOMEPAGE }, "https://acme.com/enterprise": { error: "timeout" } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.pages.enterprise.state, "unknown");
});

test("thin (sub-navigable), non-SPA homepage: a real 404 probe stays unknown, not absent", async () => {
  const thin = HTML("Acme", `<nav><a href="/">Home</a><a href="/about">About</a></nav><h1>Acme</h1><p>${"word ".repeat(60)}</p>`);
  const { fetcher } = fakeSite({ "https://acme.com/": { text: thin } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "ok", "enough visible text/links to not be an SPA shell");
  assert.equal(result.pages.pricing.state, "unknown");
  assert.ok(result.pages.pricing.checks.includes("homepage_not_navigable"));
});

test("non-HTML homepage response is classified non_html, not ok", async () => {
  const { fetcher } = fakeSite({ "https://acme.com/": { text: JSON.stringify({ ok: true }), contentType: "application/json" } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "non_html");
});

test("pre-launch marker is detected from homepage text alone", async () => {
  const waitlist = HTML(
    "Acme - Coming Soon",
    `<h1>Something big is coming</h1><nav><a href="/">Home</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/contact">Contact</a></nav>
     <p>We're building the future of team collaboration and we can't wait to share it with you. Join the waitlist to get early access before anyone else.</p>`,
  );
  const { fetcher } = fakeSite({ "https://acme.com/": { text: waitlist } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.outcome, "ok", "enough real content/links that this is a genuine (if minimal) homepage, not an SPA shell");
  assert.equal(result.prelaunch, true);
});

test("a mature site with no waitlist language is NOT flagged pre-launch", async () => {
  const { fetcher } = fakeSite({ "https://acme.com/": { text: MATURE_HOMEPAGE } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.prelaunch, false);
});

test("false-positive fix (live dry-run finding): a technical blog post mentioning 'case study' is never mistaken for a customer-proof page", async () => {
  const homepage = HTML(
    "Acme Blog",
    `<nav><a href="/">Home</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/team">Team</a><a href="/press">Press</a>
     <a href="/blog/tanstack-query-checkout-outbox-case-study/">Case Study</a></nav>`,
  );
  const blogPost = HTML("Resuming persisted mutations | Acme", `<h1>A TanStack Query case study</h1><p>In this case study we walk through a checkout outbox implementation.</p>`);
  const { fetcher } = fakeSite({ "https://acme.com/": { text: homepage }, "https://acme.com/blog/tanstack-query-checkout-outbox-case-study/": { text: blogPost } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.notEqual(result.pages.customers.state, "present", "a blog post is never customer proof, even if its title/text says 'case study'");
});

test("false-positive fix: a real /case-studies PATH (not just link text) still verifies normally", async () => {
  const homepage = HTML("Acme", `<nav><a href="/">Home</a><a href="/case-studies">Our customers</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/team">Team</a></nav>`);
  const caseStudiesPage = HTML("Customer Stories | Acme", `<h1>Customer stories</h1><p>Read our case studies. Trusted by thousands of customers worldwide.</p>`);
  const { fetcher } = fakeSite({ "https://acme.com/": { text: homepage }, "https://acme.com/case-studies": { text: caseStudiesPage } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.pages.customers.state, "present");
});

test("false-positive fix: a text-matched candidate (e.g. 'Enterprise') nested under /blog/ is rejected as a candidate, falling back to the conventional probe instead", async () => {
  const homepage = HTML("Acme", `<nav><a href="/">Home</a><a href="/blog/why-enterprise-buyers-choose-acme">Enterprise</a><a href="/about">About</a><a href="/team">Team</a><a href="/press">Press</a></nav>`);
  const { fetcher } = fakeSite({ "https://acme.com/": { text: homepage } }); // no route for /enterprise -> probe 404s
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.notEqual(result.pages.enterprise.state, "present", "a blog post must never verify as the enterprise page merely because its link text says 'Enterprise'");
});

test("careers content-term fix (live dry-run finding): a real careers page using 'open roles'/'join the team' phrasing verifies as present", async () => {
  const homepage = HTML("Acme", `<nav><a href="/">Home</a><a href="/careers">Careers</a><a href="/about">About</a><a href="/blog">Blog</a><a href="/team">Team</a></nav>`);
  const careersPage = HTML("Careers | Acme", `<h1>Join the team</h1><p>We're growing fast. Check out our open roles below.</p>`);
  const { fetcher } = fakeSite({ "https://acme.com/": { text: homepage }, "https://acme.com/careers": { text: careersPage } });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.equal(result.pages.careers.state, "present");
});

test("the request budget never exceeds the hard cap, even on a rich homepage with sitemap entries", async () => {
  const sitemap = `<?xml version="1.0"?><urlset><url><loc>https://acme.com/pricing</loc></url><url><loc>https://acme.com/enterprise</loc></url></urlset>`;
  const { fetcher } = fakeSite({
    "https://acme.com/": { text: MATURE_HOMEPAGE },
    "https://acme.com/sitemap.xml": { text: sitemap, contentType: "application/xml" },
    "https://acme.com/pricing": { text: PRICING_PAGE },
    "https://acme.com/enterprise": { text: ENTERPRISE_PAGE },
    "https://acme.com/security": { text: SECURITY_PAGE },
    "https://acme.com/customers": { text: CUSTOMERS_PAGE },
  });
  const result = await runWebsitePass("acme.com", { fetcher });
  assert.ok(result.requestsUsed <= MAX_REQUESTS_PER_PASS);
  assert.ok(result.requestsUsed <= 9, `typical pass should stay well under the cap (got ${result.requestsUsed})`);
});
