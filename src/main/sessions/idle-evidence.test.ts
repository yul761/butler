import { describe, expect, it } from "vitest";
import { HealedTurns, IDLE_QUIET_MS, IdleEvidence } from "./idle-evidence";
import { SCREEN_PENDING_LIMIT, TermScreen } from "./screen";

const RULE = "─".repeat(80);
const idle = ["⏺ 做完了。", "", RULE, "❯ ", RULE, "  ? for shortcuts"];

function world(lines: string[]) {
  const w = { now: 1_000_000, lines, out: 1_000_000, grew: 1_000_000 as number | null };
  const e = new IdleEvidence({ screen: () => w.lines, lastOutputAt: () => w.out, transcriptGrewAt: () => w.grew, now: () => w.now });
  return { w, e, check: () => e.check("h", "t") };
}

describe("IdleEvidence (BTL-269 B)", () => {
  it("asks boxEmpty when given (dictation, NO_COLOR placeholder: PR #108 review), with the termId and this screen", () => {
    const w = { now: 1_000_000 };
    const asked: [string, string[]][] = [];
    let empty: boolean | null = false;
    const e = new IdleEvidence({
      screen: () => idle,
      lastOutputAt: () => 1,
      transcriptGrewAt: () => null,
      now: () => w.now,
      boxEmpty: (t, l) => {
        asked.push([t, l]);
        return empty;
      },
    });
    w.now += IDLE_QUIET_MS;
    expect(e.check("h", "t")).toEqual({ idle: false, working: false, looksIdle: false });
    expect(asked).toEqual([["t", idle]]);
    empty = true;
    expect(e.check("h", "t").idle).toBe(true);
  });

  it("is idle only after the output and the transcript have both been quiet for 45 s under an empty input box", () => {
    const { w, check } = world(idle);
    expect(check()).toEqual({ idle: false, working: false, looksIdle: true });
    w.now += IDLE_QUIET_MS;
    expect(check()).toEqual({ idle: true, working: false, looksIdle: true });
    w.grew = w.now - 1;
    expect(check().idle).toBe(false);
    w.grew = null; // 没有 transcript：只看屏幕和输出
    expect(check().idle).toBe(true);
  });

  it("time asleep is not quiet: the first check after waking is not idle; quiet counts again from the wake-up", () => {
    const { w, e, check } = world(idle);
    check(); // 睡前看过一次屏幕
    // 睡了 10 分钟（期间没有检查），醒来。
    w.now += 10 * 60_000;
    e.resumed();
    expect(check()).toEqual({ idle: false, working: false, looksIdle: true });
    w.grew = null;
    expect(check().idle).toBe(false);
    w.now += IDLE_QUIET_MS - 1;
    expect(check().idle).toBe(false);
    w.now += 1;
    expect(check().idle).toBe(true);
  });

  it("reads the screen as of now with lazy parsing (BTL-277): output written since the last read counts, even past the pending limit", () => {
    const s = new TermScreen(60, 10);
    const w = { now: 1_000_000, out: 0 };
    const e = new IdleEvidence({ screen: () => s.lines({ dropDim: true }), lastOutputAt: () => w.out, transcriptGrewAt: () => null, now: () => w.now });
    const write = (d: string) => {
      s.write(d);
      w.out = w.now;
    };
    const rule = "─".repeat(50);
    const box = `${rule}\r\n❯ \r\n${rule}\r\n  ? for shortcuts`;
    write(`\x1b[2J\x1b[H⏺ 做完了。\r\n${box}`);
    w.now += IDLE_QUIET_MS;
    expect(e.check("h", "t").idle).toBe(true);
    // 又开始干活：转圈那一行写进来了，还没人解析过。读屏幕时当场解析，看到的是这一刻的屏幕，不是上一次读的。
    write(`\x1b[2J\x1b[H✻ Thinking… (1s · esc to interrupt)\r\n${box}`);
    expect(s.pending()).toBeGreaterThan(0);
    expect(e.check("h", "t")).toEqual({ idle: false, working: true, looksIdle: false });
    // 转圈一直刷，攒过了上限（当场解析过几次），最后一帧又停着：看到的是最后一帧，安静从它画出来起重新算。
    let more = "";
    for (let i = 0; more.length <= SCREEN_PENDING_LIMIT * 2; i++) more += `\x1b[1;1H\x1b[2K✻ Thinking… (${i}s · esc to interrupt)`;
    write(more);
    write(`\x1b[2J\x1b[H⏺ 又做完了。\r\n${box}`);
    expect(e.check("h", "t")).toEqual({ idle: false, working: false, looksIdle: true });
    w.now += IDLE_QUIET_MS;
    expect(e.check("h", "t").idle).toBe(true);
    s.dispose();
  });

  it("a screen that could not be read (parse failed, terminal gone) is never idle", () => {
    const { w, check } = world([]);
    w.now += 10 * 60_000;
    expect(check()).toEqual({ idle: false, working: false, looksIdle: false });
  });

  it("a spinner line is working, not idle", () => {
    const { w, check } = world(["✻ Thinking… (3s · esc to interrupt)", ...idle]);
    w.now += 60_000;
    expect(check()).toEqual({ idle: false, working: true, looksIdle: false });
  });

  it("text in the box, a permission prompt or a startup dialog is never idle", () => {
    for (const lines of [
      [RULE, "❯ 写了一半", RULE],
      [RULE, " Do you want to proceed?", " ❯ 1. Yes", "   2. No"],
      [RULE, " Do you trust the files in this folder?", " ❯ 1. Yes, proceed", "   2. No, exit", " Enter to confirm · Esc to exit"],
    ]) {
      const { w, check } = world(lines);
      w.now += 60_000;
      expect(check().idle).toBe(false);
      expect(check().looksIdle).toBe(false);
    }
  });

  it("the suggestion shown in the box (already blanked as dim) counts as empty; text that reads like the placeholder is the user's (PR #108 review)", () => {
    const { w, check } = world([RULE, "❯ ", RULE]);
    w.now += 60_000;
    expect(check().idle).toBe(true);
    w.lines = [RULE, "❯ Try \"the other approach\"", RULE];
    expect(check()).toEqual({ idle: false, working: false, looksIdle: false });
  });

  it("a status line that keeps the terminal busy: the content above the box unchanged for 45 s still counts as quiet; a change starts over", () => {
    const { w, e, check } = world(idle);
    check();
    w.now += 30_000;
    w.out = w.now;
    w.lines = [...idle.slice(0, -1), "  ctx 40%"];
    expect(check().idle).toBe(false);
    w.now += 16_000;
    w.out = w.now;
    expect(check().idle).toBe(true);
    w.lines = ["⏺ 又说了一句。", ...idle];
    expect(check().idle).toBe(false);
    e.forget("t");
    w.lines = idle;
    expect(check().idle).toBe(false);
  });
});

describe("HealedTurns (BTL-269 B)", () => {
  it("lets needs-you see a healed session as waiting until it moves again", () => {
    const h = new HealedTurns();
    expect(h.kindFor("s", true, "thinking")).toBe("thinking");
    h.add("s");
    expect(h.kindFor("s", true, "thinking")).toBe("waiting");
    expect(h.kindFor("s", true, "thinking")).toBe("waiting");
    expect(h.kindFor("other", true, "thinking")).toBe("thinking");
    // 它又开始干活了：忘掉。
    expect(h.kindFor("s", false, "thinking")).toBe("thinking");
    expect(h.kindFor("s", true, "thinking")).toBe("thinking");
    h.add("s");
    expect(h.kindFor("s", true, "edit")).toBe("edit");
    expect(h.kindFor("s", true, "thinking")).toBe("thinking");
  });
});
