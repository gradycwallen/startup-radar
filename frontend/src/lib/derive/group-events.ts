import type { DiscoveryEvent } from "../data/types";

/** A cluster of discovery_events that almost certainly describe the SAME underlying real-world
 * event. `primary` is the highest-confidence event in the group (shown expanded); `events` is
 * every event in the group, primary included, highest confidence first. */
export interface EventGroup {
  primary: DiscoveryEvent;
  events: DiscoveryEvent[];
}

/**
 * Groups discovery_events that are almost certainly the SAME underlying event — e.g. one funding
 * round covered by five outlets, or the original PR Newswire release and Google News' own
 * redirect copy of it. Backend discovery is intentionally conservative and keeps every distinct
 * source_url as its own row (root CLAUDE.md §5C: "independent evidence from multiple sources
 * [is] never collapsed into one record") — this is presentation-only grouping over already-correct
 * data; it changes nothing about what Scout persists.
 *
 * Grouping is deliberately conservative: two events are only merged when there is a concrete,
 * extractable signal that they describe the same fact — never by loose text similarity across
 * differently-worded headlines (real headlines for the same story, written by different outlets,
 * can share very few words). Two signals are tried, in order, and the first one either event
 * supports is used:
 *   1. Same event_type + same event_date + the same dollar amount, extracted from `description`.
 *      Every funding event's description is built server-side from the SAME normalized
 *      $X.XM/$X.XB figure (src/discovery/accept.ts in the repo root), so an exact match here is
 *      strong evidence of the same round — this is by far the most common real duplicate.
 *   2. Same event_type + same event_date + an EXACT normalized-headline match, for events with no
 *      extractable amount (product launches, stealth, accelerator news, etc.).
 * An event with no event_date, or that matches neither signal, is left standalone. Under-grouping
 * (showing two similar-looking items separately) is preferred over over-grouping (silently
 * merging two genuinely different events) — the same conservatism the backend already applies
 * elsewhere (never fabricate, never guess) applies here too. One known, accepted consequence: the
 * same round reported with slightly different amounts by different outlets (e.g. an early report
 * of "$3.3M" vs. the confirmed "$3.8M") will NOT be merged — a real, disclosed trade-off, not a bug.
 */
export function groupEvents(events: DiscoveryEvent[]): EventGroup[] {
  const buckets: { key: string; members: DiscoveryEvent[] }[] = [];
  const byKey = new Map<string, { key: string; members: DiscoveryEvent[] }>();

  for (const event of events) {
    const key = groupKey(event);
    const existing = key ? byKey.get(key) : undefined;
    if (existing) {
      existing.members.push(event);
      continue;
    }
    const bucket = { key: key ?? `standalone-${event.id}`, members: [event] };
    if (key) byKey.set(key, bucket);
    buckets.push(bucket);
  }

  return buckets.map(({ members }) => {
    const sorted = [...members].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    return { primary: sorted[0]!, events: sorted };
  });
}

function groupKey(event: DiscoveryEvent): string | null {
  if (!event.eventDate) return null; // no date is too weak a signal to safely group on
  const amount = extractAmountSignature(event.description);
  if (amount !== null) return `${event.eventType}|${event.eventDate}|amount:${amount}`;
  const headline = normalizeHeadline(event.headline);
  if (headline) return `${event.eventType}|${event.eventDate}|headline:${headline}`;
  return null;
}

/** Extracts a normalized whole-dollar figure from a "$X.XM"/"$X.XB"/"$X.XK"-style substring, as
 * produced by the backend's own description text. Returns null when no such figure is present —
 * never guesses a number from prose. */
function extractAmountSignature(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/\$\s?([\d,]+(?:\.\d+)?)\s?([MBK])?/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!.replace(/,/g, ""));
  if (Number.isNaN(value)) return null;
  const unit = match[2]?.toUpperCase();
  const multiplier = unit === "B" ? 1_000_000_000 : unit === "K" ? 1_000 : unit === "M" ? 1_000_000 : 1;
  return Math.round(value * multiplier);
}

/** Exact-match normalization only (lowercase, strip punctuation, collapse whitespace) — no fuzzy
 * matching. Different outlets' headlines for the same story vary too much in wording for a
 * similarity threshold to be a trustworthy signal on its own. */
function normalizeHeadline(headline: string | null): string | null {
  if (!headline) return null;
  const normalized = headline.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}
