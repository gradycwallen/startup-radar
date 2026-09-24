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

/**
 * V2-2C.1: finds a supported-source URL (GitHub/Greenhouse/Lever/Ashby) EMBEDDED anywhere in raw
 * page text — inline `<script>` JS, server-rendered JSON, escaped HTML — not just a literal
 * `<a href>` or `<script src>`. Built for cases like a careers page that lists individual Ashby
 * application URLs (`jobs.ashbyhq.com/acme/<uuid>/application`) inside server-rendered JSON, with no
 * plain anchor or script tag pointing at the board itself anywhere on the page.
 *
 * Deliberately hostname-anchored, never a generic "looks like a URL" scan: the pattern can ONLY
 * match one of the exact hosts scanForSourceLinks already recognizes, so this never invents a new
 * KIND of candidate — it only finds MORE OCCURRENCES of kinds scanForSourceLinks already knows how
 * to parse. Every match is handed to the caller to run through the SAME scanForSourceLinks
 * segment-parsing (which already reads only `segments[0]` — or `[0]`/`[1]` for a GitHub repo —
 * regardless of how many path segments follow, so a per-job URL like `.../acme/<uuid>/application`
 * normalizes to the same board candidate as a bare `.../acme` link) and from there through the SAME
 * identity confirmation (confirmGithub/confirmAts) as a plain anchor. This function only widens
 * WHERE a candidate URL can be found; it never changes what counts as confirmation.
 */
const EMBEDDED_HOST_PATTERN = /https?:\/\/(?:www\.)?(?:github\.com|boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com)\/[^\s"'<>\\]*/gi;

export function extractEmbeddedSourceLinks(text: string): HtmlLink[] {
  if (!text) return [];
  const out: HtmlLink[] = [];
  const seen = new Set<string>();
  EMBEDDED_HOST_PATTERN.lastIndex = 0;
  for (let m = EMBEDDED_HOST_PATTERN.exec(text); m; m = EMBEDDED_HOST_PATTERN.exec(text)) {
    const href = m[0].replace(/[.,;:)\]}]+$/, "");
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ href, text: "" });
  }
  return out;
}
