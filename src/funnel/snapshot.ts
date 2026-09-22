import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CompanyRow, EventRow } from "../dedupe.ts";

/**
 * A funnel snapshot lets the WHOLE V2-1 funnel run offline: `http/` holds recorded responses from every source (feeds,
 * Google News queries, directories, cohort pages, company homepages) and `db.json` the existing companies at recording
 * time. Replaying it needs no network, no credentials and no database.
 */
export const FUNNEL_SNAPSHOT_VERSION = 1;

const ManifestSchema = z.object({
  version: z.literal(FUNNEL_SNAPSHOT_VERSION),
  kind: z.literal("funnel"),
  created_at: z.string(),
  description: z.string(),
  /** When the sources were recorded. */
  now: z.string(),
  /** As-of dates (YYYY-MM-DD) whose Google News windows were recorded. */
  as_of_dates: z.array(z.string()),
  window_days: z.number(),
});
const DbSchema = z.object({
  companies: z.array(z.object({ id: z.number(), name: z.string(), domain: z.string() })),
  events: z.array(z.object({ id: z.number(), company_id: z.number(), event_type: z.string(), event_date: z.string().nullable(), source_url: z.string().nullable(), headline: z.string().nullable(), description: z.string().nullable() })),
});

export type FunnelManifest = z.infer<typeof ManifestSchema>;
export interface FunnelSnapshot {
  manifest: FunnelManifest;
  db: { companies: CompanyRow[]; events: EventRow[] };
}

export function writeFunnelSnapshot(dir: string, snap: FunnelSnapshot): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(snap.manifest, null, 2));
  writeFileSync(join(dir, "db.json"), JSON.stringify(snap.db, null, 2));
}

export function loadFunnelSnapshot(dir: string): FunnelSnapshot {
  if (!existsSync(dir)) throw new Error(`funnel snapshot directory not found: ${dir}`);
  const read = (name: string): unknown => {
    const file = join(dir, name);
    if (!existsSync(file)) throw new Error(`funnel snapshot is missing ${name} (${dir})`);
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`funnel snapshot file ${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const manifest = ManifestSchema.safeParse(read("manifest.json"));
  if (!manifest.success) throw new Error(`invalid funnel snapshot manifest: ${manifest.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (!existsSync(join(dir, "http"))) throw new Error(`funnel snapshot has no http/ recordings (${dir})`);
  const db = DbSchema.safeParse(read("db.json"));
  if (!db.success) throw new Error(`invalid funnel snapshot db.json: ${db.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { manifest: manifest.data, db: db.data };
}
