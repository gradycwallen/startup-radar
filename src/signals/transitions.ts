/**
 * V2-2B.1: read-time deterministic transitions derived from a company's EXISTING discovery_events
 * history (V2-1) — no new collector, no new schema, nothing persisted. A company's event_type
 * history is already captured by V2-1's discovery funnel; this module simply asks a new question
 * of data we already have, the same way velocity.ts derives comparisons from data observe.ts
 * already collected. Never a duplicate observation, never persisted, always recomputable — call it
 * again any time and it produces the same answer from the same discovery_events.
 *
 * Deliberately narrow, decoupled input shape (not V1's own EventRow/CompanyRow) — the same "must
 * not couple to V1 discovery internals" discipline CompanyContext already follows (see types.ts).
 */

export interface DiscoveryEventForTransitions {
  event_type: string;
  /** date, no time — matches public.discovery_events.event_date. */
  event_date: string | null;
  /** ISO timestamptz — when Scout recorded this event. Used as the ordering key ONLY when
   * event_date is absent, matching the same fallback already used elsewhere in this codebase
   * (src/lib/data/companies.ts, frontend momentum.ts). */
  observed_at: string;
}

export type DiscoveryTransitionType = "stealth_to_public";

export interface DiscoveryTransition {
  type: DiscoveryTransitionType;
  fromEventDate: string | null;
  toEventDate: string | null;
  toEventType: string;
  explanation: string;
}

function effectiveTimeMs(e: DiscoveryEventForTransitions): number {
  return new Date(e.event_date ?? e.observed_at).getTime();
}

/** Event types that constitute "public" evidence for the stealth->public transition. `news` is
 * included deliberately conservatively — a `news` mention alone is weaker evidence than a funding
 * round or product launch, but is still genuinely public coverage, which is the only thing this
 * transition claims (it does NOT claim funding or a launch specifically happened). */
const PUBLIC_EVENT_TYPES = new Set(["funding", "product_launch", "news"]);

/**
 * Detects stealth -> public: an EARLIEST `stealth` event followed by a STRICTLY LATER
 * `funding`/`product_launch`/`news` event. Both endpoints use only real timestamps already on the
 * event rows — nothing invented. "Strictly later" (not same-day-or-later) is enforced via real
 * parsed timestamps specifically to avoid the ambiguous-ordering case the V2-2B.1 brief warns
 * against: two events dated the same day, in whichever order the funnel happened to write them,
 * must never be read as a transition in either direction.
 *
 * Only the FIRST stealth event and the FIRST qualifying public event after it are used, so a
 * company with several stealth-tagged articles and several funding articles still produces exactly
 * ONE transition, not a burst of near-duplicate ones.
 */
export function detectStealthToPublic(events: readonly DiscoveryEventForTransitions[]): DiscoveryTransition | null {
  const stealthEvents = [...events].filter((e) => e.event_type === "stealth").sort((a, b) => effectiveTimeMs(a) - effectiveTimeMs(b));
  if (stealthEvents.length === 0) return null;
  const firstStealth = stealthEvents[0]!;
  const stealthMs = effectiveTimeMs(firstStealth);

  const publicEvents = events
    .filter((e) => PUBLIC_EVENT_TYPES.has(e.event_type) && effectiveTimeMs(e) > stealthMs)
    .sort((a, b) => effectiveTimeMs(a) - effectiveTimeMs(b));
  if (publicEvents.length === 0) return null;
  const firstPublic = publicEvents[0]!;

  const publicLabel = firstPublic.event_type === "funding" ? "a funding event" : firstPublic.event_type === "product_launch" ? "a product launch" : "public news coverage";
  return {
    type: "stealth_to_public",
    fromEventDate: firstStealth.event_date,
    toEventDate: firstPublic.event_date,
    toEventType: firstPublic.event_type,
    explanation: `Emerged from stealth${firstStealth.event_date ? ` (${firstStealth.event_date})` : ""} and was later covered by ${publicLabel}${firstPublic.event_date ? ` (${firstPublic.event_date})` : ""}.`,
  };
}

/** All discovery-event transitions detected for one company. Currently just stealth_to_public —
 * the one example the V2-2B design brief called out as highest-priority; more can be added here
 * later without touching any caller, same pattern as observe.ts's family dispatch. */
export function deriveDiscoveryTransitions(events: readonly DiscoveryEventForTransitions[]): DiscoveryTransition[] {
  const stealthToPublic = detectStealthToPublic(events);
  return stealthToPublic ? [stealthToPublic] : [];
}
