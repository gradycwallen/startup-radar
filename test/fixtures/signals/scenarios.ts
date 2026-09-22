import type { Observation } from "../../../src/signals/types.ts";

/**
 * Realistic longitudinal observation sequences for the six scenarios the V2-2A brief specifies
 * (A-F). "Now" is fixed so tests are deterministic regardless of when they run.
 */
export const NOW = new Date("2026-09-22T00:00:00.000Z");
const DAY_MS = 86_400_000;

let nextId = 1;
export function obs(companyId: number, signalSourceId: number, metricName: string, value: number | null, daysAgo: number, extra: Partial<Observation> = {}): Observation {
  return {
    id: nextId++,
    company_id: companyId,
    signal_source_id: signalSourceId,
    metric_name: metricName,
    numeric_value: value,
    text_value: extra.text_value ?? null,
    // `extra.observed_at` (an exact timestamp) wins when given — some tests need hour-level
    // precision (freshness/cooldown boundaries) that a whole-day `daysAgo` can't express.
    observed_at: extra.observed_at ?? new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
    source_timestamp: extra.source_timestamp ?? null,
    collection_version: extra.collection_version ?? "test-v1",
    raw_payload_ref: null,
  };
}

// ---- A. Stable company: no strong signal expected ------------------------------------------------------------------

export const SCENARIO_A_COMPANY_ID = 101;
export const SCENARIO_A: Observation[] = [
  obs(SCENARIO_A_COMPANY_ID, 1, "ats_open_jobs_total", 4, 60),
  obs(SCENARIO_A_COMPANY_ID, 1, "ats_open_jobs_total", 4, 30),
  obs(SCENARIO_A_COMPANY_ID, 1, "ats_open_jobs_total", 5, 0),
  obs(SCENARIO_A_COMPANY_ID, 2, "github_stars", 100, 60),
  obs(SCENARIO_A_COMPANY_ID, 2, "github_stars", 102, 30),
  obs(SCENARIO_A_COMPANY_ID, 2, "github_stars", 103, 0),
  obs(SCENARIO_A_COMPANY_ID, 2, "github_commits_last_4w", 6, 60),
  obs(SCENARIO_A_COMPANY_ID, 2, "github_commits_last_4w", 5, 30),
  obs(SCENARIO_A_COMPANY_ID, 2, "github_commits_last_4w", 7, 0),
];

// ---- B. Hiring acceleration: jobs 2 -> 5 -> 14, sales 0 -> 0 -> 4 -----------------------------------------------------

export const SCENARIO_B_COMPANY_ID = 102;
export const SCENARIO_B: Observation[] = [
  obs(SCENARIO_B_COMPANY_ID, 3, "ats_open_jobs_total", 2, 30),
  obs(SCENARIO_B_COMPANY_ID, 3, "ats_open_jobs_sales", 0, 30),
  obs(SCENARIO_B_COMPANY_ID, 3, "ats_open_jobs_total", 5, 15),
  obs(SCENARIO_B_COMPANY_ID, 3, "ats_open_jobs_sales", 0, 15),
  obs(SCENARIO_B_COMPANY_ID, 3, "ats_open_jobs_total", 14, 0),
  obs(SCENARIO_B_COMPANY_ID, 3, "ats_open_jobs_sales", 4, 0),
];

// ---- C. Developer acceleration: commits 8 -> 11 -> 48, contributors 3 -> 3 -> 7, a release appears --------------------

export const SCENARIO_C_COMPANY_ID = 103;
export const SCENARIO_C: Observation[] = [
  obs(SCENARIO_C_COMPANY_ID, 4, "github_commits_last_4w", 8, 30),
  obs(SCENARIO_C_COMPANY_ID, 4, "github_contributors", 3, 30),
  obs(SCENARIO_C_COMPANY_ID, 4, "github_commits_last_4w", 11, 15),
  obs(SCENARIO_C_COMPANY_ID, 4, "github_contributors", 3, 15),
  obs(SCENARIO_C_COMPANY_ID, 4, "github_commits_last_4w", 48, 0),
  obs(SCENARIO_C_COMPANY_ID, 4, "github_contributors", 7, 0),
  obs(SCENARIO_C_COMPANY_ID, 4, "github_latest_release_at", null, 15, { text_value: "2026-08-15T00:00:00Z" }),
  obs(SCENARIO_C_COMPANY_ID, 4, "github_latest_release_at", null, 0, { text_value: "2026-09-20T00:00:00Z" }),
];

// ---- D. Multi-family acceleration: hiring AND github both activate, independently --------------------------------

export const SCENARIO_D_COMPANY_ID = 104;
export const SCENARIO_D: Observation[] = [
  obs(SCENARIO_D_COMPANY_ID, 5, "ats_open_jobs_total", 3, 30),
  obs(SCENARIO_D_COMPANY_ID, 5, "ats_open_jobs_total", 9, 15),
  obs(SCENARIO_D_COMPANY_ID, 5, "ats_open_jobs_total", 16, 0),
  obs(SCENARIO_D_COMPANY_ID, 6, "github_stars", 200, 30),
  obs(SCENARIO_D_COMPANY_ID, 6, "github_stars", 350, 15),
  obs(SCENARIO_D_COMPANY_ID, 6, "github_stars", 1300, 0),
];

// ---- E. Noisy one-period spike: jumps then immediately falls back -------------------------------------------------
// (endpoint-based windowing already ignores the mid-window peak; see velocity.ts's isPersistent doc.)

export const SCENARIO_E_COMPANY_ID = 105;
export const SCENARIO_E: Observation[] = [
  obs(SCENARIO_E_COMPANY_ID, 7, "ats_open_jobs_total", 3, 20),
  obs(SCENARIO_E_COMPANY_ID, 7, "ats_open_jobs_total", 20, 10), // transient spike
  obs(SCENARIO_E_COMPANY_ID, 7, "ats_open_jobs_total", 4, 0), // falls back near baseline
];

/** A second flavor of "noisy": the spike IS the latest reading, with no prior movement — this is
 * what the extra isPersistent() check (not just endpoint comparison) is specifically for. */
export const SCENARIO_E2_COMPANY_ID = 106;
export const SCENARIO_E2: Observation[] = [
  obs(SCENARIO_E2_COMPANY_ID, 8, "ats_open_jobs_total", 3, 30),
  obs(SCENARIO_E2_COMPANY_ID, 8, "ats_open_jobs_total", 3, 15), // flat right up to the last reading
  obs(SCENARIO_E2_COMPANY_ID, 8, "ats_open_jobs_total", 20, 0), // spike appears only just now
];

// ---- F. Insufficient history: one observation only -----------------------------------------------------------------

export const SCENARIO_F_COMPANY_ID = 107;
export const SCENARIO_F: Observation[] = [
  obs(SCENARIO_F_COMPANY_ID, 9, "ats_open_jobs_total", 6, 0),
  obs(SCENARIO_F_COMPANY_ID, 10, "github_stars", 500, 0),
];
