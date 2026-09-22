import { ExistingIndex } from "../funnel/existing.ts";
import { DEFAULT_FUNNEL_CONFIG, runFunnel, type FunnelConfig, type FunnelResult } from "../funnel/funnel.ts";
import { ItemLedger } from "../funnel/item-ledger.ts";
import { loadFunnelSnapshot } from "../funnel/snapshot.ts";
import { aliasKey, nameKey } from "../funnel/text.ts";
import { createHomepageChecker } from "../http.ts";
import { LeadLedger } from "../ledger.ts";
import { nullLogger } from "../log.ts";
import { PoliteFetcher } from "../sources/fetcher.ts";
import { defaultSourceProviders, selectProviders } from "../sources/registry.ts";
import { HttpSnapshotStore, createReplayFetch } from "../snapshot.ts";
import type { RankedEntity } from "../funnel/rank.ts";
import { LABELS, type Label } from "./labels.ts";

export type DomainVerdict = "exact" | "alt" | "mismatch" | "unresolved";

export interface TargetStages {
  /** Some source item's title mentions the company (before any filtering). */
  item_found: boolean;
  /** Extraction produced a raw lead for it. */
  lead: boolean;
  prefiltered: string | null;
  entity: boolean;
  existing: boolean;
  rank: number | null;
  score: number | null;
  finalist: boolean;
  track: string | null;
  selection: string | null;
  domain_resolved: string | null;
  domain_verdict: DomainVerdict;
  providers: string[];
  source_keys: string[];
  /** Where in the funnel it was lost, or "finalist". */
  outcome: string;
}

export interface TargetResult {
  label: Label;
  as_of: string;
  stages: TargetStages;
  /** Same measurement at every other as-of day (for context, e.g. a company visible a day later). */
  elsewhere: Array<{ as_of: string; outcome: string; rank: number | null }>;
}

export interface EvalReport {
  finalists: number;
  runs: Array<{ as_of: string; counts: FunnelResult["counts"]; providers: FunnelResult["providers"]; finalists: Array<{ name: string; score: number; domain: string | null; providers: string[]; selection: string; rank: number; track: string; label: string | null }> }>;
  targets: TargetResult[];
  recall: { group: string; n: number; raw_lead: number; entity: number; finalist: number; finalist_domain_ok: number }[];
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const keysOfLabel = (l: Label) => [nameKey(l.name), aliasKey(l.name)].filter((k) => k.length >= 2);
const domainsOfLabel = (l: Label) => [l.domain, ...(l.altDomains ?? [])];

export function matchesLabel(l: Label, name: string, domains: readonly string[] = []): boolean {
  const keys = keysOfLabel(l);
  const nk = nameKey(name);
  const ak = aliasKey(name);
  if (keys.includes(nk) || keys.includes(ak)) return true;
  return domains.some((d) => domainsOfLabel(l).includes(d));
}

function verdict(l: Label, resolved: string | null): DomainVerdict {
  if (!resolved) return "unresolved";
  if (resolved === l.domain) return "exact";
  if ((l.altDomains ?? []).includes(resolved)) return "alt";
  return "mismatch";
}

function measure(l: Label, r: FunnelResult, itemTitles: readonly string[]): TargetStages {
  const wordRe = new RegExp(`(^|[^a-z0-9])${l.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
  const item_found = itemTitles.some((t) => wordRe.test(t) || (compact(l.name).length >= 5 && compact(t).includes(compact(l.name))));
  const leads = r.leads.filter((x) => matchesLabel(l, x.name, x.domain_candidates ?? []));
  const pre = r.prefiltered.find((x) => matchesLabel(l, x.name));
  const ranked = r.ranked.find((x: RankedEntity) => matchesLabel(l, x.entity.name, x.entity.domain.candidates.map((c) => c.domain)));
  const existing = r.existing.find((x) => matchesLabel(l, x.name));
  const stages: TargetStages = {
    item_found, lead: leads.length > 0, prefiltered: pre?.reason ?? null, entity: !!ranked || !!existing, existing: !!existing, rank: ranked?.rank ?? null, score: ranked?.score ?? null,
    finalist: ranked?.finalist ?? false, track: ranked?.track ?? null, selection: ranked?.selection ?? null, domain_resolved: ranked?.entity.domain.domain ?? null,
    domain_verdict: verdict(l, ranked?.entity.domain.domain ?? null), providers: ranked?.entity.providers ?? [], source_keys: ranked?.entity.source_keys ?? [], outcome: "",
  };
  stages.outcome = stages.finalist ? "finalist" : stages.existing ? "existing_company" : stages.entity ? `ranked_not_selected(${stages.selection})` : stages.prefiltered ? `prefiltered:${stages.prefiltered}` : stages.lead ? "lead_lost_in_clustering" : stages.item_found ? "item_seen_no_lead_extracted" : "not_in_any_source_item";
  return stages;
}

export interface EvalOptions {
  snapshotDir: string;
  asOfDates?: string[];
  providers?: string[];
  finalists?: number;
  windowDays?: number;
  labels?: readonly Label[];
}

/** Run the WHOLE funnel offline (replayed sources, snapshot database) for each as-of date and measure recall against the labels. */
export async function evaluate(opts: EvalOptions): Promise<EvalReport> {
  const snap = loadFunnelSnapshot(opts.snapshotDir);
  const dates = opts.asOfDates ?? snap.manifest.as_of_dates;
  const labels = opts.labels ?? LABELS;
  const providers = selectProviders(defaultSourceProviders(), opts.providers);
  const store = new HttpSnapshotStore(opts.snapshotDir);
  const fetchImpl = createReplayFetch(store);
  const results: Array<{ date: string; result: FunnelResult; titles: string[] }> = [];
  for (const date of dates) {
    const items = ItemLedger.inMemory();
    const cfg: FunnelConfig = { ...DEFAULT_FUNNEL_CONFIG, ...(opts.finalists ? { finalists: opts.finalists } : {}), ...(opts.windowDays ? { windowDays: opts.windowDays } : {}), asOf: new Date(`${date}T23:59:59.999Z`) };
    const result = await runFunnel(
      {
        providers, fetcher: new PoliteFetcher({ fetchImpl, minDelayMs: 0, hostDelayMs: {} }), existing: new ExistingIndex(snap.db.companies, snap.db.events),
        checkHomepage: createHomepageChecker(fetchImpl), ledger: LeadLedger.inMemory(), items, log: nullLogger(), signal: new AbortController().signal,
      },
      cfg,
    );
    results.push({ date, result, titles: items.all().filter((i) => i.outcome.startsWith("outside_window:after") === false).map((i) => i.title) });
  }
  const byDate = Object.fromEntries(results.map((r) => [r.date, r]));
  const targets: TargetResult[] = labels.map((label) => {
    const main = byDate[label.expectedAsOf];
    if (!main) throw new Error(`no run for expected as-of ${label.expectedAsOf} (have ${dates.join(", ")})`);
    const stages = measure(label, main.result, main.titles);
    const elsewhere = results.filter((r) => r.date !== label.expectedAsOf).map((r) => {
      const s = measure(label, r.result, r.titles);
      return { as_of: r.date, outcome: s.outcome, rank: s.rank };
    });
    return { label, as_of: label.expectedAsOf, stages, elsewhere };
  });
  const recallOf = (group: Label["group"]) => {
    const ts = targets.filter((t) => t.label.group === group);
    const n = ts.length;
    return {
      group, n, raw_lead: ts.filter((t) => t.stages.lead || t.stages.existing).length, entity: ts.filter((t) => t.stages.entity).length,
      finalist: ts.filter((t) => t.stages.finalist).length, finalist_domain_ok: ts.filter((t) => t.stages.finalist && (t.stages.domain_verdict === "exact" || t.stages.domain_verdict === "alt")).length,
    };
  };
  return {
    finalists: opts.finalists ?? DEFAULT_FUNNEL_CONFIG.finalists,
    runs: results.map((r) => ({
      as_of: r.date, counts: r.result.counts, providers: r.result.providers,
      finalists: [...r.result.finalists, ...r.result.directory_finalists].map((f) => ({
        name: f.entity.name, score: f.score, domain: f.entity.domain.domain, providers: f.entity.providers, selection: f.selection, rank: f.rank, track: f.track,
        label: labels.find((l) => matchesLabel(l, f.entity.name, f.entity.domain.candidates.map((c) => c.domain)))?.name ?? null,
      })),
    })),
    targets,
    recall: [recallOf("primary"), recallOf("separate")],
  };
}

export function formatEval(rep: EvalReport): string {
  const L: string[] = [];
  L.push(`FINALISTS PER RUN: ${rep.finalists}`);
  L.push("\nTARGETS (at the daily run that should catch them)");
  for (const t of rep.targets) {
    const s = t.stages;
    L.push(`  ${t.label.name.padEnd(14)} as-of ${t.as_of} [${t.label.group}] -> ${s.outcome.padEnd(46)} item:${s.item_found ? "Y" : "n"} lead:${s.lead ? "Y" : "n"} rank:${String(s.rank ?? "-").padStart(3)}${s.finalist && s.track ? `[${s.track}]` : ""} score:${String(s.score ?? "-").padStart(5)} domain:${s.domain_verdict}${s.domain_resolved ? `(${s.domain_resolved})` : ""}`);
    if (s.providers.length) L.push(`${" ".repeat(19)}found via ${s.providers.join(", ")}; sources: ${s.source_keys.join(", ")}`);
    const other = t.elsewhere.filter((e) => e.outcome !== "not_in_any_source_item");
    if (other.length) L.push(`${" ".repeat(19)}other days: ${other.map((e) => `${e.as_of.slice(5)}=${e.outcome}${e.rank ? `#${e.rank}` : ""}`).join("  ")}`);
  }
  L.push("\nRECALL");
  for (const r of rep.recall) L.push(`  ${r.group.padEnd(9)} n=${r.n}  raw lead ${r.raw_lead}/${r.n}   entity ${r.entity}/${r.n}   finalist@${rep.finalists} ${r.finalist}/${r.n}   finalist with correct domain ${r.finalist_domain_ok}/${r.n}`);
  return L.join("\n");
}
