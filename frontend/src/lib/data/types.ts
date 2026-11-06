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
  /** Just enough of each Signal Intelligence signal (public.signals) for Momentum to count real
   * activity — see src/lib/derive/momentum.ts. Full signal detail is still only read per company
   * (src/lib/data/signals.ts). Absent for mock data. */
  activitySignals?: ActivitySignal[];
}

export interface ActivitySignal {
  signalType: string;
  firedAt: string; // ISO timestamptz
}

/** Where a given payload came from — surfaced in the UI so mock data is never mistaken for live
 * intelligence. See src/lib/data/companies.ts. */
export type DataSource = "supabase" | "mock";

// ---- V2-3A: Signal Intelligence (public.signal_sources / observations / signals) ---------------
//
// These are DELIBERATELY separate from Company/DiscoveryEvent above and are never merged into
// CompanyWithEvents — Signal Intelligence (Scout's derived, deterministic backend signals) and
// Discovery (external events/articles) are different concepts; see root CLAUDE.md and the V2-3A
// delivery report for why they must not be blurred together. Field names here mirror the raw
// backend types 1:1 (src/signals/types.ts in the repo root) — this file has no dependency on that
// module; it is redefined here on purpose, matching this file's own stated decoupling policy.

/** A resolved external source Scout observes for a company. Maps 1:1 to public.signal_sources.
 * `sourceType` is left as `string` (not a union), matching how `DiscoveryEvent.eventType` is
 * already handled above — new source types can appear before this file is updated, and callers
 * must degrade gracefully rather than assume a closed set. */
export interface SignalSource {
  id: number;
  companyId: number;
  sourceType: string;
  externalId: string;
  canonicalUrl: string | null;
  resolutionMethod: string;
  active: boolean;
}

/** One raw, append-only observation. Maps 1:1 to public.observations. `metadata` is small,
 * normalized, backend-controlled evidence (see the V2-2B.2 delivery report) — never raw HTML,
 * never a giant payload; still treated here as opaque/untyped since its shape varies by family and
 * metric, and the view-model layer (src/lib/derive/signal-view-model.ts) is solely responsible for
 * deciding what, if anything, from it is safe/useful to surface. */
export interface SignalObservation {
  id: number;
  companyId: number;
  signalSourceId: number;
  metricName: string;
  numericValue: number | null;
  textValue: string | null;
  observedAt: string; // ISO timestamptz — when Scout captured it
  collectionVersion: string;
  metadata: Record<string, unknown> | null;
}

/** One derived, deterministic signal. Maps 1:1 to public.signals. `family`/`signalType` are left
 * as `string` (not unions) for the same forward-compatibility reason as `SignalSource.sourceType`
 * — a future family/signal_type must degrade gracefully, never crash a page render. */
export interface DerivedSignal {
  id: number;
  companyId: number;
  family: string;
  signalType: string;
  windowDays: number;
  fromObservationId: number | null;
  toObservationId: number | null;
  fromValue: number | null;
  toValue: number | null;
  delta: number | null;
  relativeChange: number | null;
  explanation: string;
  firedAt: string; // ISO timestamptz
  metadata: Record<string, unknown> | null;
}

/** Everything Signal Intelligence needs for one company, fetched together. */
export interface SignalIntelligence {
  sources: SignalSource[];
  observations: SignalObservation[];
  signals: DerivedSignal[];
  unavailable?: boolean;
}
