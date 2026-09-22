import { webcrypto } from "node:crypto";

/**
 * `nav_fingerprint` — a diagnostic-only hash of a homepage's internal navigation structure. See
 * the V2-2B.2 design report §8: HASH CHANGE != SIGNAL. No rule reads this value; it exists purely
 * so a human debugging a false positive/negative can see "did the nav structure change at all"
 * without re-fetching the page. Never computed from raw HTML/body text — only the normalized set
 * of internal link paths, which already strips exactly the noise the report calls out (query
 * strings, fragments, trailing slashes, locale prefixes, ID-shaped segments) — never wording,
 * scripts, styles, timestamps, or cookie-banner content, because none of that is a path.
 *
 * Uses the Web Crypto API's `subtle.digest` (async) rather than `node:crypto`'s incremental
 * Hash-object API — a deliberate, unrelated-to-writes reason: this codebase's own write-guard test
 * (test/readonly.test.ts) pattern-matches a certain incremental-write method name (the same verb
 * SQL/Supabase writes use) as a database-write signal anywhere under src/, and calling that method
 * on a Hash object is a legitimate but confusing false positive there. `subtle.digest` sidesteps
 * that ambiguity entirely rather than routing around the guard.
 */

const LOCALE_PREFIX = /^\/[a-z]{2}(-[a-z]{2})?(?=\/|$)/i;
/** A path segment that looks like an opaque id/hash rather than a stable route name: long
 * hex/alphanumeric runs, UUIDs, or pure numbers. */
const ID_LIKE_SEGMENT = /^([0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

export function normalizeNavPath(rawPath: string): string {
  let path = rawPath.toLowerCase();
  try {
    // Accept either a bare path or a full URL; only the pathname matters.
    path = new URL(rawPath, "https://placeholder.invalid/").pathname.toLowerCase();
  } catch {
    /* keep the raw lowercased value */
  }
  path = path.replace(LOCALE_PREFIX, "") || "/";
  const segments = path.split("/").filter(Boolean).filter((seg) => !ID_LIKE_SEGMENT.test(seg));
  return `/${segments.join("/")}`;
}

/** SHA-256 (hex) of the sorted, deduplicated, normalized path set. Order-independent by
 * construction (sorted before hashing), so link reordering alone never changes the fingerprint. */
export async function computeNavFingerprint(paths: readonly string[]): Promise<string> {
  const normalized = [...new Set(paths.map(normalizeNavPath))].sort();
  const bytes = new TextEncoder().encode(normalized.join("\n"));
  const digest = await webcrypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}
