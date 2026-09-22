import { normalizeDomain } from "../../domain.ts";
import { extractLinks, htmlToText, parseHtml } from "../../sources/html.ts";

/**
 * Small, deterministic HTML field extraction for website monitoring — built on the SAME parser
 * (`node-html-parser`, via src/sources/html.ts) V2-1's funnel already uses, not a new dependency.
 * Extracts only normalized, structural fields (title/H1/lang/visible-text length/link paths) —
 * never raw HTML, never a body-text dump. See the V2-2B.2 design report §7/§14.
 */

export interface ExtractedPage {
  title: string | null;
  h1: string | null;
  /** Lowercased `<html lang="...">` value, or null when absent/unparseable. */
  lang: string | null;
  /** Whitespace-collapsed visible text, capped (used for content-term checks and SPA-shell
   * detection's length heuristic — never stored in full). */
  visibleText: string;
  /** Internal same-registrable-domain link paths (deduplicated), for nav_fingerprint and
   * page-candidate scanning. */
  internalPaths: string[];
  /** All absolute http(s) links found, with their visible anchor text — page-type candidate
   * scanning needs both the URL and the text. */
  links: { href: string; text: string }[];
}

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const LANG_RE = /<html[^>]*\blang=["']([a-zA-Z-]+)["']/i;

function clipTo(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

export function extractPageFields(html: string, baseUrl: string): ExtractedPage {
  const title = clipTo((TITLE_RE.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim(), 200) || null;
  const lang = (LANG_RE.exec(html)?.[1] ?? "").toLowerCase().split("-")[0] || null;

  const root = parseHtml(html);
  const h1El = root.querySelector("h1");
  const h1 = h1El ? clipTo(h1El.text.replace(/\s+/g, " ").trim(), 200) || null : null;

  const visibleText = htmlToText(html, 4000);

  const links = extractLinks(html, baseUrl);
  const baseDomain = normalizeDomain(baseUrl);
  const internalPaths: string[] = [];
  for (const link of links) {
    let u: URL;
    try {
      u = new URL(link.href);
    } catch {
      continue;
    }
    if (baseDomain && normalizeDomain(link.href) === baseDomain) internalPaths.push(u.pathname);
  }

  return { title, h1, lang, visibleText, internalPaths: [...new Set(internalPaths)], links };
}

/** Content-type sniff for when a real `Content-Type` header isn't available (some fixtures/tests):
 * a page is treated as HTML if it declares itself as such, or failing that, actually looks like
 * markup. Never treats plain JSON/XML/text as HTML. */
export function looksLikeHtml(contentType: string | undefined, text: string): boolean {
  if (contentType) return /html/i.test(contentType);
  return /<html[\s>]/i.test(text) || /<!doctype\s+html/i.test(text);
}
