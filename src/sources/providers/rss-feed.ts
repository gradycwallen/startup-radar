import { normalizeDomain } from "../../domain.ts";
import { candidateDomains } from "../domains.ts";
import { parseFeed } from "../feed.ts";
import { extractLinks, htmlToText } from "../html.ts";
import { makeItem } from "../item.ts";
import type { SourceContext, SourceItem, SourceProvider } from "../types.ts";

export interface FeedDef {
  id: string;
  /** Publisher name shown as the item's source. */
  name: string;
  url: string;
  reliability: number;
  /** Lane hint for items whose event type cannot be extracted. */
  lane: string;
  description: string;
}

/**
 * The startup/news RSS registry. Each entry is one independent provider instance: add, remove or repair a feed
 * by editing one line. Verified reachable on 2026-09-21; FinSMEs and FinTech Futures (Cloudflare 403) and
 * VentureBeat (429) are deliberately absent, and Google News covers their headlines instead.
 */
export const FEED_REGISTRY: readonly FeedDef[] = [
  { id: "techcrunch-startups", name: "TechCrunch", url: "https://techcrunch.com/category/startups/feed/", reliability: 0.9, lane: "news", description: "TechCrunch: Startups" },
  { id: "techcrunch-venture", name: "TechCrunch", url: "https://techcrunch.com/category/venture/feed/", reliability: 0.9, lane: "funding", description: "TechCrunch: Venture" },
  { id: "tech-eu", name: "Tech.eu", url: "https://tech.eu/feed/", reliability: 0.8, lane: "news", description: "Tech.eu: European tech and funding news" },
  { id: "eu-startups", name: "EU-Startups", url: "https://www.eu-startups.com/feed/", reliability: 0.8, lane: "news", description: "EU-Startups: European startup news" },
  { id: "arcticstartup", name: "ArcticStartup", url: "https://arcticstartup.com/feed/", reliability: 0.75, lane: "news", description: "ArcticStartup: Nordic and Baltic startups" },
  { id: "sifted", name: "Sifted", url: "https://sifted.eu/feed", reliability: 0.85, lane: "news", description: "Sifted: European startups (excerpt-only feed)" },
  { id: "prnewswire-vc", name: "PR Newswire", url: "https://www.prnewswire.com/rss/financial-services-latest-news/venture-capital-list.rss", reliability: 0.85, lane: "funding", description: "PR Newswire: Venture Capital releases" },
];

/** One RSS/Atom feed. */
export class RssFeedProvider implements SourceProvider {
  readonly kind = "rss" as const;
  readonly id: string;
  readonly description: string;
  readonly reliability: number;

  constructor(private readonly def: FeedDef) {
    this.id = def.id;
    this.description = def.description;
    this.reliability = def.reliability;
  }

  async fetchItems(ctx: SourceContext): Promise<SourceItem[]> {
    const res = await ctx.fetcher.getText(this.def.url, { provider: this.id, signal: ctx.signal });
    if (res.status !== 200) return [];
    const { entries } = parseFeed(res.text);
    const ownHost = normalizeDomain(this.def.url) ?? "";
    const fetchedAt = new Date();
    const items: SourceItem[] = [];
    for (const e of entries) {
      const body = e.contentHtml || e.summaryHtml;
      const item = makeItem({
        provider: this.id, kind: "rss", lane: this.def.lane, title: htmlToText(e.title, 300), url: e.link, url_kind: "article",
        source_name: this.def.name, published_at: e.published, excerpt: htmlToText(body, 600),
        outbound_domains: candidateDomains(extractLinks(body, e.link), [ownHost, normalizeDomain(e.link) ?? ""]),
        fetchedAt,
      });
      if (item) items.push(item);
    }
    return items;
  }
}
