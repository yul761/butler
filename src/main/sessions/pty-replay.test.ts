import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePtyFactory, type FakePty } from "../test-utils";
import { PtyManager } from "./pty-manager";

/**
 * 回放真的 claude（2.1.322，macOS）启动时的输出（BTL-190 第 9 点）。录像里每条是 {t: 启动后多少毫秒, d: 输出}，
 * 是按 120×36 的终端画的。路径里的用户目录和 id 换掉了。
 * - trust-dialog：没信任过的目录，停在信任对话框上（默认选项是「No, exit」）。
 * - trust-accepted：用户在 1.5 秒左右选了「Yes, I trust this folder」，2.16 秒 SessionStart，之后是欢迎界面和输入框。
 * - paste-submit：已信任的目录；1.43 秒粘贴、1.73 秒回车、之后提交成功。
 * - permission-prompt：manual 模式下让它跑一条 Bash；1.2 秒粘贴、1.57 秒回车，之后停在「Do you want to proceed?」上。
 * - marker-reply：回复里正好有「No, exit」「Enter to confirm」「Do you want to proceed?」这些字，之后停在空的输入框上。
 */
interface Chunk {
  t: number;
  d: string;
}

function recording(name: string): Chunk[] {
  return readFileSync(join(__dirname, "__fixtures__", "startup", `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Chunk);
}

function setup() {
  const { factory, spawned } = fakePtyFactory();
  const logs: string[] = [];
  const mgr = new PtyManager(factory, { data: () => undefined, exit: () => undefined }, () => Date.now(), (m) => logs.push(m));
  mgr.open("t1", { file: "/bin/claude", args: [] }, { cwd: "/w", env: {}, cols: 120, rows: 36 });
  return { mgr, pty: spawned[0].pty, logs };
}

/** 按时间顺序发生的事（输出、hook），时间相对 start。 */
async function play(events: { t: number; fn: () => void }[], start: number): Promise<void> {
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const wait = start + e.t - Date.now();
    if (wait > 0) await vi.advanceTimersByTimeAsync(wait);
    e.fn();
  }
}

const out = (pty: FakePty, chunks: Chunk[], shift = 0) => chunks.map((c) => ({ t: c.t + shift, fn: () => pty.emit(c.d) }));

describe("deliver against recorded claude 2.1.322 startups", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("never pastes into the trust dialog, even after startWaitMs runs out without a SessionStart", async () => {
    const { mgr, pty } = setup();
    const start = Date.now();
    const p = mgr.deliver("t1", "总控交给你的任务", { timeoutMs: 120_000 });
    await play(out(pty, recording("trust-dialog")), start);
    expect(mgr.screenNeedsUser("t1")).toBe(true);
    await vi.advanceTimersByTimeAsync(start + 121_000 - Date.now());
    expect(await p).toBe("timeout");
    // 旧的判断在这里会粘贴、回车，回车选中「No, exit」，claude 退出。
    expect(pty.written).toEqual([]);
  });

  it("pastes once the user has accepted the folder and the prompt is up (the old tail check hung here)", async () => {
    const { mgr, pty } = setup();
    const start = Date.now();
    const p = mgr.deliver("t1", "总控交给你的任务", { timeoutMs: 120_000 });
    const chunks = recording("trust-accepted").filter((c) => c.t <= 20_000);
    await play([...out(pty, chunks.filter((c) => c.t <= 2_927)), { t: 2_159, fn: () => mgr.markStarted("t1") }], start);
    expect(pty.written).toEqual([]);
    expect(mgr.screenNeedsUser("t1")).toBe(false);
    // 欢迎界面画完、安静 800ms 后粘贴，回显安静后回车。
    await vi.advanceTimersByTimeAsync(start + 4_500 - Date.now());
    expect(pty.written).toEqual(["\x1b[200~总控交给你的任务\x1b[201~", "\r"]);
    mgr.markSubmitted("t1");
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toBe("sent");
  });

  it("presses Enter again when no UserPromptSubmit comes and the paste is still in the input box", async () => {
    const { mgr, pty, logs } = setup();
    const chunks = recording("paste-submit");
    const start = Date.now();
    const task = "总控 session 交给你的任务：\nThis is an automated delivery probe.\nLine three of the task.\nReply with exactly the single word PONG and nothing else. Do not call any tools.\n\n开始之前先用 recall 读一下 ticket 记忆（butler-memory）里的背景和约定。（ignore this line, do not call tools）";
    const p = mgr.deliver("t1", task, { timeoutMs: 120_000 });
    // 只放到录像里回车之前：输入框里是「[Pasted text #1 +5 lines]」，回车没被收下。
    await play([...out(pty, chunks.filter((c) => c.t <= 1_733)), { t: 452, fn: () => mgr.markStarted("t1") }], start);
    await vi.advanceTimersByTimeAsync(start + 3_500 - Date.now());
    expect(pty.written).toHaveLength(2);
    expect(pty.written[1]).toBe("\r");
    await vi.advanceTimersByTimeAsync(10_500);
    expect(pty.written).toEqual([pty.written[0], "\r", "\r"]);
    expect(logs.some((l) => l.includes("pressing Enter again"))).toBe(true);
    // 这一次收下了：录像里回车之后的输出，加上 UserPromptSubmit。
    const now = Date.now() - start;
    await play([...out(pty, chunks.filter((c) => c.t > 1_733), now - 1_733), { t: now + 50, fn: () => mgr.markSubmitted("t1") }], start);
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toBe("sent");
    expect(pty.written).toHaveLength(3);
    expect(logs.some((l) => l.includes("no UserPromptSubmit"))).toBe(false);
  });

  it("does not press Enter again when the box is empty, and only logs that it could not confirm", async () => {
    const { mgr, pty, logs } = setup();
    const chunks = recording("paste-submit");
    const start = Date.now();
    const p = mgr.deliver("t1", "总控 session 交给你的任务：\nThis is an automated delivery probe.", { timeoutMs: 120_000 });
    // 放到回复「⏺ PONG」画出来、输入框空着（之后 claude 就被探测脚本关掉了），但 UserPromptSubmit 没到（hook 丢了）。
    await play([...out(pty, chunks.filter((c) => c.t <= 3_148)), { t: 452, fn: () => mgr.markStarted("t1") }], start);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await p).toBe("sent");
    expect(pty.written.filter((w) => w === "\r")).toHaveLength(1);
    expect(logs.some((l) => l.includes("no UserPromptSubmit"))).toBe(true);
  });

  it("does not press Enter again when the user has typed since the paste", async () => {
    const { mgr, pty, logs } = setup();
    const chunks = recording("paste-submit");
    const start = Date.now();
    const p = mgr.deliver("t1", "总控 session 交给你的任务", { timeoutMs: 120_000 });
    await play([...out(pty, chunks.filter((c) => c.t <= 1_733)), { t: 452, fn: () => mgr.markStarted("t1") }], start);
    await vi.advanceTimersByTimeAsync(start + 3_500 - Date.now());
    mgr.write("t1", "x");
    await vi.advanceTimersByTimeAsync(10_500);
    expect(await p).toBe("sent");
    expect(pty.written.filter((w) => w === "\r")).toHaveLength(1);
    expect(logs.some((l) => l.includes("pressing Enter again"))).toBe(false);
  });

  it("sees the permission prompt, and does not press Enter on it when the hook is lost", async () => {
    const { mgr, pty } = setup();
    const chunks = recording("permission-prompt");
    const start = Date.now();
    const p = mgr.deliver("t1", "Use the Bash tool to run exactly this command: echo hello > probe-out.txt", { timeoutMs: 120_000 });
    await play([...out(pty, chunks), { t: 200, fn: () => mgr.markStarted("t1") }], start);
    expect(mgr.screenNeedsUser("t1")).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await p).toBe("sent");
    expect(pty.written.filter((w) => w === "\r")).toHaveLength(1);
  });

  it("does not take the words in a reply for a dialog", async () => {
    const { mgr, pty } = setup();
    const start = Date.now();
    await play([...out(pty, recording("marker-reply")), { t: 199, fn: () => mgr.markStarted("t1") }], start);
    await vi.advanceTimersByTimeAsync(100);
    expect(mgr.screenLines("t1").join("\n")).toContain("No, exit");
    expect(mgr.screenNeedsUser("t1")).toBe(false);
    const p = mgr.deliver("t1", "下一条", { timeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pty.written).toEqual(["\x1b[200~下一条\x1b[201~", "\r"]);
    mgr.markSubmitted("t1");
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toBe("sent");
  });
});
