import { parseArgs } from "node:util";
import { evaluate, formatEval } from "./evaluate.ts";

const { values } = parseArgs({ options: { snapshot: { type: "string" }, "as-of": { type: "string" }, finalists: { type: "string" }, json: { type: "boolean" }, runs: { type: "boolean" } }, strict: true });
const snapshot = values.snapshot ?? "test/fixtures/snapshots/funnel-eval-2026-09-21";
const rep = await evaluate({ snapshotDir: snapshot, ...(values["as-of"] ? { asOfDates: values["as-of"].split(",") } : {}), ...(values.finalists ? { finalists: Number(values.finalists) } : {}) });
if (values.json) console.log(JSON.stringify(rep, null, 2));
else {
  console.log(formatEval(rep));
  if (values.runs) for (const r of rep.runs) console.log(`\n--- ${r.as_of}\n` + r.finalists.map((f) => `  #${String(f.rank).padStart(3)} ${f.score.toFixed(1).padStart(5)} ${f.name.padEnd(28).slice(0, 28)} ${(f.domain ?? "-").padEnd(24)} ${f.providers.join(",").slice(0, 34).padEnd(34)} ${f.selection}${f.label ? `  <== LABEL ${f.label}` : ""}`).join("\n"));
}
