import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOW_ALL_ROBOTS, isPathAllowed, parseRobotsTxt } from "../src/signals/website/robots.ts";

test("robots: absent/empty robots.txt allows everything", () => {
  assert.equal(isPathAllowed(ALLOW_ALL_ROBOTS, "/"), true);
  assert.equal(isPathAllowed(parseRobotsTxt("", "StartupRadarScout"), "/anything"), true);
});

test("robots: a wildcard Disallow: / denies our crawler", () => {
  const rules = parseRobotsTxt("User-agent: *\nDisallow: /\n", "StartupRadarScout");
  assert.equal(isPathAllowed(rules, "/"), false);
  assert.equal(isPathAllowed(rules, "/pricing"), false);
});

test("robots: an exact-name group is preferred over the wildcard group", () => {
  const text = "User-agent: *\nDisallow: /\n\nUser-agent: StartupRadarScout\nDisallow:\n";
  const rules = parseRobotsTxt(text, "StartupRadarScout");
  assert.equal(isPathAllowed(rules, "/"), true, "our named group allows everything, overriding the wildcard block");
});

test("robots: longest-match-wins, and a tie favors Allow", () => {
  const text = "User-agent: *\nDisallow: /private\nAllow: /private/public-page\n";
  const rules = parseRobotsTxt(text, "StartupRadarScout");
  assert.equal(isPathAllowed(rules, "/private/secret"), false);
  assert.equal(isPathAllowed(rules, "/private/public-page"), true, "the more specific Allow rule wins");
  assert.equal(isPathAllowed(rules, "/other"), true);
});

test("robots: comments and Sitemap/Crawl-delay directives are ignored, not treated as rules", () => {
  const text = "# comment\nUser-agent: *\nCrawl-delay: 5\nSitemap: https://example.com/sitemap.xml\nDisallow: /admin\n";
  const rules = parseRobotsTxt(text, "StartupRadarScout");
  assert.equal(isPathAllowed(rules, "/admin"), false);
  assert.equal(isPathAllowed(rules, "/pricing"), true);
});

test("robots: a malformed line with no preceding User-agent is skipped, never crashes", () => {
  const rules = parseRobotsTxt("Disallow: /orphan\nUser-agent: *\nDisallow: /real\n", "StartupRadarScout");
  assert.equal(isPathAllowed(rules, "/orphan"), true, "the orphaned rule (before any User-agent) never applies");
  assert.equal(isPathAllowed(rules, "/real"), false);
});
