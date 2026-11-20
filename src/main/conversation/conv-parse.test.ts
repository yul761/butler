import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { deliveryText } from "../prereview/delivery";
import { M } from "../strings";
import { capText, cleanUserText, CONV_TEXT_MAX, convEntriesOf, toolEffect, type ConvEntry } from "./conv-parse";

const lines = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
const convFixture = lines(join(__dirname, "__fixtures__", "conv.jsonl"));
const tailFixture = lines(join(__dirname, "..", "sessions", "__fixtures__", "refresh-tail.jsonl"));

/** entry 的可比较部分（key、parent、at 另测）。 */
const shape = (e: ConvEntry) => {
  switch (e.kind) {
    case "user":
      return { kind: e.kind, open: e.open, text: e.text };
    case "assistant":
      return { kind: e.kind, text: e.text, stop: e.stop };
    case "tool":
      return { kind: e.kind, name: e.name, effect: e.effect, stop: e.stop };
    case "noise":
      return { kind: e.kind };
  }
};

const userLine = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", uuid: "u", timestamp: "2026-11-19T10:00:00.000Z", message: { role: "user", content }, ...extra });

describe("convEntriesOf on the conversation fixture", () => {
  it("keeps only speech, opens turns and tags tools", () => {
    expect(convFixture.flatMap(convEntriesOf).map(shape)).toEqual([
      { kind: "user", open: "user", text: "换新阈值是多少？" },
      { kind: "assistant", text: "我看一下", stop: false },
      { kind: "tool", name: "Read", effect: "read", stop: false },
      { kind: "noise" },
      { kind: "assistant", text: "150k。", stop: true },
      { kind: "user", open: "user", text: "把按钮改成蓝色" },
      { kind: "tool", name: "Edit", effect: "mutate", stop: false },
      { kind: "noise" },
      { kind: "assistant", text: "改好了", stop: true },
      { kind: "user", open: "silent", text: null },
      { kind: "noise" },
      { kind: "user", open: "silent", text: null },
      { kind: "assistant", text: "收到", stop: true },
      { kind: "user", open: "user", text: "[image]" },
      { kind: "assistant", text: "这是一张截图", stop: true },
    ]);
  });

  it("uses uuids, numbers extra entries on one line, hashes lines without uuid", () => {
    const all = convFixture.flatMap(convEntriesOf);
    expect(all[0]).toMatchObject({ key: "c1", parent: null, at: Date.parse("2026-11-19T10:00:01.000Z") });
    expect(all[1]).toMatchObject({ key: "c2", parent: "c1" });
    expect(all[2]).toMatchObject({ key: "c2#1", parent: "c1" });
    const last = all[all.length - 1];
    expect(last.key).toMatch(/^h:[0-9a-f]{40}$/);
    expect(last.parent).toBe("c14");
    expect(convEntriesOf(convFixture[convFixture.length - 1])[0].key).toBe(last.key);
  });
});

describe("convEntriesOf on the refresh-tail fixture", () => {
  const all = tailFixture.flatMap(convEntriesOf);
  const byKey = (k: string) => all.filter((e) => e.key === k || e.key.startsWith(`${k}#`));

  it("treats slash commands as silent and their output as noise", () => {
    expect(byKey("u5").map(shape)).toEqual([{ kind: "user", open: "silent", text: null }]);
    expect(byKey("u6").map(shape)).toEqual([{ kind: "noise" }]);
    expect(byKey("u4").map(shape)).toEqual([{ kind: "noise" }]);
  });

  it("strips reminders from what the user said", () => {
    expect(byKey("u7").map(shape)).toEqual([{ kind: "user", open: "user", text: "开 PR 吧" }]);
  });

  it("classifies mcp writes as mutating", () => {
    expect(byKey("a4").map(shape)).toEqual([{ kind: "tool", name: "mcp__github__create_pull_request", effect: "mutate", stop: false }]);
  });

  it("recognises /handoff and its meta expansion", () => {
    expect(byKey("u9").map(shape)).toEqual([{ kind: "user", open: "handoff", text: null }]);
    expect(byKey("u10").map(shape)).toEqual([{ kind: "noise" }]);
  });

  it("drops sidechains, non-message lines and thinking", () => {
    expect(byKey("s1")).toEqual([]);
    expect(all.some((e) => (e.kind === "assistant" || e.kind === "user") && (e.text ?? "").includes("先看看文件"))).toBe(false);
    expect(all.filter((e) => e.kind === "assistant").map((e) => (e as { text: string }).text)).toContain("我先看一下登录页。");
  });
});

describe.each(["zh", "en"] as const)("Butler's own messages (%s)", (lang) => {
  afterEach(() => setLang("zh"));
  const openOf = (text: string) => {
    setLang(lang);
    const e = convEntriesOf(userLine(text))[0];
    return e.kind === "user" ? e.open : e.kind;
  };

  it("handoff requests", () => {
    expect(openOf(M().refreshEpicHandoff)).toBe("handoff");
    expect(openOf(M().idleCloseEpicHandoff)).toBe("handoff");
  });

  it("notices and resume prompts are silent", () => {
    expect(openOf(M().refreshResume("ticket", "PROJ-1", "/x"))).toBe("silent");
    expect(openOf(M().ciPassedNotice("PROJ-1", "abc1234"))).toBe("silent");
    expect(openOf(`${M().inboxReportsIntro}\n…`)).toBe("silent");
  });

  it("relayed answers are stored but do not count as questions", () => {
    setLang(lang);
    const e = convEntriesOf(userLine(`${M().inboxAnswersIntro}\n${M().inboxAnswer("q", "a")}`))[0];
    expect(e).toMatchObject({ kind: "user", open: "relay" });
    expect((e as { text: string }).text).toContain(M().inboxAnswer("q", "a"));
  });

  it("a single relayed answer (no intro line) is a relay too (final review 3)", () => {
    setLang(lang);
    expect(openOf(M().inboxAnswer("要不要改成每天跑？", "要"))).toBe("relay");
    expect(openOf(M().inboxAnswer("Run it daily?", "yes"))).toBe("relay");
    // 只是开头像，没有「用户的回答」那一段：照常是用户说的话。
    const pre = M().inboxAnswer("\u0000", "").split("\u0000")[0];
    expect(openOf(`${pre}x 之后呢`)).toBe("user");
  });

  it("messages Butler types into the terminal are silent (PR #60 review 2)", () => {
    setLang(lang);
    const m = M();
    expect(openOf(`${m.butlerMessagePrefix}\n帮我看看 PR #60 为什么红了？`)).toBe("silent");
    expect(openOf(m.butlerReplyLine("BTL-1", ["m1"], "要不要先合？"))).toBe("silent");
    expect(openOf(m.butlerPatrolMessage)).toBe("silent");
    expect(openOf(m.cost.continueAfterDowngrade("haiku"))).toBe("silent");
    expect(openOf(m.cost.continueAfterRaise("$5"))).toBe("silent");
    const pre = { shortSha: "abc1234", violations: [], gaps: [], error: "boom", lang };
    expect(openOf(deliveryText({ ...pre, verdict: "error" }))).toBe("silent");
    expect(openOf(deliveryText({ ...pre, verdict: "clean" }))).toBe("silent");
    expect(openOf(deliveryText({ ...pre, verdict: "violations", violations: [{ lessonId: null, checkKey: null, severity: "must", file: "a.ts", line: 1, what: "x", fix: "y" }] }))).toBe("silent");
  });

  it("the user talking about Butler is still the user", () => {
    expect(openOf("Butler 对话页为什么是空的？")).toBe("user");
    expect(openOf("Butler is slow, why?")).toBe("user");
    expect(openOf("【回顾】这周做了什么？")).toBe("user");
  });

  it("plain speech is user", () => {
    expect(openOf("这个怎么做？")).toBe("user");
  });
});

describe("noise and skipped lines", () => {
  it.each([
    ["<local-command-stderr>boom</local-command-stderr>"],
    ["<local-command-caveat>Caveat</local-command-caveat>"],
    ["<bash-input>ls</bash-input>"],
    ["<bash-stdout>a</bash-stdout>"],
    ["<bash-stderr>b</bash-stderr>"],
    ["<task-notification>done</task-notification>"],
    ["[Request interrupted by user for tool use]"],
    ["<system-reminder>only</system-reminder>   "],
  ])("%s is noise", (text) => {
    expect(convEntriesOf(userLine(text)).map((e) => e.kind)).toEqual(["noise"]);
  });

  it.each([
    [{ isMeta: true }],
    [{ isCompactSummary: true }],
  ])("flags %o make noise", (extra) => {
    expect(convEntriesOf(userLine("hello", extra)).map((e) => e.kind)).toEqual(["noise"]);
  });

  it("api errors and synthetic messages are noise", () => {
    const a = (extra: Record<string, unknown>, model = "claude-opus") =>
      JSON.stringify({ type: "assistant", uuid: "a", message: { role: "assistant", model, content: [{ type: "text", text: "API Error" }] }, ...extra });
    expect(convEntriesOf(a({ isApiErrorMessage: true })).map((e) => e.kind)).toEqual(["noise"]);
    expect(convEntriesOf(a({}, "<synthetic>")).map((e) => e.kind)).toEqual(["noise"]);
  });

  it("strips IDE context blocks and joins text blocks", () => {
    expect(cleanUserText("<ide_selection>x</ide_selection><ide_opened_file>f</ide_opened_file>\n<ide_diagnostics>d</ide_diagnostics> 看看")).toBe("看看");
    const e = convEntriesOf(userLine([{ type: "text", text: "一" }, { type: "image", source: {} }, { type: "text", text: "二" }]))[0];
    expect(e).toMatchObject({ kind: "user", text: "一\n\n[image]\n\n二" });
  });

  it.each([
    ["bad json", '{"type":"user",'],
    ["unknown type", JSON.stringify({ type: "file-history-snapshot", uuid: "x" })],
    ["sidechain", JSON.stringify({ type: "user", uuid: "x", isSidechain: true, message: { content: "hi" } })],
    ["missing message", JSON.stringify({ type: "user", uuid: "x" })],
    ["numeric content", JSON.stringify({ type: "assistant", uuid: "x", message: { content: 42 } })],
    ["not an object", "42"],
  ])("%s does not throw", (_n, line) => {
    expect(() => convEntriesOf(line)).not.toThrow();
    expect(convEntriesOf(line).filter((e) => e.kind !== "noise")).toEqual([]);
  });

  it("unknown blocks, tool_use without input and odd timestamps are tolerated", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "x",
      timestamp: 12345,
      message: { content: [{ type: "mystery" }, null, { type: "tool_use", name: "Bash" }, { type: "text", text: "ok" }] },
    });
    const out = convEntriesOf(line);
    expect(out.map(shape)).toEqual([
      { kind: "tool", name: "Bash", effect: "other", stop: false },
      { kind: "assistant", text: "ok", stop: false },
    ]);
    expect(out.every((e) => e.at === null)).toBe(true);
  });

  it("stop only goes on the last entry of the line", () => {
    const line = JSON.stringify({ type: "assistant", uuid: "x", message: { stop_reason: "end_turn", content: [{ type: "text", text: "a" }, { type: "tool_use", name: "Read", input: {} }] } });
    expect(convEntriesOf(line).map((e) => (e as { stop?: boolean }).stop)).toEqual([false, true]);
  });
});

describe("toolEffect", () => {
  const bash = (command: string) => toolEffect("Bash", { command });
  it.each([
    ["Edit", {}, "mutate"],
    ["Write", {}, "mutate"],
    ["MultiEdit", {}, "mutate"],
    ["NotebookEdit", {}, "mutate"],
    ["Read", {}, "read"],
    ["Grep", {}, "read"],
    ["Glob", {}, "read"],
    ["LS", {}, "read"],
    ["WebFetch", {}, "read"],
    ["WebSearch", {}, "read"],
    ["TodoWrite", {}, "read"],
    ["BashOutput", {}, "read"],
    ["ToolSearch", {}, "read"],
    ["AskUserQuestion", {}, "read"],
    ["Task", {}, "other"],
    ["mcp__github__create_pull_request", {}, "mutate"],
    ["mcp__butler-workspace__remember", {}, "mutate"],
    ["mcp__butler-workspace__handoff", {}, "mutate"],
    ["mcp__x__set_epic_plan", {}, "mutate"],
    ["mcp__butler-workspace__recall", {}, "read"],
    ["mcp__butler-workspace__facts", {}, "read"],
    ["mcp__github__get_pull_request", {}, "read"],
    ["mcp__butler-sessions__session_activity", {}, "read"],
    ["mcp__butler-sessions__report", {}, "other"],
  ] as const)("%s → %s", (name, input, effect) => {
    expect(toolEffect(name, input)).toBe(effect);
  });

  it.each([
    ["git commit -m x", "mutate"],
    ["git push origin HEAD", "mutate"],
    ["git rebase origin/main", "mutate"],
    ["git stash push -m a", "mutate"],
    ["gh pr create --fill", "mutate"],
    ["gh pr merge 12 --merge", "mutate"],
    ["sed -i '' s/a/b/ f", "mutate"],
    ["rm -rf out", "mutate"],
    ["cd x && mkdir y", "mutate"],
    ["git log | head > /tmp/x", "mutate"],
    ["echo hi >> notes.md", "mutate"],
    ["git pull --rebase", "mutate"],
    ["git status && git diff", "read"],
    ["git log --oneline | head -5", "read"],
    ["ls -la; pwd", "read"],
    ["cat a | grep b | wc -l", "read"],
    ["echo hi > /dev/null", "read"],
    ["grep -rn x src 2>/dev/null", "read"],
    ["rg foo 2>&1 | head", "read"],
    ["gh pr view 12", "read"],
    ["gh pr checks 12", "read"],
    ["gh run list", "read"],
    ["pnpm test", "other"],
    ["git fetch", "other"],
    ["gh issue view 3", "other"],
    ["", "other"],
  ] as const)("Bash %s → %s", (command, effect) => {
    expect(bash(command)).toBe(effect);
  });

  it("bash without a command string is other", () => {
    expect(toolEffect("Bash", undefined)).toBe("other");
    expect(toolEffect("Bash", { command: 3 })).toBe("other");
  });
});

describe("capText", () => {
  it("leaves short text alone", () => {
    expect(capText("abc")).toBe("abc");
    expect(capText("a".repeat(CONV_TEXT_MAX))).toBe("a".repeat(CONV_TEXT_MAX));
  });

  it("keeps the head and the tail of long text", () => {
    const out = capText("a".repeat(30_000));
    expect(out.length).toBeLessThanOrEqual(CONV_TEXT_MAX + 40);
    expect(out.startsWith("a".repeat(16_000) + "\n")).toBe(true);
    expect(out.endsWith("\n" + "a".repeat(4000))).toBe(true);
    expect(out).toContain("10000 chars omitted");
  });

  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(25_000);
    const out = capText(text);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });
});
