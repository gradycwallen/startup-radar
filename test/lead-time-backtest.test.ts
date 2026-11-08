import assert from "node:assert/strict";
import { test } from "node:test";
import { backtestLeadTime, formatLeadTimeBacktestReport } from "../src/analysis/lead-time-backtest.ts";

test("same-round corroboration (multiple articles, dates within the gap window) is NOT treated as two rounds", () => {
  const report = backtestLeadTime(
    [
      { companyId: 1, eventDate: "2026-10-01" },
      { companyId: 1, eventDate: "2026-10-02" },
      { companyId: 1, eventDate: "2026-10-03" },
    ],
    [],
  );
  assert.equal(report.companiesWithMultipleFundingEvents, 1);
  assert.equal(report.companiesWithGenuineSubsequentRound, 0, "a 2-day spread is one announcement, not a second round");
  assert.deepEqual(report.pairs, []);
});

test("two rounds far enough apart ARE treated as genuinely separate, with a custom gap threshold", () => {
  const report = backtestLeadTime(
    [
      { companyId: 1, eventDate: "2026-09-01" },
      { companyId: 1, eventDate: "2026-11-01" }, // 61 days later
    ],
    [],
    14,
  );
  assert.equal(report.companiesWithGenuineSubsequentRound, 1);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0]!.leadTimeDays, null, "no signal fired in between, so no lead time, not a crash");
});

test("the signal closest before (but strictly before) the next round's announcement is picked, not the first or furthest one", () => {
  const report = backtestLeadTime(
    [
      { companyId: 1, eventDate: "2026-09-01" },
      { companyId: 1, eventDate: "2026-11-01" },
    ],
    [
      { companyId: 1, family: "github", firedAt: "2026-09-10T00:00:00Z" }, // early, further away
      { companyId: 1, family: "hiring", firedAt: "2026-10-25T00:00:00Z" }, // closest before the next round
      { companyId: 1, family: "website", firedAt: "2026-11-02T00:00:00Z" }, // AFTER next round — must be ignored
    ],
    14,
  );
  const pair = report.pairs[0]!;
  assert.equal(pair.precedingSignalFamily, "hiring");
  assert.equal(pair.leadTimeDays, 7);
});

test("a signal before the PRIOR round is not mistakenly counted as preceding the next one", () => {
  const report = backtestLeadTime(
    [
      { companyId: 1, eventDate: "2026-09-01" },
      { companyId: 1, eventDate: "2026-11-01" },
    ],
    [{ companyId: 1, family: "github", firedAt: "2026-08-01T00:00:00Z" }], // before the FIRST round entirely
    14,
  );
  assert.equal(report.pairs[0]!.precedingSignalFamily, null);
});

test("a company with only one funding event is never counted, with or without signals", () => {
  const report = backtestLeadTime(
    [{ companyId: 1, eventDate: "2026-09-01" }],
    [{ companyId: 1, family: "github", firedAt: "2026-09-05T00:00:00Z" }],
  );
  assert.equal(report.companiesWithMultipleFundingEvents, 0);
  assert.equal(report.pairs.length, 0);
});

test("formatLeadTimeBacktestReport explicitly explains the zero-pairs case rather than printing empty/misleading stats", () => {
  const report = backtestLeadTime(
    [
      { companyId: 1, eventDate: "2026-10-01" },
      { companyId: 1, eventDate: "2026-10-02" },
    ],
    [],
  );
  const text = formatLeadTimeBacktestReport(report);
  assert.match(text, /Nothing to backtest/);
  assert.doesNotMatch(text, /Round pairs found/);
});

test("median/mean are computed only over pairs that actually had a preceding signal", () => {
  const report = backtestLeadTime(
    [
      { companyId: 1, eventDate: "2026-01-01" },
      { companyId: 1, eventDate: "2026-03-01" }, // pair 1: signal fires 10 days before
      { companyId: 1, eventDate: "2026-05-01" }, // pair 2: no signal
    ],
    [{ companyId: 1, family: "github", firedAt: "2026-02-19T00:00:00Z" }],
    14,
  );
  assert.equal(report.pairs.length, 2);
  assert.equal(report.pairsWithPrecedingSignal, 1);
  assert.equal(report.leadTimeDaysMedian, 10);
  assert.equal(report.leadTimeDaysMean, 10);
});
