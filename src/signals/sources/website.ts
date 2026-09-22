import type { Fetcher } from "../../sources/fetcher.ts";
import { runWebsitePass } from "../website/resolve.ts";
import { PAGE_TYPES } from "../website/types.ts";
import type { CollectedMetric, CollectionResult } from "./types.ts";

/**
 * V2-2B.2 website collector — the observe.ts dispatch target for `source_type: "website"`. Wraps
 * the pure `runWebsitePass` (src/signals/website/resolve.ts) and converts its result into the
 * generic `CollectedMetric[]` shape every other collector already produces, so observe.ts's
 * `toObservations` needs no website-specific branch.
 *
 * MISSING VS. ZERO (non-negotiable — see root CLAUDE.md): a page whose state is "unknown" writes
 * NO metric at all — never a 0, never a guessed value. Only "present" (1) and "absent" (0) ever
 * become observations; `website_homepage_prelaunch` follows the same rule (only written when the
 * homepage pass actually succeeded). `website_fetch_outcome` is the one metric written on EVERY
 * pass, success or failure, so a down site is naturally re-checked (see freshness.ts) and so the
 * pass's own diagnostic context (lang, nav link count, nav_fingerprint, requests used) has
 * somewhere honest to live even when nothing else could be resolved.
 */
export const WEBSITE_COLLECTOR_VERSION = "website-v1";

export async function collectWebsite(fetcher: Fetcher, companyDomain: string, signal?: AbortSignal): Promise<CollectionResult> {
  const pass = await runWebsitePass(companyDomain, { fetcher, signal });
  const metrics: CollectedMetric[] = [];

  metrics.push({
    metricName: "website_fetch_outcome",
    numericValue: null,
    textValue: pass.outcome,
    sourceTimestamp: null,
    metadata: {
      requests_used: pass.requestsUsed,
      pages_checked: pass.pagesChecked.length,
      ...(pass.homepageFinalUrl ? { final_url: pass.homepageFinalUrl } : {}),
      ...(pass.homepageStatus !== null ? { status: pass.homepageStatus } : {}),
      ...(pass.lang ? { lang: pass.lang } : {}),
      ...(pass.navLinkCount !== null ? { nav_link_count: pass.navLinkCount } : {}),
      ...(pass.navFingerprint ? { nav_fingerprint: pass.navFingerprint } : {}),
    },
  });

  if (pass.prelaunch !== null) {
    metrics.push({ metricName: "website_homepage_prelaunch", numericValue: pass.prelaunch ? 1 : 0, textValue: null, sourceTimestamp: null, metadata: null });
  }

  for (const pageType of PAGE_TYPES) {
    const page = pass.pages[pageType];
    if (page.state === "unknown") continue; // MISSING != ZERO — no row at all, see module doc
    metrics.push({
      metricName: `website_page_${pageType}`,
      numericValue: page.state === "present" ? 1 : 0,
      textValue: page.path,
      sourceTimestamp: null,
      metadata: {
        how: page.how,
        checks: page.checks,
        ...(page.finalUrl ? { final_url: page.finalUrl } : {}),
        ...(page.status !== null ? { status: page.status } : {}),
        ...(page.title ? { title: page.title } : {}),
        ...(page.h1 ? { h1: page.h1 } : {}),
      },
    });
  }

  return { metrics, collectionVersion: WEBSITE_COLLECTOR_VERSION, sourceStatus: pass.homepageStatus ?? 0 };
}
