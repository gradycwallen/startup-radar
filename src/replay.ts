import { emptyUsage } from "./claude.ts";
import type { CompanyRow, EventRow } from "./dedupe.ts";
import type { HomepageCheck, HomepageChecker } from "./http.ts";
import { leadId } from "./ledger.ts";
import type { DiscoveryContext, DiscoveryProvider, LaneReport, ProviderResult } from "./providers/types.ts";
import type { RawLead, Verification } from "./schema.ts";
import { SNAPSHOT_VERSION, SnapshotMissError, writeSnapshot, type Snapshot } from "./snapshot.ts";
import type { Verifier, VerifierOutput, VerifyContext } from "./verify.ts";

/**
 * Replay components. Each serves recorded data only, so a run built from them needs no credentials,
 * makes no Anthropic call, touches no live source and no database. Anything not in the snapshot fails
 * loudly (SnapshotMissError / "not_in_snapshot") instead of silently going live.
 */

export class ReplayProvider implements DiscoveryProvider {
  readonly name = "replay";
  readonly lanes: readonly string[];
  constructor(private readonly data: Snapshot["discovery"]) {
    this.lanes = [...new Set([...data.lanes.map((l) => l.lane), ...data.leads.map((l) => l.lane)])];
  }

  async discover(ctx: DiscoveryContext): Promise<ProviderResult> {
    const leads: RawLead[] = [];
    const reports: LaneReport[] = [];
    for (const lane of this.lanes) {
      if (ctx.lanes?.length && !ctx.lanes.includes(lane)) continue;
      const recorded = this.data.lanes.find((l) => l.lane === lane);
      if (ctx.signal.aborted) {
        reports.push({ lane, status: "skipped_shutdown", elapsed_ms: 0, leads: 0, usage: emptyUsage() });
        continue;
      }
      const laneLeads = this.data.leads.filter((l) => l.lane === lane);
      ctx.onLeads?.(laneLeads);
      leads.push(...laneLeads);
      // Recorded status is kept; recorded cost/time are NOT (nothing was spent or waited on in this replay).
      reports.push({
        lane, status: recorded?.status === "ok" || !recorded ? "ok" : (recorded.status as LaneReport["status"]),
        elapsed_ms: 0, leads: laneLeads.length, usage: emptyUsage(),
        ...(recorded?.error ? { error: recorded.error } : {}),
      });
    }
    return { leads, errors: [], lanes: reports, usage: emptyUsage() };
  }
}

export class SnapshotVerifier implements Verifier {
  constructor(private readonly data: Snapshot["verifications"]) {}

  async verify(lead: RawLead, _ctx: VerifyContext): Promise<VerifierOutput> {
    const id = leadId(lead);
    const rec = this.data[id];
    if (!rec) throw new SnapshotMissError(`no recorded verification for lead ${id} (${lead.name})`);
    return { verification: rec.verification, retrievedUrls: new Set(rec.retrieved_urls) };
  }
}

/** The database as it was when the snapshot was taken. Read-only by construction. */
export class SnapshotReader {
  constructor(private readonly data: Snapshot["db"]) {}
  async findCompanyByDomain(domain: string): Promise<CompanyRow | null> {
    return this.data.companies.find((c) => c.domain === domain) ?? null;
  }
  async findCompaniesByName(name: string): Promise<CompanyRow[]> {
    return this.data.companies.filter((c) => c.name.toLowerCase() === name.toLowerCase());
  }
  async getEvents(companyId: number): Promise<EventRow[]> {
    return this.data.events.filter((e) => e.company_id === companyId);
  }
  async counts(): Promise<{ companies: number; discovery_events: number }> {
    return { companies: this.data.companies.length, discovery_events: this.data.events.length };
  }
}

export function snapshotHomepageChecker(homepages: Snapshot["homepages"]): HomepageChecker {
  return async (domain) => homepages[domain] ?? { reachable: false, error: "not_in_snapshot" };
}

// ---------------------------------------------------------------------------------------------
// Recording (used by a live run with --record-snapshot)
// ---------------------------------------------------------------------------------------------

/** Collects what a live run sees so it can be written as a replayable snapshot. Wrapping never changes behavior. */
export class SnapshotRecorder {
  #provider = "recorded";
  #lanes: LaneReport[] = [];
  #leads: RawLead[] = [];
  readonly #verifications: Snapshot["verifications"] = {};
  readonly #homepages: Record<string, HomepageCheck> = {};

  wrapProvider(inner: DiscoveryProvider): DiscoveryProvider {
    this.#provider = inner.name;
    return {
      name: inner.name,
      lanes: inner.lanes,
      discover: async (ctx) => {
        const res = await inner.discover(ctx);
        this.#lanes = res.lanes;
        this.#leads = res.leads;
        return res;
      },
    };
  }

  wrapVerifier(inner: Verifier): Verifier {
    return {
      verify: async (lead, ctx) => {
        const out = await inner.verify(lead, ctx);
        this.#verifications[leadId(lead)] = { verification: out.verification as Verification, retrieved_urls: [...out.retrievedUrls] };
        return out;
      },
    };
  }

  wrapHomepageChecker(inner: HomepageChecker): HomepageChecker {
    return async (domain, signal) => {
      const res = await inner(domain, signal);
      this.#homepages[domain] ??= res;
      return res;
    };
  }

  /** Write the snapshot directory. `db` is the read-only database state to freeze alongside. */
  finish(dir: string, meta: { now: Date; runId: string | null; description: string; db: Snapshot["db"] }): void {
    writeSnapshot(dir, {
      manifest: { version: SNAPSHOT_VERSION, created_at: new Date().toISOString(), description: meta.description, source_run_id: meta.runId, now: meta.now.toISOString() },
      discovery: { provider: this.#provider, lanes: this.#lanes, leads: this.#leads },
      verifications: this.#verifications,
      homepages: this.#homepages,
      db: meta.db,
    });
  }
}
