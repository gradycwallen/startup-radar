/**
 * Domain types for the frontend. These mirror the Scout database (see root CLAUDE.md §3 and
 * src/schema.ts / src/config.ts in the repo root) but are intentionally the frontend's OWN types,
 * not a re-export of backend internals — the frontend is read-only and must stay decoupled from
 * Scout's implementation details.
 */

/** The six event types Scout can produce (src/config.ts: EVENT_TYPES in the repo root). Enforced by
 * the backend application, not a database constraint — treat any other string defensively. */
export const EVENT_TYPES = [
  "funding",
  "product_launch",
  "accelerator",
  "news",
  "open_source",
  "stealth",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function isKnownEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/** A company as Scout recorded it. Maps 1:1 to public.companies. */
export interface Company {
  id: number;
  name: string;
  domain: string;
  description: string | null;
  category: string | null;
  discoveredAt: string; // ISO timestamptz
  discoverySource: string | null;
  discoveryUrl: string | null;
  confidence: number | null;
  discoveryReason: string | null;
  foundedYear: number | null;
}

/** One discovery event for a company. Maps 1:1 to public.discovery_events. */
export interface DiscoveryEvent {
  id: number;
  companyId: number;
  eventType: string;
  eventDate: string | null; // date, no time
  sourceName: string | null;
  sourceUrl: string | null;
  headline: string | null;
  description: string | null;
  confidence: number | null;
  observedAt: string; // ISO timestamptz
}

/** A company with its full event history attached, as most UI needs it. */
export interface CompanyWithEvents extends Company {
  events: DiscoveryEvent[];
}

/** Where a given payload came from — surfaced in the UI so mock data is never mistaken for live
 * intelligence. See src/lib/data/companies.ts. */
export type DataSource = "supabase" | "mock";
