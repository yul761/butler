import { afterEach, describe, expect, it } from "vitest";
import type { PrivacyLevel } from "../../shared/llm";
import { ProviderError, type ChatCall } from "./provider";
import { normalizeText } from "./pseudonym";
import { chatReply, gatewayHarness, HARNESS_NOW, sampleSource, type GatewayHarness } from "./testing";
import type { NarrativeSource, OutboundPayload } from "./types";

let h: GatewayHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const payloadOf = (body: string) => JSON.parse((JSON.parse(body) as { messages: { content: string }[] }).messages[1].content) as OutboundPayload;
const row = (ts: number) => ({ ts, provider: "x", model: "m", level: "metadata" as const, status: "pending" as const, payloadSent: null });
/** 远程服务商地址：用保留的 .invalid 域名，即使代码有 bug 也不可能连到真实服务。 */
const REMOTE_URL = "https://llm.example.invalid/v1";
const FAKE_KEY = "sk-test-FAKE0000";

describe("PrivacyGateway", () => {
  it("does nothing when the level is off or the provider is not configured", async () => {
    h = await gatewayHarness();
    h.settings.set("llmLevel", "off");
    expect(await h.gateway.narrate(sampleSource())).toEqual({ status: "off", narrative: null, auditId: null });
    h.settings.set("llmLevel", "metadata");
    h.settings.set("llmModel", "");
    expect((await h.gateway.narrate(sampleSource())).status).toBe("off");
    h.settings.set("llmModel", "fake-model");
    // 远程服务没有 key：当作没配置，不发。
    h.settings.set("llmBaseUrl", REMOTE_URL);
    expect((await h.gateway.narrate(sampleSource())).status).toBe("off");
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()).toEqual([]);
  });

  it("treats a remote provider as not configured when the saved key cannot be read", async () => {
    let calls = 0;
    h = await gatewayHarness({
      chat: async () => {
        calls++;
        throw new Error("must not be called");
      },
    });
    h.settings.set("llmBaseUrl", REMOTE_URL);
    h.keys.save(FAKE_KEY);
    h.box.setBroken(true);
    expect(await h.gateway.narrate(sampleSource())).toEqual({ status: "off", narrative: null, auditId: null });
    expect(calls).toBe(0);
    expect(h.audit.list()).toEqual([]);
  });

  it("sends placeholders only, restores the reply and records the call", async () => {
    h = await gatewayHarness({ level: "metadata" });
    h.provider.handle((r) => {
      const id = payloadOf(r.body).tickets.find((t) => t.status === "in_review")!.id;
      return chatReply(JSON.stringify({ focus: [`先合并 ${id} 的 PR。`, "然后处理今天的下一步。"] }), { prompt_tokens: 1000, completion_tokens: 100 });
    });
    const r = await h.gateway.narrate(sampleSource());
    expect(r).toMatchObject({ status: "ok", narrative: "先合并 PROJ-123 的 PR。\n然后处理今天的下一步。" });
    const [body] = h.bodies();
    for (const v of ["PROJ-12", "acme-billing", "feature/PROJ-12-login", "登录", "staging"]) expect(body).not.toContain(v);
    const [entry] = h.audit.list();
    expect(entry).toMatchObject({
      id: r.auditId, status: "sent", level: "metadata", provider: new URL(h.provider.baseUrl).host, model: "fake-model",
      payloadSent: body, tokensIn: 1000, tokensOut: 100, error: null,
    });
    expect(entry.costUsd).toBeCloseTo((1000 * 1 + 100 * 2) / 1e6, 12);
    expect(entry.response).toContain("先合并 [[T_");
  });

  it.each<PrivacyLevel>(["metadata", "redacted"])("never sends any original value in any normalised form (%s)", async (level) => {
    h = await gatewayHarness({ level });
    h.terms.replaceAll([
      { term: "Wang Lei", category: "person" },
      { term: "Project Falcon", category: "term" },
    ]);
    const src: NarrativeSource = {
      date: "2026-10-21",
      tickets: [
        {
          key: "ZETA-42", status: "blocked", pr: { state: "open", review: "pending" }, daysInStatus: 4, idleDays: 2, doneLastDay: 0,
          // orion-payments 被 U+200B 拆开；人名、敏感词、ticket 号和分支名都在自由文本里。
          nextSteps: ["和 Wang Lei 确认 orion​-payments 的退款", "ZETA-42 先别合并"],
          // 全角和 en dash 写法的 ticket 号。
          blockers: ["Project Falcon 还没上线", "等 ＺＥＴＡ－４２ 的评审", "ZETA–42 卡在 CI"],
          followups: [{ kind: "other", trigger: "after_merge", description: "合并 feature/ZETA-42-refund 后通知 wang lei", overdueDays: null }],
        },
      ],
      items: [{ section: "first", rule: "blocked_long", ticketKey: "ZETA-42", days: 4, count: null }],
      known: { tickets: ["ZETA-42"], repos: ["orion-payments"], branches: ["feature/ZETA-42-refund"] },
    };
    expect((await h.gateway.narrate(src)).status).toBe("ok");
    expect(h.provider.requests).toHaveLength(1);
    const received = normalizeText(h.bodies()[0]).toLowerCase();
    for (const original of ["ZETA-42", "orion-payments", "feature/ZETA-42-refund", "Wang Lei", "Project Falcon"]) {
      expect(received, original).not.toContain(normalizeText(original).toLowerCase());
    }
    expect(normalizeText(h.audit.list()[0].payloadSent ?? "").toLowerCase()).toBe(received);
  });

  it("drops a sentence with an invented placeholder, and fails when nothing usable is left", async () => {
    h = await gatewayHarness();
    h.provider.handle(() => chatReply('{"focus":["先看 [[T_0000]] 的阻塞。","今天没有别的事。"]}'));
    expect(await h.gateway.narrate(sampleSource())).toMatchObject({ status: "ok", narrative: "今天没有别的事。" });
    h.provider.handle(() => chatReply('{"focus":["先看 [[T_0000]] 的阻塞。"]}'));
    expect((await h.gateway.narrate(sampleSource())).status).toBe("failed");
    expect(h.audit.list()[0]).toMatchObject({ status: "sent", error: "响应里没有可用的句子" });
  });

  it("blocks the whole request when the outbound text contains sensitive info, and keeps it off disk", async () => {
    h = await gatewayHarness({ level: "redacted" });
    const src = sampleSource();
    src.tickets[0].nextSteps = ["看一下 https://wiki.internal.example.com/x"];
    const r = await h.gateway.narrate(src);
    expect(r.status).toBe("blocked");
    expect(h.provider.requests).toHaveLength(0);
    const [entry] = h.audit.list();
    expect(entry).toMatchObject({ id: r.auditId, status: "blocked", payloadSent: null });
    expect(entry.blockedReason?.map((x) => x.rule)).toContain("url");
    expect(JSON.stringify(entry)).not.toContain("wiki.internal");
  });

  const CUT_SECRETS = [
    "好".repeat(103) + " wang.lei@acme-corp.com",
    "好".repeat(98) + " build01.prod.acme-internal.com",
    "好".repeat(96) + " ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0",
  ];
  const cutCases = (["redacted", "full"] as const).flatMap((level) =>
    (["nextSteps", "blockers"] as const).flatMap((field) => CUT_SECRETS.map((text, i) => ({ level, field, text, i }))),
  );
  it.each(cutCases)("blocks a secret that the length limit would cut in half ($level, $field, #$i)", async ({ level, field, text }) => {
    h = await gatewayHarness({ level });
    const src = sampleSource();
    src.tickets[0][field] = [text];
    const r = await h.gateway.narrate(src);
    expect(r.status).toBe("blocked");
    expect(h.provider.requests).toHaveLength(0);
    const [entry] = h.audit.list();
    expect(entry).toMatchObject({ id: r.auditId, status: "blocked", payloadSent: null });
    for (const v of ["wang.lei", "acme-corp", "build01", "acme-internal", "ghp_A1b2"]) expect(JSON.stringify(entry)).not.toContain(v);
  });

  it("blocks an unknown ticket key in free text, but not at the full level where real keys are intended", async () => {
    h = await gatewayHarness({ level: "redacted" });
    const src = sampleSource();
    src.tickets[0].blockers = ["等 OTHER-77 合并"];
    expect((await h.gateway.narrate(src)).status).toBe("blocked");
    h.settings.set("llmLevel", "full");
    expect((await h.gateway.narrate(src)).status).toBe("ok");
    expect(h.bodies()[0]).toContain("OTHER-77");
    expect(h.bodies()[0]).toContain("PROJ-12");
  });

  it("does not mistake enum values or dates for leaked names", async () => {
    h = await gatewayHarness({ level: "redacted" });
    const src = sampleSource();
    // 仓库名恰好和枚举值（status active、followup kind config）相同。
    src.known.repos = ["acme-billing", "config", "active"];
    expect((await h.gateway.narrate(src)).status).toBe("ok");
  });

  it("refuses over budget or without a price, before anything is sent; last month does not count", async () => {
    h = await gatewayHarness();
    h.settings.set("llmPrices", "");
    expect(await h.gateway.narrate(sampleSource())).toMatchObject({ status: "budget" });
    expect(h.audit.list()[0].error).toContain("价格");
    h.settings.set("llmPrices", "* 1 2");
    const last = h.audit.insert(row(new Date(2026, 8, 30).getTime()));
    h.audit.finish(last, { status: "sent", costUsd: 100 });
    expect((await h.gateway.narrate(sampleSource())).status).toBe("ok");
    const early = h.audit.insert(row(new Date(2026, 9, 2).getTime()));
    h.audit.finish(early, { status: "sent", costUsd: 4.999 });
    expect((await h.gateway.narrate(sampleSource())).status).toBe("budget");
    expect(h.provider.requests).toHaveLength(1);
    expect(h.audit.list()[0]).toMatchObject({ status: "budget", payloadSent: null });
    expect(h.audit.list()[0].error).toContain("预算");
  });

  it("does not prune this month's spending even when the retention period is shorter", async () => {
    h = await gatewayHarness();
    h.settings.set("auditRetentionDays", "7");
    const early = h.audit.insert(row(new Date(2026, 9, 2).getTime()));
    h.audit.finish(early, { status: "sent", costUsd: 4.999 });
    expect((await h.gateway.narrate(sampleSource())).status).toBe("budget");
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list().map((e) => e.id)).toContain(early);
  });

  it("serialises requests so the budget sees the first request's cost", async () => {
    h = await gatewayHarness();
    h.settings.set("llmPrices", "* 1000 1000");
    h.settings.set("llmMonthlyBudgetUsd", "10");
    h.provider.handle(() => chatReply('{"focus":["OK"]}', { prompt_tokens: 1_000_000, completion_tokens: 0 }));
    const [a, b] = await Promise.all([h.gateway.narrate(sampleSource()), h.gateway.narrate(sampleSource())]);
    expect([a.status, b.status]).toEqual(["ok", "budget"]);
    expect(h.provider.requests).toHaveLength(1);
  });

  it("never has two requests in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const chat: ChatCall = async (req) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { content: '{"focus":["OK"]}', tokensIn: 1, tokensOut: 1, raw: "{}", sentBody: JSON.stringify({ model: req.model }) };
    };
    h = await gatewayHarness({ chat });
    const results = await Promise.all([1, 2, 3].map(() => h!.gateway.narrate(sampleSource())));
    expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(maxInFlight).toBe(1);
  });

  it("never throws: an unexpected error becomes failed and later calls still run", async () => {
    h = await gatewayHarness();
    const prune = h.audit.prune.bind(h.audit);
    h.audit.prune = () => {
      throw new Error("database is locked");
    };
    await expect(h.gateway.narrate(sampleSource())).resolves.toEqual({ status: "failed", narrative: null, auditId: null });
    expect(h.logs.join("\n")).toContain("database is locked");
    h.audit.prune = prune;
    expect((await h.gateway.narrate(sampleSource())).status).toBe("ok");
  });

  it("asks before sending and sends nothing when declined", async () => {
    h = await gatewayHarness();
    h.settings.set("llmConfirm", "1");
    h.setConfirm(async () => false);
    expect(await h.gateway.narrate(sampleSource())).toMatchObject({ status: "off" });
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()[0]).toMatchObject({ status: "declined" });
    expect(h.confirms[0]).toContain(`POST ${h.provider.baseUrl}/chat/completions`);
    expect(h.confirms[0]).toContain("[[T_");
    expect(h.confirms[0]).not.toContain("PROJ-12");
    h.setConfirm(async () => {
      throw new Error("dialog crashed");
    });
    expect((await h.gateway.narrate(sampleSource())).status).toBe("failed");
    h.setConfirm(async () => true);
    expect((await h.gateway.narrate(sampleSource())).status).toBe("ok");
    expect(h.provider.requests).toHaveLength(1);
  });

  it("never throws even when the log itself throws, and closes the audit row", async () => {
    h = await gatewayHarness({
      log: () => {
        throw new Error("log boom");
      },
    });
    h.settings.set("llmConfirm", "1");
    h.setConfirm(async () => {
      throw new Error("dialog crashed");
    });
    const r = await h.gateway.narrate(sampleSource());
    expect(r).toMatchObject({ status: "failed" });
    expect(h.audit.list()[0]).toMatchObject({ id: r.auditId, status: "declined", payloadSent: null });
    h.setConfirm(async () => true);
    expect((await h.gateway.narrate(sampleSource())).status).toBe("ok");
    expect(h.provider.requests).toHaveLength(1);
  });

  it("stops waiting for the confirm dialog when the app quits", async () => {
    h = await gatewayHarness();
    h.settings.set("llmConfirm", "1");
    h.setConfirm(() => new Promise<boolean>(() => undefined));
    const ac = new AbortController();
    const p = h.gateway.narrate(sampleSource(), ac.signal);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const r = await p;
    expect(r.status).toBe("failed");
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()[0]).toMatchObject({ id: r.auditId, status: "declined", payloadSent: null });
    h.setConfirm(async () => true);
    expect((await h.gateway.narrate(sampleSource())).status).toBe("ok");
  });

  it("counts the cost of a 2xx reply that is not a chat completion", async () => {
    h = await gatewayHarness();
    h.provider.handle(() => ({ status: 200, raw: "<html>oops</html>", headers: { "content-type": "text/html" } }));
    const r = await h.gateway.narrate(sampleSource());
    expect(r.status).toBe("failed");
    const [entry] = h.audit.list();
    expect(entry).toMatchObject({ id: r.auditId, status: "sent", payloadSent: h.bodies()[0] });
    expect(entry.costUsd).toBeGreaterThan(0);
    expect(entry.error).toContain("JSON");
  });

  it("still records the cost when the first audit update after a send fails", async () => {
    h = await gatewayHarness();
    const finish = h.audit.finish.bind(h.audit);
    let failures = 1;
    h.audit.finish = (id, f) => {
      if (failures-- > 0) throw new Error("database is locked");
      finish(id, f);
    };
    const r = await h.gateway.narrate(sampleSource());
    expect(r.status).toBe("ok");
    const [entry] = h.audit.list();
    expect(entry.status).toBe("sent");
    expect(entry.costUsd).toBeGreaterThan(0);
  });

  it("returns failed without throwing when the audit cannot be updated after a send", async () => {
    h = await gatewayHarness();
    h.audit.finish = () => {
      throw new Error("database is locked");
    };
    await expect(h.gateway.narrate(sampleSource())).resolves.toMatchObject({ status: "failed" });
    expect(h.logs.join("\n")).toContain("database is locked");
  });

  it("never writes the key into the audit or the log, even when the provider echoes it", async () => {
    h = await gatewayHarness();
    h.keys.save("sk-secret-0123456789abcdef");
    h.provider.handle((r) => ({ status: 500, body: { error: `upstream rejected ${String(r.headers.authorization)}` } }));
    expect((await h.gateway.narrate(sampleSource())).status).toBe("failed");
    expect(h.provider.requests[0].headers.authorization).toBe("Bearer sk-secret-0123456789abcdef");
    expect(JSON.stringify(h.audit.list()) + h.logs.join("\n")).not.toContain("sk-secret");
    expect(h.audit.list()[0]).toMatchObject({ status: "failed" });
    expect(h.audit.list()[0].error).toContain("HTTP 500");
  });

  it("keeps the key out of every audit column and result field when a 500 echoes Bearer <key>", async () => {
    h = await gatewayHarness();
    h.keys.save(FAKE_KEY);
    h.provider.handle((r) => ({ status: 500, raw: `upstream rejected ${String(r.headers.authorization)} (key ${FAKE_KEY})` }));
    const r = await h.gateway.narrate(sampleSource());
    expect(r.status).toBe("failed");
    expect(h.provider.requests[0].headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    const [entry] = h.audit.list();
    for (const [col, v] of Object.entries(entry)) expect(JSON.stringify(v) ?? "", col).not.toContain(FAKE_KEY);
    for (const [field, v] of Object.entries(r)) expect(JSON.stringify(v) ?? "", field).not.toContain(FAKE_KEY);
    expect(h.logs.join("\n")).not.toContain(FAKE_KEY);
    expect(entry.error).toContain("HTTP 500");
  });

  it("keeps the key out of every audit column and result field when a 200 echoes it in the content", async () => {
    h = await gatewayHarness();
    h.keys.save(FAKE_KEY);
    h.provider.handle((r) => chatReply(JSON.stringify({ focus: [`先合并 PR，凭证 ${String(r.headers.authorization)}。`, `另一个是 ${FAKE_KEY}。`] })));
    const r = await h.gateway.narrate(sampleSource());
    expect(r.status).toBe("ok");
    const [entry] = h.audit.list();
    expect(entry.status).toBe("sent");
    for (const [col, v] of Object.entries(entry)) expect(JSON.stringify(v) ?? "", col).not.toContain(FAKE_KEY);
    for (const [field, v] of Object.entries(r)) expect(JSON.stringify(v) ?? "", field).not.toContain(FAKE_KEY);
    expect(h.logs.join("\n")).not.toContain(FAKE_KEY);
  });

  it("scrubs the key itself even if a chat implementation returns it unscrubbed", async () => {
    h = await gatewayHarness({
      chat: async (req) => ({
        content: JSON.stringify({ focus: [`凭证 ${String(req.apiKey)}。`, "先合并 PR。"] }),
        tokensIn: 1,
        tokensOut: 1,
        raw: `{"echo":"Bearer ${String(req.apiKey)}","plain":"${String(req.apiKey)}"}`,
        sentBody: "{}",
      }),
    });
    h.keys.save(FAKE_KEY);
    const r = await h.gateway.narrate(sampleSource());
    expect(r.status).toBe("ok");
    expect(JSON.stringify(r) + JSON.stringify(h.audit.list()) + h.logs.join("\n")).not.toContain(FAKE_KEY);
  });

  it("records the body that actually went out when the send fails after leaving the machine", async () => {
    h = await gatewayHarness();
    // 第一次 400 要求换参数名，第二次 500：实际发出的最后一个请求体带 max_completion_tokens。
    h.provider.handle((_r, n) =>
      n === 1 ? { status: 400, body: { error: "use max_completion_tokens instead" } } : { status: 500, body: { error: "boom" } },
    );
    expect((await h.gateway.narrate(sampleSource())).status).toBe("failed");
    expect(h.provider.requests).toHaveLength(2);
    const [entry] = h.audit.list();
    expect(entry.status).toBe("failed");
    expect(entry.payloadSent).toBe(h.bodies()[1]);
    expect(entry.payloadSent).toContain("max_completion_tokens");
  });

  it("records no payload when the send fails before anything left the machine", async () => {
    h = await gatewayHarness({
      chat: async () => {
        throw new ProviderError("network", "connect ECONNREFUSED", null, null);
      },
    });
    const r = await h.gateway.narrate(sampleSource());
    expect(r.status).toBe("failed");
    expect(h.audit.list()[0]).toMatchObject({ id: r.auditId, status: "failed", payloadSent: null, error: "connect ECONNREFUSED" });
  });

  it("fails without sending when the saved key cannot be decrypted (loopback provider)", async () => {
    h = await gatewayHarness();
    h.keys.save("sk-secret-0123456789abcdef");
    h.box.setBroken(true);
    expect((await h.gateway.narrate(sampleSource())).status).toBe("failed");
    expect(h.provider.requests).toHaveLength(0);
  });

  it("fails on a reply that is not the agreed JSON but still records what it cost", async () => {
    h = await gatewayHarness();
    h.provider.handle(() => chatReply("今天先合并 PR。"));
    expect((await h.gateway.narrate(sampleSource())).status).toBe("failed");
    expect(h.audit.list()[0]).toMatchObject({ status: "sent", error: "响应不符合格式", tokensIn: 120, tokensOut: 40 });
  });

  it("fails when the app is quitting, without sending", async () => {
    h = await gatewayHarness();
    const ac = new AbortController();
    ac.abort();
    const r = await h.gateway.narrate(sampleSource(), ac.signal);
    expect(r.status).toBe("failed");
    expect(h.provider.requests).toHaveLength(0);
    expect(h.confirms).toHaveLength(0);
    expect(h.audit.list()).toHaveLength(1);
    expect(h.audit.list()[0]).toMatchObject({ id: r.auditId, status: "declined", payloadSent: null, error: "app 正在退出" });
  });

  it("prunes audit rows past the retention period", async () => {
    h = await gatewayHarness();
    h.audit.insert({ ts: HARNESS_NOW - 91 * 86_400_000, provider: "x", model: "m", level: "metadata", status: "blocked", payloadSent: null });
    await h.gateway.narrate(sampleSource());
    expect(h.audit.list()).toHaveLength(1);
    expect(h.audit.list()[0].ts).toBe(HARNESS_NOW);
  });
});
