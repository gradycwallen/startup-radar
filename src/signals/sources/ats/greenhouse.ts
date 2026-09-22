import type { Fetcher } from "../../../sources/fetcher.ts";
import type { CollectionResult } from "../types.ts";
import { aggregateAtsJobs, type AtsJob } from "./aggregate.ts";

/** Greenhouse's public Job Board API — official, no auth (docs.greenhouse.io/job-board.html). */
export const ATS_COLLECTOR_VERSION = "ats-v1";

interface GreenhouseJob {
  id: number;
  title: string;
  updated_at?: string;
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
  const jobs: AtsJob[] = rawJobs.map((j) => ({ externalJobId: String(j.id), title: j.title, postedAt: j.updated_at ?? null }));
  return { metrics: aggregateAtsJobs(jobs), collectionVersion: ATS_COLLECTOR_VERSION, sourceStatus: res.status };
}
