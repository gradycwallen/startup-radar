import { normalizeDomain } from "../domain.ts";
import { aliasKey, nameDomainSimilarity, nameKey } from "../funnel/text.ts";
import type { Fetcher } from "../sources/fetcher.ts";
import { extractLinks } from "../sources/html.ts";
import { scanForSourceLinks, type LinkCandidate } from "./sources/link-scan.ts";
import type { CompanyContext, ResolutionMethod, SignalSource, SourceType } from "./types.ts";

/**
 * Deterministic-first entity resolution: connects a `companies` row to the external sources
 * V2-2A's collectors can observe (a GitHub org/repo, an ATS board). Runs entirely without AI.
 *
 * Evidence used, in order:
 *  1. Links on the company's OWN homepage (and, if nothing found there, its `/careers` page) —
 *     data we already have (the company's `domain`), fetched politely through the same Fetcher
 *     the discovery funnel uses.
 *  2. For each candidate found that way, a CONFIRMATION check against the candidate's own public
 *     metadata: a GitHub org/user's public `blog`/`html_url` field pointing back at the company's
 *     domain, or an ATS board's own reported organization name matching the company name.
 *
 * Two confidence tiers, never a bare "looks like the name":
 *  - "homepage_link_confirmed"  — the company's site links to it AND the candidate's own metadata
 *     links back. Mutual confirmation; this is the only tier eligible for the highest confidence.
 *  - "homepage_link_name_match" — the company's site links to it and the slug/token closely
 *     matches the company name, but the candidate offered no independent confirmation.
 * A link whose slug does NOT resemble the company name, with no confirmation either, is REJECTED
 * outright — never returned as a candidate. Unresolved is the correct outcome when evidence is
 * genuinely insufficient; a wrong resolution is worse than none (see the V2-2A report).
 */

const CONFIRMED_CONFIDENCE = 0.95;
const NAME_MATCH_CONFIDENCE = 0.7;
/** Minimum nameDomainSimilarity for a linked candidate's slug to be accepted at all without independent confirmation. */
const MIN_NAME_SIMILARITY = 0.75;

export interface UnresolvedSource {
  sourceType: SourceType;
  externalId: string;
  reason: string;
}

export interface ResolutionResult {
  resolved: Omit<SignalSource, "id">[];
  unresolved: UnresolvedSource[];
  /** Pages actually fetched, for observability/testing — never more than 3 per company. */
  pagesChecked: string[];
}

async function getText(fetcher: Fetcher, url: string, signal: AbortSignal | undefined, provider: string): Promise<string | null> {
  try {
    const res = await fetcher.getText(url, { accept: "text/html,application/xhtml+xml", signal, provider });
    return res.status >= 200 && res.status < 400 ? res.text : null;
  } catch {
    return null;
  }
}

async function getJson(fetcher: Fetcher, url: string, signal: AbortSignal | undefined, provider: string): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetcher.getText(url, { accept: "application/json", signal, provider });
    if (res.status < 200 || res.status >= 400) return { status: res.status, json: null };
    try {
      return { status: res.status, json: JSON.parse(res.text) };
    } catch {
      return { status: res.status, json: null };
    }
  } catch {
    return null;
  }
}

function nameSimilarityFor(company: CompanyContext, slug: string): number {
  const keys = [nameKey(company.name), aliasKey(company.name)].filter((k) => k.length >= 2);
  return nameDomainSimilarity(keys, slug);
}

async function confirmGithub(fetcher: Fetcher, candidate: LinkCandidate, company: CompanyContext, signal: AbortSignal | undefined): Promise<{ confirmed: boolean; evidence: string }> {
  const login = candidate.sourceType === "github_org" ? candidate.externalId : candidate.externalId.split("/")[0]!;
  for (const kind of ["orgs", "users"]) {
    const res = await getJson(fetcher, `https://api.github.com/${kind}/${login}`, signal, "signals-github-resolve");
    if (!res || res.status === 404) continue;
    if (res.status !== 200 || typeof res.json !== "object" || res.json === null) continue;
    const obj = res.json as Record<string, unknown>;
    const blog = typeof obj.blog === "string" ? obj.blog : "";
    const blogDomain = blog ? normalizeDomain(blog) : null;
    if (blogDomain && blogDomain === company.domain) {
      return { confirmed: true, evidence: `GitHub ${kind === "orgs" ? "organization" : "user"} profile's website field ("${blog}") matches the company's domain` };
    }
    return { confirmed: false, evidence: "" };
  }
  return { confirmed: false, evidence: "" };
}

interface AtsConfirmation {
  confirmed: boolean;
  evidence: string;
  /** True only when we got a real, parseable response — used to decide if we can even attempt this source. */
  reachable: boolean;
}

async function confirmAts(fetcher: Fetcher, candidate: LinkCandidate, company: CompanyContext, signal: AbortSignal | undefined): Promise<AtsConfirmation> {
  const keys = [nameKey(company.name), aliasKey(company.name)].filter((k) => k.length >= 2);
  const closeName = (name: string) => keys.some((k) => nameKey(name) === k || aliasKey(name) === k);

  if (candidate.sourceType === "greenhouse") {
    const res = await getJson(fetcher, `https://boards-api.greenhouse.io/v1/boards/${candidate.externalId}`, signal, "signals-ats-resolve");
    if (!res || res.status !== 200 || typeof res.json !== "object" || res.json === null) return { confirmed: false, evidence: "", reachable: false };
    const name = (res.json as Record<string, unknown>).name;
    if (typeof name === "string" && closeName(name)) return { confirmed: true, evidence: `Greenhouse board's own organization name ("${name}") matches the company name`, reachable: true };
    return { confirmed: false, evidence: "", reachable: true };
  }
  if (candidate.sourceType === "lever") {
    // Lever's postings endpoint has no top-level org-name field to confirm against; reachability alone is checked.
    const res = await getJson(fetcher, `https://api.lever.co/v0/postings/${candidate.externalId}?mode=json`, signal, "signals-ats-resolve");
    return { confirmed: false, evidence: "", reachable: !!res && res.status === 200 && Array.isArray(res.json) };
  }
  if (candidate.sourceType === "ashby") {
    const res = await getJson(fetcher, `https://api.ashbyhq.com/posting-api/job-board/${candidate.externalId}`, signal, "signals-ats-resolve");
    if (!res || res.status !== 200 || typeof res.json !== "object" || res.json === null) return { confirmed: false, evidence: "", reachable: false };
    const org = (res.json as Record<string, unknown>).organizationName;
    if (typeof org === "string" && closeName(org)) return { confirmed: true, evidence: `Ashby board's own organization name ("${org}") matches the company name`, reachable: true };
    return { confirmed: false, evidence: "", reachable: true };
  }
  return { confirmed: false, evidence: "", reachable: false };
}

export async function resolveCompanySources(company: CompanyContext, fetcher: Fetcher, signal?: AbortSignal): Promise<ResolutionResult> {
  const pagesChecked: string[] = [];
  const homepageHtml = await getText(fetcher, `https://${company.domain}/`, signal, "signals-resolve-homepage");
  pagesChecked.push(`https://${company.domain}/`);
  let links = homepageHtml ? extractLinks(homepageHtml, `https://${company.domain}/`) : [];
  let candidates = scanForSourceLinks(links);

  // Nothing found on the homepage: try the conventional careers path once (one extra request, never more).
  if (!candidates.some((c) => c.sourceType === "greenhouse" || c.sourceType === "lever" || c.sourceType === "ashby")) {
    const careersHtml = await getText(fetcher, `https://${company.domain}/careers`, signal, "signals-resolve-careers");
    pagesChecked.push(`https://${company.domain}/careers`);
    if (careersHtml) {
      links = links.concat(extractLinks(careersHtml, `https://${company.domain}/careers`));
      candidates = scanForSourceLinks(links);
    }
  }

  const resolved: Omit<SignalSource, "id">[] = [];
  const unresolved: UnresolvedSource[] = [];

  for (const candidate of candidates) {
    const slugForSimilarity = candidate.sourceType === "github_repo" ? candidate.externalId.split("/")[1]! : candidate.externalId;
    const nameSim = nameSimilarityFor(company, slugForSimilarity);

    let method: ResolutionMethod | null = null;
    let confidence = 0;
    let evidence = "";

    if (candidate.sourceType === "github_org" || candidate.sourceType === "github_repo") {
      const confirm = await confirmGithub(fetcher, candidate, company, signal);
      if (confirm.confirmed) {
        method = "homepage_link_confirmed";
        confidence = CONFIRMED_CONFIDENCE;
        evidence = `Linked from ${company.domain}'s homepage; ${confirm.evidence}`;
      } else if (nameSim >= MIN_NAME_SIMILARITY) {
        method = "homepage_link_name_match";
        confidence = NAME_MATCH_CONFIDENCE;
        evidence = `Linked from ${company.domain}'s homepage; "${slugForSimilarity}" closely matches the company name (similarity ${nameSim.toFixed(2)})`;
      }
    } else {
      const confirm = await confirmAts(fetcher, candidate, company, signal);
      if (!confirm.reachable) {
        unresolved.push({ sourceType: candidate.sourceType, externalId: candidate.externalId, reason: "linked board was unreachable or returned an unexpected shape" });
        continue;
      }
      if (confirm.confirmed) {
        method = "homepage_link_confirmed";
        confidence = CONFIRMED_CONFIDENCE;
        evidence = `Linked from ${company.domain}'s homepage/careers page; ${confirm.evidence}`;
      } else if (nameSim >= MIN_NAME_SIMILARITY) {
        method = "homepage_link_name_match";
        confidence = NAME_MATCH_CONFIDENCE;
        evidence = `Linked from ${company.domain}'s homepage/careers page; board token "${slugForSimilarity}" closely matches the company name (similarity ${nameSim.toFixed(2)})`;
      }
    }

    if (method) {
      resolved.push({
        company_id: company.id, source_type: candidate.sourceType, external_id: candidate.externalId, canonical_url: candidate.canonicalUrl,
        resolution_method: method, resolution_confidence: confidence, resolution_evidence: evidence, active: true, metadata: null,
      });
    } else {
      unresolved.push({ sourceType: candidate.sourceType, externalId: candidate.externalId, reason: `linked, but "${slugForSimilarity}" does not resemble the company name closely enough (similarity ${nameSim.toFixed(2)} < ${MIN_NAME_SIMILARITY}) and no independent confirmation was available` });
    }
  }
  return { resolved, unresolved, pagesChecked };
}
