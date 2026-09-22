import type { Logger } from "../log.ts";
import type { Fetcher } from "./fetcher.ts";

/**
 * The normalized unit every source provider produces. A SourceItem is one retrieved piece of source
 * material (an article, a directory row, a cohort-page entry). Deterministic extraction turns items
 * into raw leads (company mentions); an item may yield zero, one or many leads.
 */
export interface SourceItem {
  /** Stable id: hash of provider + url + title. */
  item_id: string;
  /** Provider that produced it (e.g. "techcrunch-startups"). */
  provider: string;
  kind: SourceKind;
  /** The lane the provider/query targeted; leads are re-laned by the event type actually extracted. */
  lane: string;
  title: string;
  url: string;
  /** "article": a publisher page. "redirect": an aggregator redirect (Google News). "directory": a directory entry. */
  url_kind: "article" | "redirect" | "directory";
  /** Publisher or site name when known ("TechCrunch", "Y Combinator"). */
  source_name: string | null;
  /** ISO timestamp; null when the source does not date its items (directories). */
  published_at: string | null;
  /** Plain-text summary/excerpt, at most ~600 characters. */
  excerpt: string;
  /** Registrable domains linked from the item's content (publishers, socials and investors removed). */
  outbound_domains: string[];
  /** Structured fields for directory / cohort sources: the company is named explicitly, no guessing. */
  structured: StructuredFields | null;
  /** Provenance tags, e.g. the Google News queries that returned the item. */
  tags: string[];
  fetched_at: string;
}

export type SourceKind = "rss" | "google-news" | "directory" | "cohort-page";

export interface StructuredFields {
  company_name: string;
  website: string | null;
  description: string | null;
  program: string | null;
  batch: string | null;
  team_size?: number | null;
  industry?: string | null;
}

export interface SourceContext {
  /** The moment the run is "as of": items published after it do not exist yet for this run. */
  asOf: Date;
  windowDays: number;
  fetcher: Fetcher;
  signal: AbortSignal;
  log: Logger;
}

/**
 * A pluggable source of items. Providers are independent: each can be enabled, disabled, repaired or replaced
 * without touching the funnel. A provider must not throw for an unhealthy source; it returns what it could get
 * and lets the fetcher's statistics describe the failure (the funnel isolates a throwing provider anyway).
 */
export interface SourceProvider {
  readonly id: string;
  readonly kind: SourceKind;
  readonly description: string;
  /** Prior trust in the source, 0..1 (used by ranking). */
  readonly reliability: number;
  /** Items older than this many days are stale for this provider; undefined = use the run's window. */
  readonly maxAgeDays?: number;
  /** True for state-based sources (directories) whose items carry no event date. */
  readonly undated?: boolean;
  fetchItems(ctx: SourceContext): Promise<SourceItem[]>;
}

export type ProviderStatus = "ok" | "degraded" | "failed" | "stale" | "empty";

export interface ProviderHealth {
  provider: string;
  kind: SourceKind;
  status: ProviderStatus;
  requests: number;
  http_statuses: Record<string, number>;
  bytes: number;
  elapsed_ms: number;
  items_fetched: number;
  items_in_window: number;
  newest_item: string | null;
  oldest_item: string | null;
  /** Human-readable explanation of a non-ok status. */
  note: string | null;
}

export interface ProviderRun {
  provider: SourceProvider;
  items: SourceItem[];
  error: string | null;
}

export type { Logger };
