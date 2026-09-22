import type { DerivedSignal, Observation } from "../types.ts";
import { bestAvailableWindow, isPersistent, metricSeries } from "../velocity.ts";
import { GITHUB_LEVEL_RULE_VERSION, GITHUB_LEVEL_THRESHOLDS, GITHUB_RULE_VERSION, GITHUB_THRESHOLDS } from "./thresholds.ts";
import { fmtNum, fmtPct, makeLevelSignal, makeSignal } from "./format.ts";

/**
 * Deterministic GitHub signals. Stars are tracked but deliberately do NOT dominate: star_velocity
 * is one of five signal types here, weighted no higher than contributor/commit signals, and easy
 * to game (bots, promotion) compared to contributor growth or sustained commit activity.
 */
export function deriveGithubSignals(companyId: number, history: readonly Observation[]): Omit<DerivedSignal, "id">[] {
  const out: Omit<DerivedSignal, "id">[] = [];

  const stars = bestAvailableWindow(history, "github_stars");
  if (stars && stars.delta !== null) {
    const qualifies = (stars.relativeChange !== null && stars.relativeChange >= GITHUB_THRESHOLDS.starVelocityMinRelative) || stars.delta >= GITHUB_THRESHOLDS.starVelocityMinDelta;
    if (qualifies && stars.delta > 0 && isPersistent(history, stars)) {
      out.push(makeSignal(companyId, "github", "star_velocity_increase", GITHUB_RULE_VERSION, stars, `GitHub stars rose from ${fmtNum(stars.from?.numeric_value ?? null)} to ${fmtNum(stars.to.numeric_value)} in ${Math.round(stars.actualSpanDays ?? stars.windowDays)} days${stars.relativeChange !== null ? ` (${fmtPct(stars.relativeChange)})` : ""}.`));
    }
  }

  const contributors = bestAvailableWindow(history, "github_contributors");
  if (contributors && contributors.delta !== null && contributors.delta >= GITHUB_THRESHOLDS.contributorGrowthMinDelta) {
    out.push(makeSignal(companyId, "github", "contributor_growth", GITHUB_RULE_VERSION, contributors, `Contributor count grew from ${fmtNum(contributors.from?.numeric_value ?? null)} to ${fmtNum(contributors.to.numeric_value)} in ${Math.round(contributors.actualSpanDays ?? contributors.windowDays)} days.`));
  }

  const commits = bestAvailableWindow(history, "github_commits_last_4w");
  if (commits && commits.delta !== null) {
    const qualifies = (commits.relativeChange !== null && commits.relativeChange >= GITHUB_THRESHOLDS.commitActivityMinRelative) && commits.delta >= GITHUB_THRESHOLDS.commitActivityMinAbsolute;
    if (qualifies && isPersistent(history, commits)) {
      const contributorsCmp = bestAvailableWindow(history, "github_contributors");
      const note = contributorsCmp && contributorsCmp.delta !== null && contributorsCmp.delta > 0 ? ` and contributors increased from ${fmtNum(contributorsCmp.from?.numeric_value ?? null)} to ${fmtNum(contributorsCmp.to.numeric_value)}` : "";
      out.push(makeSignal(companyId, "github", "commit_activity_increase", GITHUB_RULE_VERSION, commits, `Developer activity increased: weekly commits (trailing 4-week total) rose from ${fmtNum(commits.from?.numeric_value ?? null)} to ${fmtNum(commits.to.numeric_value)}${note}.`));
    }

    // quiet_to_active: prior value was near-zero, current value clears the "active" floor.
    if (commits.from && commits.from.numeric_value !== null && commits.from.numeric_value <= GITHUB_THRESHOLDS.quietCommitsCeiling && (commits.to.numeric_value ?? 0) >= GITHUB_THRESHOLDS.activeCommitsFloor) {
      out.push(makeSignal(companyId, "github", "quiet_to_active", GITHUB_RULE_VERSION, commits, `Repository went from a quiet period (${fmtNum(commits.from.numeric_value)} commits) to active development (${fmtNum(commits.to.numeric_value)} commits) over ${Math.round(commits.actualSpanDays ?? commits.windowDays)} days.`));
    }
  }

  // release_activity: a new release appeared that we had not observed before.
  const releaseSeries = metricSeries(history, "github_latest_release_at");
  if (releaseSeries.length >= 2) {
    const latest = releaseSeries[releaseSeries.length - 1]!;
    const prior = releaseSeries[releaseSeries.length - 2]!;
    if (latest.text_value && latest.text_value !== prior.text_value) {
      out.push({
        company_id: companyId, family: "github", signal_type: "release_activity", window_days: 0,
        from_observation_id: prior.id, to_observation_id: latest.id, from_value: null, to_value: null, delta: null, relative_change: null,
        rule_version: GITHUB_RULE_VERSION, explanation: `A new release was published (${latest.text_value}), superseding the previously observed release (${prior.text_value}).`,
        fired_at: new Date().toISOString(), metadata: null,
      });
    }
  }

  return out;
}

/**
 * LEVEL GitHub signals (V2-2B.1) — the GitHub-side half of the cold-start fix; see
 * rules/hiring.ts: deriveHiringLevelSignals for the full rationale (gated on
 * `metricSeries(...).length === 1`, fires at most once ever per company per metric, wording
 * restricted to describing the current state only). `now` is an explicit, injectable parameter
 * (not `Date.now()`), threaded down from orchestrate.ts's own `deps.now`, so the release-recency
 * check stays deterministic and testable like everything else in this codebase.
 */
export function deriveGithubLevelSignals(companyId: number, history: readonly Observation[], now: Date): Omit<DerivedSignal, "id">[] {
  const out: Omit<DerivedSignal, "id">[] = [];

  const commitsSeries = metricSeries(history, "github_commits_last_4w");
  if (commitsSeries.length === 1) {
    const obs = commitsSeries[0]!;
    if (obs.numeric_value !== null && obs.numeric_value >= GITHUB_LEVEL_THRESHOLDS.activeCommitsAtFirstObservation) {
      out.push(
        makeLevelSignal(
          companyId, "github", "active_development_present_at_first_observation", GITHUB_LEVEL_RULE_VERSION, obs,
          `${fmtNum(obs.numeric_value)} commits in the trailing 4 weeks observed at first look — notably active development present. No prior reading exists, so this is reported as the current level, not a change.`,
        ),
      );
    }
  }

  const contributorsSeries = metricSeries(history, "github_contributors");
  if (contributorsSeries.length === 1) {
    const obs = contributorsSeries[0]!;
    if (obs.numeric_value !== null && obs.numeric_value >= GITHUB_LEVEL_THRESHOLDS.contributorsAtFirstObservation) {
      out.push(
        makeLevelSignal(
          companyId, "github", "meaningful_contributor_count_at_first_observation", GITHUB_LEVEL_RULE_VERSION, obs,
          `${fmtNum(obs.numeric_value)} contributors observed at first look — a meaningful contributor base present. No prior reading exists, so this is reported as the current level, not a change.`,
        ),
      );
    }
  }

  // Recent-release-at-first-look: unlike the other level checks, this needs no history-count gate
  // beyond "first observation of this metric" — it's a freshness check on the reading's OWN
  // source-reported date, not a magnitude threshold, so there's nothing for a second observation
  // to add here (the existing velocity `release_activity` rule takes over once a SECOND, DIFFERENT
  // release is observed).
  const releaseSeries = metricSeries(history, "github_latest_release_at");
  if (releaseSeries.length === 1) {
    const obs = releaseSeries[0]!;
    if (obs.text_value) {
      const releaseAgeDays = (now.getTime() - new Date(obs.text_value).getTime()) / 86_400_000;
      if (releaseAgeDays >= 0 && releaseAgeDays <= GITHUB_LEVEL_THRESHOLDS.recentReleaseMaxAgeDays) {
        out.push(
          makeLevelSignal(
            companyId, "github", "recent_release_present_at_first_observation", GITHUB_LEVEL_RULE_VERSION, obs,
            `Most recent release (${obs.text_value}) is within the last ${Math.round(releaseAgeDays)} days — recent release activity present at first look.`,
          ),
        );
      }
    }
  }

  return out;
}
