import { DEFAULTS, LIMITS, type RunConfig } from "../src/config.ts";
import { emptyUsage } from "../src/claude.ts";
import type { LaneReport } from "../src/providers/types.ts";
import type { RawLead } from "../src/schema.ts";

export const defaultLimitsForTests = () => ({ ...LIMITS });
export const leadFor = (n: number, lane: string): RawLead => ({
  provider: "fake", lane, name: `Co${n}`, homepage_hint: `https://co${n}.ai`, event_type_hint: "funding",
  source_url: `https://news.example.com/co${n}`, source_name: "News", event_date: "2026-09-10", headline: `Co${n} raises`, snippet: null, source_retrieved: true,
});
export const laneOk = (lane: string, leads: number): LaneReport => ({ lane, status: "ok", elapsed_ms: 10, leads, usage: { ...emptyUsage(), inputTokens: 100, apiCalls: 1 } });
export const stubConfig = (over: Partial<RunConfig> = {}): RunConfig => ({
  dryRun: true, maxNew: DEFAULTS.maxNew, maxCandidates: 50, minConfidence: 0.75, recencyDays: 14, maxEventAgeDays: 45, concurrency: 1,
  leadsPerLane: 6, lanes: undefined, logDir: "logs", limits: { ...LIMITS }, budgetUsd: 0.75, ...over,
});
