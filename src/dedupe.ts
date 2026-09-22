import { normalizeUrl } from "./domain.ts";
import type { NormalizedCandidate } from "./schema.ts";

export interface CompanyRow {
  id: number;
  name: string;
  domain: string;
}

export interface EventRow {
  id: number;
  company_id: number;
  event_type: string;
  event_date: string | null;
  source_url: string | null;
  headline: string | null;
  description: string | null;
}

/** Everything the pipeline may ask the database. Reads only. */
export interface CompanyReader {
  findCompanyByDomain(domain: string): Promise<CompanyRow | null>;
  findCompaniesByName(name: string): Promise<CompanyRow[]>;
  getEvents(companyId: number): Promise<EventRow[]>;
}

export type DedupeOutcome =
  | { kind: "new_company" }
  | { kind: "existing_company_new_event"; company: CompanyRow }
  | {
      kind: "duplicate_event";
      company: CompanyRow | null;
      reason: "same_source_url" | "same_underlying_event";
      matched: string;
    }
  | { kind: "same_run_new_event"; domain: string } // company is new in THIS run; this is an additional, distinct event
  | { kind: "name_collision"; companies: CompanyRow[] };

// ---- same-underlying-event heuristics (deterministic) ----------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "its", "has", "have", "was", "were",
  "are", "new", "announced", "announces", "raises", "raised", "round", "led", "million", "billion",
  "startup", "company", "via", "after", "about", "their", "will", "over", "more", "than",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9.$€£ ]+/g, " ")
      .split(/\s+/)
      .map((t) => t.replace(/^[.$€£]+|[.]+$/g, ""))
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

/** Money amounts normalized to a comparable string, e.g. "$15M" -> "15m", "€1.5 million" -> "1.5m". */
export function extractAmounts(text: string): Set<string> {
  const out = new Set<string>();
  const re = /[$€£]\s?(\d+(?:[.,]\d+)?)\s?(k|m|mm|b|bn|thousand|million|billion)?\b|(\d+(?:[.,]\d+)?)\s?(million|billion|m|bn)\b/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const num = (m[1] ?? m[3] ?? "").replace(",", ".");
    const unitRaw = (m[2] ?? m[4] ?? "").toLowerCase();
    const unit = unitRaw.startsWith("b") ? "b" : unitRaw.startsWith("m") ? "m" : unitRaw.startsWith("t") || unitRaw === "k" ? "k" : "";
    if (num) out.add(`${Number(num)}${unit}`);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface EventLike {
  event_type: string;
  headline: string | null;
  description: string | null;
}

/**
 * True when two events of the same type are obviously coverage of the SAME underlying event.
 * - Both mention money amounts: same event iff they share an amount; different amounts => different
 *   events (a seed round and a later Series A stay separate even within days of each other).
 * - Otherwise: high textual overlap of headline+description.
 * Dates are deliberately not used: seed rows carry insertion dates, and a single event is
 * routinely reported over several days.
 */
export function isSameUnderlyingEvent(a: EventLike, b: EventLike, threshold = 0.6): boolean {
  if (a.event_type !== b.event_type) return false;
  const ta = `${a.headline ?? ""} ${a.description ?? ""}`;
  const tb = `${b.headline ?? ""} ${b.description ?? ""}`;
  const amountsA = extractAmounts(ta);
  const amountsB = extractAmounts(tb);
  if (amountsA.size > 0 && amountsB.size > 0) {
    for (const x of amountsA) if (amountsB.has(x)) return true;
    return false;
  }
  return jaccard(tokens(ta), tokens(tb)) >= threshold;
}

// ---- in-run registry ---------------------------------------------------------------------

export interface PendingEvent extends EventLike {
  source_url: string;
}

/** Tracks what earlier candidates in the SAME run would have written, so a run can't duplicate itself. */
export class RunRegistry {
  readonly #byDomain = new Map<string, PendingEvent[]>();
  readonly #names = new Map<string, string>();

  hasDomain(domain: string): boolean {
    return this.#byDomain.has(domain);
  }
  eventsFor(domain: string): PendingEvent[] {
    return this.#byDomain.get(domain) ?? [];
  }
  nameOwner(name: string): string | undefined {
    return this.#names.get(name.toLowerCase());
  }
  record(c: NormalizedCandidate): void {
    const list = this.#byDomain.get(c.company.domain) ?? [];
    list.push({ ...c.event, source_url: c.event.source_url });
    this.#byDomain.set(c.company.domain, list);
    this.#names.set(c.company.name.toLowerCase(), c.company.domain);
  }
}

function matchEvent(
  c: NormalizedCandidate,
  events: Array<EventLike & { source_url: string | null }>,
): { reason: "same_source_url" | "same_underlying_event"; matched: string } | null {
  for (const e of events) {
    if (e.source_url && normalizeUrl(e.source_url) === c.event.source_url)
      return { reason: "same_source_url", matched: e.source_url };
  }
  for (const e of events) {
    if (isSameUnderlyingEvent(c.event, e)) return { reason: "same_underlying_event", matched: e.headline ?? e.description ?? "" };
  }
  return null;
}

/**
 * Decide what a validated candidate would mean for the database.
 * Primary event key is (company_id, normalized source_url); then same-underlying-event heuristics.
 * A genuinely different event for a known company is allowed even if it is close in time.
 */
export async function classifyCandidate(
  c: NormalizedCandidate,
  reader: CompanyReader,
  registry: RunRegistry,
): Promise<DedupeOutcome> {
  const existing = await reader.findCompanyByDomain(c.company.domain);

  if (!existing) {
    if (registry.hasDomain(c.company.domain)) {
      const hit = matchEvent(c, registry.eventsFor(c.company.domain));
      if (hit) return { kind: "duplicate_event", company: null, ...hit };
      return { kind: "same_run_new_event", domain: c.company.domain };
    }
    // New domain: a same-name company under another domain may be a rebrand. Hold for review.
    const sameName = await reader.findCompaniesByName(c.company.name);
    if (sameName.length > 0) return { kind: "name_collision", companies: sameName };
    return { kind: "new_company" };
  }

  const events = [...(await reader.getEvents(existing.id)), ...registry.eventsFor(existing.domain)];
  const hit = matchEvent(c, events);
  if (hit) return { kind: "duplicate_event", company: existing, ...hit };
  return { kind: "existing_company_new_event", company: existing };
}
