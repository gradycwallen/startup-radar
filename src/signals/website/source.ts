import type { CompanyContext, SignalSource } from "../types.ts";

/**
 * Builds a company's `website` signal source. Unlike GitHub/ATS resolution (resolution.ts), this
 * needs NO network request and no confirmation step: the company's own canonical `domain` field
 * (already read from `companies`) IS the source identity, with certainty — see the V2-2B.2 design
 * report §11/§21. `resolution_confidence: 1` reflects that certainty honestly (compare: even the
 * strongest GitHub/ATS confirmation tops out at 0.95, because that evidence is inferential).
 */
export function buildWebsiteSignalSource(company: CompanyContext): Omit<SignalSource, "id"> {
  return {
    company_id: company.id,
    source_type: "website",
    external_id: company.domain,
    canonical_url: `https://${company.domain}/`,
    resolution_method: "company_domain",
    resolution_confidence: 1,
    resolution_evidence: `Company's own canonical domain (${company.domain}) from companies.domain — no link-scanning or confirmation needed.`,
    active: true,
    metadata: null,
  };
}
