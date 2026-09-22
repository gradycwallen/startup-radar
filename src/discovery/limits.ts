/**
 * Hard operational safety caps for automated discovery persistence — centralized, per the V2-1.1
 * brief ("A runaway source or parser bug must NOT be capable of inserting hundreds of companies
 * overnight"). A CLI flag (`--max-writes`) may LOWER `maxNewCompaniesPerRun`, never raise it above
 * this ceiling — the same "can lower, never raise" pattern already used for the Phase 1 budget
 * ceiling (`--max-cost-usd`) and V2-2A.1's collection freshness.
 *
 * These are deliberately conservative starting values for a ten-row database, not a tuned
 * production capacity — revisit once real operating history exists.
 */
export const DISCOVERY_LIMITS = {
  /** How many finalist+resolved-domain candidates are even considered for persistence in one run,
   * across both tracks combined. Comfortably above what a healthy run should ever produce; exists
   * as a second, independent backstop above the company-write cap below. */
  maxAcceptedCandidates: 10,
  /** THE primary safety cap: at most this many brand-new companies may be inserted in one run. */
  maxNewCompaniesPerRun: 5,
  /** A generous ceiling on discovery_events inserted in one run (a company can have a few
   * corroborating sources) — guards against a bug that would otherwise attach an unbounded number
   * of events to one company, not a cap expected to bind in normal operation. */
  maxNewEventsPerRun: 25,
} as const;
