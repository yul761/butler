import { Terminal } from "@xterm/headless";

/** 攒着没解析的输出超过这么多（字符）就不再留：下次有人看屏幕时用回放尾部（tail）重建（BTL-277）。 */
export const SCREEN_PENDING_LIMIT = 256 * 1024;

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
 * 攒着的超过 SCREEN_PENDING_LIMIT 就丢掉，标成要重建：下次看屏幕时清空 xterm，用 tail()（PtyManager 的回放缓冲，
 * 和渲染进程挂终端时重放的是同一份）重画。没有 tail 就照常攒着。
 */
export class TermScreen {
  private readonly term: Terminal;
  private readonly core: SyncCore | null;
  private disposed = false;
  /** 还没交给 xterm 的输出和改尺寸，按到达顺序。 */
  private steps: Step[] = [];
  private pendingChars = 0;
  /** 攒满丢掉了：下次看屏幕时按这个尺寸重建。 */
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
    if (this.tail && this.pendingChars > SCREEN_PENDING_LIMIT) {
      this.steps = [];
      this.pendingChars = 0;
      this.rebuild = { cols: this.cols, rows: this.rows };
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
      // 上次读可能停在一个转义序列中间（两块 pty 输出切开了 OSC 标题、CSI……），后面的输出又整段丢了：
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

  /** 当前这一屏，每行一个字符串（行尾空白去掉）。 */
  lines(): string[] {
    if (this.disposed) return [];
    this.catchUp();
    const b = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < this.term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
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

export function permissionOnScreen(lines: string[]): boolean {
  return hasAny(lines, PERMISSION_MARKERS);
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
