import { afterEach, describe, expect, it } from "vitest";
import type { Turn, TurnItem, UnattendedWhy } from "../../shared/turn";
import type { NowNotice } from "../../shared/types";
import { S, setUiLang } from "./strings";
import { turnSentence } from "./turn-text";

const item = (turn: Turn): TurnItem => ({ ticketKey: "BTL-1", pr: null, featureId: null, turn, since: 0, others: 0 });
const say = (turn: Turn) => turnSentence(turn, item(turn), S);
const shipherd = (notice: NowNotice): Turn => ({ owner: "you", kind: "shipherd", notice });
const T = { page: "shipherd", sessionId: null } as const;
afterEach(() => setUiLang("zh"));

describe("turnSentence", () => {
  it("covers every owner and kind in zh", () => {
    const cases: [Turn, string][] = [
      [{ owner: "you", kind: "answer", question: "用哪个库？", options: [], askId: 1, sessionId: "s" }, "问你：用哪个库？"],
      [{ owner: "you", kind: "merge", risk: "high" }, "可以合并了，风险高"],
      [{ owner: "you", kind: "merge", risk: null }, "可以合并了"],
      [{ owner: "you", kind: "review", author: "amy", title: "Fix", url: "u" }, "amy 请你 review：Fix"],
      [{ owner: "you", kind: "stuck", source: "needs_you", detail: "缺 key", sessionId: null }, "卡住了：缺 key"],
      [{ owner: "you", kind: "stuck", source: "needs_you", detail: null, sessionId: null }, "卡住了，说做不下去"],
      [{ owner: "you", kind: "stuck", source: "blocked_report", detail: "等接口", sessionId: null }, "报告做不下去：等接口"],
      [{ owner: "you", kind: "stuck", source: "silent", detail: null, sessionId: null }, "在跑，但很久没动静"],
      [{ owner: "you", kind: "stuck", source: "silent", detail: "npm test", sessionId: null }, "在跑，但很久没动静：npm test"],
      [{ owner: "you", kind: "stuck", source: "ticket_blocked", detail: null, sessionId: null }, "ticket 标成了阻塞"],
      [{ owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: null }, "CI 挂了，没人在修"],
      [{ owner: "agent", kind: "fixing_ci", sessionId: "s" }, "agent 在修 CI"],
      [{ owner: "agent", kind: "working", sessionId: "s" }, "agent 在做"],
      [{ owner: "external", kind: "awaiting_review", names: ["bob", "amy"] }, "在等 bob、amy review"],
      [{ owner: "external", kind: "awaiting_review", names: [] }, "在等 review"],
      [{ owner: "external", kind: "ci_running", names: [] }, "在等 CI"],
      [{ owner: "external", kind: "merge_queue", names: [] }, "在合并队列里"],
      [{ owner: "external", kind: "stack_below", names: ["feature/a"] }, "在等栈的下一层 feature/a 合并"],
      [{ owner: "done", kind: "merged" }, "合了"],
      [{ owner: "idle", kind: "not_started" }, "还没开始"],
    ];
    for (const [turn, text] of cases) expect(say(turn), JSON.stringify(turn)).toBe(text);
  });

  it("every unattended why has a sentence in both languages", () => {
    const whys: UnattendedWhy[] = ["ci_failing", "changes_requested", "conflicts", "behind", "draft", "no_reviewer", "agent_stopped", "ci_undelivered"];
    for (const lang of ["zh", "en"] as const) {
      setUiLang(lang);
      const out = whys.map((why) => say({ owner: "you", kind: "unattended", why, canSend: false, sessionId: null }));
      expect(new Set(out).size).toBe(whys.length);
      for (const s of out) expect(s.length).toBeGreaterThan(0);
    }
  });

  it("has the same keys in en", () => {
    setUiLang("en");
    expect(say({ owner: "you", kind: "merge", risk: null })).toBe("Ready to merge");
    expect(say({ owner: "you", kind: "merge", risk: "low" })).toBe("Ready to merge — low risk");
    expect(say({ owner: "external", kind: "awaiting_review", names: ["bob", "amy"] })).toBe("Waiting for review from bob, amy");
    expect(say({ owner: "agent", kind: "addressing_review", sessionId: "s" })).toBe("The agent is addressing review");
    expect(say({ owner: "external", kind: "stack_below", names: ["feature/a"] })).toBe("Waiting for the layer below (feature/a) to merge");
  });

  it("shipherd sentences come from the notice kind", () => {
    expect(say(shipherd({ kind: "approval", target: T, title: null }))).toBe("在终端里等你确认权限");
    expect(say(shipherd({ kind: "approval", target: T, title: null, startup: true }))).toBe("在终端里等你回答启动询问（信任文件夹或新的 MCP server）");
    const waiting = (reason: "review" | "undelivered") => shipherd({ kind: "comments_waiting", waiting: { reason, ticketKey: "BTL-1", prId: 1, number: 3, count: 2, since: 0 }, target: T, title: null });
    expect(say(waiting("review"))).toBe("有 2 条评论等你分类");
    expect(say(waiting("undelivered"))).toBe("有 2 条评论没送到 session");
    const stack = (reason: "conflict" | "stuck" | "confirm") => shipherd({ kind: "stack", stack: { reason, stackId: 1, stackName: "s", branch: "b" }, target: null });
    expect(say(stack("conflict"))).toBe("栈里有冲突没交给 session");
    expect(say(stack("stuck"))).toBe("栈的 rebase 卡住了");
    expect(say(stack("confirm"))).toBe("栈的 rebase 等你确认");
    // 冲突标记拦住的层、被它拦住的上面几层：都说「有一层带着冲突标记」（BTL-278）
    const base = { stackId: 1, stackName: "s", branch: "c", ticketKey: "C", prNumber: null };
    expect(say(shipherd({ kind: "stack", stack: { ...base, reason: "markers", files: ["b.txt"], where: "local" }, target: null }))).toBe("栈里有一层带着冲突标记，没推出去");
    expect(say(shipherd({ kind: "stack", stack: { ...base, reason: "held_below", branches: ["c", "d"], by: "b" }, target: null }))).toBe("栈里有一层带着冲突标记，没推出去");
    expect(say(shipherd({ kind: "lessons_paused" }))).toBe("Shipherd 要你点一下");
    setUiLang("en");
    expect(say(waiting("review"))).toBe("2 comments to triage");
    expect(say(shipherd({ kind: "approval", target: T, title: null }))).toBe("Waiting for you to confirm a permission prompt");
  });
});
