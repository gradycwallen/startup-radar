import assert from "node:assert/strict";
import { test } from "node:test";
import { RunClock, ScoutTimeoutError, ShutdownError, classifyAbort, timeoutScope } from "../src/deadline.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("timeoutScope aborts after its limit with a typed reason naming kind, label, limit and elapsed", async () => {
  const scope = timeoutScope("lane", "funding", 60);
  assert.equal(scope.signal.aborted, false);
  await sleep(120);
  assert.equal(scope.signal.aborted, true);
  const reason = scope.signal.reason;
  assert.ok(reason instanceof ScoutTimeoutError);
  assert.equal(reason.kind, "lane");
  assert.equal(reason.label, "funding");
  assert.equal(reason.limitMs, 60);
  assert.ok(reason.elapsedMs >= 50 && reason.elapsedMs < 500, `elapsed ${reason.elapsedMs}`);
  assert.match(reason.message, /lane timeout: "funding" exceeded 60ms/);
});

test("cancel() clears the timer so a finished scope can never fire later", async () => {
  const scope = timeoutScope("request", "x", 40);
  scope.cancel();
  await sleep(90);
  assert.equal(scope.signal.aborted, false);
});

test("a parent abort wins and carries the parent's reason (shutdown is not reported as a timeout)", () => {
  const parent = new AbortController();
  const scope = timeoutScope("request", "child", 60_000, parent.signal);
  parent.abort(new ShutdownError("SIGTERM"));
  assert.equal(scope.signal.aborted, true);
  assert.ok(scope.signal.reason instanceof ShutdownError);
  scope.cancel();
});

test("nested scopes: the outer deadline firing first is reported as the outer kind", async () => {
  const lane = timeoutScope("lane", "funding", 50);
  const request = timeoutScope("request", "funding#1", 60_000, lane.signal);
  await sleep(110);
  assert.equal(request.signal.aborted, true);
  const reason = request.signal.reason;
  assert.ok(reason instanceof ScoutTimeoutError && reason.kind === "lane" && reason.label === "funding");
  lane.cancel();
  request.cancel();
});

test("nested scopes: an inner deadline firing first does not abort the outer scope", async () => {
  const lane = timeoutScope("lane", "funding", 60_000);
  const request = timeoutScope("request", "funding#1", 40, lane.signal);
  await sleep(90);
  assert.equal(request.signal.aborted, true);
  assert.equal(lane.signal.aborted, false);
  lane.cancel();
  request.cancel();
});

test("classifyAbort returns the typed reason for our aborts and passes other errors through", () => {
  const parent = new AbortController();
  const original = new Error("APIUserAbortError: Request was aborted.");
  assert.equal(classifyAbort(original, parent.signal), original); // not aborted: untouched
  parent.abort(new ShutdownError("SIGINT"));
  assert.ok(classifyAbort(original, parent.signal) instanceof ShutdownError);
  const foreign = new AbortController();
  foreign.abort(new Error("somebody else"));
  assert.equal(classifyAbort(original, foreign.signal), original); // unknown reason: untouched
  assert.equal(classifyAbort(original, undefined), original);
});

test("RunClock: soft deadline is a boundary check, never an abort", () => {
  let t = 1_000;
  const clock = new RunClock(45 * 60_000, () => t);
  assert.equal(clock.softDeadlineReached(), false);
  t += 45 * 60_000 - 1;
  assert.equal(clock.softDeadlineReached(), false);
  t += 1;
  assert.equal(clock.softDeadlineReached(), true);
  assert.equal(clock.elapsedMs(), 45 * 60_000);
});
