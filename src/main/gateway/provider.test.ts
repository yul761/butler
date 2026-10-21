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
    // status 带上 2xx：gateway 据此知道服务商收下了请求、可能已经计费。
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "bad_response", status: 200 });
    p.handle(() => ({ body: { choices: [] } }));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "bad_response", status: 200 });
  });

  it("times out and can be cancelled", async () => {
    const p = await provider();
    p.handle(() => ({ ...chatReply("x"), delayMs: 3000 }));
    await expect(chatCompletion(req(p.baseUrl, { timeoutMs: 200 }))).rejects.toMatchObject({ kind: "timeout", message: "超过 200 毫秒没有响应" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(chatCompletion(req(p.baseUrl, { signal: ac.signal }))).rejects.toMatchObject({ kind: "aborted" });
  });

  it.each([301, 302, 307, 308])("never follows a %i redirect, so the key cannot be forwarded", async (status) => {
    const p = await provider();
    const other = await provider();
    p.handle(() => ({ status, headers: { location: `${other.baseUrl}/chat/completions` } }));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "network" });
    expect(p.requests.length).toBe(1);
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
    p.handle(() => chatReply("x".repeat(RESPONSE_LIMIT + 10)));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "bad_response", message: `响应超过 ${RESPONSE_LIMIT} 个字符` });
  });

  it("scrubs the key from a 2xx raw body and content", async () => {
    const p = await provider();
    p.handle(() => ({ body: { choices: [{ message: { content: `echo ${KEY} and Bearer ${KEY}` } }], debug: { headers: { authorization: `Bearer ${KEY}` } } } }));
    const r = await chatCompletion(req(p.baseUrl));
    expect(r.raw).not.toContain(KEY);
    expect(r.content).not.toContain(KEY);
    expect(r.content).toContain("***");
  });

  it("uses one deadline for the retry too", async () => {
    const p = await provider();
    p.handle((_r, n) =>
      n === 1 ? { status: 400, body: { error: "use max_completion_tokens" }, delayMs: 150 } : { ...chatReply("x"), delayMs: 3000 },
    );
    const t0 = Date.now();
    await expect(chatCompletion(req(p.baseUrl, { timeoutMs: 300 }))).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - t0).toBeLessThan(450);
    expect(p.requests).toHaveLength(2);
  });

  it("records the last body sent on the error", async () => {
    const p = await provider();
    p.handle((_r, n) => (n === 1 ? { status: 400, body: { error: "use max_completion_tokens" } } : { status: 500, body: { error: "boom" } }));
    const err = (await chatCompletion(req(p.baseUrl)).catch((e: unknown) => e)) as ProviderError;
    expect(err).toMatchObject({ kind: "http", status: 500 });
    expect(err.sentBody).toBe(p.requests[1].body);
    expect(JSON.parse(err.sentBody ?? "")).toMatchObject({ max_completion_tokens: 800 });
  });

  it("does not retry a 400 that does not mention the parameter, and retries at most once", async () => {
    const p = await provider();
    p.handle(() => ({ status: 400, body: { error: "nope" } }));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ status: 400 });
    expect(p.requests).toHaveLength(1);
    const q = await provider();
    q.handle(() => ({ status: 400, body: { error: "use max_completion_tokens" } }));
    await expect(chatCompletion(req(q.baseUrl))).rejects.toMatchObject({ status: 400 });
    expect(q.requests).toHaveLength(2);
  });

  it("refuses unsafe base URLs without sending anything", async () => {
    const p = await provider();
    await expect(chatCompletion(req("http://butler-test.invalid/v1"))).rejects.toMatchObject({ kind: "network", sentBody: null });
    await expect(chatCompletion(req(`${p.baseUrl}?x=1`))).rejects.toMatchObject({ kind: "network" });
    await expect(chatCompletion(req(`${p.baseUrl}#f`))).rejects.toMatchObject({ kind: "network" });
    await expect(chatCompletion(req(p.baseUrl.replace("http://", "http://u:p@")))).rejects.toMatchObject({ kind: "network" });
    expect(p.requests).toHaveLength(0);
  });
});

describe("provider helpers", () => {
  it("builds the body and scrubs secrets", () => {
    expect(JSON.parse(chatBody({ model: "m", messages: [], maxTokens: 5 }, "max_completion_tokens"))).toEqual({ model: "m", messages: [], max_completion_tokens: 5, stream: false });
    expect(scrub(`header was Bearer ${KEY} and ${KEY}`, KEY)).toBe("header was Bearer *** and ***");
    expect(scrub("Authorization: Bearer abc.def", null)).toBe("Authorization: Bearer ***");
    expect(scrub("Bearer ***abcdef and Bearer ***", null)).toBe("Bearer *** and Bearer ***");
    expect(scrub("k=sk%20test%2Fkey!", "sk test/key!")).toBe("k=***");
    expect(scrub("k=sk%20test%2Fkey! raw sk test/key!", "sk test/key!")).toBe("k=*** raw ***");
  });
});
