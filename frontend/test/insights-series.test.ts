import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSourceMix, buildWeeklyDiscoveryVolume, buildWeeklySignalVolume } from "../src/lib/derive/insights-series.ts";

const NOW = new Date("2026-11-07T00:00:00Z"); // a Saturday

test("a week with zero real companies shows as a real zero bucket, not a gap in the series", () => {
  const buckets = buildWeeklyDiscoveryVolume(
    [{ discoveredAt: "2026-10-05T00:00:00Z", discoverySource: "yc-directory" }, { discoveredAt: "2026-11-02T00:00:00Z", discoverySource: "yc-directory" }],
    NOW,
  );
  // weeks between the first and last company should all be present, including silent ones
  assert.ok(buckets.length >= 4, `expected several weekly buckets spanning the range, got ${buckets.length}`);
  const zeroWeeks = buckets.filter((b) => b.count === 0);
  assert.ok(zeroWeeks.length > 0, "at least one genuinely silent week should appear as count:0, not be omitted");
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  assert.equal(total, 2, "every real company must be counted exactly once across all buckets");
});

test("buildWeeklyDiscoveryVolume with no companies at all returns an empty series, not a crash", () => {
  assert.deepEqual(buildWeeklyDiscoveryVolume([], NOW), []);
});

test("buildWeeklySignalVolume filters to exactly one family and still covers the full week range from ALL signals, not just that family's own range", () => {
  const signals = [
    { family: "github", firedAt: "2026-10-05T00:00:00Z" },
    { family: "hiring", firedAt: "2026-11-02T00:00:00Z" }, // later than github's own range
  ];
  const githubBuckets = buildWeeklySignalVolume(signals, "github", NOW);
  const total = githubBuckets.reduce((sum, b) => sum + b.count, 0);
  assert.equal(total, 1, "only the github-family signal should be counted");
  assert.ok(githubBuckets.length >= 4, "the week range should extend through the hiring signal's later date too, since the whole-dataset range anchors it");
});

test("buildSourceMix groups a null discovery_source under 'Unlabeled' rather than dropping the company", () => {
  const mix = buildSourceMix([
    { discoveredAt: "2026-10-01T00:00:00Z", discoverySource: "yc-directory" },
    { discoveredAt: "2026-10-01T00:00:00Z", discoverySource: null },
  ]);
  assert.equal(mix.length, 2);
  assert.ok(mix.some((m) => m.source === "Unlabeled" && m.count === 1));
});

test("buildSourceMix sorts by count descending", () => {
  const mix = buildSourceMix([
    { discoveredAt: "2026-10-01T00:00:00Z", discoverySource: "a" },
    { discoveredAt: "2026-10-01T00:00:00Z", discoverySource: "b" },
    { discoveredAt: "2026-10-01T00:00:00Z", discoverySource: "b" },
  ]);
  assert.deepEqual(mix.map((m) => m.source), ["b", "a"]);
});
