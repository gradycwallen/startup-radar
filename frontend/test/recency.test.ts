import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate } from "../src/lib/derive/recency.ts";

test("date-only discovery events retain their calendar date west of UTC", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.equal(formatDate("2026-09-30"), "Sep 30, 2026");
    assert.equal(formatDate("invalid"), null);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
