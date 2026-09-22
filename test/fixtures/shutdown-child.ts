// Fixture for test/shutdown.test.ts: runs the real executeRun + installShutdown with a provider that
// blocks until shutdown, so the test can send a real SIGTERM/SIGINT to a real process.
import { emptyUsage } from "../../src/claude.ts";
import { LIMITS } from "../../src/config.ts";
import { RunClock } from "../../src/deadline.ts";
import { createLogger } from "../../src/log.ts";
import { executeRun } from "../../src/run.ts";
import { installShutdown } from "../../src/shutdown.ts";
import { FakeReader, NOW, okHomepage, testBudget, testLedger } from "../helpers.ts";

const dir = process.argv[2]!;
const log = createLogger(dir, "child-run", { quiet: true });
const shutdown = installShutdown(process, log);
const db = new FakeReader(
  Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `C${i}`, domain: `c${i}.com` })),
  [],
);

const { exitCode } = await executeRun({
  provider: {
    name: "hang",
    lanes: ["funding"],
    async discover(ctx) {
      console.log("READY");
      await new Promise<void>((res) => ctx.signal.addEventListener("abort", () => res(), { once: true }));
      return { leads: [], errors: [], lanes: [{ lane: "funding", status: "aborted", elapsed_ms: 1, leads: 0, usage: emptyUsage() }] };
    },
  },
  verifier: { verify: async () => { throw new Error("unused"); } },
  db,
  checkHomepage: okHomepage(),
  log,
  config: {
    dryRun: true, maxNew: 10, maxCandidates: 14, minConfidence: 0.75, recencyDays: 14, maxEventAgeDays: 45,
    concurrency: 1, leadsPerLane: 6, lanes: undefined, logDir: dir, limits: { ...LIMITS }, budgetUsd: 0.75,
  },
  now: NOW,
  clock: new RunClock(LIMITS.runSoftDeadlineMs),
  shutdown,
  budget: testBudget(),
  ledger: testLedger(),
});
shutdown.dispose();
process.exit(exitCode);
