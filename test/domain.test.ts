import assert from "node:assert/strict";
import { test } from "node:test";
import { isDenylistedDomain, normalizeDomain, normalizeUrl } from "../src/domain.ts";

test("normalizeDomain: bare registrable domain, lowercase, no protocol/www/path/query/port", () => {
  const cases: Array<[string, string]> = [
    ["https://www.Glow.io/", "glow.io"],
    ["HTTP://XDOF.AI/path/to/page?x=1#frag", "xdof.ai"],
    ["www.arrakis.tech", "arrakis.tech"],
    ["app.waddlelabs.ai", "waddlelabs.ai"],
    ["https://blog.eu-startups.com/a/b", "eu-startups.com"],
    ["  liquidcompute.com/  ", "liquidcompute.com"],
    ["https://ravelfuture.com:8443/x", "ravelfuture.com"],
    ["https://shop.example.co.uk/x", "example.co.uk"],
    ["https://myproject.vercel.app/", "myproject.vercel.app"],
    ["https://Praxisrobotics.IO", "praxisrobotics.io"],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeDomain(input), expected, input);
});

test("normalizeDomain: rejects things that are not company domains", () => {
  for (const bad of ["", "   ", "localhost", "http://127.0.0.1/", "https://192.168.1.1", "mailto:a@b.com", "javascript:alert(1)", "ftp://x.com", "not a url", "https://", null, undefined]) {
    assert.equal(normalizeDomain(bad as string | null | undefined), null, String(bad));
  }
});

test("normalizeDomain is idempotent", () => {
  for (const input of ["https://www.Glow.io/x", "sub.a.co.uk", "foo.github.io"]) {
    const once = normalizeDomain(input)!;
    assert.equal(normalizeDomain(once), once);
  }
});

test("denylist covers news/aggregator/platform domains only", () => {
  assert.equal(isDenylistedDomain("techcrunch.com"), true);
  assert.equal(isDenylistedDomain("github.com"), true);
  assert.equal(isDenylistedDomain("glow.io"), false);
});

test("normalizeUrl: canonical form for de-duplication", () => {
  assert.equal(
    normalizeUrl("http://WWW.TechCrunch.com/2026/09/04/xdof/?utm_source=a&utm_medium=b&fbclid=z#comments"),
    "https://techcrunch.com/2026/09/04/xdof",
  );
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com");
  assert.equal(normalizeUrl("https://example.com//a//b/"), "https://example.com/a/b");
  assert.equal(normalizeUrl("https://example.com/p?b=2&a=1&utm_campaign=x"), "https://example.com/p?a=1&b=2");
  assert.equal(normalizeUrl("https://example.com:443/p"), "https://example.com/p");
  assert.equal(normalizeUrl("https://example.com:8080/p"), "https://example.com:8080/p");
  assert.equal(normalizeUrl("example.com/p"), "https://example.com/p");
});

test("normalizeUrl: same page in different spellings collapses to one key", () => {
  const variants = [
    "https://techcrunch.com/a/b",
    "http://techcrunch.com/a/b/",
    "https://www.techcrunch.com/a/b?utm_source=x",
    "HTTPS://TECHCRUNCH.COM/a/b#top",
  ];
  assert.equal(new Set(variants.map((v) => normalizeUrl(v))).size, 1);
});

test("normalizeUrl: rejects non-http(s) and garbage", () => {
  for (const bad of ["", "ftp://x.com/a", "mailto:a@b.com", "javascript:void(0)", "https://localhost/x", null, undefined]) {
    assert.equal(normalizeUrl(bad as string | null | undefined), null, String(bad));
  }
});
