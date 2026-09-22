import type { Fetcher } from "../../../sources/fetcher.ts";
import type { CollectionResult } from "../types.ts";
import { aggregateAtsJobs, type AtsJob } from "./aggregate.ts";
import { ATS_COLLECTOR_VERSION } from "./greenhouse.ts";

/** Lever's public Postings API — official, no auth (github.com/lever/postings-api). Returns only
 * published (public) postings; nothing hidden/internal is ever reachable through it. */
interface LeverPosting {
  id: string;
  text: string;
  createdAt?: number; // epoch ms
}

export async function collectLever(fetcher: Fetcher, siteToken: string, signal?: AbortSignal): Promise<CollectionResult> {
  const res = await fetcher.getText(`https://api.lever.co/v0/postings/${siteToken}?mode=json`, { accept: "application/json", provider: "signals-ats-lever", signal });
  if (res.status !== 200) return { metrics: [], collectionVersion: ATS_COLLECTOR_VERSION, sourceStatus: res.status };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { metrics: [], collectionVersion: ATS_COLLECTOR_VERSION, sourceStatus: res.status };
  }
  const rawJobs = Array.isArray(parsed) ? (parsed as LeverPosting[]) : [];
  const jobs: AtsJob[] = rawJobs.map((j) => ({ externalJobId: j.id, title: j.text, postedAt: typeof j.createdAt === "number" ? new Date(j.createdAt).toISOString() : null }));
  return { metrics: aggregateAtsJobs(jobs), collectionVersion: ATS_COLLECTOR_VERSION, sourceStatus: res.status };
}
