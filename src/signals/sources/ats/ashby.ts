import type { Fetcher } from "../../../sources/fetcher.ts";
import type { CollectionResult } from "../types.ts";
import { aggregateAtsJobs, type AtsJob } from "./aggregate.ts";
import { ATS_COLLECTOR_VERSION } from "./greenhouse.ts";

/** Ashby's public Job Postings API — official, no auth (developers.ashbyhq.com/docs/public-job-posting-api). */
interface AshbyJob {
  id: string;
  title: string;
  publishedAt?: string;
}

export async function collectAshby(fetcher: Fetcher, boardName: string, signal?: AbortSignal): Promise<CollectionResult> {
  const res = await fetcher.getText(`https://api.ashbyhq.com/posting-api/job-board/${boardName}`, { accept: "application/json", provider: "signals-ats-ashby", signal });
  if (res.status !== 200) return { metrics: [], collectionVersion: ATS_COLLECTOR_VERSION, sourceStatus: res.status };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { metrics: [], collectionVersion: ATS_COLLECTOR_VERSION, sourceStatus: res.status };
  }
  const rawJobs = Array.isArray((parsed as Record<string, unknown>)?.jobs) ? ((parsed as Record<string, unknown>).jobs as AshbyJob[]) : [];
  const jobs: AtsJob[] = rawJobs.map((j) => ({ externalJobId: j.id, title: j.title, postedAt: j.publishedAt ?? null }));
  return { metrics: aggregateAtsJobs(jobs), collectionVersion: ATS_COLLECTOR_VERSION, sourceStatus: res.status };
}
