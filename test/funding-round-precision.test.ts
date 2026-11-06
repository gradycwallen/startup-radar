import assert from "node:assert/strict";
import { test } from "node:test";
import { extractHeadline } from "../src/funnel/extract.ts";

test("an older round in an excerpt is not attributed to the newly announced financing", () => {
  for (const [title, excerpt] of [
    ["Kabilio raises €10 million", "The investors also led its pre-seed round."],
    ["Biograil raises €20 million", "HTGF led Biograil's seed syndicate in 2019."],
  ] as const) {
    const result = extractHeadline(title, excerpt);
    assert.ok(!("drop" in result));
    assert.equal(result.round, null);
  }
  const explicit = extractHeadline("Acme raises $5 million in a Series A", "");
  assert.ok(!("drop" in explicit));
  assert.equal(explicit.round, "series_a");
});
