import { parse } from "tldts";
import { DOMAIN_DENYLIST } from "./config.ts";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Parse a user/model-supplied URL or bare host into a URL, or null. Rejects non-http(s) schemes (mailto:, javascript:, ...). */
function toUrl(input: string): URL | null {
  let s = input.trim();
  if (!s) return null;
  if (!SCHEME.test(s)) {
    // "scheme:rest" without "//" is a non-web scheme, unless it is really "host:port".
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:@\s]+:\d+(\/|$)/.test(s)) return null;
    s = `https://${s}`;
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

/**
 * Normalize any URL/host string to the registrable domain: lowercase, no protocol,
 * no www./subdomains, no path/query/port. Returns null when there is no valid
 * registrable domain (IPs, localhost, garbage).
 *
 * Private suffixes (github.io, vercel.app, ...) are honored, so "foo.vercel.app"
 * stays "foo.vercel.app" instead of collapsing every hosted project into "vercel.app".
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const url = toUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  const parsed = parse(host, { allowPrivateDomains: true });
  if (parsed.isIp || !parsed.domain) return null;
  return parsed.domain.toLowerCase();
}

export function isDenylistedDomain(domain: string): boolean {
  return DOMAIN_DENYLIST.has(domain);
}

const TRACKING_PARAM =
  /^(utm_.*|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|igshid|ref|ref_src|_hsenc|_hsmi|ncid|cmpid|taid)$/i;

/**
 * Normalize a source URL for de-duplication: https, lowercase host without www.,
 * default ports/fragments/tracking params removed, remaining params sorted,
 * trailing slash removed. Returns null for non-http(s) or unparseable input.
 */
export function normalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const url = toUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!host || !host.includes(".")) return null;
  const port = url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : "";
  const kept = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = kept.length
    ? "?" + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "/") path = "";
  return `https://${host}${port}${path}${query}`;
}
