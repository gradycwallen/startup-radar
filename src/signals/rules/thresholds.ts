/**
 * ALL signal thresholds live here — one place, never scattered through rule logic. Bump the
 * relevant *_RULE_VERSION whenever a threshold changes; old `signals` rows keep whatever
 * rule_version produced them, so history stays interpretable even after rules evolve (a signal
 * fired under hiring-v1 is never silently reinterpreted as if hiring-v2 had produced it).
 *
 * These are STARTING values for V2-2A, deliberately conservative, NOT validated against real
 * outcomes yet — proving the framework is this milestone's goal, not claiming predictive value.
 * Backtesting against known cases (the way V2-1's ranking weights were tuned against the Phase-1
 * eval labels) is future work, not done here.
 */

export const HIRING_RULE_VERSION = "hiring-v1";
export const HIRING_THRESHOLDS = {
  /** Minimum absolute growth in total open jobs to call it an "increase" at all. */
  openJobsIncreaseMinDelta: 3,
  /** A "surge" needs EITHER a large relative jump OR a large absolute one (guards against both
   * "2 -> 5" reading as a 150% surge from a tiny base, and a slow linear climb from a big base
   * never qualifying). */
  openJobsSurgeMinRelative: 2.0, // e.g. 3 -> 9 or more (>=200% growth)
  openJobsSurgeMinAbsolute: 8, // e.g. 20 -> 28, even if that is "only" 40%
  engineeringIncreaseMinDelta: 3,
} as const;

export const GITHUB_RULE_VERSION = "github-v1";
export const GITHUB_THRESHOLDS = {
  starVelocityMinDelta: 50,
  starVelocityMinRelative: 0.5, // +50%
  contributorGrowthMinDelta: 2,
  commitActivityMinRelative: 1.0, // commits at least doubled
  commitActivityMinAbsolute: 10, // ...and it's not just "1 commit became 2"
  /** A prior 4-week commit count at or below this counts as "quiet" for quiet_to_active. */
  quietCommitsCeiling: 2,
  /** The CURRENT 4-week commit count must clear this to count as "active" for quiet_to_active. */
  activeCommitsFloor: 10,
} as const;
