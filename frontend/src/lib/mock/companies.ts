/**
 * ============================================================================================
 *  MOCK / DEVELOPMENT-ONLY DATA — not real companies, not sourced from Scout or Supabase.
 * ============================================================================================
 *
 * This file exists ONLY as a fallback for local development when `frontend/.env.local` has no
 * Supabase credentials configured (see src/lib/data/companies.ts). It is never blended with real
 * Supabase rows, and the UI always shows a visible "Sample data" indicator (see
 * src/components/ui/data-source-banner.tsx) whenever this file's data is what's on screen.
 *
 * Every company below is fictional. Names, descriptions, funding figures, sources and dates are
 * all invented for layout/design purposes and must never be presented as facts about real
 * companies. Do not add any of Startup Radar's real seeded companies here, and do not use this
 * file to "fill out" a real company's missing fields — see root CLAUDE.md §5 and the
 * accompanying report for why (fabricating claims about real, identifiable startups is out of
 * bounds, even for demo purposes).
 */
import type { CompanyWithEvents } from "../data/types";

export const MOCK_COMPANIES: readonly CompanyWithEvents[] = [
  {
    id: -1,
    name: "Nimbus Analytics",
    domain: "example.com",
    description: "Sample company — usage-based observability for LLM inference costs.",
    category: "Developer Tools / AI",
    discoveredAt: "2026-09-20T10:00:00.000Z",
    discoverySource: "Sample data",
    discoveryUrl: "https://example.com",
    confidence: 0.91,
    discoveryReason: "Sample discovery reason: emerged from stealth with a seed round.",
    foundedYear: 2025,
    events: [
      {
        id: -101,
        companyId: -1,
        eventType: "stealth",
        eventDate: "2026-09-20",
        sourceName: "Sample data",
        sourceUrl: "https://example.com",
        headline: "Nimbus Analytics emerges from stealth (sample)",
        description: "Sample event description for layout purposes only.",
        confidence: 0.91,
        observedAt: "2026-09-20T10:00:00.000Z",
      },
    ],
  },
  {
    id: -2,
    name: "Fernweg Robotics",
    domain: "example.org",
    description: "Sample company — modular warehouse picking arms for mid-size 3PLs.",
    category: "Robotics",
    discoveredAt: "2026-09-18T10:00:00.000Z",
    discoverySource: "Sample data",
    discoveryUrl: "https://example.org",
    confidence: 0.83,
    discoveryReason: "Sample discovery reason: raised a seed round led by a sample fund.",
    foundedYear: 2024,
    events: [
      {
        id: -201,
        companyId: -2,
        eventType: "funding",
        eventDate: "2026-09-18",
        sourceName: "Sample data",
        sourceUrl: "https://example.org",
        headline: "Fernweg Robotics raises seed round (sample)",
        description: "Sample event description for layout purposes only.",
        confidence: 0.83,
        observedAt: "2026-09-18T10:00:00.000Z",
      },
    ],
  },
  {
    id: -3,
    name: "Cobalt Loop",
    domain: "example.net",
    description: "Sample company — closed-loop battery-material recovery for EV manufacturers.",
    category: "Climate / Materials",
    discoveredAt: "2026-09-15T10:00:00.000Z",
    discoverySource: "Sample data",
    discoveryUrl: "https://example.net",
    confidence: 0.78,
    discoveryReason: "Sample discovery reason: joined an accelerator cohort.",
    foundedYear: null,
    events: [
      {
        id: -301,
        companyId: -3,
        eventType: "accelerator",
        eventDate: "2026-09-15",
        sourceName: "Sample data",
        sourceUrl: "https://example.net",
        headline: "Cobalt Loop joins accelerator cohort (sample)",
        description: "Sample event description for layout purposes only.",
        confidence: 0.78,
        observedAt: "2026-09-15T10:00:00.000Z",
      },
    ],
  },
];
