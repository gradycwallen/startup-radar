import Anthropic from "@anthropic-ai/sdk";

/**
 * A fake Anthropic HTTP transport. The REAL SDK runs on top of it (streaming, retry logic, abort
 * handling), so timeout/abort tests exercise the same code path as production without any network.
 */

export type Wait = { wait: number };
export type SseItem = object | Wait;

const isWait = (x: SseItem): x is Wait => typeof (x as Wait).wait === "number";

export type Behavior =
  /** Stream these events (honoring {wait} markers), then finish. */
  | { kind: "sse"; events: SseItem[]; headers?: Record<string, string> }
  /** Stream these events, then stall forever until the request is aborted. */
  | { kind: "stall"; events?: SseItem[]; headers?: Record<string, string> }
  /** Never send headers until the request is aborted. */
  | { kind: "no-headers" }
  /** A plain HTTP status (e.g. 429 with retry-after, or 500). */
  | { kind: "status"; status: number; headers?: Record<string, string>; body?: object }
  /** A non-streaming JSON message (used by the repair call). */
  | { kind: "json"; body: object };

export interface RecordedCall {
  n: number;
  body: any;
  headers: Headers;
  startedAt: number;
  abortedAt: number | null;
}

export function fakeAnthropic(script: Behavior[] | ((call: RecordedCall) => Behavior), clientOptions: Partial<ConstructorParameters<typeof Anthropic>[0]> = {}) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    const call: RecordedCall = {
      n: calls.length + 1,
      body: init.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init.headers as HeadersInit),
      startedAt: performance.now(),
      abortedAt: null,
    };
    calls.push(call);
    const behavior = typeof script === "function" ? script(call) : (script[call.n - 1] ?? script[script.length - 1]!);
    const signal = init.signal ?? undefined;
    const abortError = () => new DOMException("The operation was aborted.", "AbortError");
    const onAbort = (fn: () => void) => {
      if (signal?.aborted) {
        call.abortedAt = performance.now();
        fn();
      } else signal?.addEventListener("abort", () => { call.abortedAt = performance.now(); fn(); }, { once: true });
    };

    switch (behavior.kind) {
      case "no-headers":
        return new Promise<Response>((_, reject) => onAbort(() => reject(abortError())));
      case "status":
        return new Response(JSON.stringify(behavior.body ?? { type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
          status: behavior.status, headers: { "content-type": "application/json", ...behavior.headers },
        });
      case "json":
        return new Response(JSON.stringify(behavior.body), { status: 200, headers: { "content-type": "application/json", "request-id": "req_json" } });
      case "sse":
      case "stall": {
        const items = behavior.events ?? [];
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            let aborted = false;
            onAbort(() => {
              aborted = true;
              try { controller.error(abortError()); } catch { /* already closed */ }
            });
            for (const item of items) {
              if (aborted) return;
              if (isWait(item)) { await new Promise((r) => setTimeout(r, item.wait)); continue; }
              const type = (item as { type: string }).type;
              controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(item)}\n\n`));
              await new Promise((r) => setTimeout(r, 1));
            }
            if (behavior.kind === "sse" && !aborted) controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test123", ...behavior.headers } });
      }
    }
  }) as typeof fetch;

  const client = new Anthropic({ apiKey: "sk-ant-test-key-DO-NOT-LOG-0123456789", fetch: fetchImpl, ...clientOptions });
  return { client, calls, fetch: fetchImpl };
}

// --- SSE event builders -------------------------------------------------------------------------

export const msgStart = (inputTokens = 1000) => ({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } },
});

export function serverToolUse(index: number, id: string, name: "web_search" | "web_fetch", input: object): object[] {
  return [
    { type: "content_block_start", index, content_block: { type: "server_tool_use", id, name, input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index },
  ];
}

export function searchResult(index: number, toolUseId: string, urls: string[]): object[] {
  return [
    {
      type: "content_block_start", index,
      content_block: { type: "web_search_tool_result", tool_use_id: toolUseId, content: urls.map((url) => ({ type: "web_search_result", url, title: "t", encrypted_content: "x", page_age: null })) },
    },
    { type: "content_block_stop", index },
  ];
}

export function fetchError(index: number, toolUseId: string, code: string): object[] {
  return [
    { type: "content_block_start", index, content_block: { type: "web_fetch_tool_result", tool_use_id: toolUseId, content: { type: "web_fetch_tool_error", error_code: code } } },
    { type: "content_block_stop", index },
  ];
}

export function textBlock(index: number, text: string): object[] {
  return [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index },
  ];
}

export const msgEnd = (stop = "end_turn", out = 50, searches = 0, fetches = 0) => [
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: out, server_tool_use: { web_search_requests: searches, web_fetch_requests: fetches } } },
  { type: "message_stop" },
];

/** A complete successful lane response: one web search, then the JSON leads. */
export function leadsResponse(leads: object[] = [], urls: string[] = ["https://news.example.com/a"]): Behavior {
  return {
    kind: "sse",
    events: [
      msgStart(2000),
      ...serverToolUse(0, "srvtoolu_1", "web_search", { query: "seed round" }),
      ...searchResult(1, "srvtoolu_1", urls),
      ...textBlock(2, JSON.stringify({ leads })),
      ...msgEnd("end_turn", 80, 1, 0),
    ],
  };
}

export const aLead = (over: object = {}) => ({
  name: "Acme", homepage_hint: "https://acme.ai", event_type_hint: "funding", source_url: "https://news.example.com/a",
  source_name: "News", event_date: "2026-09-10", headline: "Acme raises", snippet: null, ...over,
});

/** The exact error body Anthropic returned in the Phase 1 run when the account ran out of credit. */
export const CREDIT_ERROR_BODY = {
  type: "error",
  error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." },
};
