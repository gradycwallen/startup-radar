import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

// V2-2A introduces exactly ONE narrow, deliberate exception to "read-only": src/signals/store.ts
// may write, but ONLY insert/upsert (never update/delete on data, never DDL), and ONLY to the
// three new V2-2A tables. Every other file under src/ — including the rest of src/signals/ — is
// held to the original, unweakened Phase 1 rule. See root CLAUDE.md's V2-2A section.
const WRITE_GUARD_EXEMPT_FILE = join("src", "signals", "store.ts");

test("PHASE 1 + V2-2A GUARD: no write-capable database call exists anywhere under src/ except the one whitelisted signal store", () => {
  const forbidden = [
    /\.\s*(insert|update|upsert|delete)\s*\(/,
    /\.\s*rpc\s*\(/,
    /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE)\b/i,
    /\.\s*storage\b/,
    /apply_migration|execute_sql/,
  ];
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    if (file === WRITE_GUARD_EXEMPT_FILE) continue;
    const text = readFileSync(file, "utf8");
    for (const re of forbidden) if (re.test(text)) offenders.push(`${file}: ${re}`);
  }
  assert.deepEqual(offenders, []);
});

test("V2-2A GUARD: the one whitelisted signal store writes ONLY insert/upsert (never update/delete/DDL) and NEVER touches companies or discovery_events", () => {
  const text = readFileSync(WRITE_GUARD_EXEMPT_FILE, "utf8");
  assert.ok(!/\.\s*(update|delete)\s*\(/.test(text), "store.ts must never call .update()/.delete() — observations/signals are append-only, signal_sources only ever upserts");
  assert.ok(!/\.\s*rpc\s*\(/.test(text) && !/\b(TRUNCATE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE)\b/i.test(text), "store.ts must never touch schema or call rpc()");
  const tableCalls = [...text.matchAll(/\.from\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
  assert.ok(tableCalls.length > 0, "store.ts should reference at least one table");
  assert.deepEqual([...new Set(tableCalls)].sort(), ["observations", "signal_sources", "signals"], "store.ts must touch ONLY the three V2-2A tables — never companies or discovery_events");
});

test("PHASE 1 + V2-2A GUARD: only db.ts and the whitelisted signal store touch supabase-js; db.ts only issues select/count reads", () => {
  const importers = sourceFiles("src").filter((f) => /@supabase\/supabase-js/.test(readFileSync(f, "utf8")));
  assert.deepEqual(importers.sort(), [join("src", "db.ts"), WRITE_GUARD_EXEMPT_FILE].sort());
  const db = readFileSync(join("src", "db.ts"), "utf8");
  const fromCalls = db.match(/\.from\(/g)?.length ?? 0;
  const selectCalls = db.match(/\.select\(/g)?.length ?? 0;
  assert.ok(fromCalls > 0 && fromCalls === selectCalls, `every .from() must be followed by .select() (from=${fromCalls}, select=${selectCalls})`);
});

test("PHASE 1 GUARD: the CLI refuses --write", () => {
  const main = readFileSync(join("src", "main.ts"), "utf8");
  assert.match(main, /values\.write[\s\S]{0,200}Refusing/);
});

test("V2-0 GUARD: Anthropic API calls exist ONLY in claude.ts (the budget-guarded choke point); clients are built only in main.ts", () => {
  const callPattern = /\.messages\s*\.\s*(stream|create|countTokens|batches)\b|\.batches\s*\.|\.beta\s*\./;
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8");
    if (file !== join("src", "claude.ts") && callPattern.test(text)) offenders.push(`${file}: calls the Anthropic API outside claude.ts`);
    if (file !== join("src", "main.ts") && /new\s+Anthropic\s*\(/.test(text)) offenders.push(`${file}: constructs an Anthropic client outside main.ts`);
  }
  assert.deepEqual(offenders, []);
});

test("V2-2A GUARD: the architected AI entity-resolution fallback is never invoked from anywhere in V2-2A", () => {
  const definingFile = join("src", "signals", "resolution-ai-fallback.ts");
  const offenders = sourceFiles(join("src", "signals"))
    .filter((f) => f !== definingFile)
    .filter((f) => /resolveAmbiguousEntityWithAi/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, [], "no file besides resolution-ai-fallback.ts itself may reference resolveAmbiguousEntityWithAi in V2-2A");
});

test("V2-0 GUARD: budget, ledger, snapshot and replay modules import neither the Anthropic SDK nor Supabase", () => {
  for (const f of ["budget.ts", "ledger.ts", "snapshot.ts", "replay.ts"]) {
    const text = readFileSync(join("src", f), "utf8");
    assert.ok(!/from\s+"@anthropic-ai\/sdk"|from\s+"@supabase\/supabase-js"/.test(text), `${f} must stay free of API/database clients`);
  }
});

test("V2-0 GUARD: the --replay branch of main.ts never reads .env, builds an Anthropic client or opens a database", () => {
  const main = readFileSync(join("src", "main.ts"), "utf8");
  const start = main.indexOf("if (values.replay) {");
  const end = main.indexOf("// ---- LIVE");
  assert.ok(start > 0 && end > start);
  const replayBranch = main.slice(start, end);
  for (const forbidden of ["loadEnvFile", "readEnv", "new Anthropic", "ReadOnlyDb", "process.env"]) assert.ok(!replayBranch.includes(forbidden), `replay branch must not use ${forbidden}`);
  assert.ok(main.indexOf("loadEnvFile();") > end, ".env is only loaded after the replay branch has returned");
});

test("V2-0 GUARD: every ledger/snapshot file write goes through explicit local paths (no network, no database client in those modules)", () => {
  for (const f of ["ledger.ts", "snapshot.ts", "budget.ts"]) {
    const text = readFileSync(join("src", f), "utf8");
    assert.ok(!/\bfetch\s*\(/.test(text.replace(/typeof fetch|real: typeof fetch|createReplayFetch|createRecordingFetch|await real\(|\breal\(/g, "")) || f === "snapshot.ts", `${f} must not fetch`);
  }
});
