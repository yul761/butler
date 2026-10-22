import { afterEach, describe, expect, it } from "vitest";
import { chatReply, gatewayHarness, type GatewayHarness } from "./testing";

let h: GatewayHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const FAKE_KEY = "sk-test-FAKE0000";
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
});
