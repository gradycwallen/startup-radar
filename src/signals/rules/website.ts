import { PAGE_TYPES, type PageType } from "../website/types.ts";
import type { DerivedSignal, Observation } from "../types.ts";

/**
 * V2-2B.2 deterministic website signals. No LLM decides anything here — see the design report
 * §4/§5/§9/§20/§22/§23 for the full rationale behind each rule below. Two kinds of signal:
 *
 *  - LEVEL (cold-start): `website_commercial_footprint_present_at_first_observation` — fires from
 *    the FIRST successful ("ok") website pass alone, describing the CURRENT footprint only. Never
 *    worded as "appeared"/"started". Gated (like every other level signal in this codebase — see
 *    rules/hiring.ts/rules/github.ts) so it can only ever be attempted from a company's single
 *    first "ok" pass; once a second "ok" pass exists, this function stops proposing it at all.
 *  - TRANSITION (appearance-only, confirmed): a page must go from a CONFIRMED-ABSENT reading to
 *    TWO CONSECUTIVE confirmed-present readings, all sharing one `collection_version`, with no
 *    earlier presence anywhere in history — see `findFirstAppearance` below. No removal signals
 *    exist (see the design report §14/§20/§25) — confirmed-absent rows are still stored (useful to
 *    a future rule), just never turned into a "disappeared" signal here.
 *
 * TIER is metadata only (`metadata.tier`), never a numeric score — see §9/§10 of the design
 * report: "combinations and named patterns, not an opaque point system."
 */

export const WEBSITE_LEVEL_RULE_VERSION = "website-level-v1";
export const WEBSITE_TRANSITION_RULE_VERSION = "website-transition-v1";

type Tier = "high" | "low";
const PAGE_TIER: Record<PageType, Tier> = { pricing: "high", enterprise: "high", security: "high", customers: "high", careers: "low" };
const HIGH_TIER_PAGES: readonly PageType[] = PAGE_TYPES.filter((p) => PAGE_TIER[p] === "high");

const PAGE_LABEL: Record<PageType, string> = {
  pricing: "Pricing", enterprise: "Enterprise", security: "Security/trust", customers: "Customer proof", careers: "Careers",
};

// ---- pass reconstruction ------------------------------------------------------------------------------------------
//
// One website pass writes several metric rows (website_fetch_outcome, website_homepage_prelaunch,
// website_page_*) that all share the EXACT SAME `observed_at` (see observe.ts: toObservations uses
// one `observedAt` per collection call). Grouping by that timestamp reconstructs "what the pass as
// a whole looked like" without needing a new table or a pass id — the existing append-only
// observations rows already carry everything needed.

interface PassSnapshot {
  observedAt: string;
  outcome: Observation | null;
  prelaunch: Observation | null;
  pages: Partial<Record<PageType, Observation>>;
}

function buildPassSnapshots(history: readonly Observation[]): PassSnapshot[] {
  const byTime = new Map<string, PassSnapshot>();
  for (const o of history) {
    if (!o.metric_name.startsWith("website_")) continue;
    let snap = byTime.get(o.observed_at);
    if (!snap) {
      snap = { observedAt: o.observed_at, outcome: null, prelaunch: null, pages: {} };
      byTime.set(o.observed_at, snap);
    }
    if (o.metric_name === "website_fetch_outcome") snap.outcome = o;
    else if (o.metric_name === "website_homepage_prelaunch") snap.prelaunch = o;
    else if (o.metric_name.startsWith("website_page_")) {
      const pt = o.metric_name.slice("website_page_".length) as PageType;
      if ((PAGE_TYPES as readonly string[]).includes(pt)) snap.pages[pt] = o;
    }
  }
  return [...byTime.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}

// ---- LEVEL: cold-start footprint present at first observation ------------------------------------------------------

/**
 * Fires AT MOST ONCE per company, ever — gated on there being exactly one "ok" website pass in
 * history (mirrors rules/hiring.ts/rules/github.ts's `metricSeries(...).length === 1` gate; once a
 * second "ok" pass exists, this stops being attempted at all, matching the discipline every other
 * level signal already follows).
 */
export function deriveWebsiteLevelSignals(companyId: number, history: readonly Observation[]): Omit<DerivedSignal, "id">[] {
  const snapshots = buildPassSnapshots(history);
  const okSnapshots = snapshots.filter((s) => s.outcome?.text_value === "ok");
  if (okSnapshots.length !== 1) return [];
  const first = okSnapshots[0]!;

  const present = PAGE_TYPES.filter((pt) => first.pages[pt]?.numeric_value === 1);
  const patterns: string[] = [];
  if (present.includes("enterprise") && present.includes("security")) patterns.push("enterprise_ready");
  if (present.includes("pricing") && present.includes("customers")) patterns.push("proven_commercial");
  if (patterns.length === 0) return []; // minimal/thin site at first look — no exaggerated signal (design report case A)

  const pageList = present
    .map((pt) => {
      const path = first.pages[pt]?.text_value;
      return path ? `${PAGE_LABEL[pt]} (${path})` : PAGE_LABEL[pt];
    })
    .join(", ");

  const anchor = first.outcome!;
  return [
    {
      company_id: companyId,
      family: "website",
      signal_type: "website_commercial_footprint_present_at_first_observation",
      window_days: 0,
      from_observation_id: null,
      to_observation_id: anchor.id,
      from_value: null,
      to_value: null,
      delta: null,
      relative_change: null,
      rule_version: WEBSITE_LEVEL_RULE_VERSION,
      explanation: `${pageList} present at first website observation. No prior reading exists, so this is reported as the current footprint, not a change.`,
      fired_at: new Date().toISOString(),
      metadata: { patterns, pages_present: present },
    },
  ];
}

// ---- TRANSITION: confirmed page appearance --------------------------------------------------------------------------

/**
 * Finds the FIRST qualifying "absent -> present -> present" run for one metric's known (written)
 * readings, in order:
 *   1. `before` confirmed absent (0), `at`/`after` both confirmed present (1) — three CONSECUTIVE
 *      KNOWN readings (unknown/unwritten passes never appear in `series` at all, so they're
 *      already skipped by construction — see sources/website.ts's missing-vs-zero discipline).
 *   2. all three share the same `collection_version` — a detector-version bump between the
 *      baseline and the confirmation must never masquerade as a real site change.
 *   3. the page was NEVER present anywhere before `before` — this is a FIRST appearance, not a
 *      reappearance after later flapping (flapping never re-fires: once a later index fails this
 *      check because presence already happened earlier, no subsequent candidate can pass it
 *      either, since the disqualifying presence only ever gets further in the past).
 */
function findFirstAppearance(series: readonly Observation[]): { from: Observation; to: Observation } | null {
  for (let i = 1; i + 1 < series.length; i++) {
    const before = series[i - 1]!, at = series[i]!, after = series[i + 1]!;
    if (before.numeric_value !== 0 || at.numeric_value !== 1 || after.numeric_value !== 1) continue;
    if (before.collection_version !== at.collection_version || at.collection_version !== after.collection_version) continue;
    if (series.slice(0, i - 1).some((o) => o.numeric_value === 1)) continue; // already present earlier — not a first appearance
    return { from: before, to: after };
  }
  return null;
}

function metricKnownSeries(history: readonly Observation[], metricName: string): Observation[] {
  return history.filter((o) => o.metric_name === metricName && (o.numeric_value === 0 || o.numeric_value === 1)).slice().sort((a, b) => a.observed_at.localeCompare(b.observed_at));
}

function appearanceSignal(companyId: number, pageType: PageType, transition: { from: Observation; to: Observation }): Omit<DerivedSignal, "id"> {
  const spanDays = (new Date(transition.to.observed_at).getTime() - new Date(transition.from.observed_at).getTime()) / 86_400_000;
  const path = transition.to.text_value ? ` (${transition.to.text_value})` : "";
  const confirmedAbsentOn = transition.from.observed_at.slice(0, 10);
  const firstSeenOn = transition.to.observed_at.slice(0, 10);
  return {
    company_id: companyId,
    family: "website",
    signal_type: `website_${pageType}_page_appeared`,
    window_days: 0,
    from_observation_id: transition.from.id,
    to_observation_id: transition.to.id,
    from_value: 0,
    to_value: 1,
    delta: 1,
    relative_change: null,
    rule_version: WEBSITE_TRANSITION_RULE_VERSION,
    explanation: `${PAGE_LABEL[pageType]} page${path} confirmed present, having been confirmed absent on ${confirmedAbsentOn} (~${Math.max(0, Math.round(spanDays))} days earlier, confirmed again by ${firstSeenOn}).`,
    fired_at: new Date().toISOString(),
    metadata: { tier: PAGE_TIER[pageType] },
  };
}

function isPrelaunchSnapshot(s: PassSnapshot): boolean {
  return s.prelaunch?.numeric_value === 1 && PAGE_TYPES.every((pt) => s.pages[pt]?.numeric_value !== 1);
}
function isPublicSnapshot(s: PassSnapshot): boolean {
  return s.prelaunch?.numeric_value === 0 && HIGH_TIER_PAGES.some((pt) => s.pages[pt]?.numeric_value === 1);
}

/** The website-side view of a stealth->public style transition — see the design report §8:
 * deliberately named/worded around what was actually observed (a website state change), never
 * claiming the company itself "was in stealth." Complements, does not replace, the existing
 * discovery-event `stealth_to_public` transition (transitions.ts). */
function findPrelaunchToPublicTransition(snapshots: readonly PassSnapshot[]): { from: Observation; to: Observation } | null {
  const known = snapshots.filter((s) => s.prelaunch !== null);
  const firstPrelaunchIdx = known.findIndex(isPrelaunchSnapshot);
  if (firstPrelaunchIdx === -1) return null;
  if (known.slice(0, firstPrelaunchIdx).some(isPublicSnapshot)) return null; // already looked public earlier — not a genuine first transition
  for (let j = firstPrelaunchIdx + 1; j + 1 < known.length; j++) {
    const a = known[j]!, b = known[j + 1]!;
    if (isPublicSnapshot(a) && isPublicSnapshot(b) && a.prelaunch!.collection_version === b.prelaunch!.collection_version) {
      return { from: known[firstPrelaunchIdx]!.prelaunch!, to: b.prelaunch! };
    }
  }
  return null;
}

export function deriveWebsiteTransitionSignals(companyId: number, history: readonly Observation[]): Omit<DerivedSignal, "id">[] {
  const out: Omit<DerivedSignal, "id">[] = [];

  for (const pageType of PAGE_TYPES) {
    const transition = findFirstAppearance(metricKnownSeries(history, `website_page_${pageType}`));
    if (transition) out.push(appearanceSignal(companyId, pageType, transition));
  }

  const snapshots = buildPassSnapshots(history);
  const prelaunchTransition = findPrelaunchToPublicTransition(snapshots);
  if (prelaunchTransition) {
    const spanDays = (new Date(prelaunchTransition.to.observed_at).getTime() - new Date(prelaunchTransition.from.observed_at).getTime()) / 86_400_000;
    out.push({
      company_id: companyId,
      family: "website",
      signal_type: "website_prelaunch_to_public",
      window_days: 0,
      from_observation_id: prelaunchTransition.from.id,
      to_observation_id: prelaunchTransition.to.id,
      from_value: null,
      to_value: null,
      delta: null,
      relative_change: null,
      rule_version: WEBSITE_TRANSITION_RULE_VERSION,
      explanation: `Website changed from a pre-launch landing page (waitlist/coming-soon language, no commercial pages) to a public site with at least one of pricing/enterprise/security/customer-proof pages present, confirmed twice over ~${Math.max(0, Math.round(spanDays))} days.`,
      fired_at: new Date().toISOString(),
      metadata: { tier: "high" },
    });
  }

  return out;
}
