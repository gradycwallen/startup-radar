import assert from "node:assert/strict";
import { test } from "node:test";
import { SignalStore } from "../src/signals/store.ts";

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

const source = {
  company_id: 42, source_type: "github_org" as const, external_id: "acme", canonical_url: "https://github.com/acme",
  resolution_method: "homepage_link_confirmed" as const, resolution_confidence: 0.95, resolution_evidence: "test evidence", active: true, metadata: null,
};

test("SignalStore.upsertSignalSource: upserts on (company_id, source_type, external_id) — a source is never rediscovered as a fresh row", async () => {
  const captured: Captured[] = [];
  // .single() sends Accept: vnd.pgrst.object+json and PostgREST replies with a bare object, not an array.
  const store = new SignalStore("https://x.supabase.co", "k", { fetch: fakeSupabaseFetch(captured, { ...source, id: 7 }) });
  const result = await store.upsertSignalSource(source);
  assert.equal(result.id, 7);
  const call = captured.find((c) => c.url.includes("signal_sources"))!;
  assert.match(call.url, /on_conflict=company_id%2Csource_type%2Cexternal_id|on_conflict=company_id,source_type,external_id/, `expected an on_conflict natural-key upsert, got: ${call.url}`);
});

test("SignalStore.insertObservations: plain insert, empty array is a no-op that makes no request at all", async () => {
  const captured: Captured[] = [];
  const store = new SignalStore("https://x.supabase.co", "k", { fetch: fakeSupabaseFetch(captured, [{ id: 1 }, { id: 2 }]) });
  assert.deepEqual(await store.insertObservations([]), []);
  assert.equal(captured.length, 0, "an empty batch must not touch the network at all");

  const obs = { company_id: 42, signal_source_id: 7, metric_name: "github_stars", numeric_value: 10, text_value: null, observed_at: "2026-09-22T00:00:00Z", source_timestamp: null, collection_version: "github-v1", raw_payload_ref: null };
  const result = await store.insertObservations([obs, obs]);
  assert.equal(result.length, 2);
  assert.ok(captured[0]!.url.includes("observations"));
  assert.equal(captured[0]!.method, "POST");
});

test("SignalStore: a literal `id: null` on the object (exactly what observe.ts produces before persistence) is NEVER sent to the identity column — regression for a real bug found during live verification", async () => {
  const captured: Captured[] = [];
  const store = new SignalStore("https://x.supabase.co", "k", { fetch: fakeSupabaseFetch(captured, [{}]) });
  // Structurally assignable to Omit<Observation, "id"> (extra properties on a variable, not a
  // literal, pass TS's structural check) — which is exactly the point: the type system alone does
  // NOT stop this shape from reaching the store, so the store itself must strip `id` at runtime.
  const obsWithLiteralNullId = { id: null, company_id: 42, signal_source_id: 7, metric_name: "github_stars", numeric_value: 10, text_value: null, observed_at: "2026-09-22T00:00:00Z", source_timestamp: null, collection_version: "github-v1", raw_payload_ref: null };
  await store.insertObservations([obsWithLiteralNullId]);
  const body = captured[0]!.body as Array<Record<string, unknown>>;
  assert.ok(!("id" in body[0]!), `id must never be sent — an explicit null fails the identity column's NOT NULL constraint (got keys: ${Object.keys(body[0]!).join(", ")})`);
});

test("SignalStore.insertSignals: plain insert, carries every explainability field through untouched", async () => {
  const captured: Captured[] = [];
  const signal = {
    company_id: 42, family: "github" as const, signal_type: "star_velocity_increase", window_days: 30, from_observation_id: 1, to_observation_id: 2,
    from_value: 100, to_value: 1000, delta: 900, relative_change: 9, rule_version: "github-v1", explanation: "GitHub stars rose from 100 to 1000 in 30 days (+900%).",
    fired_at: "2026-09-22T00:00:00Z", metadata: null,
  };
  const store = new SignalStore("https://x.supabase.co", "k", { fetch: fakeSupabaseFetch(captured, [{ ...signal, id: 55 }]) });
  const [result] = await store.insertSignals([signal]);
  assert.equal(result!.id, 55);
  const body = captured[0]!.body as unknown[];
  assert.deepEqual((body[0] as Record<string, unknown>).explanation, signal.explanation);
});

test("SignalStore: a database error surfaces as a real rejection, never silently swallowed", async () => {
  const captured: Captured[] = [];
  const store = new SignalStore("https://x.supabase.co", "k", { fetch: fakeSupabaseFetch(captured, { message: "constraint violation" }, 400) });
  await assert.rejects(() => store.upsertSignalSource(source), /constraint violation/);
});

test("SignalStore: a write that exceeds its deadline is aborted, not left hanging", async () => {
  const neverResolves = (async () => new Promise<Response>(() => {})) as typeof fetch;
  const store = new SignalStore("https://x.supabase.co", "k", { fetch: neverResolves, writeTimeoutMs: 20 });
  await assert.rejects(() => store.upsertSignalSource(source), /exceeded 20ms/);
});
