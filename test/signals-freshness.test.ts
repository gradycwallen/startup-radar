import assert from "node:assert/strict";
import { test } from "node:test";
import { COLLECTION_FRESHNESS_HOURS, isFresh, mostRecentObservedAt } from "../src/signals/freshness.ts";
import { obs } from "./fixtures/signals/scenarios.ts";

test("mostRecentObservedAt: the latest observed_at across ALL metrics for one source, ignoring other sources", () => {
  const history = [obs(1, 1, "a", 1, 10), obs(1, 1, "b", 2, 3), obs(1, 2, "a", 3, 0) /* different source */];
  assert.equal(mostRecentObservedAt(history, 1), history[1]!.observed_at, "the most recent of source 1's own observations (3 days ago), not source 2's");
  assert.equal(mostRecentObservedAt(history, 999), null, "a source with zero observations has no 'most recent' at all");
});

test("isFresh: a source collected within the freshness window is fresh (skip); one collected longer ago is not", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const collectedRecently = [obs(1, 1, "x", 1, 0, { observed_at: new Date(now.getTime() - 2 * 3_600_000).toISOString() })];
  assert.equal(isFresh(collectedRecently, 1, now, false), true, "collected 2h ago, well inside the cooldown");

  const collectedLongAgo = [obs(1, 1, "x", 1, 0, { observed_at: new Date(now.getTime() - 25 * 3_600_000).toISOString() })];
  assert.equal(isFresh(collectedLongAgo, 1, now, false), false, "collected 25h ago, past the cooldown");
});

test("isFresh: a source with NO prior observation is never fresh — there is nothing to have gone stale", () => {
  assert.equal(isFresh([], 1, new Date(), false), false);
});

test("isFresh: --force bypasses the cooldown unconditionally, but is never the default (caller must opt in)", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const justCollected = [obs(1, 1, "x", 1, 0, { observed_at: now.toISOString() })];
  assert.equal(isFresh(justCollected, 1, now, false), true, "without force, a just-collected source is fresh");
  assert.equal(isFresh(justCollected, 1, now, true), false, "with force=true, freshness is bypassed entirely");
});

test("isFresh: the freshness threshold is centralized and honored at its exact boundary", () => {
  assert.equal(COLLECTION_FRESHNESS_HOURS, 22, "the documented, centralized threshold — change this constant, not scattered literals, if it ever needs to move");
  const now = new Date("2026-09-22T12:00:00Z");
  const justUnderThreshold = [obs(1, 1, "x", 1, 0, { observed_at: new Date(now.getTime() - (COLLECTION_FRESHNESS_HOURS - 1) * 3_600_000).toISOString() })];
  assert.equal(isFresh(justUnderThreshold, 1, now, false), true);
  const justOverThreshold = [obs(1, 1, "x", 1, 0, { observed_at: new Date(now.getTime() - (COLLECTION_FRESHNESS_HOURS + 1) * 3_600_000).toISOString() })];
  assert.equal(isFresh(justOverThreshold, 1, now, false), false);
});

test("isFresh: a custom freshnessHours override is honored (used by tests / could be tuned later without code changes)", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const history = [obs(1, 1, "x", 1, 0, { observed_at: new Date(now.getTime() - 5 * 3_600_000).toISOString() })];
  assert.equal(isFresh(history, 1, now, false, 4), false, "5h old, but the override cooldown is only 4h");
  assert.equal(isFresh(history, 1, now, false, 6), true, "5h old, and the override cooldown is 6h");
});
