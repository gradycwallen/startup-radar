import type { Fetcher } from "../../../sources/fetcher.ts";
import type { CollectionResult } from "../types.ts";
import { aggregateAtsJobs, type AtsJob } from "./aggregate.ts";

/** Greenhouse's public Job Board API — official, no auth (docs.greenhouse.io/job-board.html). */
export const ATS_COLLECTOR_VERSION = "ats-v1";

interface GreenhouseJob {
  id: number;
  title: string;
  /** When the posting was LAST EDITED — mutates on any change (comp update, typo fix). Deliberately
   * NOT used for `postedAt` below: it would make an old posting look freshly-posted after a minor
   * edit. Kept only as the fallback for the rare case `first_published` is absent. */
  updated_at?: string;
  /** The posting's real original publish date — confirmed against Greenhouse's live Job Board API
   * (V2-2B.1 ATS research) as a genuine, distinct field alongside `updated_at`. This is the
   * semantically correct field for "when was this role posted." */
  first_published?: string;
}

export async function collectGreenhouse(fetcher: Fetcher, boardToken: string, signal?: AbortSignal): Promise<CollectionResult> {
  const res = await fetcher.getText(`https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs`, { accept: "application/json", provider: "signals-ats-greenhouse", signal });
  if (res.status !== 200) return { metrics: [], collectionVersion: ATS_COLLECTOR_VERSION, sourceStatus: res.status };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { metrics: [], collectionVersion: ATS_COLLECTOR_VERSION, sourceStatus: res.status };
  }
  const rawJobs = Array.isArray((parsed as Record<string, unknown>)?.jobs) ? ((parsed as Record<string, unknown>).jobs as GreenhouseJob[]) : [];
  const jobs: AtsJob[] = rawJobs.map((j) => ({ externalJobId: String(j.id), title: j.title, postedAt: j.first_published ?? j.updated_at ?? null }));
  return { metrics: aggregateAtsJobs(jobs), collectionVersion: ATS_COLLECTOR_VERSION, sourceStatus: res.status };
}
