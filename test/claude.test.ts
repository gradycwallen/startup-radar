import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { collectUrls, extractJson, parseModelJson, ModelOutputError } from "../src/claude.ts";

test("extractJson handles fenced blocks, bare JSON and surrounding prose", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":{"b":2}} thanks'), { a: { b: 2 } });
  assert.throws(() => extractJson("no json here"));
});

test("parseModelJson validates against the schema", () => {
  const schema = z.object({ n: z.number() });
  assert.deepEqual(parseModelJson('{"n":3}', schema), { n: 3 });
  assert.throws(() => parseModelJson('{"n":"x"}', schema), ModelOutputError);
  assert.throws(() => parseModelJson("nope", schema), ModelOutputError);
});

test("collectUrls gathers URLs from search results, fetch results and citations only", () => {
  const urls = collectUrls([
    { type: "text", text: "hi", citations: [{ url: "https://cited.com/a?utm_source=x" }] },
    { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://www.techcrunch.com/x/", title: "t" }] },
    { type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: "http://glow.io/", content: { source: { url: "https://nested.com/z" } } } },
    { type: "server_tool_use", input: { url: "https://should-not-count.com" } },
  ]);
  assert.deepEqual([...urls].sort(), ["https://cited.com/a", "https://glow.io", "https://nested.com/z", "https://techcrunch.com/x"]);
});
