import assert from "node:assert/strict";
import { test } from "node:test";
import {
  freshnessHoursFor, hasPendingWebsiteChange, isFresh, websiteFreshnessHours,
  COLLECTION_FRESHNESS_HOURS, WEBSITE_FAILURE_FALLBACK_AFTER, WEBSITE_FRESHNESS_HOURS, WEBSITE_PENDING_FRESHNESS_HOURS,
} from "../src/signals/freshness.ts";
import type { Observation } from "../src/signals/types.ts";

/** V2-2B.2 — the per-source-type freshness policy matrix (design report §17). */

let nextId = 1;
function outcomeObs(hoursAgo: number, text: string, overrides: Partial<Observation> = {}): Observation {
  return {
    id: nextId++, company_id: 1, signal_source_id: 1, metric_name: "website_fetch_outcome", numeric_value: null, text_value: text,
    observed_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), source_timestamp: null, collection_version: "website-v1", raw_payload_ref: null, metadata: null,
    ...overrides,
  };
}
function pageObs(metric: string, hoursAgo: number, value: number, overrides: Partial<Observation> = {}): Observation {
  return {
    id: nextId++, company_id: 1, signal_source_id: 1, metric_name: metric, numeric_value: value, text_value: null,
    observed_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), source_timestamp: null, collection_version: "website-v1", raw_payload_ref: null, metadata: null,
    ...overrides,
  };
}

test("website freshness: never observed defaults to the normal (long) cadence — irrelevant anyway since isFresh treats it as never fresh", () => {
  assert.equal(websiteFreshnessHours([], 1), WEBSITE_FRESHNESS_HOURS);
});

test("website freshness: a stable 'ok' pass with no pending change uses the normal 166h cadence", () => {
  const history = [outcomeObs(48, "ok"), pageObs("website_page_pricing", 48, 1)];
  assert.equal(websiteFreshnessHours(history, 1), WEBSITE_FRESHNESS_HOURS);
});

test("website freshness: an unconfirmed page-state change (pending) uses the fast 22h re-check cadence", () => {
  const history = [
    outcomeObs(48, "ok"), outcomeObs(2, "ok"),
    pageObs("website_page_pricing", 48, 0), pageObs("website_page_pricing", 2, 1), // just flipped — unconfirmed
  ];
  assert.equal(websiteFreshnessHours(history, 1), WEBSITE_PENDING_FRESHNESS_HOURS);
});

test("website freshness: a single transient failure (timeout) uses the fast 22h retry cadence", () => {
  const history = [outcomeObs(48, "ok"), outcomeObs(2, "timeout")];
  assert.equal(websiteFreshnessHours(history, 1), WEBSITE_PENDING_FRESHNESS_HOURS);
});

test(`website freshness: ${WEBSITE_FAILURE_FALLBACK_AFTER} consecutive transient failures fall back to the normal (slow) cadence`, () => {
  const history = [outcomeObs(80, "timeout"), outcomeObs(60, "dns_failure"), outcomeObs(2, "http_5xx")];
  assert.equal(websiteFreshnessHours(history, 1), WEBSITE_FRESHNESS_HOURS);
});

test("website freshness: a 4th consecutive failure stays at the normal cadence (does not somehow get MORE frequent)", () => {
  const history = [outcomeObs(100, "timeout"), outcomeObs(80, "timeout"), outcomeObs(60, "timeout"), outcomeObs(2, "timeout")];
  assert.equal(websiteFreshnessHours(history, 1), WEBSITE_FRESHNESS_HOURS);
});

test("website freshness: a stable-but-unreachable outcome (blocked/robots_denied/non_html/offdomain_redirect/spa_shell) always uses the normal cadence, never the fast retry", () => {
  for (const outcome of ["blocked", "robots_denied", "non_html", "offdomain_redirect", "spa_shell"]) {
    assert.equal(websiteFreshnessHours([outcomeObs(2, outcome)], 1), WEBSITE_FRESHNESS_HOURS, `${outcome} should use the normal cadence`);
  }
});

test("website freshness: a transient failure immediately following a stable 'ok' history correctly uses the fast retry cadence (the streak counts only trailing failures)", () => {
  const history = [outcomeObs(200, "ok"), outcomeObs(150, "ok"), outcomeObs(2, "timeout")];
  assert.equal(websiteFreshnessHours(history, 1), WEBSITE_PENDING_FRESHNESS_HOURS);
});

test("hasPendingWebsiteChange: false when there's only one reading of a metric (nothing to compare)", () => {
  assert.equal(hasPendingWebsiteChange([pageObs("website_page_pricing", 2, 1)], 1), false);
});

test("hasPendingWebsiteChange: false when the last two readings agree", () => {
  const history = [pageObs("website_page_pricing", 48, 1), pageObs("website_page_pricing", 2, 1)];
  assert.equal(hasPendingWebsiteChange(history, 1), false);
});

test("hasPendingWebsiteChange: only looks at readings for THIS signal source, not another company/source's history", () => {
  const otherSource: Observation = { ...pageObs("website_page_pricing", 2, 1), signal_source_id: 999 };
  const history = [pageObs("website_page_pricing", 48, 0), otherSource];
  assert.equal(hasPendingWebsiteChange(history, 1), false, "signal_source_id 1 only has ONE reading of its own — nothing to compare");
});

test("freshnessHoursFor: dispatches to the website policy for a website source, and the flat default for everything else", () => {
  const websiteSource = { source_type: "website" as const, id: 1 };
  const githubSource = { source_type: "github_repo" as const, id: 2 };
  const history = [outcomeObs(2, "ok")];
  assert.equal(freshnessHoursFor(websiteSource, history), WEBSITE_FRESHNESS_HOURS);
  assert.equal(freshnessHoursFor(githubSource, history), COLLECTION_FRESHNESS_HOURS);
  assert.equal(freshnessHoursFor(githubSource, history, 99), 99, "a caller-supplied default is honored for non-website sources");
});

test("freshnessHoursFor + isFresh integration: a website source stays 'fresh' well past the flat 22h github/ats window", () => {
  const history = [outcomeObs(23, "ok")]; // 23h ago — would be STALE under the flat 22h github/ats policy
  const websiteSource = { source_type: "website" as const, id: 1 };
  const hours = freshnessHoursFor(websiteSource, history);
  assert.equal(isFresh(history, 1, new Date(), false, hours), true, "23h-old website data is still fresh under the 166h website cadence");
});
