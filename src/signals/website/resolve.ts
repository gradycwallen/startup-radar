import { normalizeDomain } from "../../domain.ts";
import type { Fetcher } from "../../sources/fetcher.ts";
import { computeNavFingerprint } from "./fingerprint.ts";
import { extractPageFields, looksLikeHtml, type ExtractedPage } from "./extract.ts";
import { PAGE_TYPE_RULES, BOT_CHALLENGE_PATTERN, PRELAUNCH_MARKER_PATTERN } from "./patterns.ts";
import { ALLOW_ALL_ROBOTS, isPathAllowed, parseRobotsTxt, type RobotsRules } from "./robots.ts";
import { looksLikeSoft404, SOFT_404_PROBE_PATH, type PageSignature } from "./soft404.ts";
import { emptyPages, PAGE_TYPES, type FetchOutcome, type PageEvidence, type PageType, type WebsitePassResult } from "./types.ts";

/**
 * V2-2B.2's core deterministic website-monitoring pass. Given a company's canonical domain, finds
 * and classifies up to 5 semantic pages (pricing/enterprise/security/customers/careers) plus a
 * pre-launch marker on the homepage, within a HARD request budget — no crawling, no recursion, no
 * browser rendering. See the V2-2B.2 design report §4/§6/§11/§15/§26 for the full rationale.
 *
 * Budget, worst case: robots.txt(1) + homepage(1) + sitemap.xml(1) + soft-404 baseline(1) +
 * up to one request per page type (verify OR probe, never both — 5) = 9, well under the hard cap
 * of 12 enforced below. A page type resolved via a known-host link (careers only) costs zero.
 */

export const MAX_REQUESTS_PER_PASS = 12;
export const ROBOTS_USER_AGENT_TOKEN = "StartupRadarScout";
const MIN_NAV_LINKS_FOR_NAVIGABLE = 5;
const SPA_SHELL_MAX_TEXT_LENGTH = 150;
const SPA_SHELL_MAX_LINKS = 3;

export interface WebsiteResolveOptions {
  fetcher: Fetcher;
  signal?: AbortSignal;
}

interface Budget {
  used: number;
  readonly max: number;
}

function budgetRemaining(b: Budget): boolean {
  return b.used < b.max;
}

interface RawFetchOk {
  ok: true;
  status: number;
  text: string;
  finalUrl: string;
  contentType?: string;
}
interface RawFetchErr {
  ok: false;
  classified: "timeout" | "dns_failure";
}

async function budgetedFetch(fetcher: Fetcher, url: string, accept: string, budget: Budget, checked: string[], signal?: AbortSignal): Promise<RawFetchOk | RawFetchErr | null> {
  if (!budgetRemaining(budget)) return null; // request cap reached — caller must treat as "not attempted", never as a failure signal
  budget.used++;
  checked.push(url);
  try {
    const res = await fetcher.getText(url, { accept, provider: "signals-website", signal });
    return { ok: true, status: res.status, text: res.text, finalUrl: res.url, contentType: res.contentType };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const classified: "timeout" | "dns_failure" = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message) ? "dns_failure" : "timeout";
    return { ok: false, classified };
  }
}

function toSignature(status: number, extracted: ExtractedPage): PageSignature {
  return { status, title: extracted.title, h1: extracted.h1 };
}

async function fetchRobots(fetcher: Fetcher, origin: string, budget: Budget, checked: string[], signal?: AbortSignal): Promise<RobotsRules> {
  const res = await budgetedFetch(fetcher, `${origin}/robots.txt`, "text/plain", budget, checked, signal);
  if (!res || !res.ok || res.status < 200 || res.status >= 300) return ALLOW_ALL_ROBOTS; // absent/unreachable robots.txt = no restrictions, per convention
  return parseRobotsTxt(res.text, ROBOTS_USER_AGENT_TOKEN);
}

/** Classifies a successfully-received homepage response into an outcome, or "ok" with its
 * extracted fields. Redirect-following is the fetcher's job (see PoliteFetcher); here we only
 * inspect the FINAL response. */
function classifyHomepage(companyDomain: string, res: RawFetchOk): { outcome: FetchOutcome; extracted: ExtractedPage | null } {
  const finalDomain = normalizeDomain(res.finalUrl);
  if (finalDomain && finalDomain !== companyDomain) return { outcome: "offdomain_redirect", extracted: null };

  // Bot-challenge pages are commonly served on 403/429/503 (sometimes even a "soft" 200) — check
  // for the challenge markers BEFORE any status-code-based branch, so a 503 Cloudflare challenge
  // is correctly "blocked" rather than misclassified as "http_5xx". Checked against the RAW text,
  // since a challenge page's own HTML is exactly what we want to recognize, not a cleaned extraction.
  if (BOT_CHALLENGE_PATTERN.test(res.text)) return { outcome: "blocked", extracted: null };
  if ([401, 403, 429].includes(res.status)) return { outcome: "blocked", extracted: null };
  if (res.status >= 500) return { outcome: "http_5xx", extracted: null };
  if (res.status < 200 || res.status >= 400) return { outcome: "timeout", extracted: null }; // an unexpected 3xx/4xx we didn't already classify — treat as unreachable, never as "ok"
  if (!looksLikeHtml(res.contentType, res.text)) return { outcome: "non_html", extracted: null };

  const extracted = extractPageFields(res.text, res.finalUrl);
  if (extracted.visibleText.length < SPA_SHELL_MAX_TEXT_LENGTH && extracted.links.length < SPA_SHELL_MAX_LINKS) {
    return { outcome: "spa_shell", extracted: null };
  }
  return { outcome: "ok", extracted };
}

/** Extracts `<loc>` entries from a root `urlset` sitemap. A `sitemapindex` (a sitemap OF sitemaps)
 * contributes nothing here — see the design report §6: following into a nested index is explicitly
 * NOT done, to keep the request budget simple and predictable; nav-link scanning and the
 * conventional-path probe already cover what a sitemap-index would otherwise add. */
function parseSitemapUrls(xml: string): string[] {
  if (/<sitemapindex/i.test(xml)) return [];
  const urls: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  for (let m = re.exec(xml); m && urls.length < 500; m = re.exec(xml)) urls.push(m[1]!.trim());
  return urls;
}

interface Candidate {
  url: string;
  how: "nav_link" | "sitemap";
}

/** A genuine pricing/enterprise/security/customers/careers page is essentially never nested under
 * a blog path — but a TEXT-pattern match (an anchor literally saying "Enterprise" or "Case Study")
 * can land on exactly that by accident. Found during the V2-2B.2 live dry-run validation: a
 * company's own engineering blog post about a "TanStack Query case study" matched the customers
 * text pattern and verified as a "customer proof" page — a real, structural false-positive class,
 * not a one-off headline to special-case (see the design report's own stated philosophy on this).
 * PATH-pattern matches are exempt: an actual "/case-studies/..." or "/customers/..." URL is real
 * evidence regardless of where it happens to sit. */
const BLOG_PATH = /^\/blog(\/|$)/i;

function findCandidates(pageType: PageType, companyDomain: string, homepageLinks: readonly { href: string; text: string }[], sitemapUrls: readonly string[]): Candidate[] {
  const rule = PAGE_TYPE_RULES[pageType];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (url: string, how: Candidate["how"]) => {
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, how });
  };

  for (const link of homepageLinks) {
    let u: URL;
    try {
      u = new URL(link.href);
    } catch {
      continue;
    }
    if (normalizeDomain(link.href) !== companyDomain) continue; // candidates must be on the company's own domain (subdomain OK via registrable-domain match)
    const pathMatch = rule.pathPatterns.some((p) => p.test(u.pathname));
    if (pathMatch) push(link.href, "nav_link");
    else if (!BLOG_PATH.test(u.pathname) && rule.textPatterns.some((p) => p.test(link.text))) push(link.href, "nav_link");
  }
  for (const rawUrl of sitemapUrls) {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      continue;
    }
    if (normalizeDomain(rawUrl) !== companyDomain) continue;
    if (rule.pathPatterns.some((p) => p.test(u.pathname))) push(rawUrl, "sitemap");
  }
  return out;
}

function findKnownHost(pageType: PageType, homepageLinks: readonly { href: string; text: string }[]): string | null {
  const hosts = PAGE_TYPE_RULES[pageType].knownHosts;
  if (!hosts) return null;
  for (const link of homepageLinks) {
    let host: string;
    try {
      host = new URL(link.href).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (hosts.some((h) => h.test(host))) return link.href;
  }
  return null;
}

/** Resolves ONE page type given whatever candidates/known-host evidence is already available.
 * Never mutates shared state — returns a fresh PageEvidence. See the module doc for the budget
 * accounting each branch performs. */
async function resolvePageType(
  pageType: PageType,
  companyDomain: string,
  homepageFinalUrl: string,
  candidates: Candidate[],
  knownHostUrl: string | null,
  navigable: boolean,
  langIsNonEnglish: boolean,
  soft404Baseline: PageSignature | null,
  fetcher: Fetcher,
  budget: Budget,
  checked: string[],
  signal: AbortSignal | undefined,
): Promise<PageEvidence> {
  const rule = PAGE_TYPE_RULES[pageType];

  // Known-host evidence (careers only) — the linked board itself IS the confirmation; zero extra requests.
  if (knownHostUrl) {
    return { state: "present", path: new URL(knownHostUrl).pathname, finalUrl: knownHostUrl, status: null, how: "known_host", checks: ["known_host_link"], title: null, h1: null };
  }

  if (candidates.length > 0) {
    const candidate = candidates[0]!;
    const res = await budgetedFetch(fetcher, candidate.url, "text/html,application/xhtml+xml", budget, checked, signal);
    if (!res) return { state: "unknown", path: null, finalUrl: null, status: null, how: null, checks: ["budget_exhausted"], title: null, h1: null };
    if (!res.ok) return { state: "unknown", path: new URL(candidate.url).pathname, finalUrl: null, status: null, how: null, checks: [`fetch_failed:${res.classified}`], title: null, h1: null };
    if (res.status < 200 || res.status >= 400 || !looksLikeHtml(res.contentType, res.text)) {
      return { state: "unknown", path: new URL(candidate.url).pathname, finalUrl: res.finalUrl, status: res.status, how: null, checks: ["candidate_not_verifiable"], title: null, h1: null };
    }
    const extracted = extractPageFields(res.text, res.finalUrl);
    const finalDomain = normalizeDomain(res.finalUrl);
    const checks: string[] = [];
    if (finalDomain !== companyDomain) checks.push("offdomain");
    else checks.push("same_domain");
    const redirectedToHomepage = res.finalUrl.replace(/\/$/, "") === homepageFinalUrl.replace(/\/$/, "");
    if (redirectedToHomepage) checks.push("redirected_to_homepage");
    const soft404 = looksLikeSoft404(toSignature(res.status, extracted), soft404Baseline);
    if (soft404) checks.push("soft_404_match");
    const contentMatch = rule.contentTerms.test(extracted.visibleText) || rule.contentTerms.test(extracted.title ?? "") || rule.contentTerms.test(extracted.h1 ?? "");
    if (contentMatch) checks.push("content_terms_match");

    // A candidate only verifies as "present" when it's really the company's own page, isn't a
    // homepage-redirect disguise, doesn't match the soft-404 baseline, and its own content
    // actually says what the link claimed. Anything short of that is inconclusive — NOT absent
    // (a real link existed; we simply couldn't confirm it), matching §6/§18's redesign/soft-404
    // false-positive guidance.
    if (finalDomain === companyDomain && !redirectedToHomepage && !soft404 && contentMatch) {
      return { state: "present", path: new URL(candidate.url).pathname, finalUrl: res.finalUrl, status: res.status, how: candidate.how, checks, title: extracted.title, h1: extracted.h1 };
    }
    return { state: "unknown", path: new URL(candidate.url).pathname, finalUrl: res.finalUrl, status: res.status, how: null, checks, title: extracted.title, h1: extracted.h1 };
  }

  // No candidate anywhere: attempt the conventional-path probe, the ONLY route to a confirmed
  // "absent" — see the design report §6's exact absence recipe.
  const probeUrl = `https://${companyDomain}${rule.probePath}`;
  const res = await budgetedFetch(fetcher, probeUrl, "text/html,application/xhtml+xml", budget, checked, signal);
  if (!res) return { state: "unknown", path: null, finalUrl: null, status: null, how: null, checks: ["budget_exhausted"], title: null, h1: null };
  if (!res.ok) return { state: "unknown", path: rule.probePath, finalUrl: null, status: null, how: null, checks: [`fetch_failed:${res.classified}`], title: null, h1: null };

  if (res.status === 404 || res.status === 410) {
    if (!navigable) return { state: "unknown", path: rule.probePath, finalUrl: res.finalUrl, status: res.status, how: null, checks: ["homepage_not_navigable"], title: null, h1: null };
    if (langIsNonEnglish) return { state: "unknown", path: rule.probePath, finalUrl: res.finalUrl, status: res.status, how: null, checks: ["non_english_conservatism"], title: null, h1: null };
    return { state: "absent", path: rule.probePath, finalUrl: res.finalUrl, status: res.status, how: "probe", checks: ["probe_404"], title: null, h1: null };
  }
  if (res.status >= 200 && res.status < 300 && looksLikeHtml(res.contentType, res.text)) {
    const extracted = extractPageFields(res.text, res.finalUrl);
    const redirectedToHomepage = res.finalUrl.replace(/\/$/, "") === homepageFinalUrl.replace(/\/$/, "");
    const soft404 = looksLikeSoft404(toSignature(res.status, extracted), soft404Baseline);
    if (redirectedToHomepage || soft404) {
      if (!navigable || langIsNonEnglish) {
        return { state: "unknown", path: rule.probePath, finalUrl: res.finalUrl, status: res.status, how: null, checks: [redirectedToHomepage ? "redirected_to_homepage" : "soft_404_match"], title: extracted.title, h1: extracted.h1 };
      }
      return { state: "absent", path: rule.probePath, finalUrl: res.finalUrl, status: res.status, how: "probe", checks: [redirectedToHomepage ? "probe_redirected_to_homepage" : "probe_soft_404"], title: extracted.title, h1: extracted.h1 };
    }
    const contentMatch = rule.contentTerms.test(extracted.visibleText) || rule.contentTerms.test(extracted.title ?? "") || rule.contentTerms.test(extracted.h1 ?? "");
    const finalDomain = normalizeDomain(res.finalUrl);
    if (finalDomain === companyDomain && contentMatch) {
      return { state: "present", path: rule.probePath, finalUrl: res.finalUrl, status: res.status, how: "probe", checks: ["probe_content_match"], title: extracted.title, h1: extracted.h1 };
    }
  }
  // Anything else (5xx, off-domain, non-HTML, unverifiable 200) at the probe: inconclusive.
  return { state: "unknown", path: rule.probePath, finalUrl: res.finalUrl, status: res.status, how: null, checks: ["probe_inconclusive"], title: null, h1: null };
}

/**
 * Runs one full website pass for a company. Never throws — every failure mode is captured as an
 * `outcome`/`unknown` state instead, matching this codebase's "a fetch failure is never
 * interpreted as absence" rule (§13/§19 of the design report).
 */
export async function runWebsitePass(companyDomain: string, options: WebsiteResolveOptions): Promise<WebsitePassResult> {
  const { fetcher, signal } = options;
  const budget: Budget = { used: 0, max: MAX_REQUESTS_PER_PASS };
  const checked: string[] = [];
  const origin = `https://${companyDomain}`;

  const robots = await fetchRobots(fetcher, origin, budget, checked, signal);
  if (!isPathAllowed(robots, "/")) {
    return { outcome: "robots_denied", homepageFinalUrl: null, homepageStatus: null, lang: null, navLinkCount: null, navFingerprint: null, prelaunch: null, pages: emptyPages(), requestsUsed: budget.used, pagesChecked: checked };
  }

  const homepageRes = await budgetedFetch(fetcher, `${origin}/`, "text/html,application/xhtml+xml", budget, checked, signal);
  if (!homepageRes) {
    // Budget exhausted on robots.txt alone should never happen (max is 12, robots is 1), but stay honest if it did.
    return { outcome: "timeout", homepageFinalUrl: null, homepageStatus: null, lang: null, navLinkCount: null, navFingerprint: null, prelaunch: null, pages: emptyPages(), requestsUsed: budget.used, pagesChecked: checked };
  }
  if (!homepageRes.ok) {
    const outcome: FetchOutcome = homepageRes.classified;
    return { outcome, homepageFinalUrl: null, homepageStatus: null, lang: null, navLinkCount: null, navFingerprint: null, prelaunch: null, pages: emptyPages(), requestsUsed: budget.used, pagesChecked: checked };
  }

  const { outcome, extracted } = classifyHomepage(companyDomain, homepageRes);
  if (outcome !== "ok" || !extracted) {
    return { outcome, homepageFinalUrl: homepageRes.finalUrl, homepageStatus: homepageRes.status, lang: null, navLinkCount: null, navFingerprint: null, prelaunch: null, pages: emptyPages(), requestsUsed: budget.used, pagesChecked: checked };
  }

  const navLinkCount = extracted.internalPaths.length;
  const navFingerprint = await computeNavFingerprint(extracted.internalPaths);
  const navigable = navLinkCount >= MIN_NAV_LINKS_FOR_NAVIGABLE;
  const langIsNonEnglish = extracted.lang !== null && extracted.lang !== "en";
  const prelaunch = PRELAUNCH_MARKER_PATTERN.test(extracted.visibleText) || PRELAUNCH_MARKER_PATTERN.test(extracted.title ?? "");

  const sitemapRes = await budgetedFetch(fetcher, `${origin}/sitemap.xml`, "application/xml,text/xml", budget, checked, signal);
  const sitemapUrls = sitemapRes && sitemapRes.ok && sitemapRes.status >= 200 && sitemapRes.status < 300 ? parseSitemapUrls(sitemapRes.text) : [];

  // The soft-404 baseline is only useful once we're about to probe/verify a page, but it's cheap
  // and needed by potentially every page type below, so fetch it once, eagerly, right here.
  const baselineRes = await budgetedFetch(fetcher, `${origin}${SOFT_404_PROBE_PATH}`, "text/html,application/xhtml+xml", budget, checked, signal);
  const soft404Baseline: PageSignature | null =
    baselineRes && baselineRes.ok ? toSignature(baselineRes.status, extractPageFields(baselineRes.text, baselineRes.finalUrl)) : null;

  const pages = emptyPages();
  for (const pageType of PAGE_TYPES) {
    const knownHostUrl = findKnownHost(pageType, extracted.links);
    const candidates = knownHostUrl ? [] : findCandidates(pageType, companyDomain, extracted.links, sitemapUrls);
    pages[pageType] = await resolvePageType(
      pageType, companyDomain, homepageRes.finalUrl, candidates, knownHostUrl, navigable, langIsNonEnglish, soft404Baseline, fetcher, budget, checked, signal,
    );
  }

  return {
    outcome: "ok",
    homepageFinalUrl: homepageRes.finalUrl,
    homepageStatus: homepageRes.status,
    lang: extracted.lang,
    navLinkCount,
    navFingerprint,
    prelaunch,
    pages,
    requestsUsed: budget.used,
    pagesChecked: checked,
  };
}
