import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { M } from "../strings";
import { tempDir } from "../test-utils";
import {
  extractRefreshTail, readRefreshTail, refreshCommandMatcher, renderRefreshTail, TAIL_CHARS, TAIL_TURNS, toolSummary, writeRefreshTail, type TailTurn,
} from "./refresh-tail";

const FIXTURE = join(__dirname, "__fixtures__", "refresh-tail.jsonl");
const fixtureLines = () => readFileSync(FIXTURE, "utf8").split("\n");
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown) => ({ type: "assistant", message: { role: "assistant", content } });
const said = (t: string) => [{ type: "text", text: t }];
const HANDOFF = user("<command-message>handoff</command-message>\n<command-name>/handoff</command-name>");

afterEach(() => setLang("zh"));

describe("extractRefreshTail", () => {
  it("takes the turns before Butler's /handoff and leaves out the command, its output, sidechains, meta and tool results", () => {
    const r = extractRefreshTail(fixtureLines(), refreshCommandMatcher("ticket"));
    expect(r.commandFound).toBe(true);
    expect(r.turns).toEqual<TailTurn[]>([
      {
        user: "把登录页的按钮改成蓝色",
        items: [
          { text: "我先看一下登录页。" },
          { tool: "Read", summary: "/repo/src/login.tsx" },
          { tool: "Bash", summary: "pnpm test --filter login && echo done" },
          { text: "改好了，测试都过了。" },
        ],
      },
      // 斜杠命令写成「/命令 参数」；它的本地输出不算一轮。
      { user: "/model sonnet", items: [] },
      // system-reminder 去掉。
      { user: "开 PR 吧", items: [{ tool: "mcp__github__create_pull_request", summary: "登录按钮改成蓝色" }, { text: "PR #12 开好了，等 CI。" }] },
    ]);
  });

  it("uses the last handoff request when there were several, and finds the epic request in either language", () => {
    const lines = [
      line(user("第一件事")), line(HANDOFF), line(assistant(said("旧的 handoff"))),
      line(user("第二件事")), line(assistant(said("做完第二件"))),
      line(user(M().refreshEpicHandoff)), line(assistant(said("写好进度了"))),
    ].join("").split("\n");
    const ticket = extractRefreshTail(lines, refreshCommandMatcher("ticket"));
    expect(ticket.turns.map((t) => t.user)).toEqual(["第一件事"]);
    const epic = extractRefreshTail(lines, refreshCommandMatcher("epic"));
    expect(epic.turns.map((t) => t.user)).toEqual(["第一件事", "/handoff", "第二件事"]);
    setLang("en");
    const en = [line(user("one")), line(user(M().refreshEpicHandoff))].join("").split("\n");
    setLang("zh");
    expect(extractRefreshTail(en, refreshCommandMatcher("epic")).turns.map((t) => t.user)).toEqual(["one"]);
  });

  it("returns nothing when the handoff request is not there", () => {
    const lines = [line(user("问题")), line(assistant(said("回答")))].join("").split("\n");
    expect(extractRefreshTail(lines, refreshCommandMatcher("ticket"))).toEqual({ turns: [], commandFound: false });
  });

  it("keeps only the last 8 turns, and starts a turn without a user message when the window cuts into one", () => {
    const lines: string[] = [JSON.stringify(assistant(said("半截的回答")))];
    for (let i = 1; i <= 10; i++) lines.push(JSON.stringify(user(`问题 ${i}`)), JSON.stringify(assistant(said(`回答 ${i}`))));
    lines.push(JSON.stringify(HANDOFF), "{坏行");
    const r = extractRefreshTail(lines, refreshCommandMatcher("ticket"));
    expect(r.turns).toHaveLength(TAIL_TURNS);
    expect(r.turns[0].user).toBe("问题 3");
    expect(r.turns[7]).toEqual({ user: "问题 10", items: [{ text: "回答 10" }] });
    const short = extractRefreshTail([JSON.stringify(assistant(said("半截的回答"))), JSON.stringify(HANDOFF)], refreshCommandMatcher("ticket"));
    expect(short.turns).toEqual([{ user: null, items: [{ text: "半截的回答" }] }]);
  });
});

describe("toolSummary", () => {
  it("picks the telling argument, flattens it to one line and cuts it at 120 characters", () => {
    expect(toolSummary({ command: "git status\n  --short", description: "看状态" })).toBe("git status --short");
    expect(toolSummary({ pattern: "TODO", path: "src" })).toBe("src");
    expect(toolSummary({ a: 1 })).toBe('{"a":1}');
    expect(toolSummary({})).toBe("");
    expect(toolSummary(null)).toBe("null");
    const long = toolSummary({ command: "x".repeat(500) });
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("renderRefreshTail", () => {
  it("writes a header that says what it is, then the turns oldest first with one line per tool call", () => {
    const { turns } = extractRefreshTail(fixtureLines(), refreshCommandMatcher("ticket"));
    const out = renderRefreshTail(turns, "old-id")!;
    expect(out.startsWith(`# ${M().refreshTail.title}\n\n${M().refreshTail.intro("old-id", 3)}\n\n`)).toBe(true);
    expect(out).toContain("## 用户\n\n把登录页的按钮改成蓝色");
    expect(out).toContain("- 工具 Read: /repo/src/login.tsx\n- 工具 Bash: pnpm test --filter login && echo done");
    expect(out.indexOf("把登录页")).toBeLessThan(out.indexOf("开 PR 吧"));
    expect(out).not.toContain("butler-handoff");
    expect(out).not.toContain("子代理");
    expect(out).not.toContain("Set model to sonnet");
    setLang("en");
    const en = renderRefreshTail(turns, "old-id")!;
    expect(en).toContain(`# ${M().refreshTail.title}`);
    expect(en).toContain("- Tool Read: /repo/src/login.tsx");
    expect(en).toContain("## User");
  });

  it("drops the oldest turns to stay within 12000 characters, and cuts the front of a single turn that is too long", () => {
    const big = (n: number): TailTurn => ({ user: `问题 ${n}`, items: [{ text: `${n}`.repeat(5_000) }] });
    const out = renderRefreshTail([big(1), big(2), big(3), big(4)], "x")!;
    const body = out.slice(out.indexOf("## "));
    expect(body.length).toBeLessThanOrEqual(TAIL_CHARS + 1);
    expect(out).not.toContain("问题 1");
    expect(out).not.toContain("问题 2");
    expect(out).toContain("问题 3");
    expect(out).toContain("问题 4");
    expect(out).toContain(M().refreshTail.intro("x", 2));

    const huge = renderRefreshTail([{ user: "开头", items: [{ text: `${"a".repeat(20_000)}结尾` }] }], "x")!;
    expect(huge).toContain(M().refreshTail.cut);
    expect(huge).toContain("结尾");
    expect(huge).not.toContain("开头");
    expect(huge.length - huge.indexOf(M().refreshTail.cut)).toBeLessThanOrEqual(TAIL_CHARS + 1);
  });

  it("returns null when there is nothing to write", () => {
    expect(renderRefreshTail([], "x")).toBeNull();
  });
});

describe("readRefreshTail / writeRefreshTail", () => {
  it("grows the window until it finds the handoff request and enough turns", async () => {
    const file = join(tempDir(), "t.jsonl");
    writeFileSync(file, "");
    for (let i = 1; i <= 10; i++) appendFileSync(file, line(user(`问题 ${i}`)) + line(assistant(said(`回答 ${i}`))));
    // 后面跟着一大段 handoff 之后的输出：第一个 1 MiB 的窗口里看不到 /handoff。
    appendFileSync(file, line(HANDOFF));
    for (let i = 0; i < 150; i++) appendFileSync(file, line(assistant(said("y".repeat(10_000)))));
    const r = await readRefreshTail(file, refreshCommandMatcher("ticket"));
    expect(r.commandFound).toBe(true);
    expect(r.turns.map((t) => t.user)).toEqual(["问题 3", "问题 4", "问题 5", "问题 6", "问题 7", "问题 8", "问题 9", "问题 10"]);
  });

  it("writes the file (creating the directory, replacing an older one) and returns its path", async () => {
    const out = join(tempDir(), "refresh", "s1.md");
    expect(await writeRefreshTail({ transcript: FIXTURE, out, sessionId: "old", kind: "ticket" })).toBe(out);
    expect(readFileSync(out, "utf8")).toContain("开 PR 吧");
    const file = join(tempDir(), "t.jsonl");
    writeFileSync(file, line(user("新的问题")) + line(HANDOFF));
    expect(await writeRefreshTail({ transcript: file, out, sessionId: "old", kind: "ticket" })).toBe(out);
    expect(readFileSync(out, "utf8")).toContain("新的问题");
    expect(readFileSync(out, "utf8")).not.toContain("开 PR 吧");
  });

  it("writes nothing without a transcript or without the handoff request", async () => {
    const out = join(tempDir(), "s1.md");
    expect(await writeRefreshTail({ transcript: null, out, sessionId: "old", kind: "ticket" })).toBeNull();
    expect(await writeRefreshTail({ transcript: FIXTURE, out, sessionId: "old", kind: "epic" })).toBeNull();
    expect(existsSync(out)).toBe(false);
  });
});
