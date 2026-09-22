import { ShutdownError } from "./deadline.ts";
import type { Logger } from "./log.ts";

export type ShutdownSignal = "SIGINT" | "SIGTERM";

/** Conventional exit codes for termination by signal (128 + signal number). */
export const SHUTDOWN_EXIT_CODE: Record<ShutdownSignal, number> = { SIGINT: 130, SIGTERM: 143 };

/** The slice of `process` we need; an EventEmitter with an `exit` method works in tests. */
export interface ProcessLike {
  on(event: ShutdownSignal, listener: () => void): unknown;
  removeListener(event: ShutdownSignal, listener: () => void): unknown;
  exit(code?: number): unknown;
}

export interface ShutdownHandle {
  /** Aborts (with a ShutdownError reason) on the first SIGINT/SIGTERM. */
  readonly signal: AbortSignal;
  requestedBy(): ShutdownSignal | null;
  /** 130 / 143 once a shutdown was requested, else null. */
  exitCode(): number | null;
  dispose(): void;
}

/**
 * Cooperative shutdown. The FIRST SIGINT/SIGTERM aborts `signal`, which cancels in-flight
 * Anthropic requests (and their retry waits), stops new work, and lets the run write its
 * partial summary and exit. A SECOND signal means "now": it exits immediately.
 */
export function installShutdown(proc: ProcessLike, log: Logger): ShutdownHandle {
  const controller = new AbortController();
  let requested: ShutdownSignal | null = null;

  const handle = (name: ShutdownSignal) => () => {
    if (requested === null) {
      requested = name;
      log.warn("shutdown_requested", { message: `${name} received: aborting in-flight work, writing partial summary. Signal again to force exit.`, signal: name });
      controller.abort(new ShutdownError(name));
    } else {
      log.error("shutdown_forced", { message: `second signal (${name}): exiting immediately`, signal: name });
      proc.exit(SHUTDOWN_EXIT_CODE[name]);
    }
  };
  const onInt = handle("SIGINT");
  const onTerm = handle("SIGTERM");
  proc.on("SIGINT", onInt);
  proc.on("SIGTERM", onTerm);

  return {
    signal: controller.signal,
    requestedBy: () => requested,
    exitCode: () => (requested ? SHUTDOWN_EXIT_CODE[requested] : null),
    dispose() {
      proc.removeListener("SIGINT", onInt);
      proc.removeListener("SIGTERM", onTerm);
    },
  };
}
