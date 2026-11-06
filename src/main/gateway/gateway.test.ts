import { afterEach, describe, expect, it } from "vitest";
import { StatecoreCallError } from "./gateway";
import { ProviderError, type ChatCall } from "./provider";
import { chatReply, gatewayHarness, HARNESS_NOW, type GatewayHarness } from "./testing";

let h: GatewayHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const FAKE_KEY = "sk-test-FAKE0000";
const msgs = [
  { role: "system" as const, content: "你是记忆蒸馏器" },
  { role: "user" as const, content: "原始事件：PROJ-12 改好了登录" },
];

/**
 * 发送、记账、去掉 key 这些共用的部分（send / record / 串行队列）。“今日重点”去掉以后只有 StateCore 蒸馏走这条路，
 * 所以都经 statecoreModel() 测；StateCore 自己的条件（档位、截止时间、拒绝原因）在 statecore-model.test.ts。
 */
describe("PrivacyGateway (shared send path)", () => {
  const chat = (g: GatewayHarness) => g.gateway.statecoreModel()!.chat(msgs);

  it("serialises requests so the budget sees the first request's cost", async () => {
    h = await gatewayHarness({ level: "full" });
    h.settings.set("llmPrices", "* 1000 1000");
    h.settings.set("llmMonthlyBudgetUsd", "10");
    h.provider.handle(() => chatReply("OK", { prompt_tokens: 1_000_000, completion_tokens: 0 }));
    const [a, b] = await Promise.allSettled([chat(h), chat(h)]);
    expect(a).toEqual({ status: "fulfilled", value: "OK" });
    expect(b.status).toBe("rejected");
    expect(h.provider.requests).toHaveLength(1);
    expect(h.audit.list().map((r) => r.status)).toEqual(["budget", "sent"]);
  });

  it("never has two requests in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow: ChatCall = async (req) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { content: "OK", tokensIn: 1, tokensOut: 1, raw: "{}", sentBody: JSON.stringify({ model: req.model }) };
    };
    h = await gatewayHarness({ level: "full", chat: slow });
    expect(await Promise.all([1, 2, 3].map(() => chat(h!)))).toEqual(["OK", "OK", "OK"]);
    expect(maxInFlight).toBe(1);
  });

  it("an unexpected error rejects as a StatecoreCallError and later calls still run", async () => {
    h = await gatewayHarness({ level: "full" });
    const prune = h.audit.prune.bind(h.audit);
    h.audit.prune = () => {
      throw new Error("database is locked");
    };
    await expect(chat(h)).rejects.toThrow(StatecoreCallError);
    h.audit.prune = prune;
    expect(await chat(h)).toBe("OK");
  });

  it("still records the cost when the first audit update after a send fails", async () => {
    h = await gatewayHarness({ level: "full" });
    const finish = h.audit.finish.bind(h.audit);
    let failures = 1;
    h.audit.finish = (id, f) => {
      if (failures-- > 0) throw new Error("database is locked");
      finish(id, f);
    };
    expect(await chat(h)).toBe("OK");
    const [entry] = h.audit.list();
    expect(entry.status).toBe("sent");
    expect(entry.costUsd).toBeGreaterThan(0);
  });

  it("rejects when the audit cannot be updated after a send: the next budget check must see the cost", async () => {
    h = await gatewayHarness({ level: "full" });
    h.audit.finish = () => {
      throw new Error("database is locked");
    };
    await expect(chat(h)).rejects.toThrow(StatecoreCallError);
    expect(h.logs.join("\n")).toContain("database is locked");
  });

  it("never throws from a log that throws, and still closes the audit row", async () => {
    h = await gatewayHarness({
      level: "full",
      log: () => {
        throw new Error("log disk full");
      },
    });
    h.provider.handle(() => ({ status: 500, body: { error: "boom" } }));
    await expect(chat(h)).rejects.toThrow(StatecoreCallError);
    expect(h.audit.list()[0]).toMatchObject({ status: "failed" });
    h.provider.handle(() => chatReply("OK"));
    expect(await chat(h)).toBe("OK");
  });

  it("keeps the key out of every audit column, the error and the log when a 500 echoes Bearer <key>", async () => {
    h = await gatewayHarness({ level: "full" });
    h.keys.save(FAKE_KEY);
    h.provider.handle((r) => ({ status: 500, raw: `upstream rejected ${String(r.headers.authorization)} (key ${FAKE_KEY})` }));
    const err = await chat(h).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(StatecoreCallError);
    expect(err!.message).not.toContain(FAKE_KEY);
    expect(h.provider.requests[0].headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    const [entry] = h.audit.list();
    for (const [col, v] of Object.entries(entry)) expect(JSON.stringify(v) ?? "", col).not.toContain(FAKE_KEY);
    expect(h.logs.join("\n")).not.toContain(FAKE_KEY);
    expect(entry.error).toContain("HTTP 500");
  });

  it("keeps the key out of the audit and the returned content when a 200 echoes it", async () => {
    h = await gatewayHarness({ level: "full" });
    h.keys.save(FAKE_KEY);
    h.provider.handle((r) => chatReply(`凭证 ${String(r.headers.authorization)}，另一个是 ${FAKE_KEY}。`));
    const content = await chat(h);
    expect(content).not.toContain(FAKE_KEY);
    const [entry] = h.audit.list();
    expect(entry.status).toBe("sent");
    for (const [col, v] of Object.entries(entry)) expect(JSON.stringify(v) ?? "", col).not.toContain(FAKE_KEY);
    expect(h.logs.join("\n")).not.toContain(FAKE_KEY);
  });

  it("scrubs the key itself even if a chat implementation returns it unscrubbed", async () => {
    h = await gatewayHarness({
      level: "full",
      chat: async (req) => ({
        content: `凭证 ${String(req.apiKey)}。`,
        tokensIn: 1,
        tokensOut: 1,
        raw: `{"echo":"Bearer ${String(req.apiKey)}","plain":"${String(req.apiKey)}"}`,
        sentBody: "{}",
      }),
    });
    h.keys.save(FAKE_KEY);
    const content = await chat(h);
    expect(content + JSON.stringify(h.audit.list()) + h.logs.join("\n")).not.toContain(FAKE_KEY);
  });

  it("records the body that actually went out when the send fails after leaving the machine", async () => {
    h = await gatewayHarness({ level: "full" });
    // 第一次 400 要求换参数名，第二次 500：实际发出的最后一个请求体带 max_completion_tokens。
    h.provider.handle((_r, n) =>
      n === 1 ? { status: 400, body: { error: "use max_completion_tokens instead" } } : { status: 500, body: { error: "boom" } },
    );
    await expect(chat(h)).rejects.toThrow(StatecoreCallError);
    expect(h.provider.requests).toHaveLength(2);
    const [entry] = h.audit.list();
    expect(entry.status).toBe("failed");
    expect(entry.payloadSent).toBe(h.bodies()[1]);
    expect(entry.payloadSent).toContain("max_completion_tokens");
  });

  it("records no payload when the send fails before anything left the machine", async () => {
    h = await gatewayHarness({
      level: "full",
      chat: async () => {
        throw new ProviderError("network", "connect ECONNREFUSED", null, null);
      },
    });
    await expect(chat(h)).rejects.toThrow("connect ECONNREFUSED");
    expect(h.audit.list()[0]).toMatchObject({ status: "failed", payloadSent: null, error: "connect ECONNREFUSED", costUsd: null });
  });

  it("does not charge a request the provider rejected with an error status", async () => {
    h = await gatewayHarness({ level: "full" });
    h.provider.handle(() => ({ status: 503, body: { error: "overloaded" } }));
    await expect(chat(h)).rejects.toThrow(StatecoreCallError);
    expect(h.audit.list()[0]).toMatchObject({ status: "failed", tokensOut: null, costUsd: null });
  });

  it("prunes audit rows past the retention period", async () => {
    h = await gatewayHarness({ level: "full" });
    h.audit.insert({ ts: HARNESS_NOW - 91 * 86_400_000, provider: "x", model: "m", level: "metadata", status: "blocked", payloadSent: null });
    await chat(h);
    expect(h.audit.list()).toHaveLength(1);
    expect(h.audit.list()[0].ts).toBe(HARNESS_NOW);
  });
});
