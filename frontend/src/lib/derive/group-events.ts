import type { DiscoveryEvent } from "../data/types";

/** A cluster of discovery_events that almost certainly describe the SAME underlying real-world
 * event. `primary` is the highest-confidence event in the group (shown expanded); `events` is
 * every event in the group, primary included, highest confidence first. */
export interface EventGroup {
  primary: DiscoveryEvent;
  events: DiscoveryEvent[];
}

/** How many calendar days apart two events' event_date may be and still be considered candidates
 * for the same group — e.g. a funding round reported on Sep 21 by one outlet and Sep 22 by
 * another (a real case: Corridor's $25M seed). Deliberately small (1 day): this is a tolerance for
 * outlets publishing a day apart on the SAME confirmed fact, not a fuzzy "roughly around the same
 * time" window — every other condition below is still an EXACT match. */
const MAX_CROSS_DATE_GAP_DAYS = 1;

/**
 * Groups discovery_events that are almost certainly the SAME underlying event — e.g. one funding
 * round covered by five outlets across two adjacent publish dates, or the original PR Newswire
 * release and Google News' own redirect copy of it. Backend discovery is intentionally
 * conservative and keeps every distinct source_url as its own row (root CLAUDE.md §5C:
 * "independent evidence from multiple sources [is] never collapsed into one record") — this is
 * presentation-only grouping over already-correct data; it changes nothing about what Scout
 * persists.
 *
 * Grouping is deliberately conservative: two events are only merged when there is a concrete,
 * EXACT, extractable signal that they describe the same fact — never by fuzzy text similarity
 * across differently-worded headlines (real headlines for the same story, written by different
 * outlets, can share very few words). Two events merge (`shouldMerge` below) only when ALL of:
 *   1. The same event_type.
 *   2. event_date within `MAX_CROSS_DATE_GAP_DAYS` of each other (both events must have a date at
 *      all — an undated event is too weak a signal to safely group on).
 *   3. EITHER: for a `funding` event, the SAME dollar amount extracted from `description` (every
 *      funding event's description is built server-side from the SAME normalized $X.XM/$X.XB
 *      figure — src/discovery/accept.ts in the repo root — so an exact match here is strong
 *      evidence of the same round; this is by far the most common real duplicate) — a funding
 *      event with no extractable amount falls back to rule 4 below, same as any other event type;
 *   4. OR: an EXACT normalized-headline match (product launches, stealth, accelerator news, a
 *      funding event with no disclosed amount, etc.).
 * An event that matches neither signal 3 nor 4 against anything already grouped starts its own
 * new group. Under-grouping (showing two similar-looking items separately) is preferred over
 * over-grouping (silently merging two genuinely different events) — the same conservatism the
 * backend already applies elsewhere (never fabricate, never guess) applies here too. Two known,
 * disclosed consequences, not bugs: the same round reported with genuinely different amounts by
 * different outlets (e.g. an early report of "$3.3M" vs. the confirmed "$3.8M") is NOT merged; and
 * two real, distinct events of the same type more than a day apart are never merged even if later
 * evidence would eventually connect them.
 *
 * Implementation note: grouping is anchored, not chained. A new event joins the FIRST group whose
 * anchor (that group's very first, and therefore chronologically latest, member — events arrive
 * pre-sorted newest-first) it matches — it is never merged in merely because it matches some OTHER
 * member added later. This keeps a group's date span bounded to `MAX_CROSS_DATE_GAP_DAYS` from one
 * fixed reference point, rather than letting a chain of adjacent-day matches drift across many days
 * (event A merges with B, B merges with C, so A and C end up grouped despite being 3+ days apart).
 */
export function groupEvents(events: DiscoveryEvent[]): EventGroup[] {
  const buckets: { anchor: DiscoveryEvent; members: DiscoveryEvent[] }[] = [];

  for (const event of events) {
    const bucket = buckets.find((b) => shouldMerge(b.anchor, event));
    if (bucket) {
      bucket.members.push(event);
    } else {
      buckets.push({ anchor: event, members: [event] });
    }
  }

  return buckets.map(({ members }) => {
    const sorted = [...members].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    return { primary: sorted[0]!, events: sorted };
  });
}

function shouldMerge(a: DiscoveryEvent, b: DiscoveryEvent): boolean {
  if (a.eventType !== b.eventType) return false;
  if (!a.eventDate || !b.eventDate) return false; // no date is too weak a signal to safely group on
  if (Math.abs(dateDiffDays(a.eventDate, b.eventDate)) > MAX_CROSS_DATE_GAP_DAYS) return false;

  if (a.eventType === "funding") {
    const amountA = extractAmountSignature(a.description);
    const amountB = extractAmountSignature(b.description);
    if (amountA !== null && amountB !== null) return amountA === amountB;
    // No extractable amount on (at least) one side — fall through to the same exact-headline
    // rule every non-funding event uses below, rather than merging on date+type alone.
  }

  const headlineA = normalizeHeadline(a.headline);
  const headlineB = normalizeHeadline(b.headline);
  return headlineA !== null && headlineB !== null && headlineA === headlineB;
}

/** Whole-day difference between two "YYYY-MM-DD" dates, computed at UTC midnight (event_date
 * carries no time-of-day). Positive when `a` is later than `b`. */
function dateDiffDays(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00Z`).getTime();
  const tb = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((ta - tb) / 86_400_000);
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
