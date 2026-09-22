/**
 * Soft-404 protection (V2-2B.2 design report §6/§11/§18). A real HTTP 404/410 is trivially
 * detected without any baseline. The harder case is a "soft 404": HTTP 200 with a custom
 * not-found page — common on marketing sites (Webflow, Framer, Next.js custom 404s), which would
 * otherwise be misread as "the page exists." Fetching one deliberately nonexistent path per
 * company gives a concrete baseline to compare candidate pages against.
 */

/** Deliberately unusual/stable path — vanishingly unlikely to collide with a real route, and
 * fixed (not random) so a baseline fetch is reproducible in tests/replays. */
export const SOFT_404_PROBE_PATH = "/startup-radar-soft-404-check-9f3d1a";

const NOT_FOUND_TEXT = /\b(404|not\s+found|page\s+(doesn.?t\s+exist|is\s+missing|could\s+not\s+be\s+found))\b/i;

export interface PageSignature {
  status: number;
  title: string | null;
  h1: string | null;
}

/**
 * True when a candidate page's response looks like the SAME soft-404 template as the baseline —
 * or independently looks like a not-found page on its own (a custom 404 whose title/H1 says so,
 * even without a baseline to compare against). Never true for a real 404/410 status alone here;
 * callers already treat those as absent directly (see resolve.ts) — this function exists
 * specifically for the "200 but really absent" case.
 */
export function looksLikeSoft404(candidate: PageSignature, baseline: PageSignature | null): boolean {
  if (candidate.status < 200 || candidate.status >= 300) return false; // not the "soft" case this function targets
  if (candidate.h1 && NOT_FOUND_TEXT.test(candidate.h1)) return true;
  if (candidate.title && NOT_FOUND_TEXT.test(candidate.title)) return true;
  if (!baseline || baseline.status < 200 || baseline.status >= 300) return false;
  if (candidate.title && baseline.title && candidate.title === baseline.title) return true;
  if (candidate.h1 && baseline.h1 && candidate.h1 === baseline.h1) return true;
  return false;
}
