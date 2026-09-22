/**
 * A small, deterministic robots.txt parser/evaluator — the standard longest-match-wins semantics
 * (RFC 9309 §2.2.2: the most specific — longest — matching Allow/Disallow rule wins; a tie favors
 * Allow). No third-party dependency: robots.txt is a tiny, well-defined format and pulling in a
 * package for it would be disproportionate. Applies ONLY to website monitoring (V2-2B.2); existing
 * GitHub/ATS resolution's own homepage fetch is a separate, smaller-scope concern — see the V2-2B.2
 * design report §5/§11 on why a robots retrofit there is optional, not required.
 */

interface RobotsRule {
  path: string;
  allow: boolean;
}

export interface RobotsRules {
  rules: RobotsRule[];
}

/** Rules that permit everything — the correct default when robots.txt is absent (404/network
 * error) or unparseable, per convention: a missing robots.txt means "no restrictions," never
 * "deny everything." */
export const ALLOW_ALL_ROBOTS: RobotsRules = { rules: [] };

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True when `userAgentGroup` (the literal token after "user-agent:") applies to our crawler.
 * `*` always applies; an exact case-insensitive token match applies; anything else does not. */
function groupApplies(userAgentGroup: string, ourToken: string): boolean {
  const g = normalizeToken(userAgentGroup);
  return g === "*" || g === normalizeToken(ourToken);
}

/**
 * Parses robots.txt for the given user-agent token. Picks the MOST SPECIFIC matching group: an
 * exact-name group if one exists, else the `*` group, else no restrictions. Ignores
 * Sitemap/Crawl-delay/comment lines and any other directive we don't act on.
 */
export function parseRobotsTxt(text: string, ourUserAgentToken: string): RobotsRules {
  const lines = text.split(/\r?\n/);
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let sawRuleSinceLastAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const directive = normalizeToken(line.slice(0, colon));
    const value = line.slice(colon + 1).trim();

    if (directive === "user-agent") {
      // A new User-agent line immediately after a rule line starts a NEW group (standard robots.txt
      // grouping); consecutive User-agent lines with no rules between them extend the current group.
      if (current === null || sawRuleSinceLastAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRuleSinceLastAgent = false;
      }
      current.agents.push(value);
    } else if (directive === "allow" || directive === "disallow") {
      if (current === null) continue; // a rule with no preceding User-agent is malformed — skip
      if (value) current.rules.push({ path: value, allow: directive === "allow" });
      // An empty Disallow value means "disallow nothing" (i.e. allow all) for this group — no rule needed.
      sawRuleSinceLastAgent = true;
    }
    // Sitemap/Crawl-delay/Host/anything else: not acted on here, deliberately.
  }

  const named = groups.find((g) => g.agents.some((a) => groupApplies(a, ourUserAgentToken) && normalizeToken(a) !== "*"));
  if (named) return { rules: named.rules };
  const wildcard = groups.find((g) => g.agents.some((a) => normalizeToken(a) === "*"));
  if (wildcard) return { rules: wildcard.rules };
  return ALLOW_ALL_ROBOTS;
}

/** Longest matching rule wins; a tie between an Allow and a Disallow of equal length favors Allow
 * (RFC 9309). No matching rule at all means allowed. */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules.rules) {
    if (!path.startsWith(rule.path)) continue;
    if (best === null || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow && !best.allow)) {
      best = rule;
    }
  }
  return best === null || best.allow;
}
