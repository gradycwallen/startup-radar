import { isDenylistedDomain, normalizeDomain } from "../domain.ts";
import type { HtmlLink } from "./html.ts";

/**
 * Registrable domains that appear in article bodies but are never the subject company's own site:
 * publishers, wires, social networks, platforms, and the venture investors that fill funding articles.
 * (Complements config's DOMAIN_DENYLIST.) Being on this list only removes a domain from the company-domain
 * candidates; it does not affect anything else.
 */
export const NON_COMPANY_DOMAINS: ReadonlySet<string> = new Set([
  // publishers, wires, aggregators
  "tech.eu", "eu-startups.com", "sifted.eu", "arcticstartup.com", "cision.com", "prnasia.com", "newswire.ca", "prnewswire.com",
  "businesswire.com", "globenewswire.com", "accesswire.com", "einpresswire.com", "news.google.com", "feedburner.com", "flipboard.com",
  "strictlyvc.com", "dealroom.co", "pulse2.com", "finsmes.com", "vestbee.com", "axios.com", "wsj.com", "ft.com", "cnbc.com", "cnn.com",
  "theverge.com", "wired.com", "engadget.com", "zdnet.com", "siliconangle.com", "sifted.eu", "thenextweb.com", "maddyness.com",
  // social, platforms, infrastructure
  "twitter.com", "x.com", "linkedin.com", "facebook.com", "instagram.com", "youtube.com", "tiktok.com", "bsky.app", "threads.net",
  "github.com", "gitlab.com", "medium.com", "substack.com", "reddit.com", "wordpress.com", "wp.com", "gravatar.com", "cloudflare.com",
  "gstatic.com", "googleapis.com", "googletagmanager.com", "doubleclick.net", "google.com", "apple.com", "amazon.com", "microsoft.com",
  "eventbrite.com", "mailchimp.com", "calendly.com", "typeform.com", "notion.so", "airtable.com", "bit.ly", "t.co", "lnkd.in",
  "apps.apple.com", "play.google.com", "w3.org", "schema.org", "wikipedia.org", "crunchbase.com", "pitchbook.com", "angel.co",
  "producthunt.com", "ycombinator.com", "techstars.com", "500.co", "antler.co", "joinef.com", "seedcamp.com",
  // venture investors that fill funding articles
  "sequoiacap.com", "a16z.com", "accel.com", "indexventures.com", "lightspeedvp.com", "greylock.com", "gv.com", "kleinerperkins.com",
  "foundersfund.com", "generalcatalyst.com", "insightpartners.com", "bvp.com", "atomico.com", "balderton.com", "northzone.com",
  "creandum.com", "eqtventures.com", "speedinvest.com", "point9.com", "luxcapital.com", "greenoaks.com", "thrivecapital.com",
  "spark-capital.com", "sparkcapital.com", "redpoint.com", "8vc.com", "khoslaventures.com", "benchmark.com", "battery.com", "iconiq.com",
  "coatue.com", "tigerglobal.com", "softbank.com", "ribbitcap.com", "firstmark.com", "canapi.com", "alumniventures.com", "corazoncapital.com",
  "expa.com", "dcvc.com", "unifund.com", "blossomcap.com", "cyberstarts.com", "swishventures.com", "operatorcollective.com", "obviousventures.com",
]);

export function isNonCompanyDomain(domain: string): boolean {
  return NON_COMPANY_DOMAINS.has(domain) || isDenylistedDomain(domain);
}

/**
 * Registrable domains linked from a piece of content that could plausibly be a company's own site:
 * publishers, socials, investors and the item's own host are removed. Order of first appearance is kept.
 */
export function candidateDomains(links: readonly HtmlLink[], ownHosts: readonly string[] = []): string[] {
  const own = new Set(ownHosts.map((h) => normalizeDomain(h)).filter((d): d is string => !!d));
  const seen: string[] = [];
  for (const l of links) {
    const d = normalizeDomain(l.href);
    if (!d || own.has(d) || isNonCompanyDomain(d) || seen.includes(d)) continue;
    seen.push(d);
  }
  return seen;
}
