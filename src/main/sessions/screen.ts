import { Terminal } from "@xterm/headless";

/** 攒着没解析的输出超过这么多（字符）就当场同步解析一次，不丢（BTL-277）。回放尾巴（tail）只在解析抛错时用来重建。 */
export const SCREEN_PENDING_LIMIT = 64 * 1024;

type Step = { data: string } | { cols: number; rows: number };

/** xterm 的同步解析入口（公开 API 只有异步的 write）：没有它就退回原来的做法，每块输出马上交给 xterm 异步解析。 */
interface SyncCore {
  writeSync(data: string): void;
}

function syncCore(term: Terminal): SyncCore | null {
  const core = (term as unknown as { _core?: Partial<SyncCore> })._core;
  return core && typeof core.writeSync === "function" ? (core as SyncCore) : null;
}

/**
 * 主进程里每个终端的一份屏幕（BTL-190 第 9 点）：把 pty 的输出喂给一个不显示的 xterm，判断对话框、权限确认、输入框时看
 * 它当前显示的那一屏。只看输出流的最后一段会认错：claude 2.1.322 在词之间用光标跳列而不是空格，界面也是零碎重画的，
 * 已经消失的旧对话框文字会一直留在流的末尾。
 *
 * 懒解析（BTL-277）：输出和改尺寸先按顺序记下来，有人看屏幕（lines、flush）时才一次同步解析完，读到的就是到这一刻为止
 * 全部输出画出来的那一屏，和逐块解析的结果一样。没人看的时候（spinner 一直在转）主进程不解析。
 * 攒着的超过 SCREEN_PENDING_LIMIT 就当场同步解析一次（内存有上限，画出来的屏幕和逐块解析一样）。只有解析抛错时，
 * 才清空 xterm、用 tail()（PtyManager 的回放缓冲）重建。
 */
export class TermScreen {
  private readonly term: Terminal;
  private readonly core: SyncCore | null;
  private disposed = false;
  /** 还没交给 xterm 的输出和改尺寸，按到达顺序。 */
  private steps: Step[] = [];
  private pendingChars = 0;
  /** 解析抛错了：下次看屏幕时按这个尺寸用回放尾巴重建。 */
  private rebuild: { cols: number; rows: number } | null = null;
  private cols: number;
  private rows: number;

  constructor(cols: number, rows: number, private readonly tail?: () => string) {
    this.cols = cols;
    this.rows = rows;
    // writeSync 第一次用时 xterm 会打一条 warn，关掉它的日志。
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true, logLevel: "off" });
    this.core = syncCore(this.term);
  }

  write(data: string): void {
    if (this.disposed || data === "") return;
    if (!this.core) {
      this.term.write(data);
      return;
    }
    if (this.rebuild) return;
    this.steps.push({ data });
    this.pendingChars += data.length;
    // 攒满了就当场解析一次，不能丢：回放尾巴里只有增量更新，不是整屏快照。权限框画好以后别的行又刷过了上限，
    // 用尾巴重建就看不到这个框了（PR #101 review）。解析出错时 catchUp 会标成重建，这里不往 pty 的回调里抛。
    if (this.pendingChars > SCREEN_PENDING_LIMIT) {
      try {
        this.catchUp();
      } catch {
        /* 下次读屏幕时用回放尾巴重建 */
      }
    }
  }

  /**
   * 跟着 pty 改尺寸。排在已经写进来、还没解析的输出后面：那些是按旧尺寸画的，先改尺寸就会画到新的格子上。
   */
  resize(cols: number, rows: number): void {
    if (this.disposed || cols <= 0 || rows <= 0) return;
    this.cols = cols;
    this.rows = rows;
    if (!this.core) {
      // xterm 在解析完前面那一段、开始下一段之前调回调，正好落在流里的这个位置。
      this.term.write("", () => {
        if (!this.disposed) this.term.resize(cols, rows);
      });
      return;
    }
    if (this.rebuild) this.rebuild = { cols, rows };
    else this.steps.push({ cols, rows });
  }

  /** 把攒着的都交给 xterm（同步）。解析抛错时：有回放尾巴就记下下次读时重建（这段输出已经出队，不能当它画上了）。 */
  private catchUp(): void {
    if (!this.core) return;
    try {
      this.drain();
    } catch (e) {
      if (this.tail) {
        this.steps = [];
        this.pendingChars = 0;
        this.rebuild = { cols: this.cols, rows: this.rows };
      }
      throw e;
    }
  }

  private drain(): void {
    if (!this.core) return;
    if (this.rebuild) {
      const { cols, rows } = this.rebuild;
      this.rebuild = null;
      // 上次读可能停在一个转义序列中间（两块 pty 输出切开了 OSC 标题、CSI……），之后那段解析抛错、作废了：
      // reset() 不清解析器的状态，先送一个 CAN 把半截序列作废，不然回放尾巴会被吞进那个序列里。
      this.core.writeSync("\x18");
      this.term.reset();
      if (this.term.cols !== cols || this.term.rows !== rows) this.term.resize(cols, rows);
      const tail = this.tail?.() ?? "";
      if (tail !== "") this.core.writeSync(tail);
      return;
    }
    if (this.steps.length === 0) return;
    const steps = this.steps;
    this.steps = [];
    this.pendingChars = 0;
    let run: string[] = [];
    const flushRun = () => {
      if (run.length === 0) return;
      this.core!.writeSync(run.length === 1 ? run[0] : run.join(""));
      run = [];
    };
    for (const s of steps) {
      if ("data" in s) run.push(s.data);
      else {
        flushRun();
        this.term.resize(s.cols, s.rows);
      }
    }
    flushRun();
  }

  /**
   * 当前这一屏，每行一个字符串（行尾空白去掉）。dropDim：暗色（SGR 2）的字换成空格——claude 空输入框里的灰色提示
   * （Try "…"、建议的下一句）是暗色画的，看输入框是不是真的空着时用（BTL-269）。光标停在提示第一个字上时那个字是反色、
   * 不是暗色：反色的字后面紧跟着暗色的字，也当提示换成空格。按画法认，不按字认：用户自己打的 Try "…" 照样是字。
   */
  lines(o: { dropDim?: boolean } = {}): string[] {
    if (this.disposed) return [];
    this.catchUp();
    const b = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < this.term.rows; i++) {
      const line = b.getLine(b.viewportY + i);
      if (!line) out.push("");
      else if (!o.dropDim) out.push(line.translateToString(true));
      else {
        let text = "";
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          const next = line.getCell(x + cell.getWidth());
          const hint = cell.isDim() || (cell.isInverse() && next !== undefined && next.isDim() && next.getChars() !== "");
          text += hint ? " ".repeat(cell.getWidth()) : cell.getChars() || " ";
        }
        out.push(text.trimEnd());
      }
    }
    return out;
  }

  /** 等已经写进来的输出都解析完（懒解析时马上就完了）。 */
  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.core) {
      this.catchUp();
      return Promise.resolve();
    }
    return new Promise((resolve) => this.term.write("", resolve));
  }

  /** 攒着还没解析的字符数（测试和基准用）。等着重建时是 0：要画的内容在回放尾巴里。 */
  pending(): number {
    return this.pendingChars;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.steps = [];
    this.term.dispose();
  }
}

/** 转小写、去掉所有空白：claude 用空格还是光标跳列画词间距都一样。 */
export function squash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

/**
 * claude 启动时可能先问的问题：信任这个文件夹、启用项目里的 MCP server。这时候粘贴、回车等于替用户选了默认项
 * （2.1.322 的信任对话框默认是「No, exit」，回车 claude 就退出了）。也认一般的选择框（Enter to confirm）。
 */
const DIALOG_MARKERS = ["itrustthisfolder", "doyoutrust", "trustthefiles", "yes,proceed", "no,exit", "newmcpserver", "mcpserversfound", "usethisandallfuture", "entertoconfirm"];

/** 权限确认提示和退出计划模式的提示：session 在等人点。 */
const PERMISSION_MARKERS = ["doyouwanttoproceed", "doyouwanttomakethisedit", "doyouwanttocreate", "wouldyouliketoproceed"];

function isRule(line: string): boolean {
  const t = line.trim();
  if (t.length < 20) return false;
  let n = 0;
  for (const ch of t) if (ch === "─") n++;
  return n >= t.length * 0.9;
}

/** 输入框下面最多几行非空的提示（模式、快捷键、状态栏）。 */
const MAX_FOOTER_LINES = 4;

/**
 * claude 的输入框：屏幕下方两条「────」线，中间第一行以「❯」开头，下面只剩几行提示。返回两条线的行号；没画输入框返回 null。
 * 启动对话框、权限确认、退出计划模式的提示都是顶替输入框画的（一条线在上面，下面是问题和选项，没有第二条线）。
 */
function inputBox(lines: string[]): { top: number; bottom: number } | null {
  const rules: number[] = [];
  lines.forEach((l, i) => {
    if (isRule(l)) rules.push(i);
  });
  if (rules.length < 2) return null;
  const [top, bottom] = rules.slice(-2);
  if (!/^[❯>]/.test(lines[top + 1]?.trim() ?? "")) return null;
  if (lines.slice(bottom + 1).filter((l) => l.trim() !== "").length > MAX_FOOTER_LINES) return null;
  return { top, bottom };
}

/**
 * 只看可能是对话框的那一块：画着输入框时没有对话框（对话的内容里出现「No, exit」「Do you want to proceed?」不算）；
 * 否则看最后一条线以下（对话框画在一条线下面），一条线都没有就看整屏。
 */
function promptArea(lines: string[]): string | null {
  if (inputBox(lines)) return null;
  let last = -1;
  lines.forEach((l, i) => {
    if (isRule(l)) last = i;
  });
  return lines.slice(last + 1).map(squash).join("\n");
}

function hasAny(lines: string[], markers: string[]): boolean {
  const area = promptArea(lines);
  return area !== null && markers.some((m) => area.includes(m));
}

export function dialogOnScreen(lines: string[]): boolean {
  return hasAny(lines, DIALOG_MARKERS);
}

/** 选择框的第一个选项：「❯ 1. Yes」「1. Yes, and auto-accept edits」。 */
const FIRST_OPTION = /^(?:[❯>]\s*)?1[.)]\s*\S/;

/**
 * 权限确认、退出计划模式的提示：问题下面紧跟着编号的选项（claude 一定画「1. Yes」这一行）。
 * 只看提示区（同 promptArea），并且问题那一行之后要有第一个选项：回复里引用了「Would you like to proceed?」、
 * 输入框又没认出来（底部提示多、改了样式）时不算（BTL-269 D：这样会一直挡住往空闲 session 里送消息）。
 */
export function permissionOnScreen(lines: string[]): boolean {
  if (inputBox(lines)) return false;
  let last = -1;
  lines.forEach((l, i) => {
    if (isRule(l)) last = i;
  });
  const area = lines.slice(last + 1);
  const ask = area.findIndex((l) => PERMISSION_MARKERS.some((m) => squash(l).includes(m)));
  return ask >= 0 && area.slice(ask + 1).some((l) => FIRST_OPTION.test(l.trim()));
}

/** 这一轮还在跑：claude 在转圈的那一行写着「esc to interrupt」。 */
export function workingOnScreen(lines: string[]): boolean {
  return lines.some((l) => squash(l).includes("esctointerrupt"));
}

/** 空输入框里 claude 画的提示：Try "…"。 */
/**
 * 输入框画着、里面是空的：true；画着、里面有字：false；没画输入框：null。
 * 要传 dropDim 读出来的那一屏：灰色提示（Try "…"、建议的下一句）按画法去掉。不按字认提示：用户自己打的 Try "…" 是草稿（PR #108 review）。
 */
export function inputBoxEmpty(lines: string[]): boolean | null {
  const text = inputBoxText(lines);
  if (text === null) return null;
  return text === "";
}

/** 输入框上面的那部分屏幕（对话的内容），不含输入框和下面会刷新的状态栏；没画输入框返回 null。 */
export function aboveInputBox(lines: string[]): string[] | null {
  const box = inputBox(lines);
  return box ? lines.slice(0, box.top) : null;
}

/**
 * 输入框里的文字，去掉开头的「❯」。没画输入框（启动对话框、权限确认、全屏菜单）返回 null。
 * 空输入框时 claude 显示的是灰色的提示（Try "…"），这里不区分，调用方自己比对内容。
 */
export function inputBoxText(lines: string[]): string | null {
  const box = inputBox(lines);
  if (!box) return null;
  return lines
    .slice(box.top + 1, box.bottom)
    .map((l) => l.trim())
    .join("\n")
    .replace(/^[❯>]\s?/, "")
    .trim();
}

/** 这次粘贴还留在输入框里没提交：claude 把长粘贴折成「[Pasted text #N …]」，短的直接显示文字。 */
export function pasteInInputBox(lines: string[], text: string): boolean {
  const box = inputBoxText(lines);
  if (box === null) return false;
  const inBox = squash(box);
  if (inBox.includes("[pastedtext#")) return true;
  const head = squash(text).slice(0, 16);
  return head !== "" && inBox.startsWith(head);
}
