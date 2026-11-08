import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeCorroboration, formatCorroborationReport } from "../src/analysis/corroboration.ts";

test("a company with no resolved signal source is excluded from the rate, not counted as uncorroborated", () => {
  const report = analyzeCorroboration([{ id: 1, discoveredAt: "2026-10-01T00:00:00Z", hasFundingEvent: true, hasAnySignalSource: false }], []);
  assert.equal(report.totalFundingDiscoveries, 1);
  assert.equal(report.eligibleForCorroboration, 0);
  assert.equal(report.corroboratedCount, 0);
  assert.equal(report.corroborationRate, null, "no eligible companies means the rate is undefined, not 0%");
});

test("a company not discovered via funding is excluded entirely, even with signals", () => {
  const report = analyzeCorroboration(
    [{ id: 1, discoveredAt: "2026-10-01T00:00:00Z", hasFundingEvent: false, hasAnySignalSource: true }],
    [{ companyId: 1, family: "github", firedAt: "2026-10-05T00:00:00Z" }],
  );
  assert.equal(report.totalFundingDiscoveries, 0);
  assert.equal(report.eligibleForCorroboration, 0);
});

test("lead time is measured in days from discovery to the FIRST signal, ignoring later ones", () => {
  const report = analyzeCorroboration(
    [{ id: 1, discoveredAt: "2026-10-01T00:00:00Z", hasFundingEvent: true, hasAnySignalSource: true }],
    [
      { companyId: 1, family: "website", firedAt: "2026-10-15T00:00:00Z" },
      { companyId: 1, family: "github", firedAt: "2026-10-06T00:00:00Z" }, // earlier — this one should win
    ],
  );
  assert.equal(report.corroboratedCount, 1);
  assert.equal(report.perCompany[0]!.firstSignalFamily, "github");
  assert.equal(report.perCompany[0]!.leadTimeDays, 5);
});

test("a company with a resolved source but zero fired signals is eligible but not corroborated", () => {
  const report = analyzeCorroboration([{ id: 1, discoveredAt: "2026-10-01T00:00:00Z", hasFundingEvent: true, hasAnySignalSource: true }], []);
  assert.equal(report.eligibleForCorroboration, 1);
  assert.equal(report.corroboratedCount, 0);
  assert.equal(report.corroborationRate, 0);
  assert.equal(report.perCompany[0]!.leadTimeDays, null);
});

test("median/mean/min/max are computed only over corroborated companies, and family counts sum to corroboratedCount", () => {
  const companies = [1, 2, 3].map((id) => ({ id, discoveredAt: "2026-10-01T00:00:00Z", hasFundingEvent: true, hasAnySignalSource: true }));
  const signals = [
    { companyId: 1, family: "github" as const, firedAt: "2026-10-03T00:00:00Z" }, // 2 days
    { companyId: 2, family: "hiring" as const, firedAt: "2026-10-11T00:00:00Z" }, // 10 days
    // company 3: no signal fired
  ];
  const report = analyzeCorroboration(companies, signals);
  assert.equal(report.eligibleForCorroboration, 3);
  assert.equal(report.corroboratedCount, 2);
  assert.equal(report.corroborationRate, Math.round((2 / 3) * 1000) / 1000);
  assert.equal(report.leadTimeDaysMedian, 6);
  assert.equal(report.leadTimeDaysMean, 6);
  assert.equal(report.leadTimeDaysMin, 2);
  assert.equal(report.leadTimeDaysMax, 10);
  assert.equal(report.firstSignalFamilyCounts.github, 1);
  assert.equal(report.firstSignalFamilyCounts.hiring, 1);
  assert.equal(report.firstSignalFamilyCounts.website, 0);
});

test("formatCorroborationReport explicitly reports zero-eligible rather than printing misleading n/a stats as if they were real", () => {
  const report = analyzeCorroboration([{ id: 1, discoveredAt: "2026-10-01T00:00:00Z", hasFundingEvent: true, hasAnySignalSource: false }], []);
  const text = formatCorroborationReport(report);
  assert.match(text, /nothing to report/);
  assert.doesNotMatch(text, /Lead time to first corroborating signal/);
});

test("formatCorroborationReport renders real stats when there is data", () => {
  const report = analyzeCorroboration(
    [{ id: 1, discoveredAt: "2026-10-01T00:00:00Z", hasFundingEvent: true, hasAnySignalSource: true }],
    [{ companyId: 1, family: "website", firedAt: "2026-10-04T00:00:00Z" }],
  );
  const text = formatCorroborationReport(report);
  assert.match(text, /median: 3/);
  assert.match(text, /website\s*: 1/);
});
