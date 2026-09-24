import { ScoutTimeoutError, timeoutScope } from "../deadline.ts";
import type { HomepageChecker } from "../http.ts";
import { LeadLedger, leadId } from "../ledger.ts";
import type { Logger } from "../log.ts";
import type { RawLead } from "../schema.ts";
import type { PoliteFetcher } from "../sources/fetcher.ts";
import type { ProviderHealth, ProviderRun, SourceItem, SourceProvider } from "../sources/types.ts";
import { normalizeDomain } from "../domain.ts";
import { candidateDomains } from "../sources/domains.ts";
import { extractLinks, parseHtml } from "../sources/html.ts";
import { candidateDomainGuess, resolveEntityDomain } from "./domains.ts";
import { verifyDomainIdentity, type ContradictionHit, type SignalHit } from "./domain-verify.ts";
import { clusterLeads, sourceKey, type Entity } from "./entities.ts";
import { extractLeads } from "./extract.ts";
import type { ExistingIndex, ExistingMatch } from "./existing.ts";
import { ItemLedger } from "./item-ledger.ts";
import { prefilterLead } from "./prefilter.ts";
import { isDirectoryOnly, publisherReliability, rankEntities, scoreEntity, selectDirectoryFinalists, selectFinalists, type DomainCheck, type RankedEntity, type ScoreContext } from "./rank.ts";
import { nameKey, aliasKey } from "./text.ts";

export interface FunnelConfig {
  /** The instant the run is "as of"; items published after it do not exist for this run. */
  asOf: Date;
  windowDays: number;
  /** Finalists from the NEWS track (events found in articles: the ones needing real verification). */
  finalists: number;
  /** Finalists from the DIRECTORY track (official YC/Techstars members; identity and website are stated by the source). */
  directoryFinalists: number;
  /** How many top pre-scored news entities without a domain get their article page fetched to look for the company's own link. */
  articleBudget: number;
  /** How many top pre-scored entities STILL without a domain (after article enrichment) get a
   * single `{name}.com` guess checked and run through the stronger identity verifier
   * (domain-verify.ts). EXPERIMENTAL — see the field's own comment on DEFAULT_FUNNEL_CONFIG below.
   * Never accepted on name-match alone; requires independent identity evidence. */
  domainGuessBudget: number;
  /** How many top pre-scored entities get a homepage check (network) before final ranking. */
  homepageBudget: number;
  homepageConcurrency: number;
  minScore: number;
  reserveMinScore: number;
  maxProviderShare: number;
  maxLaneShare: number;
  providerTimeoutMs: number;
}

export const DEFAULT_FUNNEL_CONFIG: Omit<FunnelConfig, "asOf"> = {
  windowDays: 3,
  finalists: 14,
  directoryFinalists: 25,
  articleBudget: 25,
  // EXPERIMENTAL, OFF BY DEFAULT (2026-09-23 — see root CLAUDE.md's research note). This is the
  // SECOND attempt at this idea: the first (name + reachable + name-on-page) was live-tested,
  // found to accept 2 wrong domains out of 10 (an unrelated, already-established same-named
  // company owning the domain — e.g. a funded startup "Travix" vs. the real Travix International
  // travel agency), and was fully reverted. This version requires independent identity evidence
  // beyond the bare name (domain-verify.ts: an investor name, a funding amount, or a distinctive
  // phrase from the discovery evidence actually appearing on the candidate page — never the name
  // alone) and explicit contradiction detection (scale/ownership language). It has NOT yet been
  // validated against a controlled live precision audit with manual review of every accepted
  // mapping — do not raise this above 0 without that review and explicit approval; see the
  // delivery report for exactly what's outstanding.
  domainGuessBudget: 0,
  homepageBudget: 30,
  homepageConcurrency: 4,
  minScore: 30,
  reserveMinScore: 50,
  maxProviderShare: 0.4,
  maxLaneShare: 0.6,
  providerTimeoutMs: 180_000,
};

export interface FunnelDeps {
  providers: readonly SourceProvider[];
  fetcher: PoliteFetcher;
  existing: ExistingIndex;
  checkHomepage: HomepageChecker;
  ledger: LeadLedger;
  items: ItemLedger;
  log: Logger;
  signal: AbortSignal;
}

export interface MergeRecord {
  entity_id: string;
  name: string;
  leads: number;
  providers: string[];
  lanes: string[];
  source_keys: string[];
}

export interface ExistingRecord {
  entity_id: string;
  name: string;
  match: ExistingMatch;
  providers: string[];
  source_urls: string[];
}

export interface FunnelCounts {
  items_fetched: number;
  items_outside_window: number;
  items_in_window: number;
  items_without_lead: number;
  raw_leads: number;
  prefiltered: number;
  leads_after_prefilter: number;
  entities: number;
  duplicate_leads_merged: number;
  entities_multi_provider: number;
  entities_multi_lane: number;
  entities_multi_source: number;
  existing_entities: number;
  existing_event_leads: number;
  existing_known_source: number;
  new_entities: number;
  directory_entities: number;
  article_pages_attempted: number;
  article_pages_ok: number;
  article_domains_resolved: number;
  domain_guesses_attempted: number;
  domain_guesses_accepted: number;
  domain_guesses_rejected: number;
  homepage_checked: number;
  ranked: number;
  finalists: number;
  directory_finalists: number;
}

export interface FunnelResult {
  as_of: string;
  window_days: number;
  elapsed_ms: number;
  providers: ProviderHealth[];
  counts: FunnelCounts;
  item_drop_reasons: Record<string, number>;
  prefilter_reasons: Record<string, number>;
  merges: MergeRecord[];
  existing: ExistingRecord[];
  /** All new (non-existing) entities, ranked. */
  ranked: RankedEntity[];
  finalists: RankedEntity[];
  directory_finalists: RankedEntity[];
  /** Every prefiltered lead (name + reason), so drops can be audited and evaluated. */
  prefiltered: Array<{ lead_id: string; name: string; provider: string; reason: string }>;
  leads: RawLead[];
  /** EXPERIMENTAL (domainGuessBudget) — one entry per entity the guess step attempted, whether
   * accepted or rejected, with the full verifier breakdown. Empty whenever domainGuessBudget is 0
   * (the default). Exists so a precision audit never needs ad-hoc console-log instrumentation to
   * see WHY a guess was accepted or rejected — every signal is already structured data here. */
  domain_guess_audit: DomainGuessAuditEntry[];
}

export interface DomainGuessAuditEntry {
  entity_id: string;
  name: string;
  guess: string;
  accepted: boolean;
  reachable: boolean;
  final_url: string | null;
  strong: SignalHit[];
  moderate: SignalHit[];
  /** Logged for transparency only — never contributed to acceptance (see domain-verify.ts's own
   * doc comment on why round/location were downgraded to WEAK). */
  weak: SignalHit[];
  /** A hit that would otherwise have counted but was discarded because it shared a literal token
   * with an already-counted hit — i.e. two categories describing the same underlying fact. */
  discarded: SignalHit[];
  contradictions: ContradictionHit[];
  reason: string;
}

const DAY = 86_400_000;

function classifyWindow(item: SourceItem, provider: SourceProvider, cfg: FunnelConfig): string | null {
  if (provider.undated || !item.published_at) return null;
  const t = Date.parse(item.published_at);
  if (t > cfg.asOf.getTime()) return "after_as_of";
  if (cfg.asOf.getTime() - t > (provider.maxAgeDays ?? cfg.windowDays) * DAY) return "stale";
  return null;
}

async function collect(provider: SourceProvider, cfg: FunnelConfig, deps: FunnelDeps): Promise<ProviderRun> {
  const scope = timeoutScope("lane", provider.id, cfg.providerTimeoutMs, deps.signal);
  try {
    const items = await provider.fetchItems({ asOf: cfg.asOf, windowDays: cfg.windowDays, fetcher: deps.fetcher, signal: scope.signal, log: deps.log });
    return { provider, items, error: null };
  } catch (err) {
    const message = err instanceof ScoutTimeoutError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    deps.log.warn("provider_failed", { message: `${provider.id}: ${message}`, provider: provider.id });
    return { provider, items: [], error: message };
  } finally {
    scope.cancel();
  }
}

function healthOf(run: ProviderRun, inWindow: number, deps: FunnelDeps, cfg: FunnelConfig): ProviderHealth {
  const s = deps.fetcher.stats(run.provider.id);
  const dates = run.items.map((i) => i.published_at).filter((d): d is string => !!d).sort();
  const ok200 = s.statuses["200"] ?? 0;
  const bad = s.requests - ok200;
  let status: ProviderHealth["status"] = "ok";
  let note: string | null = null;
  if (run.error) { status = "failed"; note = run.error; }
  else if (s.requests > 0 && ok200 === 0) { status = "failed"; note = `no successful response (${JSON.stringify(s.statuses)})`; }
  else if (run.items.length === 0) { status = "empty"; note = "fetched but produced no items"; }
  else if (bad > 0) { status = "degraded"; note = `${bad} of ${s.requests} requests failed (${JSON.stringify(s.statuses)})`; }
  else if (!run.provider.undated && dates.length > 0 && cfg.asOf.getTime() - Date.parse(dates[dates.length - 1] as string) > 7 * DAY) { status = "stale"; note = "newest item is more than 7 days old"; }
  return {
    provider: run.provider.id, kind: run.provider.kind, status, requests: s.requests, http_statuses: s.statuses, bytes: s.bytes, elapsed_ms: s.elapsed_ms,
    items_fetched: run.items.length, items_in_window: inWindow, newest_item: dates[dates.length - 1] ?? null, oldest_item: dates[0] ?? null, note,
  };
}

async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i] as T);
    }
  }));
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export async function runFunnel(deps: FunnelDeps, cfg: FunnelConfig): Promise<FunnelResult> {
  const started = performance.now();
  const { log, ledger, items: itemLedger } = deps;
  const providerById: Record<string, SourceProvider> = {};
  for (const p of deps.providers) providerById[p.id] = p;
  const reliabilityOfProvider = (id: string) => providerById[id]?.reliability ?? 0.5;

  // 1. Collect (providers run concurrently, each isolated; the fetcher paces requests per host)
  const runs = await Promise.all(deps.providers.map((p) => collect(p, cfg, deps)));

  // 2. Window + deterministic extraction. Every item is recorded; every lead enters the ledger as soon as it exists.
  const itemDrop: Record<string, number> = {};
  const inWindowByProvider: Record<string, number> = {};
  const leadsById: Record<string, RawLead> = {};
  const rawLeads: RawLead[] = [];
  let fetched = 0;
  let outside = 0;
  let noLead = 0;
  let inWindow = 0;
  for (const run of runs) {
    for (const item of run.items) {
      fetched++;
      const w = classifyWindow(item, run.provider, cfg);
      if (w) {
        outside++;
        itemDrop[`outside_window:${w}`] = (itemDrop[`outside_window:${w}`] ?? 0) + 1;
        itemLedger.record(item, `outside_window:${w}`, 0);
        continue;
      }
      inWindow++;
      inWindowByProvider[run.provider.id] = (inWindowByProvider[run.provider.id] ?? 0) + 1;
      const ex = extractLeads(item);
      if (ex.leads.length === 0) {
        noLead++;
        const reason = ex.dropped ?? "no_lead";
        itemDrop[reason] = (itemDrop[reason] ?? 0) + 1;
        itemLedger.record(item, reason, 0);
        continue;
      }
      itemLedger.record(item, "lead", ex.leads.length);
      ledger.recordDiscovered(ex.leads);
      for (const l of ex.leads) {
        const id = leadId(l);
        if (!(id in leadsById)) {
          leadsById[id] = l;
          rawLeads.push(l);
        }
      }
    }
  }
  const health = runs.map((r) => healthOf(r, inWindowByProvider[r.provider.id] ?? 0, deps, cfg));

  // 3. Deterministic prefilter
  const prefilterReasons: Record<string, number> = {};
  const prefiltered: FunnelResult["prefiltered"] = [];
  const survivors: RawLead[] = [];
  for (const lead of rawLeads) {
    const reason = prefilterLead(lead);
    if (reason) {
      prefilterReasons[reason] = (prefilterReasons[reason] ?? 0) + 1;
      ledger.decide(leadId(lead), "prefiltered", reason);
      prefiltered.push({ lead_id: leadId(lead), name: lead.name, provider: lead.provider, reason });
    } else survivors.push(lead);
  }

  // 4. Cluster across providers and lanes, keeping every piece of evidence
  const leadReliability = (l: RawLead) => publisherReliability(sourceKey(l), reliabilityOfProvider(l.provider), l.provider);
  const entities = clusterLeads(survivors, leadReliability);
  const merges: MergeRecord[] = [];
  let merged = 0;
  for (const e of entities) {
    e.domain = resolveEntityDomain(e);
    if (e.leads.length > 1) {
      merged += e.leads.length - 1;
      merges.push({ entity_id: e.entity_id, name: e.name, leads: e.leads.length, providers: e.providers, lanes: e.lanes, source_keys: e.source_keys });
      for (const id of e.lead_ids) {
        if (id !== e.primary_lead_id) ledger.decide(id, "merged_into_entity", `entity:${e.entity_id} (${e.name})`, { duplicate_of: e.primary_lead_id, candidate_domain: e.domain.domain });
      }
    }
  }

  // 5. Existing companies are identified BEFORE any verification slot is spent
  const existingRecords: ExistingRecord[] = [];
  const candidates: Entity[] = [];
  let knownSource = 0;
  for (const e of entities) {
    const m = deps.existing.match(e);
    if (!m) {
      candidates.push(e);
      continue;
    }
    if (m.known_source) knownSource++;
    existingRecords.push({ entity_id: e.entity_id, name: e.name, match: m, providers: e.providers, source_urls: e.evidence.map((x) => x.source_url) });
    ledger.decide(e.primary_lead_id, m.event_lead ? "existing_company_event_lead" : "existing_company_known_source", `matches existing company ${m.name} (${m.domain}) via ${m.via}`, {
      candidate_domain: m.domain,
    });
  }

  // 6. Score, check homepages for the top slice, re-score, rank, select
  const homepage: Record<string, DomainCheck> = {};
  const ctx: ScoreContext = { asOf: cfg.asOf, providerReliability: reliabilityOfProvider, homepage: (d) => homepage[d] };
  const mk = (e: Entity, existing: ExistingMatch | null): RankedEntity => {
    const s = scoreEntity(e, ctx);
    return { entity: e, track: isDirectoryOnly(e) ? "directory" : "news", score: s.score, breakdown: s.breakdown, rank: 0, homepage: e.domain.domain ? (homepage[e.domain.domain] ?? null) : null, existing, finalist: false, selection: "not_selected" };
  };
  const pre = rankEntities(candidates.map((e) => mk(e, null)));

  // 6a. Article enrichment: many feeds are excerpt-only, so the company's own link is not in the item. For the best news
  // entities still lacking a domain, fetch the article page itself (never aggregator redirects) and look for a link whose
  // name resembles the company. Blocked or missing pages are simply skipped.
  let articleAttempted = 0;
  let articleOk = 0;
  let articleResolved = 0;
  const articleCache: Record<string, string[] | null> = {};
  const enrichTargets = pre.filter((r) => r.track === "news" && !r.entity.domain.domain).slice(0, cfg.articleBudget);
  await pool(enrichTargets, 3, async (r) => {
    const e = r.entity;
    const urls = e.leads.map((l) => l.source_url).filter((u) => !/(^|\.)news\.google\.com$/.test(new URL(u).hostname)).slice(0, 2);
    for (const url of urls) {
      if (!(url in articleCache)) {
        articleAttempted++;
        articleCache[url] = null;
        try {
          const res = await deps.fetcher.getText(url, { provider: "article-enrichment", signal: deps.signal, accept: "text/html" });
          if (res.status === 200) {
            articleOk++;
            const root = parseHtml(res.text);
            const main = root.querySelector("article") ?? root.querySelector("main") ?? root;
            for (const el of main.querySelectorAll("nav,header,footer,aside,script,style")) el.remove();
            articleCache[url] = candidateDomains(extractLinks(main.innerHTML, url), [normalizeDomain(url) ?? ""]);
          }
        } catch {
          /* unreachable or blocked: skip */
        }
      }
      const found = articleCache[url];
      if (found?.length) {
        const lead = e.leads.find((l) => l.source_url === url);
        if (lead) lead.domain_candidates = [...new Set([...(lead.domain_candidates ?? []), ...found])];
      }
    }
    e.domain = resolveEntityDomain(e);
    if (e.domain.domain) articleResolved++;
  });

  // 6b. EXPERIMENTAL domain guess (see DEFAULT_FUNNEL_CONFIG.domainGuessBudget's own comment): for
  // entities STILL without any domain candidate after article enrichment, try ONE deterministic
  // `{name}.com` guess (domains.ts: candidateDomainGuess) and run it through the stronger identity
  // verifier (domain-verify.ts) — never the bare "reachable + name on page" check reverted after
  // the first attempt's live audit found real wrong-company matches. Accepted only when
  // independent evidence (an investor, a funding amount, a distinctive phrase — see
  // domain-verify.ts) confirms it AND no contradiction (scale/ownership language) is present. An
  // accepted guess is fed back as an ordinary `domain_candidates` entry, so it flows through
  // `resolveEntityDomain`'s existing "linked" trust path — no new trust tier, no change to scoring
  // or to the acceptance rule in src/discovery/accept.ts. Every attempt (accepted or not) is
  // recorded in `domain_guess_audit` with its full evidence breakdown, so a precision review never
  // needs ad-hoc instrumentation.
  let domainGuessAttempted = 0;
  let domainGuessAccepted = 0;
  let domainGuessRejected = 0;
  const domainGuessAudit: DomainGuessAuditEntry[] = [];
  const guessTargets = pre.filter((r) => !r.entity.domain.domain).slice(0, cfg.domainGuessBudget);
  await pool(guessTargets, cfg.homepageConcurrency, async (r) => {
    const e = r.entity;
    const guess = candidateDomainGuess(e.name);
    if (!guess) return;
    domainGuessAttempted++;

    // Unlike the general homepage-check step below (which only ever needs a boolean name_found),
    // the identity verifier needs the actual page text — fetched fresh here rather than reusing
    // `homepage[]`'s cache, since that cache never stores raw text (deliberately: it's shared with
    // the ranking step's homepage-check budget and keeping it small matters there).
    const res = await deps.checkHomepage(guess, deps.signal);
    const keys = [nameKey(e.name), aliasKey(e.name)].filter((k) => k.length >= 3);
    const text = res.text ? compact(res.text) : null;
    homepage[guess] = { domain: guess, reachable: res.reachable, name_found: text === null ? null : keys.some((k) => text.includes(k)), ...(res.status ? { status: res.status } : {}), ...(res.error ? { error: res.error } : {}) };

    if (!res.reachable) {
      domainGuessRejected++;
      domainGuessAudit.push({ entity_id: e.entity_id, name: e.name, guess, accepted: false, reachable: false, final_url: null, strong: [], moderate: [], weak: [], discarded: [], contradictions: [], reason: `rejected: unreachable (${res.error ?? "unknown"})` });
      return;
    }
    const verification = verifyDomainIdentity({ entity: e, pageText: res.text ?? "" });
    domainGuessAudit.push({
      entity_id: e.entity_id, name: e.name, guess, accepted: verification.accepted, reachable: true, final_url: res.finalUrl ?? null,
      strong: verification.strong, moderate: verification.moderate, weak: verification.weak, discarded: verification.discarded,
      contradictions: verification.contradictions, reason: verification.reason,
    });
    if (verification.accepted) {
      for (const lead of e.leads) lead.domain_candidates = [...new Set([...(lead.domain_candidates ?? []), guess])];
      e.domain = resolveEntityDomain(e);
      if (e.domain.domain) domainGuessAccepted++;
    } else {
      domainGuessRejected++;
    }
  });

  const toCheck = pre.filter((r) => r.entity.domain.domain).slice(0, cfg.homepageBudget);
  await pool(toCheck, cfg.homepageConcurrency, async (r) => {
    const domain = r.entity.domain.domain as string;
    if (domain in homepage) return;
    const res = await deps.checkHomepage(domain, deps.signal);
    const keys = [nameKey(r.entity.name), aliasKey(r.entity.name)].filter((k) => k.length >= 3);
    const text = res.text ? compact(res.text) : null;
    homepage[domain] = { domain, reachable: res.reachable, name_found: text === null ? null : keys.some((k) => text.includes(k)), ...(res.status ? { status: res.status } : {}), ...(res.error ? { error: res.error } : {}) };
  });
  const ranked = rankEntities(candidates.map((e) => mk(e, null)));
  const newsRanked = ranked.filter((r) => r.track === "news");
  const directoryRanked = ranked.filter((r) => r.track === "directory");
  const finalists = selectFinalists(newsRanked, { finalists: cfg.finalists, minScore: cfg.minScore, reserveMinScore: cfg.reserveMinScore, maxProviderShare: cfg.maxProviderShare, maxLaneShare: cfg.maxLaneShare });
  const directoryFinalists = selectDirectoryFinalists(directoryRanked, { finalists: cfg.directoryFinalists, minScore: cfg.minScore, maxProviderShare: 0.6 });

  for (const r of ranked) {
    const id = r.entity.primary_lead_id;
    if (r.finalist) {
      const disposition = r.track === "directory" ? "finalist_directory" : "finalist";
      ledger.stage(id, "selected", { candidate_domain: r.entity.domain.domain });
      ledger.decide(id, disposition, `${r.selection}; rank ${r.rank}; score ${r.score}`, { candidate_domain: r.entity.domain.domain });
      log.info("finalist", {
        message: `[${r.track}] #${r.rank} ${r.entity.name} score ${r.score} (${r.selection})`, entity: r.entity.entity_id, name: r.entity.name, score: r.score, domain: r.entity.domain.domain,
        breakdown: Object.fromEntries(Object.entries(r.breakdown).map(([k, c]) => [k, `${c.points}/${c.weight} ${c.note}`])), quiet: true,
      });
    } else {
      ledger.decide(id, "not_selected_rank", `${r.selection}; rank ${r.rank}; score ${r.score}`, { candidate_domain: r.entity.domain.domain });
    }
  }
  const existingRanked = existingRecords.length;
  ledger.finalizeOpen("funnel_ended");

  const counts: FunnelCounts = {
    items_fetched: fetched, items_outside_window: outside, items_in_window: inWindow, items_without_lead: noLead, raw_leads: rawLeads.length,
    prefiltered: prefiltered.length, leads_after_prefilter: survivors.length, entities: entities.length, duplicate_leads_merged: merged,
    entities_multi_provider: entities.filter((e) => e.providers.length > 1).length, entities_multi_lane: entities.filter((e) => e.lanes.length > 1).length,
    entities_multi_source: entities.filter((e) => e.source_keys.length > 1).length, existing_entities: existingRanked,
    existing_event_leads: existingRecords.filter((x) => x.match.event_lead).length, existing_known_source: knownSource, new_entities: candidates.length,
    directory_entities: directoryRanked.length, article_pages_attempted: articleAttempted, article_pages_ok: articleOk, article_domains_resolved: articleResolved,
    domain_guesses_attempted: domainGuessAttempted, domain_guesses_accepted: domainGuessAccepted, domain_guesses_rejected: domainGuessRejected,
    homepage_checked: Object.keys(homepage).length, ranked: ranked.length, finalists: finalists.length, directory_finalists: directoryFinalists.length,
  };
  itemLedger.close();
  ledger.close();
  return {
    as_of: cfg.asOf.toISOString(), window_days: cfg.windowDays, elapsed_ms: Math.round(performance.now() - started), providers: health, counts,
    item_drop_reasons: itemDrop, prefilter_reasons: prefilterReasons, merges: merges.sort((a, b) => b.leads - a.leads), existing: existingRecords, ranked, finalists, directory_finalists: directoryFinalists, prefiltered, leads: rawLeads,
    domain_guess_audit: domainGuessAudit,
  };
}
