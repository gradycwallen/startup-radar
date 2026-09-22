import { normalizeDomain } from "../../domain.ts";
import { makeItem } from "../item.ts";
import type { SourceContext, SourceItem, SourceProvider } from "../types.ts";

interface YcCompany {
  name?: string;
  website?: string;
  one_liner?: string;
  long_description?: string;
  batch?: string;
  status?: string;
  team_size?: number | null;
  industry?: string;
  url?: string;
}

const SEASON_ORDER: Record<string, number> = { winter: 1, spring: 2, summer: 3, fall: 4 };

/** "summer-2026" -> sortable number; unknown shapes -> null. */
export function batchRank(slug: string): number | null {
  const m = /^(winter|spring|summer|fall)-(\d{4})$/.exec(slug);
  return m ? Number(m[2]) * 10 + (SEASON_ORDER[m[1] as string] ?? 0) : null;
}

/** Approximate first day of a batch's season, so batches that have not started yet can be excluded. */
export function batchStart(slug: string): Date | null {
  const m = /^(winter|spring|summer|fall)-(\d{4})$/.exec(slug);
  if (!m) return null;
  const month = { winter: 0, spring: 3, summer: 5, fall: 8 }[m[1] as "winter" | "spring" | "summer" | "fall"];
  return new Date(Date.UTC(Number(m[2]), month, 1));
}

/** Batches with fewer companies than this are pre-announced placeholders (the mirror lists future batches with 1-2 entries). */
const MIN_BATCH_SIZE = 20;

/**
 * Y Combinator's public company directory, via the community-run yc-oss JSON mirror. Structured: each row names the
 * company and gives its website, so the domain is not guessed. Directory rows carry no event date (`launched_at` is the
 * profile's creation time), so the items are undated and represent current batch membership.
 */
export class YcDirectoryProvider implements SourceProvider {
  readonly kind = "directory" as const;
  readonly id = "yc-directory";
  readonly description = "Y Combinator directory (yc-oss mirror), latest batches";
  readonly reliability = 0.95;
  readonly undated = true;

  constructor(private readonly options: { latestBatches?: number; maxItems?: number; baseUrl?: string } = {}) {}

  async fetchItems(ctx: SourceContext): Promise<SourceItem[]> {
    const base = this.options.baseUrl ?? "https://yc-oss.github.io/api";
    const meta = await ctx.fetcher.getText(`${base}/meta.json`, { provider: this.id, signal: ctx.signal, accept: "application/json" });
    if (meta.status !== 200) return [];
    let batches: Record<string, { name?: string; count?: number }> = {};
    try {
      batches = (JSON.parse(meta.text) as { batches?: Record<string, { name?: string; count?: number }> }).batches ?? {};
    } catch {
      return [];
    }
    // Only real batches: big enough to be a batch, and already started as of the run's date.
    const wanted = Object.keys(batches)
      .map((slug) => ({ slug, rank: batchRank(slug), start: batchStart(slug), count: batches[slug]?.count ?? 0 }))
      .filter((b): b is { slug: string; rank: number; start: Date; count: number } => b.rank !== null && b.start !== null && b.count >= MIN_BATCH_SIZE && b.start.getTime() <= ctx.asOf.getTime())
      .sort((a, b) => b.rank - a.rank)
      .slice(0, this.options.latestBatches ?? 2);
    const items: SourceItem[] = [];
    const fetchedAt = new Date();
    const max = this.options.maxItems ?? 600;
    for (const { slug } of wanted) {
      const res = await ctx.fetcher.getText(`${base}/batches/${slug}.json`, { provider: this.id, signal: ctx.signal, accept: "application/json" });
      if (res.status !== 200) continue;
      let rows: YcCompany[] = [];
      try {
        rows = JSON.parse(res.text) as YcCompany[];
      } catch {
        continue;
      }
      for (const c of rows) {
        if (items.length >= max) break;
        if (!c.name || c.status === "Inactive") continue;
        const site = c.website ? normalizeDomain(c.website) : null;
        const item = makeItem({
          provider: this.id, kind: "directory", lane: "accelerator", title: `${c.name}: joins Y Combinator ${c.batch ?? batches[slug]?.name ?? slug}`,
          url: c.url ?? `https://www.ycombinator.com/companies/${encodeURIComponent(c.name.toLowerCase())}`, url_kind: "directory", source_name: "Y Combinator",
          published_at: null, excerpt: c.one_liner ?? c.long_description ?? "", outbound_domains: site ? [site] : [],
          structured: { company_name: c.name, website: c.website ?? null, description: c.one_liner ?? null, program: "Y Combinator", batch: c.batch ?? batches[slug]?.name ?? slug, team_size: c.team_size ?? null, industry: c.industry ?? null },
          tags: [slug], fetchedAt,
        });
        if (item) items.push(item);
      }
    }
    return items;
  }
}
