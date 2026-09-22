import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSupabaseUrl, readEnv } from "../src/config.ts";
import { ReadOnlyDb } from "../src/db.ts";

test("normalizeSupabaseUrl strips trailing slashes and API paths, rejects garbage", () => {
  const want = "https://abc.supabase.co";
  for (const v of ["https://abc.supabase.co", "https://abc.supabase.co/", " https://abc.supabase.co// ", "https://abc.supabase.co/rest/v1/", "HTTPS://ABC.supabase.co/"]) {
    assert.equal(normalizeSupabaseUrl(v), want, v);
  }
  for (const bad of ["", "   ", "abc.supabase.co", "ftp://abc.supabase.co", "not a url", undefined]) {
    assert.equal(normalizeSupabaseUrl(bad), "", String(bad));
  }
});

test("readEnv reports missing names only (never values) and normalizes the URL", () => {
  const ok = readEnv({ ANTHROPIC_API_KEY: "k1", SUPABASE_URL: "https://abc.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "k2" });
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.supabase.url, "https://abc.supabase.co");
  const none = readEnv({});
  assert.deepEqual(none.missing, ["ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  const badUrl = readEnv({ ANTHROPIC_API_KEY: "k1", SUPABASE_URL: "nonsense", SUPABASE_SERVICE_ROLE_KEY: "k2" });
  assert.deepEqual(badUrl.missing, ["SUPABASE_URL (not a valid http(s) URL)"]);
});

const fakeFetch = (status: number, headers: Record<string, string> = {}): typeof fetch =>
  (async () => new Response(null, { status, headers })) as typeof fetch;

test("counts() throws when no count comes back, instead of reporting 0", async () => {
  const db = new ReadOnlyDb("https://abc.supabase.co", "k", { fetch: fakeFetch(204) });
  await assert.rejects(() => db.counts(), /no row count returned|failed after/);
});

test("counts() throws on an HTTP error, instead of reporting 0", async () => {
  const db = new ReadOnlyDb("https://abc.supabase.co", "k", { fetch: fakeFetch(404) });
  await assert.rejects(() => db.counts(), /failed after/);
});

test("counts() returns the real number when the server reports it", async () => {
  const db = new ReadOnlyDb("https://abc.supabase.co", "k", { fetch: fakeFetch(200, { "content-range": "*/10" }) });
  assert.deepEqual(await db.counts(), { companies: 10, discovery_events: 10 });
});
