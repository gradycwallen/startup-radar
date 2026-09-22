import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { emptyUsage, runWithWebTools } from "../src/claude.ts";
import { LIMITS, TOOL_CAPS } from "../src/config.ts";
import { RunClock } from "../src/deadline.ts";
import { memoryLogger } from "../src/log.ts";
import { runPipeline } from "../src/pipeline.ts";
import { ReplayProvider, SnapshotReader, SnapshotRecorder, SnapshotVerifier, snapshotHomepageChecker } from "../src/replay.ts";
import { HttpSnapshotStore, SNAPSHOT_VERSION, SnapshotMissError, createRecordingFetch, createReplayFetch, loadSnapshot, requestKey, writeSnapshot, type Snapshot } from "../src/snapshot.ts";
import type { RawLead } from "../src/schema.ts";
import { aLead, fakeAnthropic, leadsResponse } from "./fake-anthropic.ts";
import { DEFAULT_ASSUMPTIONS } from "../src/budget.ts";
import { FakeReader, NOW, okHomepage, testBudget, testLedger, verification } from "./helpers.ts";
import { leadId } from "../src/ledger.ts";
import { defaultLimitsForTests, laneOk, leadFor, stubConfig } from "./replay-helpers.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "scout-snap-"));
const rss = `<?xml version="1.0"?><rss><channel><item><title>Acme raises $5M seed</title><link>https://news.example.com/acme</link></item></channel></rss>`;
const realFetch = (calls: string[] = []): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : (input as URL).href ?? (input as Request).url);
    return new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml; charset=utf-8", "set-cookie": "session=SECRETCOOKIE", "x-secret": "nope" } });
  }) as typeof fetch;

// ---- HTTP layer ------------------------------------------------------------------------------------

test("request identity: method + normalized URL + canonical body; headers, key order and tracking params do not matter", () => {
  const a = requestKey("POST", "https://api.example.com/v1/messages?b=2&a=1", JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }));
  assert.equal(a, requestKey("post", "https://API.example.com/v1/messages?a=1&b=2&utm_source=z", JSON.stringify({ messages: [{ content: "x", role: "user" }], model: "m" })));
  assert.notEqual(a, requestKey("POST", "https://api.example.com/v1/messages?a=1&b=2", JSON.stringify({ model: "other", messages: [] })));
  assert.notEqual(requestKey("GET", "https://x.com/a"), requestKey("POST", "https://x.com/a"));
  assert.notEqual(requestKey("GET", "https://x.com/a"), requestKey("GET", "https://x.com/b"));
});

test("RECORD then REPLAY: identical status, content type and body, and the live fetch is not used for replay", async () => {
  const dir = tmp();
  const store = new HttpSnapshotStore(dir);
  const live: string[] = [];
  const recording = createRecordingFetch(realFetch(live), store, { now: () => NOW });
  const res = await recording("https://news.example.com/feed.xml", { headers: { accept: "application/rss+xml" } });
  assert.equal(await res.text(), rss, "the caller still receives the live body");
  await store.settled();
  assert.equal(live.length, 1);

  const replay = createReplayFetch(store);
  const again = await replay("https://news.example.com/feed.xml?utm_source=x");
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("content-type"), "application/rss+xml; charset=utf-8");
  assert.equal(await again.text(), rss);
  assert.equal(live.length, 1, "replay never called the live fetch");
});

test("SECRETS: request headers (credentials) are never stored, and cookies/unknown response headers are dropped", async () => {
  const dir = tmp();
  const store = new HttpSnapshotStore(dir);
  const secret = "sk-ant-api03-SECRETSECRETSECRET1234567890";
  const recording = createRecordingFetch(realFetch(), store);
  await (await recording("https://api.example.com/v1/x", { method: "POST", headers: { "x-api-key": secret, authorization: `Bearer ${secret}` }, body: JSON.stringify({ q: 1 }) })).text();
  await store.settled();
  const files = readdirSync(join(dir, "http"));
  assert.equal(files.length, 1);
  const raw = readFileSync(join(dir, "http", files[0]!), "utf8");
  for (const leak of [secret, "SECRETCOOKIE", "set-cookie", "x-secret", "authorization", "x-api-key"]) assert.ok(!raw.includes(leak), `leaked: ${leak}`);
  assert.ok(raw.includes("content-type"));
});

test("REPLAY IS OFFLINE: a request with no recording throws SnapshotMissError, and the global fetch is never consulted", async () => {
  const store = new HttpSnapshotStore(tmp());
  const original = globalThis.fetch;
  let globalFetchUsed = 0;
  globalThis.fetch = (() => { globalFetchUsed++; throw new Error("network!"); }) as typeof fetch;
  try {
    await assert.rejects(createReplayFetch(store)("https://never-recorded.example.com/x"), (e: unknown) => e instanceof SnapshotMissError && /never-recorded/.test((e as Error).message));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(globalFetchUsed, 0);
});

test("binary bodies round-trip exactly; oversized bodies are not recorded (replay reports a miss, never a partial body)", async () => {
  const store = new HttpSnapshotStore(tmp());
  const bytes = new Uint8Array([0, 255, 1, 254, 2, 253]);
  const img = (async () => new Response(bytes, { status: 200, headers: { "content-type": "image/png" } })) as typeof fetch;
  await (await createRecordingFetch(img, store)("https://x.com/a.png")).arrayBuffer();
  const big = (async () => new Response("x".repeat(5000), { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
  await (await createRecordingFetch(big, store, { maxBodyBytes: 100 })("https://x.com/big")).text();
  await store.settled();
  assert.deepEqual([...new Uint8Array(await (await createReplayFetch(store)("https://x.com/a.png")).arrayBuffer())], [...bytes]);
  await assert.rejects(createReplayFetch(store)("https://x.com/big"), SnapshotMissError);
});

test("replay honors abort signals, so deadline behavior can be tested offline", async () => {
  const store = new HttpSnapshotStore(tmp());
  await (await createRecordingFetch(realFetch(), store)("https://x.com/slow")).text();
  await store.settled();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const res = await createReplayFetch(store, { chunkDelayMs: 500 })("https://x.com/slow", { signal: ac.signal });
  await assert.rejects(res.text(), /abort/i);
});

test("ANTHROPIC responses record and replay too: the same request yields the same result with ZERO live calls", async () => {
  const dir = tmp();
  const store = new HttpSnapshotStore(dir);
  const live = fakeAnthropic([leadsResponse([aLead()])]);
  const recordingClient = new Anthropic({ apiKey: "sk-ant-test-key-DO-NOT-LOG-0123456789", fetch: createRecordingFetch(live.fetch, store) });
  const opts = (client: Anthropic) => runWithWebTools(client, {
    model: "claude-sonnet-5", system: "s", user: "u", label: "funding", stage: "discover", budget: testBudget(), caps: TOOL_CAPS.discovery,
    requestTimeoutMs: 5000, headerTimeoutMs: 5000, fetchMaxContentTokens: LIMITS.webFetchMaxContentTokens, signal: new AbortController().signal, usage: emptyUsage(), log: memoryLogger(),
  });
  const recorded = await opts(recordingClient);
  await store.settled();
  assert.equal(live.calls.length, 1);

  // Replay: a client whose ONLY transport is the store; the global fetch is booby-trapped as well.
  const original = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network!"); }) as typeof fetch;
  try {
    const replayClient = new Anthropic({ apiKey: "not-a-real-key", fetch: createReplayFetch(store), maxRetries: 0 });
    const replayed = await opts(replayClient);
    assert.equal(replayed.text, recorded.text);
    assert.deepEqual([...replayed.seenUrls], [...recorded.seenUrls]);
    assert.deepEqual(replayed.usage, recorded.usage);
    assert.equal(replayed.requests[0]!.request_id, "req_test123");
    assert.equal(live.calls.length, 1, "the live transport was not used again");
    // a DIFFERENT request has no recording and fails loudly instead of going live
    await assert.rejects(
      runWithWebTools(replayClient, { model: "claude-sonnet-5", system: "s", user: "a different prompt", label: "funding", stage: "discover", budget: testBudget(), caps: TOOL_CAPS.discovery, requestTimeoutMs: 5000, headerTimeoutMs: 5000, fetchMaxContentTokens: 20000, signal: new AbortController().signal, usage: emptyUsage(), log: memoryLogger() }),
      (e: unknown) => (e as { cause?: unknown }).cause instanceof SnapshotMissError,
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ---- Domain layer ----------------------------------------------------------------------------------

const snapshot = (): Snapshot => {
  const leads: RawLead[] = [leadFor(1, "funding"), leadFor(2, "launches"), leadFor(3, "funding")];
  return {
    manifest: { version: SNAPSHOT_VERSION, created_at: "2026-09-21T23:05:00.000Z", description: "test", source_run_id: "r1", now: NOW.toISOString() },
    discovery: { provider: "fake", lanes: [laneOk("funding", 2), laneOk("launches", 1)], leads },
    verifications: {
      [leadId(leads[0]!)]: { verification: verification({ name: "Co1", canonical_url: "https://co1.ai", source_url: leads[0]!.source_url }), retrieved_urls: [leads[0]!.source_url] },
    },
    homepages: { "co1.ai": { reachable: true, status: 200, finalDomain: "co1.ai", text: "Co1 builds things" } },
    db: { companies: [{ id: 1, name: "Existing Co", domain: "existing.com" }], events: [{ id: 1, company_id: 1, event_type: "funding", event_date: null, source_url: "https://n.example.com/e", headline: null, description: null }] },
  };
};

test("write/load round trip preserves everything", () => {
  const dir = join(tmp(), "snap");
  const s = snapshot();
  writeSnapshot(dir, s);
  assert.deepEqual(loadSnapshot(dir), s);
});

test("loadSnapshot fails clearly for a missing directory/file, bad JSON, wrong version and wrong shape", () => {
  assert.throws(() => loadSnapshot("/definitely/not/here"), /snapshot directory not found/);
  const dir = join(tmp(), "snap");
  writeSnapshot(dir, snapshot());
  const good = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));

  writeFileSync(join(dir, "db.json"), "{ not json");
  assert.throws(() => loadSnapshot(dir), /db\.json is not valid JSON/);
  writeFileSync(join(dir, "db.json"), JSON.stringify(snapshot().db));

  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...good("manifest.json"), version: 99 }));
  assert.throws(() => loadSnapshot(dir), /unsupported snapshot version 99/);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(snapshot().manifest));

  writeFileSync(join(dir, "discovery.json"), JSON.stringify({ provider: "x", lanes: [], leads: [{ lane: "funding" }] }));
  assert.throws(() => loadSnapshot(dir), /invalid snapshot/);
  writeFileSync(join(dir, "discovery.json"), JSON.stringify(snapshot().discovery));

  mkdirSync(join(dir, "sub"));
  writeSnapshot(join(dir, "sub"), snapshot());
  writeFileSync(join(dir, "sub", "homepages.json"), "[]");
  assert.throws(() => loadSnapshot(join(dir, "sub")), /invalid snapshot/);
  assert.equal(loadSnapshot(dir).discovery.leads.length, 3, "a repaired snapshot loads again");
});

test("ReplayProvider serves recorded leads per lane, streams them to onLeads, reports zero cost/time, and honors --lanes and shutdown", async () => {
  const s = snapshot();
  const batches: RawLead[][] = [];
  const base = { today: NOW, recencyDays: 14, leadsPerLane: 6, laneMs: 1, clock: new RunClock(1e9), log: memoryLogger() };
  const res = await new ReplayProvider(s.discovery).discover({ ...base, signal: new AbortController().signal, onLeads: (l) => batches.push(l) });
  assert.deepEqual(res.leads.map((l) => l.name), ["Co1", "Co3", "Co2"]);
  assert.deepEqual(batches.map((b) => b.length), [2, 1]);
  assert.deepEqual(res.lanes.map((l) => [l.lane, l.status, l.elapsed_ms, l.usage.apiCalls, l.usage.inputTokens]), [["funding", "ok", 0, 0, 0], ["launches", "ok", 0, 0, 0]]);
  assert.deepEqual((await new ReplayProvider(s.discovery).discover({ ...base, signal: new AbortController().signal, lanes: ["launches"] })).leads.map((l) => l.name), ["Co2"]);
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual((await new ReplayProvider(s.discovery).discover({ ...base, signal: ac.signal })).lanes.map((l) => l.status), ["skipped_shutdown", "skipped_shutdown"]);
});

test("SnapshotVerifier serves recordings and FAILS LOUDLY on a lead with none; SnapshotReader and the homepage checker are read-only views", async () => {
  const s = snapshot();
  const v = new SnapshotVerifier(s.verifications);
  const ctx = { signal: new AbortController().signal, usage: emptyUsage(), log: memoryLogger() };
  const out = await v.verify(s.discovery.leads[0]!, ctx);
  assert.equal(out.verification.name, "Co1");
  assert.ok(out.retrievedUrls.has(s.discovery.leads[0]!.source_url));
  await assert.rejects(v.verify(s.discovery.leads[1]!, ctx), (e: unknown) => e instanceof SnapshotMissError && /Co2/.test((e as Error).message));

  const db = new SnapshotReader(s.db);
  assert.deepEqual(await db.findCompanyByDomain("existing.com"), { id: 1, name: "Existing Co", domain: "existing.com" });
  assert.equal(await db.findCompanyByDomain("nope.com"), null);
  assert.equal((await db.findCompaniesByName("EXISTING co")).length, 1);
  assert.equal((await db.getEvents(1)).length, 1);
  assert.deepEqual(await db.counts(), { companies: 1, discovery_events: 1 });
  for (const write of ["insert", "update", "upsert", "delete", "rpc"]) assert.equal((db as unknown as Record<string, unknown>)[write], undefined, `no ${write} method`);

  const hp = snapshotHomepageChecker(s.homepages);
  assert.equal((await hp("co1.ai")).reachable, true);
  assert.deepEqual(await hp("unknown.com"), { reachable: false, error: "not_in_snapshot" });
});

test("RECORDER round trip: record a run made of fakes, write the snapshot, replay it, and get the SAME outcomes at zero cost", async () => {
  const leads = [leadFor(1, "funding"), leadFor(2, "launches"), leadFor(3, "news")];
  const recorder = new SnapshotRecorder();
  const provider = recorder.wrapProvider({ name: "fake", lanes: ["funding", "launches", "news"], discover: async (ctx) => { ctx.onLeads?.(leads); return { leads, errors: [], lanes: [laneOk("funding", 1), laneOk("launches", 1), laneOk("news", 1)], usage: emptyUsage() }; } });
  const verifier = recorder.wrapVerifier({
    async verify(l) {
      const n = l.name.replace("Co", "");
      return { verification: verification({ name: l.name, canonical_url: `https://co${n}.ai`, source_url: l.source_url, confidence: l.name === "Co2" ? 0.5 : 0.9 }), retrievedUrls: new Set([l.source_url]) };
    },
  });
  const homepage = recorder.wrapHomepageChecker(okHomepage("Co1 Co2 Co3"));
  const cfg = stubConfig();
  const live = await runPipeline({ provider, verifier, db: new FakeReader(), checkHomepage: homepage, log: memoryLogger(), config: cfg, now: NOW, signal: new AbortController().signal, clock: new RunClock(1e9), budget: testBudget(), ledger: testLedger() });

  const dir = join(tmp(), "recorded");
  recorder.finish(dir, { now: NOW, runId: "live-1", description: "test", db: { companies: [], events: [] } });
  const snap = loadSnapshot(dir);
  assert.equal(snap.discovery.leads.length, 3);
  assert.equal(Object.keys(snap.verifications).length, 3);
  assert.deepEqual(Object.keys(snap.homepages).sort(), ["co1.ai", "co2.ai", "co3.ai"]);

  const replayed = await runPipeline({
    provider: new ReplayProvider(snap.discovery), verifier: new SnapshotVerifier(snap.verifications), db: new SnapshotReader(snap.db),
    checkHomepage: snapshotHomepageChecker(snap.homepages), log: memoryLogger(), config: cfg, now: new Date(snap.manifest.now),
    signal: new AbortController().signal, clock: new RunClock(1e9), budget: testBudget(), ledger: testLedger(), mode: "replay",
  });
  const brief = (s: typeof live) => s.candidates.map((c) => [c.lead_name, c.status, c.domain, c.confidence, c.reasons.join("|")]);
  assert.deepEqual(brief(replayed), brief(live));
  assert.equal(replayed.mode, "replay");
  assert.equal(replayed.cost.committed_usd, 0);
  assert.equal(replayed.usage.apiCalls, 0);
});

test("the recorder never changes what it wraps (provider result and verifier output pass through untouched)", async () => {
  const recorder = new SnapshotRecorder();
  const inner = { verify: async () => ({ verification: verification(), retrievedUrls: new Set(["https://a.example.com/x"]) }) };
  const out = await recorder.wrapVerifier(inner).verify(leadFor(1, "funding"), { signal: new AbortController().signal, usage: emptyUsage(), log: memoryLogger() });
  assert.equal(out.verification.name, "Acme");
  assert.deepEqual([...out.retrievedUrls], ["https://a.example.com/x"]);
  assert.ok(DEFAULT_ASSUMPTIONS.safetyMargin && defaultLimitsForTests().dbReadMs === 15_000);
});
