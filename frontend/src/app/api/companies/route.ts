import { NextResponse, type NextRequest } from "next/server";
import { getAllCompaniesWithEvents } from "@/lib/data/companies";
import { computeMomentum } from "@/lib/derive/momentum";

/**
 * A public, read-only export of the current Radar — the same data the site itself renders,
 * reusing the same server-only data layer (lib/data/companies.ts) everything else reads. No
 * separate query, no separate source of truth to drift out of sync with the UI.
 *
 * `?format=csv` returns one row per company (a flat export format can't hold a nested event list,
 * so CSV gets an `eventCount` instead — use JSON, the default, for full event-level detail).
 *
 * Momentum is exported the same way the UI shows it — band + signal count + latest activity, never
 * the raw internal score (see lib/derive/momentum.ts: "never shown as a number... per the brief").
 * An API response isn't a loophole around that; same restraint, same reason.
 */
export async function GET(request: NextRequest) {
  const format = request.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
  const { companies } = await getAllCompaniesWithEvents();

  const rows = companies.map((company) => {
    const momentum = computeMomentum(company);
    return {
      id: company.id,
      name: company.name,
      domain: company.domain,
      category: company.category,
      description: company.description,
      confidence: company.confidence,
      discoveredAt: company.discoveredAt,
      discoverySource: company.discoverySource,
      discoveryUrl: company.discoveryUrl,
      discoveryReason: company.discoveryReason,
      foundedYear: company.foundedYear,
      momentumBand: momentum.band,
      signalCount: momentum.signalCount,
      latestSignalAt: momentum.latestAt ? new Date(momentum.latestAt).toISOString() : null,
      events: company.events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        eventDate: event.eventDate,
        headline: event.headline,
        description: event.description,
        sourceName: event.sourceName,
        sourceUrl: event.sourceUrl,
        confidence: event.confidence,
        observedAt: event.observedAt,
      })),
    };
  });

  if (format === "csv") {
    const columns = [
      "id",
      "name",
      "domain",
      "category",
      "description",
      "confidence",
      "discoveredAt",
      "discoverySource",
      "discoveryUrl",
      "discoveryReason",
      "foundedYear",
      "momentumBand",
      "signalCount",
      "latestSignalAt",
      "eventCount",
    ] as const;
    const csvRows = rows.map((row) => columns.map((col) => csvCell(col === "eventCount" ? row.events.length : row[col])).join(","));
    const csv = [columns.join(","), ...csvRows].join("\r\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=startup-radar-companies.csv",
      },
    });
  }

  return NextResponse.json(
    { generatedAt: new Date().toISOString(), count: rows.length, companies: rows },
    { headers: { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=60" } },
  );
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
