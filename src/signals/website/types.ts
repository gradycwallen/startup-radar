/**
 * V2-2B.2 — website structural monitoring. Types shared across robots/fingerprint/patterns/resolve.
 * Deliberately its own directory (src/signals/website/), same discipline as src/signals/sources/ats/:
 * a self-contained, pure, deterministic library with no database/CLI concerns.
 */

/** The five semantic page types tracked. `docs` was considered and explicitly deferred — see the
 * V2-2B.2 design report §3/§21. Careers is included but is LOW TIER (see rules/website.ts). */
export const PAGE_TYPES = ["pricing", "enterprise", "security", "customers", "careers"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** The primary outcome of one website pass — always recorded, even on failure (see
 * observe.ts/sources/website.ts: the "website_fetch_outcome" metric is written every pass so a
 * down site gets naturally re-checked, and so freshness.ts can classify transient vs. stable
 * failure). "ok" is the only outcome from which page states can be resolved. */
export const FETCH_OUTCOMES = [
  "ok", "spa_shell", "blocked", "robots_denied", "timeout", "dns_failure", "http_5xx", "non_html", "offdomain_redirect",
] as const;
export type FetchOutcome = (typeof FETCH_OUTCOMES)[number];

/** present/absent must both be EARNED (see resolve.ts); "unknown" is the default and the only
 * honest answer when evidence is insufficient — never inferred, never defaulted away. */
export type PageState = "present" | "absent" | "unknown";

/** How a page's state was determined — kept for provenance/debugging (observations.metadata),
 * never used to weight the resulting signal. */
export type PageResolutionMethod = "nav_link" | "sitemap" | "known_host" | "probe" | null;

export interface PageEvidence {
  state: PageState;
  /** Resolved path (present) or probed path (absent), when applicable. */
  path: string | null;
  finalUrl: string | null;
  status: number | null;
  how: PageResolutionMethod;
  /** Short evidence tags, e.g. ["not_homepage","not_soft404","content:pricing_terms"] — see the
   * design report §7. Never raw HTML. */
  checks: string[];
  title: string | null;
  h1: string | null;
}

export function unknownPage(): PageEvidence {
  return { state: "unknown", path: null, finalUrl: null, status: null, how: null, checks: [], title: null, h1: null };
}

export interface WebsitePassResult {
  outcome: FetchOutcome;
  homepageFinalUrl: string | null;
  homepageStatus: number | null;
  /** `<html lang="...">`, lowercased, when present. Null when absent/unparseable — treated as
   * "unspecified", which is NOT the same as "known non-English" (see resolve.ts's absence rule). */
  lang: string | null;
  navLinkCount: number | null;
  /** SHA-256 of the normalized internal-link path set — diagnostic only, never a signal trigger
   * (see the design report §8: HASH CHANGE != SIGNAL). */
  navFingerprint: string | null;
  /** True/false only when the homepage was `ok`; null (unknown) otherwise. Never inferred from a
   * failed fetch. */
  prelaunch: boolean | null;
  pages: Record<PageType, PageEvidence>;
  requestsUsed: number;
  /** Every URL actually fetched this pass, for observability/testing (mirrors resolution.ts's
   * `pagesChecked`). */
  pagesChecked: string[];
}

export function emptyPages(): Record<PageType, PageEvidence> {
  return { pricing: unknownPage(), enterprise: unknownPage(), security: unknownPage(), customers: unknownPage(), careers: unknownPage() };
}
