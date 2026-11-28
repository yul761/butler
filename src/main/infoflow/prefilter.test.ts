import { describe, expect, it } from "vitest";
import { FLOW_AGENT_CHARS, FLOW_USER_CHARS, hasDecisionWords, prefilterTurn } from "./prefilter";

describe("hasDecisionWords", () => {
  it.each([
    "这个 PR 关掉吧，ticket 也不做了",
    "BTL-12 改成先做",
    "把 BTL-30 挪到登录那个 feature",
    "以后接口一律用 snake_case",
    "From now on, always run the e2e before opening a PR",
    "Let's go with option B instead",
    "We no longer need the export button",
    "Never push straight to main",
    "never merge without a green CI",
  ])("%s has decision words", (t) => expect(hasDecisionWords(t)).toBe(true));

  it.each([
    "好的", "收到，我看看", "Thanks!", "跑一下测试", "看 https://example.com/close-this", "```\nmust close\n```\n看看这个",
    // 写代码时天天说的，不算决定。
    "这个接口的字段我看了，版本没问题", "合并一下这两个函数", "I always run the tests first", "Let me merge the api schema changes later",
    "First, I'll read the interface file", "我注意到这里有个依赖",
    // never 后面不是动作的不算。
    "Never mind, it works now", "I've never seen this error before",
  ])(
    "%s has none",
    (t) => expect(hasDecisionWords(t)).toBe(false),
  );
});

describe("prefilterTurn", () => {
  const long = "这个 PR 因为需求变了可以关掉，ticket 也不做了。";

  it("skips handoff and fork turns", () => {
    expect(prefilterTurn({ kind: "handoff", userText: long, agentText: long })).toEqual({ ok: false, reason: "kind" });
    expect(prefilterTurn({ kind: "fork", userText: long, agentText: long })).toEqual({ ok: false, reason: "kind" });
  });

  it("skips short turns", () => {
    expect(prefilterTurn({ kind: "user", userText: "关掉", agentText: "好" })).toEqual({ ok: false, reason: "short" });
  });

  it("skips turns without any decision words", () => {
    expect(prefilterTurn({ kind: "user", userText: "帮我看看这段代码为什么报错，谢谢", agentText: "报错是因为少了一个 import，我已经补上了。" })).toEqual({ ok: false, reason: "no_signal" });
  });

  it("passes a user turn with a decision and keeps both sides", () => {
    const r = prefilterTurn({ kind: "user", userText: long, agentText: "好，我去关。" });
    expect(r).toEqual({ ok: true, userText: long, agentText: "好，我去关。" });
  });

  it("keeps the relayed user answer stored for a silent turn", () => {
    // silent 轮里存下来的用户文本只有转达的回答：那是用户的原话，经收件箱回答的决定也要看到。
    const answer = "（转达）BTL-12 不做了，需求变了。";
    const r = prefilterTurn({ kind: "silent", userText: answer, agentText: "收到。" });
    expect(r).toEqual({ ok: true, userText: answer, agentText: "收到。" });
    // 没存用户文本的 silent 轮（Shipherd 粘进去的通知）只看 agent 说的。
    expect(prefilterTurn({ kind: "silent", userText: "", agentText: "收到，我看一下这条消息里说的是什么情况，稍后回复你。" })).toEqual({ ok: false, reason: "no_signal" });
  });

  it("keeps the head of the user text and the tail of the agent text", () => {
    const u = `以后一律这样做。${"甲".repeat(FLOW_USER_CHARS)}`;
    const a = `${"乙".repeat(FLOW_AGENT_CHARS)}结论：改成先做 BTL-12。`;
    const r = prefilterTurn({ kind: "user", userText: u, agentText: a });
    if (!r.ok) throw new Error("expected ok");
    expect([...r.userText]).toHaveLength(FLOW_USER_CHARS);
    expect(r.userText.startsWith("以后一律")).toBe(true);
    expect([...r.agentText]).toHaveLength(FLOW_AGENT_CHARS);
    expect(r.agentText.endsWith("BTL-12。")).toBe(true);
  });
});
