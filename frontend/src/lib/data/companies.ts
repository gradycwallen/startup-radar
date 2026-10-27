import "server-only";
import { cache } from "react";
import { getServerSupabaseClient } from "../supabase/server-client";
import { MOCK_COMPANIES } from "../mock/companies";
import type { ActivitySignal, Company, CompanyWithEvents, DataSource, DiscoveryEvent } from "./types";

/**
 * The frontend's ONLY data-access module for companies/events. Everything here is READ-ONLY
 * (`.select()` only, matching src/db.ts in the repo root) and runs exclusively on the server —
 * see src/lib/supabase/server-client.ts for why.
 *
 * If Supabase credentials aren't configured (or a read fails), these functions fall back to the
 * clearly-fictional dataset in src/lib/mock/companies.ts and report `source: "mock"` so the UI can
 * show a visible banner. Live data and mock data are never merged into the same result set.
 */

interface CompanyRow {
  id: number;
  name: string;
  domain: string;
  description: string | null;
  category: string | null;
  discovered_at: string;
  discovery_source: string | null;
  discovery_url: string | null;
  confidence: number | null;
  discovery_reason: string | null;
  founded_year: number | null;
}

interface EventRow {
  id: number;
  company_id: number;
  event_type: string;
  event_date: string | null;
  source_name: string | null;
  source_url: string | null;
  headline: string | null;
  description: string | null;
  confidence: number | null;
  observed_at: string;
}

interface ActivitySignalRow {
  company_id: number;
  signal_type: string;
  fired_at: string;
}

function mapCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    description: row.description,
    category: row.category,
    discoveredAt: row.discovered_at,
    discoverySource: row.discovery_source,
    discoveryUrl: row.discovery_url,
    confidence: row.confidence,
    discoveryReason: row.discovery_reason,
    foundedYear: row.founded_year,
  };
}

function mapEvent(row: EventRow): DiscoveryEvent {
  return {
    id: row.id,
    companyId: row.company_id,
    eventType: row.event_type,
    eventDate: row.event_date,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    headline: row.headline,
    description: row.description,
    confidence: row.confidence,
    observedAt: row.observed_at,
  };
}

interface CompaniesResult {
  source: DataSource;
  companies: CompanyWithEvents[];
}

/**
 * All companies with their discovery events attached, newest-discovered first. Memoized per
 * request (React `cache`) so the Radar feed, Explore page and any shared layout can all call this
 * without issuing duplicate reads.
 */
export const getAllCompaniesWithEvents = cache(async (): Promise<CompaniesResult> => {
  const client = getServerSupabaseClient();
  if (!client) return { source: "mock", companies: [...MOCK_COMPANIES] };

  const [companiesRes, eventsRes, signalsRes] = await Promise.all([
    client.from("companies").select("id, name, domain, description, category, discovered_at, discovery_source, discovery_url, confidence, discovery_reason, founded_year"),
    client.from("discovery_events").select("id, company_id, event_type, event_date, source_name, source_url, headline, description, confidence, observed_at"),
    client.from("signals").select("company_id, signal_type, fired_at"),
  ]);

  if (companiesRes.error || eventsRes.error) {
    console.error("[data/companies] Supabase read failed, falling back to mock data:", companiesRes.error ?? eventsRes.error);
    return { source: "mock", companies: [...MOCK_COMPANIES] };
  }

  const eventsByCompany = new Map<number, DiscoveryEvent[]>();
  for (const row of (eventsRes.data ?? []) as EventRow[]) {
    const event = mapEvent(row);
    const list = eventsByCompany.get(event.companyId) ?? [];
    list.push(event);
    eventsByCompany.set(event.companyId, list);
  }

  // Signals only feed Momentum, so a failed read degrades ranking rather than swapping the whole
  // page to mock data.
  if (signalsRes.error) console.error("[data/companies] Supabase signals read failed, ranking Momentum on discovery events only:", signalsRes.error);
  const signalsByCompany = new Map<number, ActivitySignal[]>();
  for (const row of (signalsRes.error ? [] : (signalsRes.data ?? [])) as ActivitySignalRow[]) {
    const list = signalsByCompany.get(row.company_id) ?? [];
    list.push({ signalType: row.signal_type, firedAt: row.fired_at });
    signalsByCompany.set(row.company_id, list);
  }

  const companies: CompanyWithEvents[] = ((companiesRes.data ?? []) as CompanyRow[])
    .map((row) => {
      const company = mapCompany(row);
      const events = (eventsByCompany.get(company.id) ?? []).sort((a, b) => (b.eventDate ?? b.observedAt).localeCompare(a.eventDate ?? a.observedAt));
      return { ...company, events, activitySignals: signalsByCompany.get(company.id) ?? [] };
    })
    .sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt));

  return { source: "supabase", companies };
});

export interface CompanyResult {
  source: DataSource;
  company: CompanyWithEvents | null;
}

/** One company by id, with its events. Reuses the memoized full list rather than a second query —
 * at Startup Radar's current scale (tens of rows) this is simpler and just as fast as a filtered
 * read; revisit if the table grows large enough to warrant a dedicated indexed lookup. */
export const getCompanyById = cache(async (id: number): Promise<CompanyResult> => {
  const { source, companies } = await getAllCompaniesWithEvents();
  return { source, company: companies.find((c) => c.id === id) ?? null };
});
