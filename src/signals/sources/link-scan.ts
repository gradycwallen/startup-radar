import type { HtmlLink } from "../../sources/html.ts";

/**
 * GitHub's own global-navigation paths — never an organization/user account, even though they sit
 * at the same URL depth ("github.com/pricing" looks exactly like "github.com/acme"). Mirrors the
 * spirit of src/sources/domains.ts's NON_COMPANY_DOMAINS: a small, deliberately short denylist;
 * the real filter is name-similarity in resolution.ts, not this list.
 */
const GITHUB_RESERVED_PATHS: ReadonlySet<string> = new Set([
  "about", "contact", "pricing", "features", "security", "sponsors", "marketplace", "topics", "collections", "trending",
  "explore", "login", "join", "signup", "settings", "notifications", "issues", "pulls", "codespaces", "orgs", "apps",
  "site", "readme", "support", "enterprise", "team", "customer-stories", "events", "resources", "solutions", "copilot",
  "actions", "packages", "discussions", "mobile", "desktop", "cli", "githubcopilot", "education", "sponsors", "new",
]);

export interface LinkCandidate {
  sourceType: "github_org" | "github_repo" | "greenhouse" | "lever" | "ashby";
  /** The organization/user login, or repo "org/repo", or ATS board token. */
  externalId: string;
  canonicalUrl: string;
}

/**
 * Scans a page's outbound links for candidate signal sources (GitHub org/repo, ATS board). Pure
 * pattern matching — accepting or rejecting a candidate on NAME evidence happens in resolution.ts.
 */
export function scanForSourceLinks(links: readonly HtmlLink[]): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: LinkCandidate) => {
    const key = `${c.sourceType}:${c.externalId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);

    if (host === "github.com" && segments.length >= 1) {
      const org = segments[0]!.toLowerCase();
      if (GITHUB_RESERVED_PATHS.has(org)) continue;
      if (segments.length === 1) {
        push({ sourceType: "github_org", externalId: org, canonicalUrl: `https://github.com/${org}` });
      } else if (segments.length === 2) {
        const repo = segments[1]!.toLowerCase();
        if (!GITHUB_RESERVED_PATHS.has(repo)) push({ sourceType: "github_repo", externalId: `${org}/${repo}`, canonicalUrl: `https://github.com/${org}/${repo}` });
      }
      continue;
    }

    if ((host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") && segments.length >= 1) {
      push({ sourceType: "greenhouse", externalId: segments[0]!.toLowerCase(), canonicalUrl: `https://boards.greenhouse.io/${segments[0]!.toLowerCase()}` });
      continue;
    }

    if (host === "jobs.lever.co" && segments.length >= 1) {
      push({ sourceType: "lever", externalId: segments[0]!.toLowerCase(), canonicalUrl: `https://jobs.lever.co/${segments[0]!.toLowerCase()}` });
      continue;
    }

    if (host === "jobs.ashbyhq.com" && segments.length >= 1) {
      push({ sourceType: "ashby", externalId: segments[0]!.toLowerCase(), canonicalUrl: `https://jobs.ashbyhq.com/${segments[0]!.toLowerCase()}` });
    }
  }
  return out;
}
