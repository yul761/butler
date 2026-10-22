import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "./budget";
import { STATECORE_MAX_TOKENS, STATECORE_TIMEOUT_MS } from "./gateway";
import { chatBody, ProviderError, type ChatRequest } from "./provider";
import { chatReply, gatewayHarness, type GatewayHarness } from "./testing";

let h: GatewayHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const FAKE_KEY = "sk-test-FAKE0000";
/** 远程服务商地址：用保留的 .invalid 域名，即使代码有 bug 也不可能连到真实服务。 */
const REMOTE_URL = "https://llm.example.invalid/v1";
const msgs = [
  { role: "system" as const, content: "你是记忆蒸馏器" },
  { role: "user" as const, content: "原始事件：PROJ-12 的 staging 地址是 https://intranet.corp/x" },
];

describe("PrivacyGateway.statecoreModel (plan 4 R1)", () => {
  it("gives no model below the full level, when not configured, or when confirm-before-send is on", async () => {
    h = await gatewayHarness({ level: "metadata" });
    expect(h.gateway.statecoreModel()).toBeNull();
    h.settings.set("llmLevel", "full");
    expect(h.gateway.statecoreModel()).not.toBeNull();
    h.settings.set("llmConfirm", "1");
    expect(h.gateway.statecoreModel()).toBeNull();
    h.settings.set("llmConfirm", "0");
    h.settings.set("llmModel", "");
    expect(h.gateway.statecoreModel()).toBeNull();
  });

  it("sends StateCore's messages unchanged and unscanned, with the key only in the header, and audits the call as statecore", async () => {
    h = await gatewayHarness({ level: "full" });
    h.keys.save(FAKE_KEY);
    h.provider.handle(() => chatReply('{"digest":"ok"}', { prompt_tokens: 1000, completion_tokens: 500 }));
    const model = h.gateway.statecoreModel()!;
    expect(await model.chat(msgs)).toBe('{"digest":"ok"}');
    expect(h.provider.requests).toHaveLength(1);
    const sent = JSON.parse(h.provider.requests[0].body) as { model: string; messages: unknown; max_tokens: number };
    expect(sent).toMatchObject({ model: "fake-model", messages: msgs, max_tokens: 8192 });
    expect(h.provider.requests[0].headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    const [row] = h.audit.list();
    expect(row).toMatchObject({ source: "statecore", level: "full", status: "sent", tokensIn: 1000, tokensOut: 500, blockedReason: null, error: null });
    expect(row.costUsd).toBeCloseTo((1000 * 1 + 500 * 2) / 1_000_000, 10);
    expect(row.payloadSent).toContain("https://intranet.corp/x");
    expect(JSON.stringify(row)).not.toContain(FAKE_KEY);
    expect(h.confirms).toEqual([]);
  });

  it("refuses every call once the level is no longer full or confirm is on (Review Focus 4)", async () => {
    h = await gatewayHarness({ level: "full" });
    const model = h.gateway.statecoreModel()!;
    h.settings.set("llmLevel", "redacted");
    await expect(model.chat(msgs)).rejects.toThrow();
    h.settings.set("llmLevel", "full");
    h.settings.set("llmConfirm", "1");
    await expect(model.chat(msgs)).rejects.toThrow();
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()).toEqual([]);
    expect(h.confirms).toEqual([]);
  });

  it("stops at the monthly budget without sending", async () => {
    h = await gatewayHarness({ level: "full" });
    // 输出上限 8192 token × $2 / 百万 ≈ $0.016，超过 $0.01。
    h.settings.set("llmMonthlyBudgetUsd", "0.01");
    await expect(h.gateway.statecoreModel()!.chat(msgs)).rejects.toThrow(/预算/);
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()).toMatchObject([{ source: "statecore", status: "budget", payloadSent: null }]);
  });

  it("records a failed call and rejects, so StateCore keeps the events for the next run", async () => {
    h = await gatewayHarness({ level: "full" });
    h.provider.handle(() => ({ status: 500, body: { error: "upstream" } }));
    await expect(h.gateway.statecoreModel()!.chat(msgs)).rejects.toThrow();
    expect(h.audit.list()).toMatchObject([{ source: "statecore", status: "failed" }]);
  });

  it("does not send once the app is quitting", async () => {
    h = await gatewayHarness({ level: "full" });
    const quit = new AbortController();
    const model = h.gateway.statecoreModel(quit.signal)!;
    quit.abort();
    await expect(model.chat(msgs)).rejects.toThrow();
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()).toEqual([]);
  });

  it("gives each call a deadline sized for its 8192-token output", async () => {
    const seen: ChatRequest[] = [];
    h = await gatewayHarness({
      level: "full",
      chat: async (req) => {
        seen.push(req);
        return { content: "{}", tokensIn: 1, tokensOut: 1, raw: "{}", sentBody: chatBody(req) };
      },
    });
    expect(await h.gateway.statecoreModel()!.chat(msgs)).toBe("{}");
    expect(STATECORE_TIMEOUT_MS).toBe(180_000);
    expect(seen).toMatchObject([{ maxTokens: STATECORE_MAX_TOKENS, timeoutMs: STATECORE_TIMEOUT_MS }]);
  });

  it("charges a conservative cost at 8192 output tokens when the request went out and then timed out", async () => {
    h = await gatewayHarness({
      level: "full",
      chat: async (req) => {
        throw new ProviderError("timeout", "超过 3 分钟没有响应", null, chatBody(req));
      },
    });
    await expect(h.gateway.statecoreModel()!.chat(msgs)).rejects.toThrow("超过 3 分钟没有响应");
    const [row] = h.audit.list();
    const tokensIn = estimateTokens(row.payloadSent!);
    expect(row).toMatchObject({ source: "statecore", status: "failed", tokensIn, tokensOut: 8192 });
    expect(row.costUsd).toBeCloseTo((tokensIn * 1 + 8192 * 2) / 1_000_000, 12);
  });

  it("charges a call cancelled mid-flight by the app quitting", async () => {
    h = await gatewayHarness({ level: "full" });
    h.provider.handle(() => ({ ...chatReply("{}"), delayMs: 5_000 }));
    const quit = new AbortController();
    const p = h.gateway.statecoreModel(quit.signal)!.chat(msgs);
    while (h.provider.requests.length === 0) await new Promise((r) => setTimeout(r, 5));
    quit.abort();
    await expect(p).rejects.toThrow();
    expect(h.audit.list()[0]).toMatchObject({ source: "statecore", status: "failed", tokensOut: 8192 });
    expect(h.audit.list()[0].costUsd).toBeGreaterThan(0);
  });

  it("charges a 2xx reply that is not a chat completion at 8192 output tokens, and rejects", async () => {
    h = await gatewayHarness({ level: "full" });
    h.provider.handle(() => ({ status: 200, raw: "<html>oops</html>", headers: { "content-type": "text/html" } }));
    await expect(h.gateway.statecoreModel()!.chat(msgs)).rejects.toThrow();
    const [row] = h.audit.list();
    expect(row).toMatchObject({ source: "statecore", status: "sent", payloadSent: h.bodies()[0], tokensOut: 8192 });
    expect(row.costUsd).toBeCloseTo((estimateTokens(h.bodies()[0]) * 1 + 8192 * 2) / 1_000_000, 12);
  });

  it("refuses a remote provider without a key, and a saved key that cannot be decrypted, without sending or auditing", async () => {
    h = await gatewayHarness({ level: "full" });
    h.settings.set("llmBaseUrl", REMOTE_URL);
    const model = h.gateway.statecoreModel()!;
    await expect(model.chat(msgs)).rejects.toThrow("没有可用的 API key");
    h.settings.set("llmBaseUrl", h.provider.baseUrl);
    h.keys.save(FAKE_KEY);
    h.box.setBroken(true);
    await expect(model.chat(msgs)).rejects.toThrow("没有可用的 API key");
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()).toEqual([]);
  });

  it("logs each refusal reason once, as a code without content or key", async () => {
    h = await gatewayHarness({ level: "full" });
    h.keys.save(FAKE_KEY);
    const model = h.gateway.statecoreModel()!;
    h.settings.set("llmConfirm", "1");
    for (let i = 0; i < 3; i++) await expect(model.chat(msgs)).rejects.toThrow();
    h.settings.set("llmConfirm", "0");
    h.settings.set("llmLevel", "redacted");
    await expect(model.chat(msgs)).rejects.toThrow();
    await expect(model.chat(msgs)).rejects.toThrow();
    h.settings.set("llmLevel", "full");
    h.box.setBroken(true);
    await expect(model.chat(msgs)).rejects.toThrow();
    // 一次成功的调用之后，同一个原因再出现时重新记一次。
    h.box.setBroken(false);
    expect(await model.chat(msgs)).toBeTypeOf("string");
    h.settings.set("llmConfirm", "1");
    await expect(model.chat(msgs)).rejects.toThrow();
    const refusals = h.logs.filter((l) => l.startsWith("statecore call refused"));
    expect(refusals).toEqual([
      "statecore call refused: confirm_on",
      "statecore call refused: level_not_full",
      "statecore call refused: no_key",
      "statecore call refused: confirm_on",
    ]);
    const all = h.logs.join("\n");
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toContain("intranet.corp");
  });
});
