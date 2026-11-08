import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFilerName, formatCandidates, matchFormDCandidates, searchFormD } from "../src/analysis/sec-form-d.ts";

test("SEC search distinguishes empty results from failed and malformed responses", async () => {
  assert.deepEqual(await searchFormD("Example", async () => ({ status: 200, text: '{"hits":{"hits":[]}}' })), []);
  await assert.rejects(searchFormD("Example", async () => ({ status: 403, text: "blocked" })), /HTTP 403/);
  await assert.rejects(searchFormD("Example", async () => ({ status: 200, text: "not json" })), /invalid JSON/);
  await assert.rejects(searchFormD("Example", async () => ({ status: 200, text: '{}' })), /unexpected response/);
  await assert.rejects(searchFormD("Example", async () => ({ status: 200, text: '{"hits":{"hits":[{}]}}' })), /incomplete filing/);
  await assert.rejects(searchFormD("Example", async () => { throw new Error("network failed"); }), /network failed/);
});

test("extractFilerName strips the trailing CIK annotation SEC's search index always appends", () => {
  assert.equal(extractFilerName("OneDome Global Inc.  (CIK 0001757593)"), "OneDome Global Inc.");
  assert.equal(extractFilerName("Acme Corp (CIK 123)"), "Acme Corp");
  assert.equal(extractFilerName("No Suffix Here"), "No Suffix Here", "a name with no CIK suffix is returned unchanged, not mangled");
});

test("an exact (modulo legal suffix) name match scores as strong", () => {
  const candidates = matchFormDCandidates({ id: 1, name: "GitHits" }, [
    { displayName: "GitHits, Inc.  (CIK 0001111111)", cik: "0001111111", accessionNumber: "0001111111-26-000001", fileDate: "2026-09-15", bizState: "CA" },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.tier, "strong");
  assert.ok(candidates[0]!.nameSimilarity >= 0.92);
});

test("a wholly unrelated name is dropped entirely, never reported as a weak candidate", () => {
  const candidates = matchFormDCandidates({ id: 1, name: "GitHits" }, [
    { displayName: "Unrelated Forensic DNA Testing Co  (CIK 0009999999)", cik: "0009999999", accessionNumber: "x", fileDate: "2026-01-01", bizState: "VA" },
  ]);
  assert.deepEqual(candidates, [], "below the 0.75 threshold, nothing is returned -- not even as a weak hint");
});

test("the real Ande/Travix-shaped case: two companies that happen to share a short name both score as candidates -- this module does not and cannot disambiguate them", () => {
  // This is the exact failure mode the module doc comment warns about: a real funded startup and
  // an unrelated, pre-existing company can share a name closely enough to both clear the
  // threshold. The correctness bar for THIS module is that it ranks and labels, not that it picks
  // the right one -- disambiguation is explicitly left to a human, by design.
  const candidates = matchFormDCandidates({ id: 1, name: "Ande" }, [
    { displayName: "Ande Inc  (CIK 0001000001)", cik: "0001000001", accessionNumber: "a", fileDate: "2026-05-01", bizState: "DE" },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.tier, "strong");
});

test("results are sorted best-match first", () => {
  const candidates = matchFormDCandidates({ id: 1, name: "Chamelio" }, [
    { displayName: "ChamelioAI Corp  (CIK 1)", cik: "1", accessionNumber: "a", fileDate: "2026-01-01", bizState: null }, // close but not exact
    { displayName: "Chamelio, Inc.  (CIK 2)", cik: "2", accessionNumber: "b", fileDate: "2026-02-01", bizState: "DE" }, // exact (modulo legal suffix)
  ]);
  assert.equal(candidates.length, 2);
  assert.ok(candidates[0]!.nameSimilarity >= candidates[1]!.nameSimilarity);
  assert.equal(candidates[0]!.cik, "2", "the exact match should rank first, even though it's listed second in the input");
});

test("a missing bizState is preserved as null, never coerced to a misleading empty string or 'unknown' guess", () => {
  const candidates = matchFormDCandidates({ id: 1, name: "Restate" }, [{ displayName: "Restate Inc  (CIK 1)", cik: "1", accessionNumber: "a", fileDate: "2026-01-01", bizState: null }]);
  assert.equal(candidates[0]!.bizState, null);
});

test("formatCandidates explicitly labels every result as unverified, and explicitly distinguishes zero-candidates from a confirmed absence", () => {
  const empty = formatCandidates([]);
  assert.match(empty, /not a confirmed absence/);

  const candidates = matchFormDCandidates({ id: 1, name: "GitHits" }, [
    { displayName: "GitHits, Inc.  (CIK 0001111111)", cik: "0001111111", accessionNumber: "0001111111-26-000001", fileDate: "2026-09-15", bizState: "CA" },
  ]);
  const text = formatCandidates(candidates);
  assert.match(text, /NONE of these are confirmed matches/);
  assert.match(text, /STRONG/);
  assert.match(text, /CIK 0001111111/);
});
