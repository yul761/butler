import { Terminal } from "@xterm/headless";

/**
 * 主进程里每个终端的一份屏幕（BTL-190 第 9 点）：把 pty 的输出喂给一个不显示的 xterm，判断对话框、权限确认、输入框时看
 * 它当前显示的那一屏。只看输出流的最后一段会认错：claude 2.1.322 在词之间用光标跳列而不是空格，界面也是零碎重画的，
 * 已经消失的旧对话框文字会一直留在流的末尾。
 * 解析是异步的（xterm 攒一批再解析），屏幕比输出晚一个事件循环；flush() 等它追上。
 */
export class TermScreen {
  private readonly term: Terminal;
  private disposed = false;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  }

  write(data: string): void {
    if (!this.disposed) this.term.write(data);
  }

  /**
   * 跟着 pty 改尺寸。排在已经写进来、还没解析的输出后面：那些是按旧尺寸画的，先改尺寸就会画到新的格子上。
   * xterm 在解析完前面那一段、开始下一段之前调回调，正好落在流里的这个位置。
   */
  resize(cols: number, rows: number): void {
    if (this.disposed || cols <= 0 || rows <= 0) return;
    this.term.write("", () => {
      if (!this.disposed) this.term.resize(cols, rows);
    });
  }

  /** 当前这一屏，每行一个字符串（行尾空白去掉）。 */
  lines(): string[] {
    if (this.disposed) return [];
    const b = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < this.term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
    return out;
  }

  /** 等已经写进来的输出都解析完。 */
  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.term.write("", resolve));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
