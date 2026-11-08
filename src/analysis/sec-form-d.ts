/**
 * SEC Form D corroboration — read-only, candidate-only, NEVER auto-accepted.
 *
 * Form D is the SEC's own notice of an exempt securities offering (the filing a startup makes
 * when it closes a Reg D round) — a primary, government-filed record, a different and more
 * authoritative kind of evidence than a press article. Checking it against companies Scout already
 * tracks is a legitimate corroboration source.
 *
 * The constraint that shapes everything here: SEC's full-text search index carries no website or
 * domain field for a filer, only its legal name, CIK, and business-address state (see
 * docs/2026-11-07-sec-form-d-feasibility.md for the full research). Every other source this
 * project uses resolves identity by domain; this one can only compare NAMES. A name-only match is
 * exactly the failure mode that produced the Ande/Travix mistake described on the About page
 * (ANDE the DNA-testing company vs. Ande the funded startup; Travix International vs. the
 * on-chain-perpetuals startup Travix) — two real companies can share a name by coincidence. This
 * module NEVER resolves that ambiguity on its own: every result is a ranked CANDIDATE for a human
 * to review, never written to the database, never presented as a confirmed match. There is no
 * write path here at all — this is intentionally a read-only, report-only tool, structurally
 * incapable of making the same mistake the domain-guessing feature made, because it makes no
 * accept/reject decision of its own.
 */

import { nameKey, similarity } from "../funnel/text.ts";

export interface SecFormDHit {
  /** SEC's own "Legal Name  (CIK 0001234567)" display string, verbatim from the search index. */
  displayName: string;
  cik: string;
  /** Accession number, e.g. "0001757593-18-000001" — identifies the specific filing. */
  accessionNumber: string;
  fileDate: string;
  /** Business-address state/territory code, e.g. "CA" — SEC's only location signal; absent for some filers. */
  bizState: string | null;
}

export interface SecFormDCandidate {
  companyId: number;
  companyName: string;
  filerName: string;
  cik: string;
  accessionNumber: string;
  fileDate: string;
  bizState: string | null;
  /** Normalized-name edit similarity, 0..1. The ONLY signal behind this ranking — see the module
   * doc comment for why this can never be treated as a confirmed identity match on its own. */
  nameSimilarity: number;
  /** "strong" (>=0.92) or "possible" (>=0.75); candidates below 0.75 are not returned at all —
   * too noisy to be worth a human's time. Neither tier is an acceptance. */
  tier: "strong" | "possible";
}

const STRONG_THRESHOLD = 0.92;
const MIN_THRESHOLD = 0.75;

/** Strips the trailing "  (CIK 0001234567)" SEC's search index appends to every display name. */
export function extractFilerName(displayName: string): string {
  return displayName.replace(/\s*\(CIK\s*\d+\)\s*$/i, "").trim();
}

/**
 * Pure, deterministic, offline-testable. For each company, ranks every hit by name similarity and
 * returns candidates clearing MIN_THRESHOLD, best first. A hit below the threshold is dropped
 * silently — reporting a 0.3-similarity "candidate" would be noise, not evidence.
 */
export function matchFormDCandidates(company: { id: number; name: string }, hits: readonly SecFormDHit[]): SecFormDCandidate[] {
  const companyKey = nameKey(company.name);
  const candidates: SecFormDCandidate[] = [];
  for (const hit of hits) {
    const filerName = extractFilerName(hit.displayName);
    const sim = Math.round(similarity(companyKey, nameKey(filerName)) * 1000) / 1000;
    if (sim < MIN_THRESHOLD) continue;
    candidates.push({
      companyId: company.id,
      companyName: company.name,
      filerName,
      cik: hit.cik,
      accessionNumber: hit.accessionNumber,
      fileDate: hit.fileDate,
      bizState: hit.bizState,
      nameSimilarity: sim,
      tier: sim >= STRONG_THRESHOLD ? "strong" : "possible",
    });
  }
  return candidates.sort((a, b) => b.nameSimilarity - a.nameSimilarity);
}

export function formatCandidates(allCandidates: readonly SecFormDCandidate[]): string {
  if (allCandidates.length === 0) {
    return "No name-similarity candidates found at or above the reporting threshold (0.75). This means\neither no company name resembles a Form D filer closely enough to be worth reviewing, or the\nsearch itself returned nothing relevant for these companies — not a confirmed absence of filings.";
  }
  const lines: string[] = [];
  lines.push(`${allCandidates.length} candidate(s) found — NONE of these are confirmed matches. Every row below is`);
  lines.push("a name-similarity hint for a human to verify, never evidence of identity on its own.");
  lines.push("");
  for (const c of allCandidates) {
    lines.push(`[${c.tier.toUpperCase().padEnd(8)}] sim=${c.nameSimilarity.toFixed(3)}  "${c.companyName}" (id ${c.companyId})  <->  "${c.filerName}" (CIK ${c.cik})`);
    lines.push(`           filed ${c.fileDate}${c.bizState ? `, business address state: ${c.bizState}` : ""}`);
    lines.push(`           https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${c.cik}&type=D`);
  }
  return lines.join("\n");
}
