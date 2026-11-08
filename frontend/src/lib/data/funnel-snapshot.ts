/**
 * A single real run of the live deterministic funnel (`npm run funnel -- --json`), captured
 * 2026-11-08, zero LLM calls, zero writes. This is a committed SNAPSHOT, not a live read — running
 * the full funnel (10 source providers, real network requests) on every page render would be slow
 * and wasteful for what's meant to be an explanatory diagram, not a live dashboard. The methodology
 * page labels this explicitly as "one real run, captured on this date" rather than implying it's
 * live — see CLAUDE.md's own convention of disclosing exactly when a measured number was taken
 * (the V2-1 eval baseline, the V2-2A live-validation batch, etc.) instead of letting it read as
 * permanently current.
 *
 * Source artifact: logs/20261108T032409Z-y0cs-now.funnel.json (as_of 2026-11-08T03:24:09.193Z,
 * elapsed_ms 27871). To refresh: run `npm run funnel -- --json` from the repo root and update the
 * numbers below from the new artifact's `counts` object.
 */

export const FUNNEL_SNAPSHOT = {
  capturedAt: "2026-11-08T03:24:09.193Z",
  stages: [
    { label: "Items fetched", description: "Raw items from all 10 source providers (RSS, Google News, YC, Techstars)", count: 892 },
    { label: "In recency window", description: "Within the 3-day lookback window", count: 837 },
    { label: "Raw leads extracted", description: "A company name was deterministically extractable", count: 683 },
    { label: "Survived prefilter", description: "Not a fund, investor, public company, or late-stage raise", count: 672 },
    { label: "Clustered into entities", description: "Deduplicated across providers and lanes", count: 589 },
    { label: "New (not already tracked)", description: "Didn't match an existing company in the database", count: 478 },
  ],
  newsFinalists: 14,
  directoryFinalists: 25,
} as const;
