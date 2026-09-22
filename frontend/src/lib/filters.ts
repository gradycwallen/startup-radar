import type { CompanyWithEvents } from "./data/types";
import { daysSince } from "./derive/recency";
import { compareMomentumDesc } from "./derive/momentum";

export type SortKey = "momentum" | "recent" | "confidence" | "name";

export interface CompanyFilters {
  q: string;
  category: string | null;
  eventType: string | null;
  minConfidence: number | null;
  maxAgeDays: number | null;
  sort: SortKey;
}

// Momentum is the default sort for the main Radar/Explore experience — see
// src/lib/derive/momentum.ts. Verified against the live database before making this the default
// (see the Momentum delivery report): recently-discovered, well-corroborated, multi-signal
// companies rank above old, thin, single-source ones, which is the whole point of the feature.
export const DEFAULT_FILTERS: CompanyFilters = {
  q: "",
  category: null,
  eventType: null,
  minConfidence: null,
  maxAgeDays: null,
  sort: "momentum",
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Parses a Next.js `searchParams` object into typed filters. Every value is optional and invalid
 * values fall back to the default rather than throwing, since these come straight from the URL. */
export function parseFilters(params: RawSearchParams): CompanyFilters {
  const q = first(params.q)?.trim() ?? "";
  const category = first(params.category)?.trim() || null;
  const eventType = first(params.event)?.trim() || null;
  const minConfidenceRaw = first(params.minConfidence);
  const minConfidence = minConfidenceRaw !== undefined && !Number.isNaN(Number(minConfidenceRaw)) ? Number(minConfidenceRaw) : null;
  const maxAgeRaw = first(params.maxAge);
  const maxAgeDays = maxAgeRaw !== undefined && !Number.isNaN(Number(maxAgeRaw)) ? Number(maxAgeRaw) : null;
  const sortRaw = first(params.sort);
  const sort: SortKey = sortRaw === "confidence" || sortRaw === "name" || sortRaw === "recent" ? sortRaw : "momentum";
  return { q, category, eventType, minConfidence, maxAgeDays, sort };
}

function matchesQuery(company: CompanyWithEvents, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    company.name.toLowerCase().includes(needle) ||
    company.domain.toLowerCase().includes(needle) ||
    (company.description?.toLowerCase().includes(needle) ?? false) ||
    (company.category?.toLowerCase().includes(needle) ?? false)
  );
}

export function filterCompanies(companies: readonly CompanyWithEvents[], filters: CompanyFilters, now: Date = new Date()): CompanyWithEvents[] {
  let out = companies.filter((c) => matchesQuery(c, filters.q));
  if (filters.category) out = out.filter((c) => c.category === filters.category);
  if (filters.eventType) out = out.filter((c) => c.events.some((e) => e.eventType === filters.eventType));
  if (filters.minConfidence !== null) out = out.filter((c) => (c.confidence ?? 0) >= filters.minConfidence!);
  if (filters.maxAgeDays !== null) out = out.filter((c) => daysSince(c.discoveredAt, now) <= filters.maxAgeDays!);

  const sorted = [...out];
  switch (filters.sort) {
    case "confidence":
      sorted.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
      break;
    case "name":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "recent":
      sorted.sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt));
      break;
    case "momentum":
    default:
      sorted.sort((a, b) => compareMomentumDesc(a, b, now));
  }
  return sorted;
}

/** Distinct categories present in the dataset, alphabetized — used to populate filter controls
 * without hardcoding a category list. */
export function distinctCategories(companies: readonly CompanyWithEvents[]): string[] {
  return [...new Set(companies.map((c) => c.category).filter((c): c is string => Boolean(c)))].sort((a, b) => a.localeCompare(b));
}

/** Distinct event types present in the dataset (in the canonical order), for filter controls. */
export function distinctEventTypes(companies: readonly CompanyWithEvents[]): string[] {
  const present = new Set(companies.flatMap((c) => c.events.map((e) => e.eventType)));
  return [...present];
}
