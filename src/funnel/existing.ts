import type { CompanyRow, EventRow } from "../dedupe.ts";
import { normalizeUrl } from "../domain.ts";
import type { Entity } from "./entities.ts";
import { aliasKey, nameKey } from "./text.ts";

export interface ExistingMatch {
  company_id: number;
  name: string;
  domain: string;
  via: "domain" | "name" | "alias";
  /** An existing event already holds one of this entity's source URLs. */
  known_source: boolean;
  /** True when the entity brings a source we do not hold yet: a potential NEW EVENT for an existing company. */
  event_lead: boolean;
}

export interface ExistingSource {
  readAllForSnapshot(): Promise<{ companies: CompanyRow[]; events: EventRow[] }>;
}

/**
 * The companies already in Startup Radar, loaded ONCE (a read-only, paged read) and indexed by domain, name and alias, so
 * every lead can be checked in memory before it can take a verification slot.
 */
export class ExistingIndex {
  readonly #byDomain: Record<string, CompanyRow> = {};
  readonly #byName: Record<string, CompanyRow> = {};
  readonly #byAlias: Record<string, CompanyRow> = {};
  readonly #eventUrls: Record<number, string[]> = {};
  readonly size: number;

  constructor(companies: readonly CompanyRow[], events: readonly EventRow[]) {
    for (const c of companies) {
      this.#byDomain[c.domain.toLowerCase()] = c;
      this.#byName[nameKey(c.name)] = c;
      const a = aliasKey(c.name);
      if (a.length >= 4) this.#byAlias[a] = c;
    }
    for (const e of events) {
      const u = e.source_url ? normalizeUrl(e.source_url) : null;
      if (u) (this.#eventUrls[e.company_id] ??= []).push(u);
    }
    this.size = companies.length;
  }

  static async load(source: ExistingSource): Promise<ExistingIndex> {
    const { companies, events } = await source.readAllForSnapshot();
    return new ExistingIndex(companies, events);
  }

  /**
   * Match an entity to an existing company by (1) its resolved domain, (2) an identical normalized name, or (3) an identical
   * alias (generic trailing words removed). A domain only counts when it is the entity's own resolved domain, never merely a
   * link found in an article (an article about X that links to an existing company must not be mistaken for that company).
   */
  match(entity: Pick<Entity, "name" | "domain" | "evidence">): ExistingMatch | null {
    let company: CompanyRow | undefined;
    let via: ExistingMatch["via"] = "name";
    if (entity.domain.domain && this.#byDomain[entity.domain.domain]) {
      company = this.#byDomain[entity.domain.domain];
      via = "domain";
    } else if (this.#byName[nameKey(entity.name)]) {
      company = this.#byName[nameKey(entity.name)];
    } else {
      const a = aliasKey(entity.name);
      if (a.length >= 4 && this.#byAlias[a]) {
        company = this.#byAlias[a];
        via = "alias";
      }
    }
    if (!company) return null;
    const held = this.#eventUrls[company.id] ?? [];
    const knownSource = entity.evidence.some((e) => {
      const u = normalizeUrl(e.source_url);
      return !!u && held.includes(u);
    });
    return { company_id: company.id, name: company.name, domain: company.domain, via, known_source: knownSource, event_lead: !knownSource };
  }
}
