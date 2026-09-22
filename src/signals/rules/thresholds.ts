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

/**
 * LEVEL signals (V2-2B.1) — fire from a metric's FIRST-EVER observation alone (see
 * rules/hiring.ts: deriveHiringLevelSignals, rules/github.ts: deriveGithubLevelSignals). No prior
 * reading exists to compare against, so these describe the CURRENT absolute state only — never a
 * claimed increase/appearance/start (see makeLevelSignal's explanation wording).
 *
 * Non-negotiable calibration rule: a level threshold must be MORE conservative than the
 * corresponding velocity threshold, because a level signal has no corroborating trend behind it —
 * a single strong reading has to be strong enough to stand on its own. These are explicitly
 * DELIBERATELY CONSERVATIVE, UNVALIDATED starting values (same disclosed posture as every other
 * threshold in this file) — not backtested against real outcomes yet.
 */
export const HIRING_LEVEL_RULE_VERSION = "hiring-level-v1";
export const HIRING_LEVEL_THRESHOLDS = {
  /** Open positions at first observation to call hiring "notably high" with zero history — the
   * exact worked example from the V2-2B design brief ("~10 open roles"), not an arbitrary round
   * number. Compare: the VELOCITY "increase" threshold is a delta of just 3 (openJobsIncreaseMinDelta). */
  openJobsHighAtFirstObservation: 10,
  /** Open sales postings at first observation to call sales hiring "meaningfully present." More
   * conservative than the velocity sales_hiring_started rule, which fires on ANY 0->nonzero
   * transition — that rule has an observed zero baseline to compare against; this one does not. */
  salesPresentMinCount: 2,
} as const;

export const GITHUB_LEVEL_RULE_VERSION = "github-level-v1";
export const GITHUB_LEVEL_THRESHOLDS = {
  /** Trailing-4-week commits at first observation to call development "notably active" with zero
   * history — deliberately 2x the velocity quiet_to_active rule's activeCommitsFloor (10), since
   * that rule at least knows the PRIOR reading was quiet; this one has no prior reading at all. */
  activeCommitsAtFirstObservation: 20,
  /** Contributor count at first observation to call the contributor base "meaningful." No existing
   * velocity threshold to anchor against (contributorGrowthMinDelta is a delta, not a level) — a
   * conservative starting value, disclosed as unvalidated. */
  contributorsAtFirstObservation: 5,
  /** A most-recent release dated within this many days of first observation counts as "recent" —
   * i.e. real, ongoing shipping activity, not a project that happens to have shipped once, years ago. */
  recentReleaseMaxAgeDays: 14,
} as const;

/**
 * V2-2B.2 website signals have no MAGNITUDE thresholds to centralize here — a page is either
 * confirmed present or confirmed absent (see src/signals/website/resolve.ts's own absence
 * recipe), and the level/transition rules are combinations of named patterns, not numeric cutoffs
 * (deliberately — see the V2-2B.2 design report §9: "combinations, not an opaque point score").
 * Their rule-version strings (WEBSITE_LEVEL_RULE_VERSION, WEBSITE_TRANSITION_RULE_VERSION) and
 * the page-tier map live in src/signals/rules/website.ts itself, next to the logic they version,
 * rather than being split across two files for no benefit.
 */
