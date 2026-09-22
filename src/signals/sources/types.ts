/** What every collector (GitHub, ATS) produces — normalized, not yet a persisted Observation.
 * The caller (observe.ts) fills in company_id/signal_source_id/observed_at/id when writing. */
export interface CollectedMetric {
  metricName: string;
  numericValue: number | null;
  textValue: string | null;
  /** When the SOURCE says this value is as-of, if it reports one (e.g. a release's published_at).
   * Null when the source has no notion of this (e.g. a live count like "open jobs right now"). */
  sourceTimestamp: string | null;
}

export interface CollectionResult {
  metrics: CollectedMetric[];
  collectionVersion: string;
  /** The primary HTTP status of the collection (for provider-health reporting). */
  sourceStatus: number;
}
