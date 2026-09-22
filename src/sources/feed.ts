import { XMLParser } from "fast-xml-parser";

export interface FeedEntry {
  title: string;
  link: string;
  guid: string | null;
  published: Date | null;
  summaryHtml: string;
  contentHtml: string;
  /** Publisher name when the feed states it per item (Google News <source>). */
  sourceName: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === "item" || name === "entry" || name === "link" || name === "category",
});

const text = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text((v as Record<string, unknown>)["#text"]);
  return "";
};

function parseDate(v: unknown): Date | null {
  const s = text(v).trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

function linkOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    // Atom: several <link rel=...>; prefer rel="alternate" (or none) with an href.
    const withHref = v.filter((l) => l && typeof l === "object" && (l as Record<string, unknown>)["@_href"]) as Array<Record<string, string>>;
    const alt = withHref.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? withHref[0];
    if (alt) return alt["@_href"] ?? "";
    return text(v[0]);
  }
  if (v && typeof v === "object") return text(v);
  return "";
}

/** Parse RSS 2.0 or Atom. Malformed input yields an empty list rather than an exception. */
export function parseFeed(xml: string): { title: string | null; entries: FeedEntry[] } {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { title: null, entries: [] };
  }
  const rss = doc.rss as { channel?: Record<string, unknown> } | undefined;
  const atom = doc.feed as Record<string, unknown> | undefined;
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
  const rawItems: Array<Record<string, unknown>> =
    (rss?.channel?.item as Array<Record<string, unknown>> | undefined) ??
    (atom?.entry as Array<Record<string, unknown>> | undefined) ??
    (rdf?.item as Array<Record<string, unknown>> | undefined) ??
    [];
  const title = text(rss?.channel?.title ?? atom?.title) || null;
  const entries: FeedEntry[] = [];
  for (const it of rawItems.slice(0, 500)) {
    const source = it.source;
    entries.push({
      title: text(it.title).trim(),
      link: linkOf(it.link).trim(),
      guid: text(it.guid ?? it.id) || null,
      published: parseDate(it.pubDate ?? it.published ?? it.updated ?? it["dc:date"]),
      summaryHtml: text(it.description ?? it.summary),
      contentHtml: text(it["content:encoded"] ?? it.content),
      sourceName: source ? text(source) || null : null,
    });
  }
  return { title, entries: entries.filter((e) => e.title || e.link) };
}
