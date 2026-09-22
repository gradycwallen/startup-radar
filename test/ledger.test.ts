import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LeadLedger, leadId } from "../src/ledger.ts";
import { createRedactor } from "../src/redact.ts";
import type { RawLead } from "../src/schema.ts";

const lead = (over: Partial<RawLead> = {}): RawLead => ({
  provider: "claude-web", lane: "funding", name: "Acme", homepage_hint: "https://www.Acme.ai/pricing", event_type_hint: "funding",
  source_url: "https://news.example.com/acme?utm_source=x", source_name: "Example News", event_date: "2026-09-10", headline: "Acme raises $5M",
  snippet: "A seed round.", source_retrieved: true, ...over,
});
const tick = () => { let n = 0; return () => new Date(Date.UTC(2026, 8, 21, 12, 0, n++)); };

test("lead ids are stable, and differ by provider, lane, source URL and name; URL spelling does not matter", () => {
  const a = leadId(lead());
  assert.equal(a, leadId(lead({ source_url: "http://www.news.example.com/acme/?utm_medium=y#top" })));
  assert.equal(a, leadId(lead({ name: "  ACME " })));
  for (const other of [lead({ provider: "rss" }), lead({ lane: "news" }), lead({ source_url: "https://news.example.com/other" }), lead({ name: "Beta" })]) {
    assert.notEqual(a, leadId(other));
  }
  assert.match(a, /^[0-9a-f]{12}$/);
});

test("every raw lead is recorded with name/title, source, provider/lane, domain hint and timestamps", () => {
  const ledger = new LeadLedger({ runId: "r", now: tick() });
  const [rec] = ledger.recordDiscovered([lead()]);
  assert.deepEqual(
    {
      name: rec!.name, title: rec!.title, source_url: rec!.source_url, source_name: rec!.source_name, provider: rec!.provider, lane: rec!.lane,
      homepage_hint: rec!.homepage_hint, domain_hint: rec!.domain_hint, event_type_hint: rec!.event_type_hint, event_date: rec!.event_date,
      snippet: rec!.snippet, source_retrieved: rec!.source_retrieved, stage: rec!.stage_reached, disposition: rec!.disposition,
    },
    {
      name: "Acme", title: "Acme raises $5M", source_url: "https://news.example.com/acme?utm_source=x", source_name: "Example News", provider: "claude-web",
      lane: "funding", homepage_hint: "https://www.Acme.ai/pricing", domain_hint: "acme.ai", event_type_hint: "funding", event_date: "2026-09-10",
      snippet: "A seed round.", source_retrieved: true, stage: "discovered", disposition: null,
    },
  );
  assert.equal(rec!.discovered_at, "2026-09-21T12:00:00.000Z");
});

test("leads without a hint or headline are still recorded, with nulls (not invented values)", () => {
  const ledger = new LeadLedger({ runId: "r" });
  const [rec] = ledger.recordDiscovered([lead({ homepage_hint: null, headline: null, snippet: null, source_name: null, event_date: null })]);
  assert.deepEqual([rec!.domain_hint, rec!.title, rec!.snippet, rec!.source_name, rec!.event_date], [null, null, null, null, null]);
});

test("recording is idempotent per lead", () => {
  const ledger = new LeadLedger({ runId: "r" });
  ledger.recordDiscovered([lead(), lead({ name: "Beta" })]);
  ledger.recordDiscovered([lead()]);
  assert.equal(ledger.all().length, 2);
});

test("stage, timestamps and disposition move as the lead does; drop reasons and duplicate links are kept", () => {
  const ledger = new LeadLedger({ runId: "r", now: tick() });
  const [a, b] = ledger.recordDiscovered([lead(), lead({ name: "Beta", source_url: "https://news.example.com/beta" })]);
  ledger.stage(a!.lead_id, "selected");
  ledger.stage(a!.lead_id, "verification_started");
  ledger.stage(a!.lead_id, "verified");
  ledger.stage(a!.lead_id, "validated", { candidate_domain: "acme.ai", confidence: 0.9, event_type: "funding" });
  ledger.decide(a!.lead_id, "would_insert_company_and_event", null, { candidate_domain: "acme.ai" });
  ledger.decide(b!.lead_id, "dropped_duplicate_lead", "same company as another lead in this run", { duplicate_of: a!.lead_id });

  const ra = ledger.get(a!.lead_id)!;
  assert.deepEqual([ra.stage_reached, ra.disposition, ra.candidate_domain, ra.confidence], ["decided", "would_insert_company_and_event", "acme.ai", 0.9]);
  const stamps = [ra.discovered_at, ra.selected_at, ra.verification_started_at, ra.decided_at];
  assert.ok(stamps.every(Boolean));
  assert.deepEqual([...stamps].sort(), stamps, "timestamps are in pipeline order");
  const rb = ledger.get(b!.lead_id)!;
  assert.deepEqual([rb.disposition, rb.drop_reason, rb.duplicate_of, rb.selected_at], ["dropped_duplicate_lead", "same company as another lead in this run", a!.lead_id, null]);
});

test("finalizeOpen gives every undecided lead a 'not_processed' disposition with the reason the run ended", () => {
  const ledger = new LeadLedger({ runId: "r" });
  const [a, b, c] = ledger.recordDiscovered([lead(), lead({ name: "B" }), lead({ name: "C" })]);
  ledger.decide(a!.lead_id, "rejected", "stale_event");
  assert.equal(ledger.finalizeOpen("run_ended:shutdown:SIGTERM"), 2);
  assert.deepEqual([b, c].map((r) => [ledger.get(r!.lead_id)!.disposition, ledger.get(r!.lead_id)!.drop_reason]), [["not_processed", "run_ended:shutdown:SIGTERM"], ["not_processed", "run_ended:shutdown:SIGTERM"]]);
  assert.ok(ledger.all().every((r) => r.disposition !== null && r.decided_at !== null));
  assert.equal(ledger.finalizeOpen("again"), 0);
  const s = ledger.summary();
  assert.deepEqual(s.by_disposition, { rejected: 1, not_processed: 2 });
  assert.equal(s.total, 3);
});

test("leads reach disk the moment they are recorded (a killed run keeps them); close() writes the consolidated file", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-leads-"));
  const ledger = new LeadLedger({ dir, runId: "run1", now: tick() });
  const [a] = ledger.recordDiscovered([lead(), lead({ name: "Beta", source_url: "https://news.example.com/beta" })]);
  // No close(), no flush: simulate the process dying right here.
  const mid = readFileSync(join(dir, "run1.leads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(mid.map((l) => [l.type, l.name]), [["discovered", "Acme"], ["discovered", "Beta"]]);
  ledger.decide(a!.lead_id, "rejected", "stale_event");
  ledger.close();
  ledger.close();
  const lines = readFileSync(join(dir, "run1.leads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ["discovered", "discovered", "change"]);
  const full = JSON.parse(readFileSync(join(dir, "run1.leads.json"), "utf8"));
  assert.equal(full.total, 2);
  assert.equal(full.leads.find((l: { name: string }) => l.name === "Acme").disposition, "rejected");
  assert.equal(ledger.summary().files.json, join(dir, "run1.leads.json"));
});

test("ledger files are redacted", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-leads-"));
  const key = "sk-ant-api03-SECRETSECRETSECRET1234567890";
  const ledger = new LeadLedger({ dir, runId: "run1", redact: createRedactor([key]) });
  ledger.recordDiscovered([lead({ snippet: `page said: ${key}` })]);
  ledger.close();
  for (const f of ["run1.leads.jsonl", "run1.leads.json"]) assert.ok(!readFileSync(join(dir, f), "utf8").includes(key), f);
});
