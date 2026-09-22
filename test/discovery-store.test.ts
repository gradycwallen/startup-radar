import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscoveryStore } from "../src/discovery/store.ts";
import type { CompanyInsert, EventInsert } from "../src/discovery/accept.ts";

interface Captured {
  method: string;
  url: string;
  body: unknown;
}

function fakeSupabaseFetch(captured: Captured[], responseBody: unknown, status = 201): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let body: unknown = null;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    }
    captured.push({ method: init?.method ?? "GET", url, body });
    return new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const company: CompanyInsert = {
  name: "Acme", domain: "acme.com", description: null, category: null, discovery_source: "tech-eu",
  discovery_url: "https://tech.eu/acme", confidence: 0.8, discovery_reason: "Acme raised funding, per Tech.eu.", founded_year: null,
};

test("DiscoveryStore.insertCompany: a plain insert on success, returns the persisted row", async () => {
  const captured: Captured[] = [];
  const store = new DiscoveryStore("https://x.supabase.co", "k", { fetch: fakeSupabaseFetch(captured, { id: 11, name: "Acme", domain: "acme.com" }) });
  const result = await store.insertCompany(company);
  assert.deepEqual(result, { inserted: { id: 11, name: "Acme", domain: "acme.com" } });
  assert.equal(captured[0]!.method, "POST");
  assert.match(captured[0]!.url, /companies/);
});

test("DiscoveryStore.insertCompany: a unique-constraint violation on domain is reported as { conflict: true }, never thrown — 'already exists' is a benign, expected outcome", async () => {
  const captured: Captured[] = [];
  const store = new DiscoveryStore("https://x.supabase.co", "k", {
    fetch: fakeSupabaseFetch(captured, { code: "23505", message: 'duplicate key value violates unique constraint "companies_domain_key"' }, 409),
  });
  const result = await store.insertCompany(company);
  assert.deepEqual(result, { conflict: true });
});

test("DiscoveryStore.insertCompany: any OTHER database error still throws — only the specific unique-violation code is treated as benign", async () => {
  const captured: Captured[] = [];
  const store = new DiscoveryStore("https://x.supabase.co", "k", { fetch: fakeSupabaseFetch(captured, { code: "42501", message: "permission denied" }, 403) });
  await assert.rejects(() => store.insertCompany(company), /permission denied/);
});

test("DiscoveryStore.upsertEvents: ignore-duplicates upsert on (company_id, source_url) — the DB constraint IS the idempotency mechanism; empty array makes no request", async () => {
  const captured: Captured[] = [];
  const store = new DiscoveryStore("https://x.supabase.co", "k", { fetch: fakeSupabaseFetch(captured, [{ id: 1 }]) });
  assert.deepEqual(await store.upsertEvents(11, []), { inserted: 0, skipped_duplicate: 0 });
  assert.equal(captured.length, 0);

  const events: EventInsert[] = [
    { event_type: "funding", event_date: "2026-09-20", source_name: "Tech.eu", source_url: "https://tech.eu/acme", headline: "Acme raises $5M", description: "seed, $5.0M", confidence: 0.8 },
  ];
  const result = await store.upsertEvents(11, events);
  assert.deepEqual(result, { inserted: 1, skipped_duplicate: 0 });
  assert.match(captured[0]!.url, /discovery_events/);
  assert.match(captured[0]!.url, /on_conflict=company_id%2Csource_url|on_conflict=company_id,source_url/);
});

test("DiscoveryStore.upsertEvents: PostgREST's ignore-duplicates + return=representation returns ONLY the rows actually inserted — inserted/skipped_duplicate accounting matches that", async () => {
  const captured: Captured[] = [];
  // Simulate: 3 events requested, only 1 was genuinely new (the other 2 conflicted and were silently dropped from the response).
  const store = new DiscoveryStore("https://x.supabase.co", "k", { fetch: fakeSupabaseFetch(captured, [{ id: 99 }]) });
  const events: EventInsert[] = [1, 2, 3].map((i) => ({ event_type: "news", event_date: null, source_name: "X", source_url: `https://x.com/${i}`, headline: null, description: null, confidence: 0.5 }));
  const result = await store.upsertEvents(11, events);
  assert.deepEqual(result, { inserted: 1, skipped_duplicate: 2 });
});

test("DiscoveryStore.companyExistsByDomain: retries transient failures (matches src/signals/store.ts's read pattern) and returns a plain boolean", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls < 2) throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    return new Response(JSON.stringify({ id: 5 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const store = new DiscoveryStore("https://x.supabase.co", "k", { fetch: fetchImpl });
  assert.equal(await store.companyExistsByDomain("acme.com"), true);
  assert.equal(calls, 2);
});

test("DiscoveryStore.companyExistsByDomain: no row -> false", async () => {
  const store = new DiscoveryStore("https://x.supabase.co", "k", { fetch: fakeSupabaseFetch([], null, 200) });
  assert.equal(await store.companyExistsByDomain("nobody.example"), false);
});

test("DiscoveryStore: a write that exceeds its deadline is aborted, not left hanging", async () => {
  const neverResolves = (async () => new Promise<Response>(() => {})) as typeof fetch;
  const store = new DiscoveryStore("https://x.supabase.co", "k", { fetch: neverResolves, writeTimeoutMs: 20 });
  await assert.rejects(() => store.insertCompany(company), /exceeded 20ms/);
});

test("DiscoveryStore: a write is attempted exactly once — never blindly retried (no idempotency key for insertCompany/upsertEvents beyond the DB's own constraints)", async () => {
  const captured: Captured[] = [];
  const store = new DiscoveryStore("https://x.supabase.co", "k", { fetch: fakeSupabaseFetch(captured, { code: "XXYYY", message: "server error" }, 500) });
  await assert.rejects(() => store.insertCompany(company));
  assert.equal(captured.length, 1);
});
