import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import { aboveInputBox, dialogOnScreen, inputBoxEmpty, inputBoxText, pasteInInputBox, permissionOnScreen, SCREEN_PENDING_LIMIT, squash, TermScreen, workingOnScreen } from "./screen";

const RULE = "─".repeat(120);

describe("TermScreen", () => {
  it("shows the current screen, with cursor jumps between words rendered as spaces", async () => {
    const s = new TermScreen(80, 6);
    s.write("\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\r\n\x1b[2G❯\x1b[4GNo,\x1b[8Gexit");
    await s.flush();
    expect(s.lines().slice(0, 2)).toEqual([" Quick safety check: Is this", " ❯ No, exit"]);
    // 清屏重画以后旧的文字就不在了（输出流的末尾里还在）。
    s.write("\x1b[2J\x1b[H> ready");
    await s.flush();
    expect(s.lines()[0]).toBe("> ready");
    expect(s.lines().slice(1).every((l) => l === "")).toBe(true);
    s.dispose();
    expect(s.lines()).toEqual([]);
  });

  it("follows resizes", async () => {
    const s = new TermScreen(20, 4);
    s.resize(40, 8);
    await s.flush();
    expect(s.lines()).toHaveLength(8);
    s.dispose();
  });
});

/** 原来的做法（BTL-277 之前）：每块输出马上交给 xterm 异步解析，改尺寸排在流里，看之前等它追上。拿它当对照。 */
class EagerScreen {
  readonly term: Terminal;
  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  }
  write(d: string) {
    this.term.write(d);
  }
  resize(cols: number, rows: number) {
    this.term.write("", () => this.term.resize(cols, rows));
  }
  async lines(o: { dropDim?: boolean } = {}): Promise<string[]> {
    await new Promise<void>((r) => this.term.write("", r));
    const b = this.term.buffer.active;
    return Array.from({ length: this.term.rows }, (_, i) => {
      const line = b.getLine(b.viewportY + i);
      if (!line) return "";
      if (!o.dropDim) return line.translateToString(true);
      let text = "";
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        text += cell.isDim() ? " ".repeat(cell.getWidth()) : cell.getChars() || " ";
      }
      return text.trimEnd();
    });
  }
}

const SPIN = ["✻", "✶", "✳", "✢", "·"];
/** 像 claude 的界面：同步输出包着的局部重画、光标跳列、颜色、输入框、权限确认、信任对话框、清屏、备用屏幕。 */
function tuiStream(seed: number, frames: number): string[] {
  let rnd = seed;
  const next = (n: number) => {
    rnd = (rnd * 1103515245 + 12345) % 2147483648;
    return rnd % n;
  };
  const rule = (w: number) => `\x1b[38;2;136;136;136m${"─".repeat(w)}\x1b[39m`;
  const out: string[] = [];
  for (let f = 0; f < frames; f++) {
    const k = next(20);
    let frame: string;
    if (k === 0) frame = `\x1b[2J\x1b[H\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck\r\n\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\n\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\n\x1b[2GEnter\x1b[8Gto\x1b[11Gconfirm`;
    else if (k === 1) frame = `\x1b[6A\x1b[J${rule(60)}\r\n Bash command\r\n   echo ${f}\r\n Do\x1b[5Gyou\x1b[9Gwant\x1b[14Gto\x1b[17Gproceed?\r\n ❯ 1. Yes\r\n   2. No`;
    else if (k === 2) frame = `\x1b[?1049h\x1b[H\x1b[2Jfull screen menu ${f}\x1b[?1049l`;
    else {
      const typed = "abcdefghij".slice(0, next(10));
      frame = `\x1b[?2026h\r\x1b[4A\x1b[2K\x1b[38;2;215;119;87m${SPIN[f % SPIN.length]}\x1b[39m\x1b[3GThinking…\x1b[14G(${f}s\x1b[19G·\x1b[21Gesc\x1b[25Gto\x1b[28Ginterrupt)\r\n\x1b[2K${rule(60)}\r\n\x1b[2K❯\x1b[3G${typed}\r\n\x1b[2K${rule(60)}\r\n\x1b[2K  ⏵⏵ auto mode on\x1b[?2026l`;
      if (next(4) === 0) frame = `⏺ line ${f} of the answer, 中文也有\r\n` + frame;
    }
    out.push(frame);
  }
  return out;
}

/** 按随机位置切块（会切在控制序列和多字节字符中间，pty 也会这样）。 */
function chop(s: string, seed: number): string[] {
  let rnd = seed;
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    rnd = (rnd * 1103515245 + 12345) % 2147483648;
    const n = 1 + (rnd % 40);
    out.push(s.slice(i, i + n));
    i += n;
  }
  return out;
}

describe("TermScreen lazy parsing (BTL-277)", () => {
  it("parses nothing until someone looks at the screen", () => {
    const s = new TermScreen(40, 4);
    s.write("hello");
    s.write(" world");
    expect(s.pending()).toBe(11);
    expect(s.lines()[0]).toBe("hello world");
    expect(s.pending()).toBe(0);
    s.dispose();
  });

  it("reads exactly what parsing every chunk as it came would show, at any point, across resizes", async () => {
    for (let seed = 1; seed <= 6; seed++) {
      const lazy = new TermScreen(60, 12);
      const eager = new EagerScreen(60, 12);
      const chunks = chop(tuiStream(seed, 120).join(""), seed);
      let rnd = seed * 31;
      for (const c of chunks) {
        lazy.write(c);
        eager.write(c);
        rnd = (rnd * 1103515245 + 12345) % 2147483648;
        if (rnd % 50 === 0) {
          const cols = 40 + (rnd % 40), rows = 8 + (rnd % 10);
          lazy.resize(cols, rows);
          eager.resize(cols, rows);
        }
        if (rnd % 7 === 0) {
          const want = await eager.lines();
          const got = lazy.lines();
          expect(got).toEqual(want);
          expect(dialogOnScreen(got)).toBe(dialogOnScreen(want));
          expect(permissionOnScreen(got)).toBe(permissionOnScreen(want));
          expect(inputBoxText(got)).toBe(inputBoxText(want));
        }
      }
      expect(lazy.lines()).toEqual(await eager.lines());
      lazy.dispose();
    }
  });

  it("BTL-269 reads (dim dropped, empty box, content above the box, spinner) match parsing every chunk, at any point", async () => {
    const rule = `\x1b[38;2;136;136;136m${"─".repeat(50)}\x1b[39m`;
    for (let seed = 1; seed <= 4; seed++) {
      const lazy = new TermScreen(60, 12);
      const eager = new EagerScreen(60, 12);
      // claude 的几种样子交替出现：转圈在干活、停着的空输入框（暗色的建议下一句）、输入框里有用户的字。
      const frames = tuiStream(seed, 60).map((f, i) =>
        i % 3 === 0 ? `\x1b[2J\x1b[H⏺ done ${i}\r\n${rule}\r\n❯ \x1b[2mrun the tests\x1b[22m\r\n${rule}\r\n  ctx ${i}%`
          : i % 3 === 1 ? `\x1b[2J\x1b[H⏺ done ${i}\r\n${rule}\r\n❯ half typed\r\n${rule}` : f);
      let rnd = seed * 17;
      for (const c of chop(frames.join(""), seed)) {
        lazy.write(c);
        eager.write(c);
        rnd = (rnd * 1103515245 + 12345) % 2147483648;
        if (rnd % 9 !== 0) continue;
        const want = await eager.lines({ dropDim: true });
        const got = lazy.lines({ dropDim: true });
        expect(got).toEqual(want);
        expect(inputBoxEmpty(got)).toBe(inputBoxEmpty(want));
        expect(aboveInputBox(got)).toEqual(aboveInputBox(want));
        expect(workingOnScreen(got)).toBe(workingOnScreen(want));
        expect(lazy.lines()).toEqual(await eager.lines());
      }
      lazy.dispose();
    }
  });

  it("parses on the spot past the limit instead of dropping: a prompt drawn earlier stays on screen (PR #101 review)", () => {
    const s = new TermScreen(60, 10, () => "\x1b[2J\x1b[Hfrom tail");
    s.write(`\x1b[2J\x1b[H${"─".repeat(50)}\r\n Bash command\r\n Do you want to proceed?\r\n ❯ 1. Yes`);
    // 之后只重画最后一行，超过排队上限。
    let more = "";
    for (let i = 0; more.length <= SCREEN_PENDING_LIMIT + 1024; i++) more += `\x1b[10;1H\x1b[2K✻ Thinking ${i}`;
    s.write(more);
    expect(s.pending()).toBeLessThanOrEqual(SCREEN_PENDING_LIMIT);
    const lines = s.lines();
    expect(lines[0]).toBe("─".repeat(50));
    expect(permissionOnScreen(lines)).toBe(true);
    expect(lines.join("\n")).not.toContain("from tail");
    s.dispose();
  });

  it("a parse that throws leaves the screen to be rebuilt from the tail on the next read", () => {
    const s = new TermScreen(20, 2, () => "\x1b[2J\x1b[Hfrom tail");
    s.write("first");
    const core = (s as unknown as { core: { writeSync(d: string): void } }).core;
    const real = core.writeSync.bind(core);
    let fail = true;
    core.writeSync = (d: string) => {
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
      real(d);
    };
    expect(() => s.lines()).toThrow("boom");
    expect(s.lines()[0]).toBe("from tail");
    s.dispose();
  });

  it("parses past the limit without a tail too", () => {
    const s = new TermScreen(20, 2);
    s.write("x".repeat(SCREEN_PENDING_LIMIT + 10));
    expect(s.pending()).toBe(0);
    s.dispose();
  });
});

describe("dialogOnScreen / permissionOnScreen", () => {
  it("a permission prompt under one rule is not taken for an input box with a tall footer, even when an earlier rule is followed by a quote (BTL-279 review)", () => {
    const lines = [
      "⏺ Notes:", RULE, "> quoted from the spec", "⏺ Running the migration", RULE,
      " Bash command", "   pnpm db:migrate", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again", "   3. No, and tell Claude what to do differently (esc)",
    ];
    expect(permissionOnScreen(lines)).toBe(true);
    expect(inputBoxEmpty(lines)).toBeNull();
    // 真的输入框下面六行状态栏照样认得出。
    const box = ["⏺ done", RULE, "> ", RULE, "  model: opus · ctx 41%", "  branch: main · +3 −1", "  cost: $0.42 today", "  PR #12 · CI green", "  ⏵⏵ accept edits on", "  ? for shortcuts"];
    expect(inputBoxEmpty(box)).toBe(true);
    expect(permissionOnScreen(box)).toBe(false);
    // 状态栏以「1.2k」「1)」开头（像编号、其实不是选项），真输入框照样认得出（BTL-279 second review）。
    for (const bar of ["  1.2k tokens · $0.03 · ctx 41%", "  1) feature/BTL-279 ↑2", "1. main · clean"]) {
      expect(inputBoxEmpty(["⏺ done", RULE, "> ", RULE, bar])).toBe(true);
      expect(inputBoxEmpty(["⏺ done", RULE, "> ", RULE, bar, "  ⏵⏵ accept edits on"])).toBe(true);
    }
    // 成套的编号选项（1. 下面有 2.）仍然不算输入框。
    expect(inputBoxEmpty(["⏺ done", RULE, "> quoted", RULE, " ❯ 1. Yes", "   2. No"])).toBeNull();
  });

  it("finds the 2.1.322 trust dialog and the older one, regardless of spacing", () => {
    expect(dialogOnScreen([" Quick safety check: Is this a project you created or one you trust?", " ❯ No, exit", "   Yes, I trust this folder", " Enter to confirm · Esc to cancel"])).toBe(true);
    expect(dialogOnScreen(["Quicksafetycheck:", "❯no,exit"])).toBe(true);
    expect(dialogOnScreen([" Do you trust the files in this folder?", " ❯ 1. Yes, proceed"])).toBe(true);
    expect(dialogOnScreen(["New MCP server found in .mcp.json: slowprobe"])).toBe(true);
    expect(dialogOnScreen([RULE, '❯ Try "fix lint errors"', RULE])).toBe(false);
  });

  it("ignores the markers in the conversation while the input box is drawn", () => {
    const talk = ["⏺ 信任对话框的默认项是 No, exit，Enter to confirm。", "  Do you want to proceed? Would you like to proceed?", ""];
    expect(dialogOnScreen([...talk, RULE, "❯ ", RULE, "  ⏵⏵ auto mode on"])).toBe(false);
    expect(permissionOnScreen([...talk, RULE, "❯ ", RULE, "  ⏵⏵ auto mode on"])).toBe(false);
    // 对话框顶替了输入框：只看最后一条线以下，上面对话里的字不算。
    expect(permissionOnScreen(["⏺ Do you want to proceed?", RULE, " Bash command", " echo hi"])).toBe(false);
    expect(permissionOnScreen(["⏺ 早先的话", RULE, " Bash command", " Do you want to proceed?", " ❯ 1. Yes"])).toBe(true);
  });

  it("finds permission prompts only", () => {
    expect(permissionOnScreen(["Bash command", "Do you want to proceed?", " ❯ 1. Yes"])).toBe(true);
    expect(permissionOnScreen(["Do  you want to make this edit to a.ts?", " ❯ 1. Yes", "   2. Yes, allow all edits", "   3. No"])).toBe(true);
    expect(permissionOnScreen([RULE, " Ready to code?", " Would you like to proceed?", "", " ❯ 1. Yes, and auto-accept edits", "   2. No, keep planning"])).toBe(true);
    expect(permissionOnScreen(["Do you want to create foo.ts?", "> 1) Yes"])).toBe(true);
    expect(permissionOnScreen(["building..."])).toBe(false);
    expect(permissionOnScreen([" Do you trust the files in this folder?"])).toBe(false);
  });
});

describe("permissionOnScreen (BTL-269 D: a quoted question is not a prompt)", () => {
  it("needs a numbered first option after the question", () => {
    // 回复里引用了这句话、输入框没认出来（底部提示多了一行）：没有选项，不算确认框。
    const reply = ["⏺ 计划写好了。Would you like to proceed? 你看一下再说。", "", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on", ...Array.from({ length: 10 }, (_, i) => `  status ${i}`)];
    expect(inputBoxText(reply)).toBeNull();
    expect(permissionOnScreen(reply)).toBe(false);
    expect(permissionOnScreen(["Would you like to proceed?"])).toBe(false);
    expect(permissionOnScreen(["Do you want to proceed?", "  1 file changed"])).toBe(false);
    // 选项在问题上面（上一段对话里的列表）也不算。
    expect(permissionOnScreen(["1. first step", "Do you want to proceed?"])).toBe(false);
  });
});

describe("workingOnScreen / inputBoxEmpty", () => {
  it("sees the spinner line of a running turn", () => {
    expect(workingOnScreen(["✻ Thinking… (12s · esc to interrupt)", RULE, "❯ ", RULE])).toBe(true);
    expect(workingOnScreen(["⏺ done", RULE, "❯ ", RULE, "  ? for shortcuts"])).toBe(false);
  });

  it("only the spinner line or the footer counts, not 'esc to interrupt' quoted in the conversation above (BTL-279)", () => {
    // 对话里贴过日志、在改 Shipherd 自己的代码：上面的内容里有这几个字不算在跑。
    const quoted = ["⏺ The guard checks for `esc to interrupt` on screen:", "  return lines.some((l) => squash(l).includes(\"esctointerrupt\"));", "⏺ done"];
    expect(workingOnScreen([...quoted, RULE, "❯ ", RULE, "  ? for shortcuts"])).toBe(false);
    // 转圈那一行（✻ ✶ ✳ ✢ · 开头）和新版画在输入框下面的提示照样算。
    expect(workingOnScreen([...quoted, "✶ Hustling… (3s · ↑ 1.2k tokens · esc to interrupt)", RULE, "❯ ", RULE])).toBe(true);
    expect(workingOnScreen([...quoted, RULE, "❯ ", RULE, "  · esc to interrupt · ← for agents"])).toBe(true);
    // 没有输入框线（启动中、整屏重画）：照旧看整屏。
    expect(workingOnScreen(["Working on it (esc to interrupt)"])).toBe(true);
    // 窄窗口里转圈那一行折行（BTL-279 review）：「esc to interrupt」落在下一行，或者被拆成两半，照样算在干活。
    expect(workingOnScreen([...quoted, "✶ Hustling… (3s · ↑ 1.2k tokens", " · esc to interrupt)", RULE, "❯ ", RULE])).toBe(true);
    expect(workingOnScreen([...quoted, "✶ Hustling… (3s · ↑ 1.2k tokens · esc to", "interrupt)", RULE, "❯ ", RULE])).toBe(true);
    // 转圈的行已经结束（下面紧跟着线）：上面对话里另起一行引用的不算。
    expect(workingOnScreen(["✻ Worked for 3s", RULE, "esc to interrupt", RULE, "❯ ", RULE])).toBe(false);
    // 对话里 * 开头的列表项，下一行引用了这几个字：不是折行的转圈行，不算。
    expect(workingOnScreen(["* The guard looks for", "  `esc to interrupt` on screen", RULE, "❯ ", RULE])).toBe(false);
  });

  it("finds the box under a tall footer: a multi-line statusline plus mode and notices (BTL-279)", () => {
    const footer = ["  ~/code/app  main*  ctx 41%", "  Opus 5.5 · $1.23 today", "  ⏵⏵ accept edits on (shift+tab to cycle)", "  1 background task", "  ✓ Update installed · Restart to apply", "  ? for shortcuts"];
    expect(inputBoxEmpty(["⏺ done", RULE, "❯ ", RULE, ...footer])).toBe(true);
    expect(aboveInputBox(["⏺ done", RULE, "❯ ", RULE, ...footer])).toEqual(["⏺ done"]);
    // 太高的就不当作输入框（对话框下面的长列表）。
    expect(inputBoxEmpty(["⏺ done", RULE, "❯ ", RULE, ...Array.from({ length: 20 }, (_, i) => `  line ${i}`)])).toBeNull();
  });

  it("an empty box is empty; text is not, even text that reads like the placeholder; no box is null", () => {
    expect(inputBoxEmpty([RULE, '❯ Try "the other approach"', RULE])).toBe(false);
    expect(inputBoxEmpty(["⏺ done", RULE, "❯ ", RULE])).toBe(true);
    expect(inputBoxEmpty([RULE, "❯ 帮我看看", RULE])).toBe(false);
    expect(inputBoxEmpty([RULE, " ❯ 1. Yes", " 2. No"])).toBeNull();
  });

  it("dropDim removes the grey suggestion so the box reads empty", async () => {
    const s = new TermScreen(40, 4);
    s.write(`${"─".repeat(40)}\r\n❯ \x1b[2mrun the tests\x1b[22m\r\n${"─".repeat(40)}`);
    await s.flush();
    expect(inputBoxEmpty(s.lines())).toBe(false);
    expect(inputBoxEmpty(s.lines({ dropDim: true }))).toBe(true);
    s.write("\x1b[2;3Hreal");
    await s.flush();
    expect(inputBoxEmpty(s.lines({ dropDim: true }))).toBe(false);
    s.dispose();
  });

  it("the placeholder with the cursor on its first letter (inverse T, dim rest) is empty; the user's own Try \"…\" is not (PR #108 review)", () => {
    const rule = "─".repeat(40);
    const s = new TermScreen(40, 4);
    s.write(`${rule}\r\n❯ \x1b[7mT\x1b[27m\x1b[2mry "fix lint errors"\x1b[22m\r\n${rule}`);
    expect(inputBoxEmpty(s.lines({ dropDim: true }))).toBe(true);
    // 用户打的同样的字（光标在行尾，反色的空格）：是字，不是提示。
    s.write(`\x1b[2J\x1b[H${rule}\r\n❯ Try "the other approach"\x1b[7m \x1b[27m\r\n${rule}`);
    expect(inputBoxText(s.lines({ dropDim: true }))).toBe('Try "the other approach"');
    expect(inputBoxEmpty(s.lines({ dropDim: true }))).toBe(false);
    // 光标停在用户的字中间（反色的字后面是普通的字）：照样是字。
    s.write(`\x1b[2J\x1b[H${rule}\r\n❯ ab\x1b[7mc\x1b[27md\r\n${rule}`);
    expect(inputBoxText(s.lines({ dropDim: true }))).toBe("abcd");
    s.dispose();
  });
});

describe("inputBoxText / pasteInInputBox", () => {
  it("reads what is between the last two rules", () => {
    expect(inputBoxText(["❯ 早先的消息", RULE, "❯ [Pasted text #1 +5 lines]", RULE, "  paste again to expand"])).toBe("[Pasted text #1 +5 lines]");
    expect(inputBoxText(["❯ 早先的消息", RULE, "❯ ", RULE])).toBe("");
    expect(inputBoxText([RULE, " ❯ No, exit"])).toBeNull();
    // 两条线之间不是「❯」开头、或者第二条线下面还有一大段：不是输入框。
    expect(inputBoxText([RULE, "| a | b |", RULE])).toBeNull();
    expect(inputBoxText([RULE, "❯ x", RULE, ...Array.from({ length: 11 }, (_, i) => `${i}`)])).toBeNull();
  });

  it("tells whether this paste is still sitting in the box", () => {
    expect(pasteInInputBox([RULE, "❯ [Pasted text #1 +5 lines]", RULE], "任意")).toBe(true);
    expect(pasteInInputBox([RULE, "❯ 修一下 lint", "  然后 push", RULE], "修一下 lint\n然后 push")).toBe(true);
    // 提交以后：任务出现在上面的对话里，输入框空了。
    expect(pasteInInputBox(["❯ 修一下 lint", "  然后 push", RULE, "❯ ", RULE], "修一下 lint\n然后 push")).toBe(false);
    expect(pasteInInputBox([RULE, '❯ Try "fix lint errors"', RULE], "修一下 lint")).toBe(false);
    expect(pasteInInputBox([" ❯ No, exit"], "修一下 lint")).toBe(false);
  });

  it("squash lowercases and drops all whitespace", () => {
    expect(squash(" Yes,  I\ttrust\nthis ")).toBe("yes,itrustthis");
  });

  it("dictation keeps dim text only when the cursor follows it; the placeholder, focused or not, is still dropped (PR #108 review)", () => {
    const rule = "─".repeat(40);
    const s = new TermScreen(40, 4);
    s.write(`${rule}\r\n❯ \x1b[2mplease fix\x1b[22m\x1b[7m \x1b[27m\r\n${rule}`);
    expect(inputBoxEmpty(s.lines({ dropDim: true }))).toBe(true);
    expect(inputBoxText(s.lines({ dropDim: "dictation" }))).toBe("please fix");
    // 听写的词之间光标跳过去（没画的空格子）：整段还是听写的字。
    s.write(`\x1b[2J\x1b[H${rule}\r\n❯ \x1b[2mplease\x1b[22m\x1b[1C\x1b[2mfix\x1b[22m\x1b[7m \x1b[27m\r\n${rule}`);
    expect(inputBoxText(s.lines({ dropDim: "dictation" }))).toBe("please fix");
    // 用户打的字后面接着听写：两段都读出来。
    s.write(`\x1b[2J\x1b[H${rule}\r\n❯ fix \x1b[2mthe title\x1b[22m\x1b[7m \x1b[27m\r\n${rule}`);
    expect(inputBoxText(s.lines({ dropDim: "dictation" }))).toBe("fix the title");
    // 有焦点时的提示：光标领着，词之间光标跳过去（没画的空格子）：整段还是提示。
    s.write(`\x1b[2J\x1b[H${rule}\r\n❯ \x1b[7mT\x1b[27m\x1b[2mry\x1b[22m\x1b[2C\x1b[2m"fix lint"\x1b[22m\r\n${rule}`);
    expect(inputBoxEmpty(s.lines({ dropDim: "dictation" }))).toBe(true);
    // 失焦时的提示（claude 2.1.332：整段暗色、没有光标）：也是提示（PR #108 第三轮 review）。
    s.write(`\x1b[2J\x1b[H${rule}\r\n❯ \x1b[2mTry\x1b[22m\x1b[1C\x1b[2m"fix lint"\x1b[22m\r\n${rule}`);
    expect(inputBoxEmpty(s.lines({ dropDim: "dictation" }))).toBe(true);
    // 暗色字后面是用户的字、不是光标：暗色字不算。
    s.write(`\x1b[2J\x1b[H${rule}\r\n❯ \x1b[2mhint\x1b[22m x\r\n${rule}`);
    expect(inputBoxText(s.lines({ dropDim: "dictation" }))).toBe("x");
    s.dispose();
  });
});

describe("TermScreen.lines cache (PR #108 review suggestion 5)", () => {
  /** 一格一格读的入口（xterm 的 IBufferLine.getCell）上的计数。 */
  function spyCells(s: TermScreen) {
    const line = (s as unknown as { term: Terminal }).term.buffer.active.getLine(0)!;
    return vi.spyOn(Object.getPrototypeOf(line) as { getCell: (...a: unknown[]) => unknown }, "getCell");
  }

  it("an unchanged screen is not read cell by cell again; new output, resize and the dropDim mode each read afresh", () => {
    const s = new TermScreen(40, 4);
    s.write(`${RULE.slice(0, 40)}\r\n❯ \x1b[2mhint\x1b[22m\r\n${RULE.slice(0, 40)}`);
    const spy = spyCells(s);
    try {
      const first = s.lines({ dropDim: true });
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      spy.mockClear();
      expect(s.lines({ dropDim: true })).toEqual(first);
      expect(spy).not.toHaveBeenCalled();
      // 别的模式不拿这份缓存。
      expect(s.lines({ dropDim: "dictation" })[1]).toBe("❯");
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      // 调用方改了返回的数组，缓存不跟着变。
      first[1] = "changed";
      expect(s.lines({ dropDim: true })[1]).toBe("❯");
      // 新的输出（还在排队、没解析）：读到新的内容。
      spy.mockClear();
      s.write("\x1b[2;3Hreal");
      expect(s.lines({ dropDim: true })[1]).toBe("❯ real");
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      // 改尺寸：按新尺寸读。
      s.resize(40, 6);
      expect(s.lines({ dropDim: true })).toHaveLength(6);
      expect(s.lines()).toHaveLength(6);
    } finally {
      spy.mockRestore();
      s.dispose();
    }
  });

  it("each cell read reuses the same cell objects", () => {
    const s = new TermScreen(40, 2);
    s.write("abc\x1b[7md\x1b[27m\x1b[2mef\x1b[22m");
    const spy = spyCells(s);
    try {
      expect(s.lines({ dropDim: true })[0]).toBe("abc");
      const targets = new Set(spy.mock.calls.map((c) => c[1]));
      expect(targets.has(undefined)).toBe(false);
      expect(targets.size).toBe(1);
    } finally {
      spy.mockRestore();
      s.dispose();
    }
  });

  it("a rebuild after a parse error is read afresh, not from the cache", () => {
    const s = new TermScreen(20, 2, () => "\x1b[2J\x1b[Hfrom tail");
    s.write("first");
    expect(s.lines()[0]).toBe("first");
    const core = (s as unknown as { core: { writeSync(d: string): void } }).core;
    const real = core.writeSync.bind(core);
    let fail = true;
    core.writeSync = (d: string) => {
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
      real(d);
    };
    s.write("second");
    expect(() => s.lines()).toThrow("boom");
    expect(s.lines()[0]).toBe("from tail");
    s.dispose();
  });
});
