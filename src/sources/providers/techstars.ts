import { normalizeDomain } from "../../domain.ts";
import { isNonCompanyDomain } from "../domains.ts";
import { parseHtml } from "../html.ts";
import { makeItem } from "../item.ts";
import type { SourceContext, SourceItem, SourceProvider } from "../types.ts";

export interface TechstarsCompany {
  name: string;
  website: string;
  description: string;
  program: string | null;
}

const NOT_A_COMPANY = /^(apply|apply today|learn more|read more|here|click here|website|visit|contact|newsroom|subscribe|share|sign up|techstars)\b/i;
const looksLikeDomain = (t: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/i.test(t.trim());

/**
 * Extract company entries from a Techstars newsroom page. Two formats occur:
 *  A) cohort announcement: `<p><strong>Aiir (</strong><a href="https://useaiir.com/">useaiir.com</a><strong>)</strong> - An AI platform...`
 *  B) class overview: `<li><a href="http://sunzu.ai"><strong>Sunzu</strong></a> is an on-demand user research layer...` under an
 *     `<h3>` program heading.
 * Names come from the page itself (never guessed); the website is the linked domain.
 */
export function parseTechstarsPage(html: string): TechstarsCompany[] {
  const root = parseHtml(html);
  const out: TechstarsCompany[] = [];
  const seen: string[] = [];
  let program: string | null = null;
  for (const el of root.querySelectorAll("h2,h3,li,p")) {
    const tag = el.tagName.toLowerCase();
    if (tag === "h2" || tag === "h3") {
      const t = el.text.replace(/\s+/g, " ").trim();
      if (/techstars|accelerator|cohort|class/i.test(t) && t.length < 120) program = t;
      continue;
    }
    // Only the element's own first external link counts (nested li/p would otherwise be counted twice).
    const anchor = el.querySelectorAll("a").find((a) => {
      const href = a.getAttribute("href") ?? "";
      const d = /^https?:/i.test(href) ? normalizeDomain(href) : null;
      return d !== null && !isNonCompanyDomain(d);
    });
    if (!anchor) continue;
    const href = anchor.getAttribute("href") ?? "";
    const domain = normalizeDomain(href);
    if (!domain) continue;
    const anchorText = anchor.text.replace(/\s+/g, " ").trim();
    const full = el.text.replace(/\s+/g, " ").trim();
    let name: string;
    if (looksLikeDomain(anchorText)) {
      // Format A: the name precedes "(" and the linked domain.
      name = (full.split("(")[0] ?? "").trim();
    } else {
      // Format B: the anchor text is the name.
      name = anchorText;
    }
    name = name.replace(/[:\-–—]+$/, "").trim();
    if (name.length < 2 || name.length > 60 || NOT_A_COMPANY.test(name) || /\s{2,}/.test(name)) continue;
    // A company entry has a description sentence; a bare link (share button, footer) does not.
    const rest = full.startsWith(name) ? full.slice(name.length) : full;
    const description = rest.replace(/^\s*(\(\s*[^)]*\)\s*)?[-–—:]?\s*/, "").trim();
    if (description.length < 20) continue;
    const key = `${name.toLowerCase()}|${domain}`;
    if (seen.includes(key)) continue;
    seen.push(key);
    out.push({ name, website: href, description: description.slice(0, 300), program });
  }
  return out;
}

const PUBLISHED = /article:published_time"\s+content="([^"]+)"|"datePublished":"([^"]+)"/;

/**
 * Techstars cohort announcements from the public newsroom. Discovers cohort/class pages from the newsroom index, fetches
 * them (bounded), and yields one structured item per company with its website domain.
 */
export class TechstarsProvider implements SourceProvider {
  readonly kind = "cohort-page" as const;
  readonly id = "techstars-cohorts";
  readonly description = "Techstars newsroom cohort/class announcements";
  readonly reliability = 0.9;
  readonly maxAgeDays: number;

  constructor(private readonly options: { indexUrl?: string; maxPages?: number; maxAgeDays?: number } = {}) {
    this.maxAgeDays = options.maxAgeDays ?? 45;
  }

  async fetchItems(ctx: SourceContext): Promise<SourceItem[]> {
    const index = this.options.indexUrl ?? "https://www.techstars.com/newsroom";
    const res = await ctx.fetcher.getText(index, { provider: this.id, signal: ctx.signal, accept: "text/html" });
    if (res.status !== 200) return [];
    const origin = new URL(index).origin;
    const links: string[] = [];
    for (const a of parseHtml(res.text).querySelectorAll("a")) {
      const href = a.getAttribute("href") ?? "";
      // Only cohort/class announcements list companies; partnership, award and event posts link to unrelated organizations.
      if (/^\/newsroom\/[^/#?]+$/.test(href) && /(class|cohort)/i.test(href) && !links.includes(href)) links.push(href);
    }
    const items: SourceItem[] = [];
    const fetchedAt = new Date();
    for (const path of links.slice(0, this.options.maxPages ?? 14)) {
      if (ctx.signal.aborted) break;
      const url = `${origin}${path}`;
      const page = await ctx.fetcher.getText(url, { provider: this.id, signal: ctx.signal, accept: "text/html" }).catch(() => null);
      if (!page || page.status !== 200) continue;
      const m = PUBLISHED.exec(page.text);
      const published = m ? new Date(m[1] ?? m[2] ?? "") : null;
      if (!published || Number.isNaN(published.getTime())) continue; // undated pages cannot be placed in time
      if (published.getTime() > ctx.asOf.getTime() + 86_400_000 - 1) continue; // published after this run's as-of day
      if (ctx.asOf.getTime() - published.getTime() > this.maxAgeDays * 86_400_000) continue;
      for (const c of parseTechstarsPage(page.text)) {
        const site = normalizeDomain(c.website);
        const item = makeItem({
          provider: this.id, kind: "cohort-page", lane: "accelerator", title: `${c.name}: ${c.program ?? "Techstars cohort"}`, url, url_kind: "article",
          source_name: "Techstars", published_at: published, excerpt: c.description, outbound_domains: site ? [site] : [],
          structured: { company_name: c.name, website: c.website, description: c.description, program: c.program, batch: null },
          tags: [path], fetchedAt,
        });
        if (item) items.push(item);
      }
    }
    return items;
  }
}
