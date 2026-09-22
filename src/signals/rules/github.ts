import type { DerivedSignal, Observation } from "../types.ts";
import { bestAvailableWindow, isPersistent, metricSeries } from "../velocity.ts";
import { GITHUB_RULE_VERSION, GITHUB_THRESHOLDS } from "./thresholds.ts";
import { fmtNum, fmtPct, makeSignal } from "./format.ts";

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
