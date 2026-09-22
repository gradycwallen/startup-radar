import { BudgetGuard, type BudgetOptions, type CostAssumptions } from "../src/budget.ts";
import type { CompanyReader, CompanyRow, EventRow } from "../src/dedupe.ts";
import { LeadLedger } from "../src/ledger.ts";
import type { HomepageChecker } from "../src/http.ts";
import type { Verification } from "../src/schema.ts";
import type { ValidationContext } from "../src/validate.ts";

export const NOW = new Date("2026-09-21T12:00:00Z");

export const okHomepage = (text = "Acme builds robots"): HomepageChecker => async (domain) => ({
  reachable: true, status: 200, finalUrl: `https://${domain}/`, finalDomain: domain, text,
});

export function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    now: NOW, minConfidence: 0.75, maxEventAgeDays: 45, preferredFoundedYear: 2021,
    checkHomepage: okHomepage(), ...overrides,
  };
}

export function verification(overrides: Partial<Verification> = {}): Verification {
  return {
    is_real_company: true, rejection_reason: null, name: "Acme", canonical_url: "https://www.acme.ai/",
    description: "Acme builds robots.", category: "Robotics", event_type: "funding", event_date: "2026-09-10",
    source_url: "https://news.example.com/acme-raises-5m?utm_source=x", source_name: "Example News",
    headline: "Acme raises $5M seed", founded_year: 2024, founded_year_evidence: "Founded in 2024.",
    stage: "early_stage", stage_evidence: "Announced $5M seed round.", is_public_or_large_mature: false,
    confidence: 0.9, discovery_reason: "Announced a $5M seed round on 10 Sep 2026.",
    corroborating_urls: [], notes: null, ...overrides,
  };
}

export const RETRIEVED = new Set(["https://news.example.com/acme-raises-5m"]);

export class FakeReader implements CompanyReader {
  constructor(
    public companies: CompanyRow[] = [],
    public events: EventRow[] = [],
  ) {}
  async findCompanyByDomain(domain: string) { return this.companies.find((c) => c.domain === domain) ?? null; }
  async findCompaniesByName(name: string) { return this.companies.filter((c) => c.name.toLowerCase() === name.toLowerCase()); }
  async getEvents(companyId: number) { return this.events.filter((e) => e.company_id === companyId); }
  async counts() { return { companies: this.companies.length, discovery_events: this.events.length }; }
}

/**
 * Cheap cost assumptions for plumbing tests: with Phase 1's REAL caps the guard (correctly) refuses every
 * request under the $0.75 ceiling, so tests that are not about budgeting shrink the estimate. The ceiling
 * itself is never raised (it cannot be).
 */
export const cheapAssumptions: Partial<CostAssumptions> = { perOpInputTokens: 500, opsPerToolUse: 1, safetyMargin: 1, webSearchUsd: 0 };
export const testBudget = (over: BudgetOptions = {}): BudgetGuard => new BudgetGuard({ assumptions: cheapAssumptions, ...over });
export const testLedger = (): LeadLedger => LeadLedger.inMemory();
