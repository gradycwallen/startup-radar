import { candidateDomains } from "../domains.ts";
import { parseFeed } from "../feed.ts";
import { htmlToText } from "../html.ts";
import { makeItem } from "../item.ts";
import type { SourceContext, SourceItem, SourceProvider } from "../types.ts";

export interface GoogleQuery {
  q: string;
  lane: string;
}

/**
 * Generic, lane-tagged queries (no company names, ever). Sector variants widen coverage because each query returns at
 * most ~100 items; that is a coverage strategy, not tuning to particular companies.
 */
export const GOOGLE_QUERIES: readonly GoogleQuery[] = [
  { q: "raises seed round", lane: "funding" },
  { q: "raises pre-seed funding", lane: "funding" },
  { q: "raises Series A", lane: "funding" },
  { q: "closes seed funding round startup", lane: "funding" },
  { q: "secures funding AI startup", lane: "funding" },
  { q: "raises seed fintech", lane: "funding" },
  { q: "raises seed healthtech biotech", lane: "funding" },
  { q: "raises seed climate energy startup", lane: "funding" },
  { q: "raises seed cybersecurity", lane: "funding" },
  { q: "raises seed SaaS software startup", lane: "funding" },
  { q: "raises seed robotics hardware", lane: "funding" },
  { q: "raises funding Europe startup", lane: "funding" },
  { q: "emerges from stealth", lane: "stealth" },
  { q: "exits stealth mode funding", lane: "stealth" },
  { q: "startup launches new product", lane: "launches" },
  { q: "startup unveils platform launch", lane: "launches" },
  { q: "accelerator cohort announced startups", lane: "accelerator" },
  { q: "demo day startups selected", lane: "accelerator" },
];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Google News RSS search as a GAP-FILLER for publishers whose own feeds are blocked or paywalled. It is unofficial and
 * returns aggregator redirect links, so it is trusted less than a publisher feed. The query window uses Google's
 * `after:`/`before:` operators relative to the run's as-of date.
 */
export class GoogleNewsProvider implements SourceProvider {
  readonly kind = "google-news" as const;
  readonly id = "google-news";
  readonly description = "Google News RSS search (gap-filler, unofficial)";
  readonly reliability = 0.5;

  constructor(private readonly queries: readonly GoogleQuery[] = GOOGLE_QUERIES) {}

  urlFor(query: GoogleQuery, asOf: Date, windowDays: number): string {
    const after = new Date(asOf.getTime() - windowDays * 86_400_000);
    const before = new Date(asOf.getTime() + 86_400_000);
    const q = `${query.q} after:${ymd(after)} before:${ymd(before)}`;
    return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  }

  async fetchItems(ctx: SourceContext): Promise<SourceItem[]> {
    const fetchedAt = new Date();
    const byKey: Array<SourceItem> = [];
    const index: Record<string, SourceItem> = {};
    for (const query of this.queries) {
      if (ctx.signal.aborted) break;
      const res = await ctx.fetcher.getText(this.urlFor(query, ctx.asOf, ctx.windowDays), { provider: this.id, signal: ctx.signal }).catch(() => null);
      if (!res || res.status !== 200) continue;
      for (const e of parseFeed(res.text).entries) {
        const publisher = e.sourceName;
        // Google appends " - Publisher" to every headline; the real headline is what precedes it.
        let title = htmlToText(e.title, 300);
        if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3)).trimEnd();
        const item = makeItem({
          provider: this.id, kind: "google-news", lane: query.lane, title, url: e.link, url_kind: "redirect", source_name: publisher,
          published_at: e.published, excerpt: "", outbound_domains: candidateDomains([]), tags: [query.q], fetchedAt,
        });
        if (!item) continue;
        const existing = index[item.item_id];
        if (existing) {
          if (!existing.tags.includes(query.q)) existing.tags.push(query.q);
        } else {
          index[item.item_id] = item;
          byKey.push(item);
        }
      }
    }
    return byKey;
  }
}
