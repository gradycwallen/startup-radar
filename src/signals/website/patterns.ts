import type { PageType } from "./types.ts";

/**
 * Deterministic, regex-only page-type detection — no LLM, matching the discipline every other
 * detector in this codebase already follows (src/funnel/extract.ts, src/signals/sources/ats/
 * roles.ts). Three kinds of evidence per page type:
 *   - `pathPatterns`  — matched against a candidate URL's pathname (nav link or sitemap entry).
 *   - `textPatterns`  — matched against a nav link's visible anchor text, for cases where the path
 *     doesn't give it away (e.g. "/company/careers" already matches a path pattern, but a link
 *     literally labelled "Careers" pointing at "/join-us" needs the text match).
 *   - `contentTerms`  — matched against the CANDIDATE PAGE'S OWN extracted text once fetched, to
 *     confirm it's really that kind of page and not, e.g., a marketing page that merely mentions
 *     the word in passing. Required for a nav_link/sitemap candidate to verify as "present" (see
 *     resolve.ts); NOT required for a known-host match, which is already confirmed by the host.
 *   - `knownHosts`     — third-party hosts that themselves confirm the page type without a content
 *     fetch (careers: the same 3 ATS boards V2-2A already resolves; security: a short list of
 *     trust-center SaaS vendors). A `careers` known-host match costs ZERO extra requests — see the
 *     design report §6/§11 (reusing evidence, not re-verifying it).
 */

export interface PageTypeRule {
  pathPatterns: RegExp[];
  textPatterns: RegExp[];
  contentTerms: RegExp;
  /** Conventional path tried when nothing else resolved this type (see resolve.ts's probe step). */
  probePath: string;
  knownHosts?: RegExp[];
}

export const PAGE_TYPE_RULES: Record<PageType, PageTypeRule> = {
  pricing: {
    pathPatterns: [/^\/pricing(\/|$)/, /^\/plans(\/|$)/, /^\/plans-and-pricing(\/|$)/, /^\/price(s)?(\/|$)/],
    textPatterns: [/\bpricing\b/i, /\bplans?\b/i],
    contentTerms: /\$\s?\d|per\s+(month|user|seat|year)|contact\s+sales|choose\s+a\s+plan|free\s+trial|\bfree\s+tier\b/i,
    probePath: "/pricing",
  },
  enterprise: {
    pathPatterns: [/^\/enterprise(\/|$)/, /^\/solutions\/enterprise(\/|$)/, /^\/for-enterprise(\/|$)/],
    textPatterns: [/\benterprise\b/i],
    contentTerms: /\benterprise\b|dedicated\s+support|\bsso\b|\bsla\b|custom\s+contract|volume\s+pricing|enterprise-grade/i,
    probePath: "/enterprise",
  },
  security: {
    pathPatterns: [/^\/security(\/|$)/, /^\/trust(\/|$)/, /^\/trust-center(\/|$)/, /^\/security-and-compliance(\/|$)/, /^\/compliance(\/|$)/],
    textPatterns: [/\bsecurity\b/i, /\btrust\s*(center|centre)?\b/i, /\bcompliance\b/i],
    contentTerms: /soc\s?2|iso\s?27001|\bgdpr\b|\bhipaa\b|penetration\s+test|data\s+encryption|\bcompliance\b|\bsecurity\b/i,
    probePath: "/security",
    knownHosts: [/(^|\.)trust\.vanta\.com$/, /(^|\.)app\.vanta\.com$/, /(^|\.)trust\.safebase\.io$/, /(^|\.)trustportal\.drata\.com$/, /\.trustpage\.com$/],
  },
  customers: {
    pathPatterns: [/^\/customers(\/|$)/, /^\/case-studies(\/|$)/, /^\/customer-stories(\/|$)/, /^\/success-stories(\/|$)/],
    // NOTE: a bare "case stud(y|ies)" text pattern was deliberately removed here (found during the
    // V2-2B.2 live dry-run validation — see the delivery report) — it matched a company's own
    // ENGINEERING blog post ("Resuming persisted mutations... a TanStack Query case study") as a
    // customer-proof page. "Case study" alone is common in technical/content-marketing blogs and is
    // NOT customer-proof-specific; only a "/case-studies" PATH (still matched above) or text that
    // explicitly says "customer"/"success" story/ies is accepted now.
    textPatterns: [/\bcustomers?\b/i, /(customer|success)\s+stor(y|ies)/i],
    contentTerms: /case\s+study|customer\s+story|trusted\s+by|our\s+customers|customer\s+success\s+stor/i,
    probePath: "/customers",
  },
  careers: {
    pathPatterns: [/^\/careers(\/|$)/, /^\/jobs(\/|$)/, /^\/company\/careers(\/|$)/, /^\/join-us(\/|$)/, /^\/join-our-team(\/|$)/],
    textPatterns: [/\bcareers?\b/i, /\bjobs?\b/i, /we.?re\s+hiring/i],
    // Expanded during live dry-run validation: a real careers page (confirmed by its own <title>)
    // failed this check because it used phrasing like "open roles"/"join the team" rather than the
    // narrower set originally listed — all additions remain career/hiring-specific (low
    // false-positive risk), just less brittle about exact wording.
    contentTerms: /open\s+(position|role)s?|we.?re\s+hiring|join\s+(our|the)\s+team|current\s+opening|we.?re\s+growing|life\s+at\s|open\s+roles?/i,
    probePath: "/careers",
    knownHosts: [/(^|\.)boards\.greenhouse\.io$/, /(^|\.)job-boards\.greenhouse\.io$/, /(^|\.)jobs\.lever\.co$/, /(^|\.)jobs\.ashbyhq\.com$/],
  },
};

/** Pre-launch/waitlist markers on the homepage itself — see resolve.ts for how this combines with
 * "none of the 5 pages present" at the RULE level (rules/website.ts), not here. This module only
 * detects the textual marker. */
export const PRELAUNCH_MARKER_PATTERN =
  /coming\s+soon|join\s+(the\s+)?waitlist|early\s+access|request\s+(an\s+)?invite|sign\s+up\s+for\s+early\s+access|notify\s+me\s+when|we.?re\s+launching\s+soon|be\s+the\s+first\s+to\s+know/i;

/** Cloudflare/bot-challenge markers — status is checked separately (usually 403/503, sometimes a
 * "soft" 200 challenge page), this only recognizes the challenge PAGE content itself. */
export const BOT_CHALLENGE_PATTERN = /checking\s+your\s+browser|cf-chl|just\s+a\s+moment|attention\s+required.*cloudflare|verify\s+you\s+are\s+human/i;
