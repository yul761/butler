import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { concatList, frameDurations } from "./capture";
import { allTickets, ASKING_TICKET, DEMO, fakeClaudeScript, ORG, PR_NUMBER, PR_TICKET, STARTED, WORKING_TICKET } from "./demo-data";

/** 演示录制（BTL-251）里不用启动 Butler 就能核对的部分：帧时长、演示数据、假 claude 的剧本。 */

describe("frame timing", () => {
  it("shows each frame until the next one, caps long gaps, and keeps holds", () => {
    expect(frameDurations([0, 100, 250, 5000, 5100], new Map([[3, 300]]), 2000)).toEqual([100, 150, 600, 300, 2000]);
    expect(frameDurations([], new Map(), 2000)).toEqual([]);
  });

  it("writes an ffmpeg concat list that repeats the last frame and quotes paths", () => {
    expect(concatList([{ file: "/a/f0.png", ms: 100 }, { file: "/it's/f1.png", ms: 2000 }])).toBe(
      "file '/a/f0.png'\nduration 0.100\nfile '/it'\\''s/f1.png'\nduration 2.000\nfile '/it'\\''s/f1.png'\n",
    );
  });
});

type Rule = { when: string; reply?: string; then?: { after: number; line: string; say?: string }[] };

describe("demo data", () => {
  it("has the same tickets, repos and options shape in both languages", () => {
    const keys = (lang: "en" | "zh") => allTickets(DEMO[lang]).map((t) => [t.key, t.repo]);
    expect(keys("zh")).toEqual(keys("en"));
    for (const d of Object.values(DEMO)) {
      for (const key of STARTED) expect(d.tasks[key], key).toBeTruthy();
      expect(d.options).toHaveLength(2);
      expect(Object.keys(d.captions)).toEqual(Object.keys(DEMO.en.captions));
    }
  });

  it("uses no real company, person or repo names", () => {
    const text = JSON.stringify(DEMO).toLowerCase();
    for (const word of ["acme", "anthropic", "github.com/yul761", "butler-center"]) expect(text).not.toContain(word);
    // github.com/fernleaf 是真实的个人账号（2026-11-21 查过）；fernleaf-notes 当时不存在。
    expect(ORG).not.toBe("fernleaf");
  });

  it("triggers each scripted rule only by the message meant for it", () => {
    for (const d of Object.values(DEMO)) {
      const rules = (fakeClaudeScript(d) as { rules: Rule[] }).rules;
      const match = (line: string) => rules.find((r) => line.includes(r.when));
      expect(match(d.description)?.reply).toBe(d.coordinatorReply);
      expect(match(`mailbox header\n---\n${d.tasks[PR_TICKET]}`)?.reply).toBe(d.doneReply);
      expect(match(d.tasks[WORKING_TICKET])?.then?.length).toBeGreaterThan(0);
      expect(match(d.tasks[ASKING_TICKET])?.then?.at(-1)?.line).toContain("ask_user");
      // Butler 送来的 CI 消息带 PR 号；合并的通知不能被它的规则抢走。
      expect(match(`Butler: CI passed on PR #${PR_NUMBER} (abc). You can move on.`)?.reply).toBe(d.ciReply);
      expect(match(d.mergedNote)?.reply).toBe(d.mergedReply);
      expect(match(`Answered: ${d.options[0]}`)?.then?.length).toBeGreaterThan(0);
    }
  });
});

describe("fake claude with a demo script", () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  afterEach(async () => {
    // 断言失败时子进程还开着：先杀掉、等它退出，Windows 上才删得掉它的 cwd。
    for (const c of children.splice(0)) {
      if (c.exitCode === null && c.signalCode === null) await new Promise((r) => { c.once("exit", r); c.kill(); });
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("shows the banner, replies by rule, and plays scripted steps that are not user messages and trigger no rule", { timeout: 15_000 }, async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "butler-demo-script-")));
    dirs.push(dir);
    const script = join(dir, "script.json");
    writeFileSync(script, JSON.stringify({
      banner: "Demo coordinator",
      rules: [{ when: "plan it", reply: "Planned.", then: [{ after: 50, line: '/fake-tool Read {"file_path":"plan it.ts"}' }] }],
    }));
    const child = spawn(process.execPath, [resolve(__dirname, "../fake-claude/fake-claude.cjs"), "--session-id", "demo-1"], {
      cwd: dir,
      env: { ...process.env, FAKE_CLAUDE_SCRIPT: script, CLAUDE_CONFIG_DIR: join(dir, "claude"), FAKE_CLAUDE_LOG: join(dir, "log") },
    });
    children.push(child);
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    const waitFor = async (text: string) => {
      for (let i = 0; i < 60 && !out.includes(text); i++) await new Promise((r) => setTimeout(r, 50));
      expect(out).toContain(text);
    };
    await waitFor("Demo coordinator");
    expect(out).not.toContain("fake claude ready");
    child.stdin.write("please plan it\n");
    await waitFor("Planned.");
    await waitFor("tool Read");
    // 剧本行里也有「plan it」：它不再触发规则（不然会一直循环）。
    await new Promise((r) => setTimeout(r, 300));
    expect(out.split("Planned.").length - 1).toBe(1);
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
    const transcript = readFileSync(join(dir, "claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"), "demo-1.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l) as { type: string; message?: { content: unknown } });
    const said = transcript.filter((e) => e.type === "user" && typeof e.message?.content === "string").map((e) => e.message!.content);
    expect(said).toEqual(["please plan it"]);
  });
});
