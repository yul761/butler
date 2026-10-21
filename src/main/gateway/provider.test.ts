import { afterEach, describe, expect, it } from "vitest";
import { chatBody, chatCompletion, ProviderError, RESPONSE_LIMIT, scrub, type ChatRequest } from "./provider";
import { chatReply, startFakeProvider, type FakeProvider } from "./testing";

const KEY = "sk-test-0123456789abcdef";
const open: FakeProvider[] = [];
async function provider(): Promise<FakeProvider> {
  const p = await startFakeProvider();
  open.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((p) => p.close()));
});

const req = (baseUrl: string, over: Partial<ChatRequest> = {}): ChatRequest => ({
  baseUrl, apiKey: KEY, model: "fake-model", maxTokens: 800,
  messages: [{ role: "system", content: "你是助理" }, { role: "user", content: '{"a":1}' }],
  ...over,
});

describe("chatCompletion against a local fake server", () => {
  it("posts an OpenAI-compatible request and reads the content and usage", async () => {
    const p = await provider();
    p.handle(() => chatReply('{"focus":["先合并"]}', { prompt_tokens: 321, completion_tokens: 12 }));
    const r = await chatCompletion(req(p.baseUrl));
    expect(r).toMatchObject({ content: '{"focus":["先合并"]}', tokensIn: 321, tokensOut: 12 });
    const [got] = p.requests;
    expect(got.method).toBe("POST");
    expect(got.url).toBe("/v1/chat/completions");
    expect(got.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(got.body)).toEqual({ model: "fake-model", messages: req(p.baseUrl).messages, max_tokens: 800, stream: false });
    expect(r.sentBody).toBe(got.body);
    expect(got.body).not.toContain(KEY);
  });

  it("sends no authorization header without a key and accepts content parts and missing usage", async () => {
    const p = await provider();
    p.handle(() => ({ body: { choices: [{ message: { content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] } }] } }));
    const r = await chatCompletion(req(p.baseUrl, { apiKey: null }));
    expect(p.requests[0].headers.authorization).toBeUndefined();
    expect(r).toMatchObject({ content: "甲乙", tokensIn: null, tokensOut: null });
  });

  it("reports HTTP errors without leaking the key a provider echoes back", async () => {
    const p = await provider();
    p.handle((r) => ({ status: 401, body: { error: `bad key: ${r.headers.authorization}` } }));
    const err = await chatCompletion(req(p.baseUrl)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "http", status: 401 });
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).toContain("***");
  });

  it("rejects a 200 that is not a chat completion", async () => {
    const p = await provider();
    p.handle(() => ({ raw: "<html>login</html>", headers: { "content-type": "text/html" } }));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "bad_response" });
    p.handle(() => ({ body: { choices: [] } }));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("times out and can be cancelled", async () => {
    const p = await provider();
    p.handle(() => ({ ...chatReply("x"), delayMs: 3000 }));
    await expect(chatCompletion(req(p.baseUrl, { timeoutMs: 200 }))).rejects.toMatchObject({ kind: "timeout", message: "超过 200 毫秒没有响应" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(chatCompletion(req(p.baseUrl, { signal: ac.signal }))).rejects.toMatchObject({ kind: "aborted" });
  });

  it("never follows a redirect, so the key cannot be forwarded", async () => {
    const p = await provider();
    const other = await provider();
    p.handle(() => ({ status: 302, headers: { location: `${other.baseUrl}/chat/completions` } }));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "network" });
    expect(other.requests).toHaveLength(0);
  });

  it("retries once with max_completion_tokens when the model rejects max_tokens", async () => {
    const p = await provider();
    p.handle((_r, n) =>
      n === 1
        ? { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } }
        : chatReply("ok"),
    );
    const r = await chatCompletion(req(p.baseUrl));
    expect(p.requests).toHaveLength(2);
    expect(JSON.parse(p.requests[1].body)).toMatchObject({ max_completion_tokens: 800 });
    expect(JSON.parse(p.requests[1].body).max_tokens).toBeUndefined();
    expect(r.sentBody).toBe(p.requests[1].body);
  });

  it("refuses an oversized response", async () => {
    const p = await provider();
    p.handle(() => ({ raw: "x".repeat(RESPONSE_LIMIT + 10) }));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("provider helpers", () => {
  it("builds the body and scrubs secrets", () => {
    expect(JSON.parse(chatBody({ model: "m", messages: [], maxTokens: 5 }, "max_completion_tokens"))).toEqual({ model: "m", messages: [], max_completion_tokens: 5, stream: false });
    expect(scrub(`header was Bearer ${KEY} and ${KEY}`, KEY)).toBe("header was Bearer *** and ***");
    expect(scrub("Authorization: Bearer abc.def", null)).toBe("Authorization: Bearer ***");
  });
});
