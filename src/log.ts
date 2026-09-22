import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { noRedaction, type Redactor } from "./redact.ts";

export interface Logger {
  readonly runId: string;
  readonly file: string;
  /** Pass `quiet: true` in data to write to the JSONL file only (no console line). */
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export interface LoggerOptions {
  /** No console output at all (used with --json). */
  quiet?: boolean;
  /** Applied to every record and console line before it is written. */
  redact?: Redactor;
}

/** JSONL file logger (one record per line) plus a terse console line. All output is redacted. */
export function createLogger(logDir: string, runId: string, options: LoggerOptions = {}): Logger {
  const redact = options.redact ?? noRedaction;
  mkdirSync(logDir, { recursive: true });
  const file = join(logDir, `${runId}.jsonl`);
  const write = (level: string, event: string, data?: Record<string, unknown>) => {
    const { quiet: lineQuiet, ...rest } = data ?? {};
    const record = { ts: new Date().toISOString(), runId, level, event, ...rest };
    appendFileSync(file, redact(JSON.stringify(record)) + "\n");
    if (!options.quiet && lineQuiet !== true) {
      const brief = "message" in rest ? ` ${String(rest.message)}` : "";
      console.error(redact(`[${level}] ${event}${brief}`));
    }
  };
  return {
    runId,
    file,
    info: (e, d) => write("info", e, d),
    warn: (e, d) => write("warn", e, d),
    error: (e, d) => write("error", e, d),
  };
}

/** Logger that discards everything; for tests. */
export function nullLogger(): Logger {
  const noop = () => {};
  return { runId: "test", file: "", info: noop, warn: noop, error: noop };
}

/** Logger that keeps records in memory; for tests asserting on what was logged. */
export function memoryLogger(): Logger & { records: Array<{ level: string; event: string } & Record<string, unknown>> } {
  const records: Array<{ level: string; event: string } & Record<string, unknown>> = [];
  const push = (level: string) => (event: string, data?: Record<string, unknown>) => {
    records.push({ level, event, ...data });
  };
  return { runId: "test", file: "", records, info: push("info"), warn: push("warn"), error: push("error") };
}
