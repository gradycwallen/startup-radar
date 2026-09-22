import { hash } from "node:crypto";
import { normalizeUrl } from "../domain.ts";
import type { SourceItem, StructuredFields, SourceKind } from "./types.ts";

export interface ItemInput {
  provider: string;
  kind: SourceKind;
  lane: string;
  title: string;
  url: string;
  url_kind: SourceItem["url_kind"];
  source_name: string | null;
  published_at: Date | string | null;
  excerpt?: string;
  outbound_domains?: string[];
  structured?: StructuredFields | null;
  tags?: string[];
  fetchedAt: Date;
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Build a SourceItem with a stable id and normalized URL. Returns null when there is nothing usable (no title or URL). */
export function makeItem(input: ItemInput): SourceItem | null {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title || !input.url) return null;
  const url = input.url_kind === "redirect" ? input.url.trim() : (normalizeUrl(input.url) ?? input.url.trim());
  const published = input.published_at instanceof Date ? input.published_at.toISOString() : input.published_at;
  return {
    item_id: hash("sha1", `${input.provider}|${url}|${title}`, "hex").slice(0, 12),
    provider: input.provider,
    kind: input.kind,
    lane: input.lane,
    title: cap(title, 300),
    url,
    url_kind: input.url_kind,
    source_name: input.source_name,
    published_at: published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : null,
    excerpt: cap((input.excerpt ?? "").replace(/\s+/g, " ").trim(), 600),
    outbound_domains: input.outbound_domains ?? [],
    structured: input.structured ?? null,
    tags: input.tags ?? [],
    fetched_at: input.fetchedAt.toISOString(),
  };
}
