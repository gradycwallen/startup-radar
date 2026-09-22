import type { Fetcher } from "../sources/fetcher.ts";
import { collectAshby } from "./sources/ats/ashby.ts";
import { collectGreenhouse } from "./sources/ats/greenhouse.ts";
import { collectLever } from "./sources/ats/lever.ts";
import { collectGithubOrg, collectGithubRepo } from "./sources/github.ts";
import type { CollectionResult } from "./sources/types.ts";
import { deriveGithubSignals } from "./rules/github.ts";
import { deriveHiringSignals } from "./rules/hiring.ts";
import type { DerivedSignal, Observation, SignalSource } from "./types.ts";

/**
 * The generic collect -> normalize step. One dispatcher per SourceType; every collector returns
 * the same shape (CollectionResult), so adding a future source (website structure, SEC Form D —
 * NOT built in V2-2A) means adding one case here, not redesigning this function.
 */
export interface ObserveOptions {
  githubToken?: string;
  now?: () => Date;
}

export async function collectForSource(source: SignalSource, fetcher: Fetcher, opts: ObserveOptions = {}, signal?: AbortSignal): Promise<Observation[]> {
  const observedAt = (opts.now?.() ?? new Date()).toISOString();
  let result: CollectionResult;
  switch (source.source_type) {
    case "github_repo": {
      const [owner, repo] = source.external_id.split("/");
      if (!owner || !repo) return [];
      result = await collectGithubRepo(fetcher, owner, repo, { token: opts.githubToken }, signal);
      break;
    }
    case "github_org":
      result = await collectGithubOrg(fetcher, source.external_id, { token: opts.githubToken }, signal);
      break;
    case "greenhouse":
      result = await collectGreenhouse(fetcher, source.external_id, signal);
      break;
    case "lever":
      result = await collectLever(fetcher, source.external_id, signal);
      break;
    case "ashby":
      result = await collectAshby(fetcher, source.external_id, signal);
      break;
    default:
      return [];
  }
  return result.metrics.map((m) => ({
    id: null,
    company_id: source.company_id,
    signal_source_id: source.id!,
    metric_name: m.metricName,
    numeric_value: m.numericValue,
    text_value: m.textValue,
    observed_at: observedAt,
    source_timestamp: m.sourceTimestamp,
    collection_version: result.collectionVersion,
    // NOT wired in V2-2A: a pointer into the HTTP snapshot store recorded for this collection.
    // The full raw response IS preserved when snapshot recording is used (--record, like V2-1's
    // funnel CLI); this field would carry that request's key. See the V2-2A report.
    raw_payload_ref: null,
  }));
}

/**
 * The generic compare -> derive step: runs every family's rules over one company's FULL
 * observation history (all sources, all metrics) and returns whatever fired. Adding a future
 * family means adding one line here and one rules/<family>.ts, not touching this dispatcher.
 */
export function deriveSignalsForCompany(companyId: number, history: readonly Observation[]): Omit<DerivedSignal, "id">[] {
  return [...deriveHiringSignals(companyId, history), ...deriveGithubSignals(companyId, history)];
}
