import assert from "node:assert/strict";
import { test } from "node:test";
import { collectForSource, deriveSignalsForCompany } from "../src/signals/observe.ts";
import { classifyRole, isEnterpriseSalesRole, isRecruitingRole, isSecurityComplianceRole } from "../src/signals/sources/ats/roles.ts";
import type { Fetcher, FetchOptions, FetchResult } from "../src/sources/fetcher.ts";
import type { SignalSource } from "../src/signals/types.ts";
import { SCENARIO_A } from "./fixtures/signals/scenarios.ts";

function fakeFetcher(routes: Record<string, { status: number; json?: unknown }>): Fetcher {
  return {
    async getText(url: string, _o?: FetchOptions): Promise<FetchResult> {
      const r = routes[url];
      if (!r) return { url, status: 404, text: "", bytes: 0, elapsed_ms: 0 };
      const text = r.json !== undefined ? JSON.stringify(r.json) : "";
      return { url, status: r.status, text, bytes: text.length, elapsed_ms: 0 };
    },
  };
}

const NOW = () => new Date("2026-09-22T00:00:00.000Z");

test("collectForSource: dispatches github_repo to the repo collector and stamps company_id/signal_source_id/observed_at", async () => {
  const source: SignalSource = { id: 9, company_id: 3, source_type: "github_repo", external_id: "acme/widget", canonical_url: null, resolution_method: "manual", resolution_confidence: 1, resolution_evidence: "test", active: true, metadata: null };
  const fetcher = fakeFetcher({ "https://api.github.com/repos/acme/widget": { status: 200, json: { stargazers_count: 5 } } });
  const [obs] = await collectForSource(source, fetcher, { now: NOW });
  assert.deepEqual([obs!.company_id, obs!.signal_source_id, obs!.observed_at, obs!.metric_name, obs!.numeric_value], [3, 9, NOW().toISOString(), "github_stars", 5]);
});

test("collectForSource: dispatches greenhouse/lever/ashby to their respective collectors", async () => {
  const gh: SignalSource = { id: 1, company_id: 1, source_type: "greenhouse", external_id: "acme", canonical_url: null, resolution_method: "manual", resolution_confidence: 1, resolution_evidence: "t", active: true, metadata: null };
  const fetcher = fakeFetcher({ "https://boards-api.greenhouse.io/v1/boards/acme/jobs": { status: 200, json: { jobs: [] } } });
  const obs = await collectForSource(gh, fetcher, { now: NOW });
  assert.ok(obs.some((o) => o.metric_name === "ats_open_jobs_total" && o.numeric_value === 0));
});

test("collectForSource: a malformed github_repo external_id (no owner/repo split) yields no observations rather than throwing", async () => {
  const source: SignalSource = { id: 1, company_id: 1, source_type: "github_repo", external_id: "not-a-valid-slug", canonical_url: null, resolution_method: "manual", resolution_confidence: 1, resolution_evidence: "t", active: true, metadata: null };
  assert.deepEqual(await collectForSource(source, fakeFetcher({})), []);
});

test("deriveSignalsForCompany: combines hiring and github families in one call (thin dispatcher over both rule sets)", () => {
  // SCENARIO_A (stable) should produce nothing from either family via the combined entry point.
  assert.deepEqual(deriveSignalsForCompany(101, SCENARIO_A), []);
});

// ---- role classifier: a broader spread, and the conservative "other" fallback -----------------------------------------

test("classifyRole: covers each category with a representative real-world title", () => {
  const cases: Array<[string, string]> = [
    ["Senior Backend Engineer", "engineering"],
    ["Staff Product Manager", "product"],
    ["Senior Product Designer", "design"],
    ["Account Executive, Mid-Market", "sales"],
    ["Head of Growth Marketing", "marketing"],
    ["Customer Success Manager", "customer_success"],
    ["Office Manager", "operations"],
    ["Senior Accountant", "finance"],
    ["Corporate Counsel", "legal"],
    ["Technical Recruiter", "people_recruiting"],
    ["Security Engineer", "security"],
    ["Chief Technology Officer", "executive_leadership"],
    ["Barista (Café Team)", "other"],
  ];
  for (const [title, expected] of cases) assert.equal(classifyRole(title), expected, title);
});

test("narrow sub-signal predicates require BOTH keywords, not just one — matching the brief's own example", () => {
  assert.equal(isEnterpriseSalesRole("Enterprise Account Executive"), true);
  assert.equal(isEnterpriseSalesRole("Account Executive"), false, "plain sales title must not trip the enterprise sub-signal");
  assert.equal(isEnterpriseSalesRole("Enterprise Customer Success Manager"), false, "'enterprise' alone without a sales keyword must not qualify");
  assert.equal(isRecruitingRole("Senior Technical Recruiter"), true);
  assert.equal(isRecruitingRole("People Operations Generalist"), false, "adjacent but not explicitly a recruiting title");
  assert.equal(isSecurityComplianceRole("SOC 2 Compliance Manager"), true);
  assert.equal(isSecurityComplianceRole("Software Engineer"), false);
});
