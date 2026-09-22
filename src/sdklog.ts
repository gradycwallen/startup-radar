import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "./log.ts";

const RETRY_SCHEDULED = /\bretrying,\s*\d+\s+attempts?\s+remaining\b/i;
const RETRIES_EXHAUSTED = /\bno more retries left\b/i;

type SdkLogger = NonNullable<ConstructorParameters<typeof Anthropic>[0]>["logger"];

/**
 * Routes the Anthropic SDK's own log lines into our JSONL log.
 *
 * At the client's `info` level the SDK reports each request's outcome (including the
 * `request-id` header and duration) and every retry ("retrying, N attempts remaining").
 * Only the SDK's message text is kept. The extra arguments the SDK passes (options,
 * headers, bodies) are dropped on purpose so credentials cannot leak through them, and
 * `debug` output is discarded entirely. The Logger itself also redacts secret patterns.
 */
export function createSdkLogger(log: Logger): NonNullable<SdkLogger> {
  const requestId = (text: string) => /request-id: "([^"]+)"/.exec(text)?.[1];
  const emit = (level: "info" | "warn" | "error", message: unknown) => {
    const text = String(message);
    const id = requestId(text);
    // The SDK words a scheduled retry exactly "retrying, N attempts remaining". Anything else that merely
    // contains "retry" ("error; not retryable", "no more retries left") is NOT a retry being attempted.
    if (RETRY_SCHEDULED.test(text)) {
      log.warn("sdk_retry", { message: text, request_id: id ?? null });
    } else if (RETRIES_EXHAUSTED.test(text)) {
      log.warn("sdk_retries_exhausted", { message: text, request_id: id ?? null });
    } else if (level === "info") {
      log.info("sdk", { message: text, request_id: id ?? null, quiet: true });
    } else {
      log[level]("sdk", { message: text, request_id: id ?? null });
    }
  };
  return {
    error: (message) => emit("error", message),
    warn: (message) => emit("warn", message),
    info: (message) => emit("info", message),
    debug: () => {},
  };
}
