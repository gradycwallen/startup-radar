import { parse, type HTMLElement } from "node-html-parser";

export function parseHtml(html: string): HTMLElement {
  return parse(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
}

/** Visible text of an HTML fragment, whitespace-collapsed and capped. */
export function htmlToText(html: string, maxChars = 600): string {
  if (!html) return "";
  const root = parseHtml(html);
  for (const el of root.querySelectorAll("script,style,noscript")) el.remove();
  const t = root.text.replace(/\s+/g, " ").trim();
  return t.length > maxChars ? `${t.slice(0, maxChars - 1).trimEnd()}…` : t;
}

export interface HtmlLink {
  href: string;
  text: string;
}

/** Absolute http(s) links found in an HTML fragment. */
export function extractLinks(html: string, base?: string): HtmlLink[] {
  if (!html) return [];
  const out: HtmlLink[] = [];
  for (const a of parseHtml(html).querySelectorAll("a")) {
    const raw = a.getAttribute("href");
    if (!raw) continue;
    try {
      const u = new URL(raw, base);
      if (u.protocol === "http:" || u.protocol === "https:") out.push({ href: u.href, text: a.text.replace(/\s+/g, " ").trim() });
    } catch {
      /* skip unparseable href */
    }
  }
  return out;
}
