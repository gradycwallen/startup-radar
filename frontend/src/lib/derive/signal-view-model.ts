import type { DerivedSignal, SignalIntelligence, SignalObservation, SignalSource } from "@/lib/data/types";

/**
 * V2-3A — Signal Intelligence's presentation layer. Turns raw `DerivedSignal`/`SignalObservation`/
 * `SignalSource` rows into `SignalViewModel`s components can render directly, with NO switch
 * statement over `signal_type` living in a component. This is the ONE place that:
 *   - decides human titles/wording for known `signal_type` values, and humanizes an unrecognized
 *     one gracefully rather than throwing or hiding it (a real requirement — the backend's own
 *     `signal_type`/`family` are deliberately open strings, not closed unions, so new ones can
 *     appear before this file is updated);
 *   - enforces the first-look/transition wording discipline (never "appeared"/"increased"/
 *     "started"/"surged"/"new" for a first-look signal — the backend already writes honest
 *     first-look explanations, so this layer's job is to never UNDO that, not to relax it);
 *   - decides what evidence is worth showing and strips everything else (no `rule_version`, no
 *     observation ids, no raw `metadata` JSON, no internal database language) — see root
 *     CLAUDE.md and the V2-3A delivery report.
 *
 * Every function here is PURE — no fetching, no React, no Next.js — so it's fully unit-testable
 * without a server, a database, or a rendered component (see frontend/test/signal-view-model.test.ts).
 */

export type SignalKind = "first_look" | "transition";
export type Tier = "high" | "low" | null;

export interface EvidenceItem {
  label: string;
  value: string;
}

export interface SourceLink {
  label: string;
  url: string;
}

/** One step in a website page's absent→present→confirmed progression (see `buildProgression`).
 * Only ever built from REAL observation rows already in hand — a step is never invented, and a
 * missing middle reading simply means a 2-step (not 3-step) progression, never a fabricated one. */
export interface ProgressionStep {
  label: string;
  date: string; // ISO timestamptz, formatted by the caller
}

export interface SignalViewModel {
  id: number;
  family: string;
  familyLabel: string;
  kind: SignalKind;
  title: string;
  explanation: string;
  tier: Tier;
  firedAt: string;
  evidence: EvidenceItem[];
  sourceLinks: SourceLink[];
  /** Only ever populated for `kind: "transition"` website signals — see `buildProgression`. */
  progression: ProgressionStep[];
}

// ---- family --------------------------------------------------------------------------------------------------

const FAMILY_LABELS: Record<string, string> = { hiring: "Hiring", github: "GitHub", website: "Website" };

function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? humanize(family);
}

// ---- kind classification ---------------------------------------------------------------------------------------

/** Every LEVEL/cold-start `signal_type` the backend produces ends in this exact suffix — a
 * deliberate backend naming convention (see rules/hiring.ts, rules/github.ts, rules/website.ts in
 * the repo root), so classifying "first look vs. transition" needs no per-type lookup table entry
 * and automatically classifies a future first-look signal type correctly too.
 *
 * Deliberately "_at_first_observation", NOT "_present_at_first_observation": most level signals
 * include "present" (`high_hiring_present_at_first_observation`), but at least one real one
 * doesn't (`meaningful_contributor_count_at_first_observation`) — found by this file's own test
 * suite. The shorter suffix is the one invariant that's actually true of every level signal today. */
const FIRST_LOOK_SUFFIX = "_at_first_observation";

export function classifyKind(signalType: string): SignalKind {
  return signalType.endsWith(FIRST_LOOK_SUFFIX) ? "first_look" : "transition";
}

// ---- titles --------------------------------------------------------------------------------------------------
//
// First-look titles describe a STATE ("... detected") — never a verb of change. Transition titles
// describe REAL change ("appeared"/"increased"/"started"/"surged" are accurate and required here,
// since the backend only ever uses these signal_types for a confirmed, evidenced change over time.

const SIGNAL_TITLES: Record<string, string> = {
  // hiring — first-look
  high_hiring_present_at_first_observation: "High hiring activity detected",
  sales_hiring_present_at_first_observation: "Sales hiring detected",
  enterprise_sales_role_present_at_first_observation: "Enterprise sales role detected",
  recruiting_role_present_at_first_observation: "Recruiting role detected",
  security_compliance_role_present_at_first_observation: "Security/compliance hiring detected",
  // hiring — transition
  open_jobs_surge: "Hiring surged",
  open_jobs_increase: "Hiring increased",
  engineering_hiring_increase: "Engineering hiring increased",
  sales_hiring_started: "Sales hiring started",
  enterprise_sales_hiring_started: "Enterprise sales hiring started",
  recruiting_hiring_started: "Recruiting hiring started",
  security_hiring_started: "Security hiring started",
  // github — first-look
  active_development_present_at_first_observation: "Active development detected",
  meaningful_contributor_count_at_first_observation: "Meaningful contributor activity detected",
  recent_release_present_at_first_observation: "Recent release activity detected",
  // github — transition
  star_velocity_increase: "GitHub stars increased",
  contributor_growth: "Contributor base grew",
  commit_activity_increase: "Development activity increased",
  quiet_to_active: "Development activity resumed",
  release_activity: "New release published",
  // website — first-look
  website_commercial_footprint_present_at_first_observation: "Commercial website footprint detected",
  // website — transition
  website_pricing_page_appeared: "Pricing page appeared",
  website_enterprise_page_appeared: "Enterprise page appeared",
  website_security_page_appeared: "Security page appeared",
  website_customer_proof_appeared: "Customer proof appeared",
  website_careers_page_appeared: "Careers page appeared",
  website_prelaunch_to_public: "Website moved from pre-launch to public",
};

/** Humanizes an UNKNOWN signal_type conservatively: `some_new_signal_type` -> "Some new signal
 * type". Never throws, never hides the signal — matches `eventTypeMeta`'s own fallback pattern
 * (src/lib/derive/event-type.ts) for the exact same reason. */
function humanize(raw: string): string {
  const spaced = raw.replace(/_/g, " ").trim();
  if (!spaced) return "Signal detected";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function titleFor(signalType: string): string {
  return SIGNAL_TITLES[signalType] ?? humanize(signalType);
}

// ---- metric labels (for evidence) ---------------------------------------------------------------------------

const METRIC_LABELS: Record<string, string> = {
  ats_open_jobs_total: "Open positions",
  ats_open_jobs_engineering: "Engineering openings",
  ats_open_jobs_sales: "Sales openings",
  ats_has_enterprise_sales_role: "Enterprise sales role",
  ats_has_recruiting_role: "Recruiting role",
  ats_has_security_compliance_role: "Security/compliance role",
  github_stars: "GitHub stars",
  github_forks: "Forks",
  github_open_issues: "Open issues",
  github_contributors: "Contributors",
  github_commits_last_4w: "Commits (trailing 4 weeks)",
  github_latest_release_at: "Latest release",
  github_org_public_repos: "Public repositories",
  website_page_pricing: "Pricing page",
  website_page_enterprise: "Enterprise page",
  website_page_security: "Security page",
  website_page_customers: "Customer proof page",
  website_page_careers: "Careers page",
  website_homepage_prelaunch: "Pre-launch marker",
};

function metricLabel(metricName: string | undefined): string {
  if (!metricName) return "Value";
  return METRIC_LABELS[metricName] ?? humanize(metricName.replace(/^(ats_|github_|website_)/, ""));
}

/** Natural "X observed" phrasing for a SINGLE known value (no prior reading to compare against —
 * see buildEvidence's `to_value`-only branch). Deliberately its own map, not a suffix glued onto
 * `metricLabel`: "Commits (trailing 4 weeks) observed" reads worse than "Commits observed," and
 * this is the one place that specific phrasing is needed. Falls back to a generic, still-honest
 * "Observed value" for a metric this file doesn't have a natural label for — never a raw metric_name. */
const SINGLE_VALUE_LABELS: Record<string, string> = {
  github_commits_last_4w: "Commits observed",
  github_contributors: "Contributors observed",
  github_stars: "Stars observed",
  github_forks: "Forks observed",
  github_open_issues: "Open issues observed",
  github_org_public_repos: "Public repositories observed",
  ats_open_jobs_total: "Open positions observed",
  ats_open_jobs_engineering: "Engineering openings observed",
  ats_open_jobs_sales: "Sales openings observed",
};

function singleValueLabel(metricName: string | undefined): string {
  if (!metricName) return "Observed value";
  return SINGLE_VALUE_LABELS[metricName] ?? "Observed value";
}

// ---- formatting -----------------------------------------------------------------------------------------------

function fmtNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function fmtPercent(relativeChange: number): string {
  return `${relativeChange >= 0 ? "+" : ""}${Math.round(relativeChange * 100)}%`;
}

function fmtDateOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---- lookup helpers over the raw arrays --------------------------------------------------------------------

function indexById<T extends { id: number }>(rows: readonly T[]): Map<number, T> {
  return new Map(rows.map((r) => [r.id, r]));
}

// ---- evidence -------------------------------------------------------------------------------------------------

const PAGE_METRIC_TO_TYPE: Record<string, string> = {
  website_page_pricing: "pricing", website_page_enterprise: "enterprise", website_page_security: "security",
  website_page_customers: "customers", website_page_careers: "careers",
};

/** Pulls a small, safe evidence set from an observation's own `metadata` — path/URL only, never
 * raw checks/title/h1/nav_fingerprint (those exist for backend debugging, not end-user display). */
function pageEvidenceFromObservation(obs: SignalObservation | undefined): { path: string | null } {
  if (!obs) return { path: null };
  return { path: obs.textValue };
}

function buildEvidence(signal: DerivedSignal, obsById: Map<number, SignalObservation>): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  const toObs = signal.toObservationId !== null ? obsById.get(signal.toObservationId) : undefined;
  const fromObs = signal.fromObservationId !== null ? obsById.get(signal.fromObservationId) : undefined;

  // Cold-start website footprint: list every present page named in the signal's own metadata,
  // with each page's real resolved path pulled from its own observation (same fired pass).
  const pagesPresent = signal.metadata?.pagesPresent ?? signal.metadata?.pages_present;
  if (Array.isArray(pagesPresent) && toObs) {
    for (const page of pagesPresent) {
      if (typeof page !== "string") continue;
      const metricName = `website_page_${page}`;
      const label = METRIC_LABELS[metricName] ?? humanize(page);
      evidence.push({ label, value: "Present" });
    }
    return evidence;
  }

  // A numeric window comparison (hiring/github velocity signals) — the signal row already carries
  // from_value/to_value/relative_change; no need to dig into observations for these.
  if (signal.fromValue !== null && signal.toValue !== null) {
    evidence.push({ label: metricLabel(toObs?.metricName), value: `${fmtNumber(signal.fromValue)} → ${fmtNumber(signal.toValue)}` });
    if (signal.windowDays > 0) evidence.push({ label: "Window", value: `${Math.round(signal.windowDays)} days` });
    if (signal.relativeChange !== null) evidence.push({ label: "Change", value: fmtPercent(signal.relativeChange) });
    return evidence;
  }

  // A cold-start LEVEL signal's single known value — no prior reading exists at all (makeLevelSignal
  // always leaves from_value null; see rules/hiring.ts/rules/github.ts in the repo root), so there is
  // genuinely nothing to compare against. Show the one real number Scout has ("Commits observed:
  // 385"), never a fabricated "from," and never a "0 →" that would misread as a real prior reading.
  if (signal.fromValue === null && signal.toValue !== null) {
    evidence.push({ label: singleValueLabel(toObs?.metricName), value: fmtNumber(signal.toValue) });
    return evidence;
  }

  // release_activity: no numeric value — the real evidence is the two release dates themselves.
  if (fromObs?.textValue && toObs?.textValue) {
    evidence.push({ label: "Previous release", value: fmtDateOnly(fromObs.textValue) });
    evidence.push({ label: "New release", value: fmtDateOnly(toObs.textValue) });
    return evidence;
  }

  // A single website page appearance — show the resolved page path.
  if (toObs && PAGE_METRIC_TO_TYPE[toObs.metricName]) {
    const { path } = pageEvidenceFromObservation(toObs);
    evidence.push({ label: metricLabel(toObs.metricName), value: path ?? "Confirmed present" });
    return evidence;
  }

  // Nothing structured to show — the explanation text alone is the evidence. Empty array is fine;
  // callers render nothing rather than an empty disclosure.
  return evidence;
}

// ---- progression (website transitions only) --------------------------------------------------------------------

/**
 * The confirmed-absent -> first-observed -> confirmed progression (design report §7/§4). ONLY
 * built for website-family transitions, where the backend's own semantics are genuinely a 3-state
 * absent/present/confirmed shape (see rules/website.ts: findFirstAppearance in the repo root) —
 * hiring/github transitions are numeric window comparisons, a different (already-covered-by-
 * evidence) shape, not this one.
 *
 * The middle "first observed" reading is recovered by looking for any OTHER observation of the
 * SAME metric/source strictly between the signal's own from/to anchors — it is never invented: if
 * no such reading exists in the data (or the anchors themselves don't resolve), this returns a
 * shorter (or empty) list rather than fabricating a step.
 */
function buildProgression(signal: DerivedSignal, obsById: Map<number, SignalObservation>, allObservations: readonly SignalObservation[]): ProgressionStep[] {
  if (signal.family !== "website" || signal.fromObservationId === null || signal.toObservationId === null) return [];
  const fromObs = obsById.get(signal.fromObservationId);
  const toObs = obsById.get(signal.toObservationId);
  if (!fromObs || !toObs) return [];

  const steps: ProgressionStep[] = [{ label: "Confirmed absent", date: fromObs.observedAt }];

  const middle = allObservations
    .filter((o) => o.metricName === fromObs.metricName && o.signalSourceId === fromObs.signalSourceId && o.observedAt > fromObs.observedAt && o.observedAt < toObs.observedAt)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  if (middle.length > 0) steps.push({ label: "First observed", date: middle[0]!.observedAt });

  steps.push({ label: "Confirmed", date: toObs.observedAt });
  return steps;
}

// ---- source links ----------------------------------------------------------------------------------------------

const SOURCE_TYPE_LINK_LABEL: Record<string, string> = {
  github_org: "View organization", github_repo: "View repository", greenhouse: "View job board", lever: "View job board", ashby: "View job board", website: "View website",
};

function buildSourceLinks(signal: DerivedSignal, sourcesByCompany: readonly SignalSource[], toObs: SignalObservation | undefined): SourceLink[] {
  const links: SourceLink[] = [];

  // A specific resolved page (website signals) — the REAL final URL Scout actually verified, never
  // a constructed/guessed one. Preferred over the generic source link below when available.
  const finalUrl = metadataString(toObs?.metadata, "final_url") ?? metadataString(toObs?.metadata, "finalUrl");
  if (finalUrl && finalUrl.startsWith("https://")) {
    links.push({ label: "View page", url: finalUrl });
    return links;
  }

  const matched =
    signal.family === "github" ? sourcesByCompany.find((s) => s.sourceType === "github_org" || s.sourceType === "github_repo")
    : signal.family === "hiring" ? sourcesByCompany.find((s) => s.sourceType === "greenhouse" || s.sourceType === "lever" || s.sourceType === "ashby")
    : sourcesByCompany.find((s) => s.sourceType === "website");

  if (matched?.canonicalUrl) links.push({ label: SOURCE_TYPE_LINK_LABEL[matched.sourceType] ?? "View source", url: matched.canonicalUrl });
  return links;
}

// ---- assembly -------------------------------------------------------------------------------------------------

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = metadata?.[key];
  return typeof v === "string" ? v : null;
}

function tierFor(signal: DerivedSignal): Tier {
  const raw = metadataString(signal.metadata, "tier");
  return raw === "high" || raw === "low" ? raw : null;
}

function buildOne(signal: DerivedSignal, obsById: Map<number, SignalObservation>, allObservations: readonly SignalObservation[], sourcesByCompany: readonly SignalSource[]): SignalViewModel {
  const toObs = signal.toObservationId !== null ? obsById.get(signal.toObservationId) : undefined;
  return {
    id: signal.id,
    family: signal.family,
    familyLabel: familyLabel(signal.family),
    kind: classifyKind(signal.signalType),
    title: titleFor(signal.signalType),
    explanation: signal.explanation,
    tier: tierFor(signal),
    firedAt: signal.firedAt,
    evidence: buildEvidence(signal, obsById),
    sourceLinks: buildSourceLinks(signal, sourcesByCompany, toObs),
    progression: buildProgression(signal, obsById, allObservations),
  };
}

/** Builds every signal's view model for one company, newest-fired first. Never throws — a signal
 * whose anchors don't resolve, or whose metadata is sparse/malformed, still produces a valid view
 * model (with less evidence, never a crash). */
export function buildSignalViewModels(intelligence: SignalIntelligence): SignalViewModel[] {
  const obsById = indexById(intelligence.observations);
  return intelligence.signals
    .map((s) => buildOne(s, obsById, intelligence.observations, intelligence.sources))
    .sort((a, b) => b.firedAt.localeCompare(a.firedAt));
}

// ---- coverage -------------------------------------------------------------------------------------------------

export type HistoryClass = "early_evidence" | "developing_history" | "longitudinal_history";

const LONGITUDINAL_MIN_DAYS = 30;

/** The one-line Coverage description (design report §5/§9, approved wording). Returns null when
 * there are no resolved sources at all — that case is handled by the empty-state copy instead
 * (see EMPTY_STATE_COPY below), not by this function. Deliberately never shows a raw observation
 * count, a percentage, or anything score-shaped — see the approved constraints. */
export function buildCoverageLine(intelligence: SignalIntelligence): string | null {
  if (intelligence.sources.length === 0) return null;
  if (intelligence.signals.length === 0) return "Tracking started";

  const times = intelligence.observations.map((o) => new Date(o.observedAt).getTime()).filter((t) => !Number.isNaN(t));
  const spanDays = times.length >= 2 ? (Math.max(...times) - Math.min(...times)) / 86_400_000 : 0;

  let historyClass: HistoryClass;
  let base: string;
  if (spanDays < 1) {
    historyClass = "early_evidence";
    base = "Early evidence";
  } else if (spanDays < LONGITUDINAL_MIN_DAYS) {
    historyClass = "developing_history";
    base = `Developing history · Tracked for ${Math.round(spanDays)} days`;
  } else {
    historyClass = "longitudinal_history";
    base = `Longitudinal history · Tracked for ${Math.round(spanDays)} days`;
  }
  void historyClass; // kept for callers that may want it later; not currently branched on further

  const familyCount = new Set(intelligence.signals.map((s) => s.family)).size;
  const familiesWord = familyCount === 1 ? "signal family" : "signal families";
  return `${base} · ${familyCount} ${familiesWord} observed`;
}

// ---- empty-state copy (single source of truth — see the approved wording) -----------------------------------

export const SIGNAL_EMPTY_STATE_COPY = {
  /** No signal_sources resolved at all yet. */
  noSources: "Signal tracking has not started for this company yet.",
  /** Sources resolved, but deriveSignalsForCompany hasn't fired anything yet. */
  noSignalsYet: "Tracking started — no notable change detected yet.",
  /** A specific piece of evidence Scout hasn't determined (page/metric unknown) — used inside
   * evidence rendering, never as a top-level section message. */
  notYetDetermined: "Not yet determined",
} as const;
