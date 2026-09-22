import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveDiscoveryTransitions, detectStealthToPublic, type DiscoveryEventForTransitions } from "../src/signals/transitions.ts";

/**
 * V2-2B.1 — read-time transitions derived from EXISTING discovery_events (V2-1). No new collector,
 * no new schema, nothing persisted: call this again any time and it produces the same answer from
 * the same discovery_events, exactly like the rest of this module's "derived and recomputable"
 * discipline.
 */

function ev(eventType: string, eventDate: string | null, observedAt = "2026-09-22T00:00:00Z"): DiscoveryEventForTransitions {
  return { event_type: eventType, event_date: eventDate, observed_at: observedAt };
}

test("stealth -> public: a stealth event followed by a LATER funding event is detected", () => {
  const events = [ev("stealth", "2026-07-01"), ev("funding", "2026-09-01")];
  const t = detectStealthToPublic(events);
  assert.ok(t);
  assert.equal(t!.type, "stealth_to_public");
  assert.equal(t!.fromEventDate, "2026-07-01");
  assert.equal(t!.toEventDate, "2026-09-01");
  assert.match(t!.explanation, /stealth/i);
  assert.match(t!.explanation, /funding/i);
});

test("stealth -> public: a stealth event followed by a LATER product_launch or news event also qualifies", () => {
  assert.ok(detectStealthToPublic([ev("stealth", "2026-07-01"), ev("product_launch", "2026-08-01")]));
  assert.ok(detectStealthToPublic([ev("stealth", "2026-07-01"), ev("news", "2026-08-01")]));
});

test("no stealth event at all: no transition, never invented", () => {
  assert.equal(detectStealthToPublic([ev("funding", "2026-09-01"), ev("news", "2026-09-05")]), null);
});

test("a stealth event with NOTHING after it: no transition — 'currently in stealth' is not itself a transition", () => {
  assert.equal(detectStealthToPublic([ev("stealth", "2026-07-01")]), null);
});

test("AMBIGUOUS ORDERING: a stealth event that comes AFTER the public event (funding first, stealth mention later) must NOT be read as a transition", () => {
  // e.g. a retrospective article calling the company's earlier phase "stealth" after funding news
  // already ran — the funding event is NOT later than the stealth reference, so no transition.
  const events = [ev("funding", "2026-07-01"), ev("stealth", "2026-09-01")];
  assert.equal(detectStealthToPublic(events), null, "stealth must be the EARLIER event — reversed order must never produce a false transition");
});

test("AMBIGUOUS ORDERING: same-day stealth and funding events (event_date ties) never produce a transition either way", () => {
  const sameDay = [ev("stealth", "2026-09-01"), ev("funding", "2026-09-01")];
  assert.equal(detectStealthToPublic(sameDay), null, "a same-day tie is ambiguous ordering, not a real transition");
});

test("only the EARLIEST stealth event and the EARLIEST qualifying public event after it are used — many stealth/funding articles still produce exactly ONE transition", () => {
  const events = [
    ev("stealth", "2026-06-01"), ev("stealth", "2026-06-15"), // two stealth-tagged articles
    ev("funding", "2026-08-01"), ev("news", "2026-08-10"), ev("funding", "2026-09-01"), // several public articles
  ];
  const transitions = deriveDiscoveryTransitions(events);
  assert.equal(transitions.length, 1, "many corroborating articles on both sides must still yield exactly one transition, not a burst");
  assert.equal(transitions[0]!.fromEventDate, "2026-06-01", "the EARLIEST stealth event is used");
  assert.equal(transitions[0]!.toEventDate, "2026-08-01", "the EARLIEST qualifying public event after stealth is used");
});

test("events with no event_date fall back to observed_at for ordering, matching the fallback used elsewhere in this codebase", () => {
  const events = [ev("stealth", null, "2026-07-01T00:00:00Z"), ev("funding", null, "2026-09-01T00:00:00Z")];
  const t = detectStealthToPublic(events);
  assert.ok(t, "null event_date must not prevent detection — observed_at still orders these correctly");
  assert.equal(t!.fromEventDate, null, "the transition object reports the real event_date (null), never fabricating one");
});

test("an accelerator or open_source event alone (never followed by funding/product_launch/news) does not count as 'public' — the type list is deliberately narrow", () => {
  const events = [ev("stealth", "2026-07-01"), ev("accelerator", "2026-08-01")];
  assert.equal(detectStealthToPublic(events), null, "accelerator is not in the deliberately narrow PUBLIC_EVENT_TYPES set");
});

test("deriveDiscoveryTransitions: a company with no discovery_events at all produces no transitions, without throwing", () => {
  assert.deepEqual(deriveDiscoveryTransitions([]), []);
});

test("calling this twice on the SAME input produces the SAME result — purely derived, recomputable, nothing persisted or mutated", () => {
  const events = [ev("stealth", "2026-07-01"), ev("funding", "2026-09-01")];
  const first = deriveDiscoveryTransitions(events);
  const second = deriveDiscoveryTransitions(events);
  assert.deepEqual(first, second);
});
