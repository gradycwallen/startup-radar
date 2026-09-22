import type { CollectedMetric } from "../types.ts";
import { classifyRole, isEnterpriseSalesRole, isRecruitingRole, isSecurityComplianceRole, ROLE_CATEGORIES } from "./roles.ts";

/** Normalized job posting, independent of which ATS it came from. */
export interface AtsJob {
  externalJobId: string;
  title: string;
  postedAt: string | null;
}

/**
 * Turns a list of open postings into the metric set every ATS collector reports. Shared so
 * Greenhouse/Lever/Ashby collectors differ only in fetching+parsing, never in what a "hiring
 * observation" means — one set of metric names, one place that decides what counts as what.
 */
export function aggregateAtsJobs(jobs: readonly AtsJob[]): CollectedMetric[] {
  const metrics: CollectedMetric[] = [{ metricName: "ats_open_jobs_total", numericValue: jobs.length, textValue: null, sourceTimestamp: null }];

  const byCategory = new Map<string, number>();
  for (const c of ROLE_CATEGORIES) byCategory.set(c, 0);
  for (const job of jobs) {
    const category = classifyRole(job.title);
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
  }
  for (const [category, count] of byCategory) metrics.push({ metricName: `ats_open_jobs_${category}`, numericValue: count, textValue: null, sourceTimestamp: null });

  metrics.push({ metricName: "ats_has_enterprise_sales_role", numericValue: jobs.some((j) => isEnterpriseSalesRole(j.title)) ? 1 : 0, textValue: null, sourceTimestamp: null });
  metrics.push({ metricName: "ats_has_recruiting_role", numericValue: jobs.some((j) => isRecruitingRole(j.title)) ? 1 : 0, textValue: null, sourceTimestamp: null });
  metrics.push({ metricName: "ats_has_security_compliance_role", numericValue: jobs.some((j) => isSecurityComplianceRole(j.title)) ? 1 : 0, textValue: null, sourceTimestamp: null });

  const withDates = jobs.filter((j): j is AtsJob & { postedAt: string } => j.postedAt !== null).sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  if (withDates.length > 0) metrics.push({ metricName: "ats_most_recent_posting_at", numericValue: null, textValue: withDates[0]!.postedAt, sourceTimestamp: withDates[0]!.postedAt });

  return metrics;
}
