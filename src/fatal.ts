import Anthropic from "@anthropic-ai/sdk";

/**
 * Errors that no retry, other candidate or later lane can recover from. When one occurs the whole
 * run's Anthropic work must stop at once (continuing only burns time and hides the failure).
 */
export type FatalKind = "insufficient_credit" | "authentication" | "permission";

export class FatalApiError extends Error {
  override readonly name = "FatalApiError";
  constructor(
    readonly kind: FatalKind,
    /** Short, credential-free description taken from the API's own error message. */
    readonly detail: string,
    readonly status: number | null,
    readonly requestId: string | null,
  ) {
    super(`fatal Anthropic API error (${kind}): ${detail}`);
  }
}

const CREDIT_TEXT = /credit balance is too low|insufficient (?:credit|credits|funds|balance)|purchase credits|plans\s*&\s*billing/i;

interface ApiErrorShape {
  status?: unknown;
  message?: unknown;
  error?: unknown;
  requestID?: unknown;
  request_id?: unknown;
}

/**
 * Decide whether an error thrown by the Anthropic SDK is a run-fatal condition:
 * insufficient credit, authentication or permission failure. Returns null for everything else
 * (rate limits, overload, timeouts, ordinary bad requests, non-API errors), which keep their
 * normal per-item handling.
 *
 * Mid-stream failures arrive as status-less APIErrors whose only signal is the error body, so
 * classification uses the status AND the body's error type AND its message.
 */
export function classifyFatalApiError(err: unknown, requestId: string | null = null): FatalApiError | null {
  if (err instanceof FatalApiError) return err;
  if (!(err instanceof Anthropic.APIError)) return null;
  const e = err as unknown as ApiErrorShape;
  const status = typeof e.status === "number" ? e.status : null;
  const body = (e.error ?? {}) as { type?: unknown; error?: { type?: unknown; message?: unknown }; message?: unknown };
  const inner = body.error && typeof body.error === "object" ? body.error : body;
  const errType = typeof inner.type === "string" ? inner.type : typeof body.type === "string" ? body.type : null;
  const apiMessage = typeof inner.message === "string" ? inner.message : typeof body.message === "string" ? body.message : "";
  const text = `${apiMessage} ${typeof e.message === "string" ? e.message : ""}`;
  const id = (typeof e.requestID === "string" && e.requestID) || (typeof e.request_id === "string" && e.request_id) || requestId;
  const detail = (apiMessage || (typeof e.message === "string" ? e.message : "")).replace(/\s+/g, " ").trim().slice(0, 200);

  if (status === 401 || errType === "authentication_error") return new FatalApiError("authentication", detail || "authentication failed", status, id);
  if (status === 403 || errType === "permission_error") return new FatalApiError("permission", detail || "permission denied", status, id);
  if (status === 402 || errType === "billing_error" || CREDIT_TEXT.test(text)) {
    return new FatalApiError("insufficient_credit", detail || "insufficient credit", status, id);
  }
  return null;
}
