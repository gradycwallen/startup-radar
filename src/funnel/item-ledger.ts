import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { noRedaction, type Redactor } from "../redact.ts";
import type { SourceItem } from "../sources/types.ts";

export interface ItemRecord {
  item_id: string;
  provider: string;
  kind: string;
  lane: string;
  title: string;
  url: string;
  source_name: string | null;
  published_at: string | null;
  outbound_domains: string[];
  /** "lead": produced a lead. Otherwise the reason it produced none (e.g. "outside_window:stale", "roundup_or_digest"). */
  outcome: string;
  leads: number;
}

/**
 * Audit trail of EVERY source item retrieved (before any filtering), with what became of it. The lead ledger records
 * the company mentions extracted from items; this records the items themselves, so "why did we never see X" can be
 * answered: it was not in any source, it was outside the window, or extraction dropped it (and why).
 */
export class ItemLedger {
  readonly #records: ItemRecord[] = [];
  readonly #jsonl: string | null;
  readonly #json: string | null;
  readonly #redact: Redactor;

  constructor(options: { dir?: string; runId: string; redact?: Redactor }) {
    this.#redact = options.redact ?? noRedaction;
    if (options.dir) {
      mkdirSync(options.dir, { recursive: true });
      this.#jsonl = join(options.dir, `${options.runId}.items.jsonl`);
      this.#json = join(options.dir, `${options.runId}.items.json`);
    } else {
      this.#jsonl = null;
      this.#json = null;
    }
  }

  static inMemory(): ItemLedger {
    return new ItemLedger({ runId: "test" });
  }

  record(item: SourceItem, outcome: string, leads: number): void {
    const rec: ItemRecord = {
      item_id: item.item_id, provider: item.provider, kind: item.kind, lane: item.lane, title: item.title, url: item.url, source_name: item.source_name,
      published_at: item.published_at, outbound_domains: item.outbound_domains, outcome, leads,
    };
    this.#records.push(rec);
    if (this.#jsonl) appendFileSync(this.#jsonl, this.#redact(JSON.stringify(rec)) + "\n");
  }

  all(): readonly ItemRecord[] {
    return this.#records;
  }

  summary(): { total: number; by_outcome: Record<string, number>; files: { jsonl: string | null; json: string | null } } {
    const by_outcome: Record<string, number> = {};
    for (const r of this.#records) by_outcome[r.outcome] = (by_outcome[r.outcome] ?? 0) + 1;
    return { total: this.#records.length, by_outcome, files: { jsonl: this.#jsonl, json: this.#json } };
  }

  close(): void {
    if (this.#json) writeFileSync(this.#json, this.#redact(JSON.stringify({ total: this.#records.length, items: this.#records }, null, 2)));
  }
}
