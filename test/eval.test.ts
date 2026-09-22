import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { evaluate, matchesLabel } from "../src/eval/evaluate.ts";
import { LABELS } from "../src/eval/labels.ts";

const FIXTURE = resolve("test/fixtures/snapshots/funnel-eval-2026-09-21");

// ---- recall regression, against the committed fixture ---------------------------------------------------------------------
//
// These numbers are a MEASURED baseline (see the V2-1 report), not a target the funnel was tuned to hit: the fix that
// changed the count below (dropping "GC Angels" via the generic "angel(s)" fund-word) was a class-level prefilter fix,
// not a target-specific one. If a future change moves these numbers, that is real signal to look at, not noise to chase
// away — update the baseline only after you've read why it moved.

test("EVAL FIXTURE: measured recall on the committed 5-day snapshot matches the reported baseline", async () => {
  const rep = await evaluate({ snapshotDir: FIXTURE });
  const primary = rep.recall.find((r) => r.group === "primary")!;
  assert.deepEqual(primary, { group: "primary", n: 8, raw_lead: 8, entity: 8, finalist: 6, finalist_domain_ok: 3 });
  const separate = rep.recall.find((r) => r.group === "separate")!;
  assert.deepEqual(separate, { group: "separate", n: 1, raw_lead: 0, entity: 0, finalist: 0, finalist_domain_ok: 0 });
});

test("EVAL FIXTURE: each primary target's stage outcome matches its known cause (rank, domain resolution, or reason it was missed)", async () => {
  const rep = await evaluate({ snapshotDir: FIXTURE });
  const by = (name: string) => rep.targets.find((t) => t.label.name === name)!.stages;
  assert.deepEqual([by("Project-S").finalist, by("Project-S").domain_verdict], [true, "unresolved"]);
  assert.deepEqual([by("Fin.com").finalist, by("Fin.com").domain_verdict], [true, "exact"]);
  assert.deepEqual([by("Empirik").finalist, by("Empirik").domain_verdict], [true, "exact"]);
  assert.deepEqual([by("ScrollEd").finalist, by("ScrollEd").selection], [true, "score"]);
  assert.deepEqual([by("TypeSafe AI").finalist, by("TypeSafe AI").domain_verdict], [true, "unresolved"]);
  assert.deepEqual([by("Aiir").finalist, by("Aiir").track, by("Aiir").domain_verdict], [true, "directory", "exact"]);
  // Gaia Dynamics: found, ranked, but not selected — entity survives the funnel, just outside the top 14.
  const gaia = by("Gaia Dynamics");
  assert.equal(gaia.entity, true);
  assert.equal(gaia.finalist, false);
  assert.ok((gaia.rank ?? 0) > rep.finalists, "Gaia Dynamics missed because it ranked below the finalist cutoff, not because it was dropped earlier");
  // Sunzu: found under an alt domain (sunzu.ai vs the label's sunzu.com), in the directory backlog beyond the 25-slot cap.
  const sunzu = by("Sunzu");
  assert.equal(sunzu.entity, true);
  assert.equal(sunzu.domain_verdict, "alt");
  // heylogin: reported separately, and genuinely absent from every recorded source item on every as-of day.
  const hey = by("heylogin");
  assert.equal(hey.outcome, "not_in_any_source_item");
  assert.ok(rep.targets.find((t) => t.label.name === "heylogin")!.elsewhere.every((e) => e.outcome === "not_in_any_source_item"));
});

// ---- false-positive review -------------------------------------------------------------------------------------------------

test("EVAL FIXTURE: an angel-investor group announcing its OWN accelerator cohort is filtered as an investor, not treated as a portfolio company", async () => {
  const rep = await evaluate({ snapshotDir: FIXTURE });
  const run = rep.runs.find((r) => r.as_of === "2026-09-21")!;
  assert.ok(!run.finalists.some((f) => f.name === "GC Angels"), "GC Angels (an angel network launching its 3rd cohort) must not be a finalist");
});

test("EVAL FIXTURE: no finalist across any run is a known large/public company or an investment fund by name", async () => {
  const rep = await evaluate({ snapshotDir: FIXTURE });
  const FUND_LIKE = /\b(capital|ventures?|\bvc\b|partners|fund|holdings|investments?|angels?)\b/i;
  const offenders = rep.runs.flatMap((r) => r.finalists.filter((f) => FUND_LIKE.test(f.name)).map((f) => `${r.as_of}: ${f.name}`));
  assert.deepEqual(offenders, []);
});

test("matchesLabel: matches by canonical/alias name key or by any label domain (including alt domains)", () => {
  const sunzu = LABELS.find((l) => l.name === "Sunzu")!;
  assert.ok(matchesLabel(sunzu, "Sunzu", []));
  assert.ok(matchesLabel(sunzu, "Anything", ["sunzu.ai"]));
  assert.ok(!matchesLabel(sunzu, "Totally Different", ["nope.com"]));
});

// ---- funnel CLI, offline (--replay) ------------------------------------------------------------------------------------

const ROOT = resolve(".");

function cli(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "scout-funnel-cli-"));
  const trace = join(dir, "network-attempts.log");
  const res = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(join(ROOT, "test/fixtures/no-network.mjs")).href, join(ROOT, "src/funnel-main.ts"), ...args, "--log-dir", dir],
    // A --json dump of a full funnel run (all ranked entities + finalists + breakdowns) comfortably exceeds
    // spawnSync's default 1MB maxBuffer; raise it well above what this fixture produces.
    { cwd: dir, env: { PATH: process.env.PATH ?? "", NO_NETWORK_LOG: trace }, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
  );
  return { ...res, dir, trace, attempts: existsSync(trace) ? readFileSync(trace, "utf8") : "" };
}

test("FUNNEL CLI --replay: runs the whole deterministic funnel with NO credentials and NO network attempt", () => {
  const r = cli(["--replay", FIXTURE, "--as-of", "2026-09-21", "--json"]);
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  assert.equal(r.attempts, "", `the replay tried to use the network:\n${r.attempts}`);
  const [result] = JSON.parse(r.stdout) as Array<{ as_of: string; finalists: unknown[]; directory_finalists: unknown[]; counts: { raw_leads: number } }>;
  assert.equal(result!.as_of.slice(0, 10), "2026-09-21");
  assert.equal(result!.finalists.length, 14);
  assert.equal(result!.directory_finalists.length, 25);
  assert.ok(result!.counts.raw_leads > 0);
  const files = readdirSync(r.dir);
  assert.ok(files.some((f) => f.endsWith(".funnel.json")));
  assert.ok(files.some((f) => f.endsWith(".leads.jsonl")), "the lead ledger is still written in replay mode");
});

test("FUNNEL CLI --replay prints a readable report without --json", () => {
  const r = cli(["--replay", FIXTURE, "--as-of", "2026-09-21"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /FUNNEL as of 2026-09-21/);
  assert.match(r.stdout, /providers:/);
  assert.equal(r.attempts, "");
});

test("FUNNEL CLI usage errors exit 2 without touching the network: --replay+--record together, unreadable snapshot", () => {
  const both = cli(["--replay", FIXTURE, "--record", "/tmp/x"]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /cannot be combined/);
  const missing = cli(["--replay", "/no/such/snapshot"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Cannot replay: funnel snapshot directory not found/);
  assert.equal(both.attempts + missing.attempts, "");
});

test("FUNNEL CLI live mode still requires Supabase credentials only (no Anthropic key needed) and reports missing NAMES only", () => {
  const r = cli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(r.attempts, "", "failing the credentials check must not touch the network");
});
