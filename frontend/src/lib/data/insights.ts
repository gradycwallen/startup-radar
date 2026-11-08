import "server-only";
import { cache } from "react";
import { getServerSupabaseClient } from "../supabase/server-client";

/**
 * The frontend's data-access module for the aggregate /insights page — a dataset-wide view
 * (every company, every signal), not scoped to one company like data/signals.ts. READ-ONLY
 * (`.select()` only), server-only, same posture as every other module here.
 *
 * Deliberately degrades to an EMPTY result (never mock/fabricated aggregate data) when Supabase
 * isn't configured or a read fails — matching data/signals.ts's own reasoning: there is no
 * meaningful "sample" aggregate to fall back to, and a fabricated trend chart would be actively
 * misleading in a way a fabricated single company profile might not be.
 */

export interface InsightsCompanyRow {
  discoveredAt: string;
  discoverySource: string | null;
}

export interface InsightsSignalRow {
  family: string;
  firedAt: string;
}

export interface InsightsData {
  companies: InsightsCompanyRow[];
  signals: InsightsSignalRow[];
  unavailable?: boolean;
}

const EMPTY: InsightsData = { companies: [], signals: [] };

export const getInsightsData = cache(async (): Promise<InsightsData> => {
  const client = getServerSupabaseClient();
  if (!client) return EMPTY;

  async function readPages(table: string, columns: string) {
    const rows: unknown[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client!.from(table).select(columns).order("id").range(offset, offset + 999);
      if (error) throw error;
      rows.push(...(data ?? []));
      if ((data?.length ?? 0) < 1000) return rows;
    }
  }

  try {
    const [companyRows, signalRows] = await Promise.all([readPages("companies", "discovered_at, discovery_source"), readPages("signals", "family, fired_at")]);
    return {
      companies: (companyRows as { discovered_at: string; discovery_source: string | null }[]).map((r) => ({ discoveredAt: r.discovered_at, discoverySource: r.discovery_source })),
      signals: (signalRows as { family: string; fired_at: string }[]).map((r) => ({ family: r.family, firedAt: r.fired_at })),
    };
  } catch (error) {
    console.error("[data/insights] Supabase read failed:", error);
    return { ...EMPTY, unavailable: true };
  }
});
