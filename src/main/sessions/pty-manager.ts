import type { SpawnSpec } from "../claude/spawn";

export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; cols: number; rows: number },
) => PtyProcess;

export interface PtyEvents {
  data(termId: string, data: string): void;
  exit(termId: string, exitCode: number): void;
}

/** 每个终端保留的回放缓冲，切回 ticket 页面时重放。 */
export const BUFFER_LIMIT = 256 * 1024;

interface Term {
  proc: PtyProcess;
  buffer: string;
  /** 已经截出缓冲的那部分输出留下的终端模式，回放时补在缓冲前面（见 modePrefix）。 */
  cutModes: Map<number, boolean>;
  lastOutputAt: number;
  exited: boolean;
  /** claude 的 SessionStart hook 到了（信任文件夹之类的启动对话框已经过去）。 */
  started: boolean;
  /** 用户上一次往这个终端写东西（渲染进程的按键，经 write）的时间；0 = 还没有。deliver、prefill 自己的写入不算。 */
  lastUserInputAt: number;
  /** 输入框里还没发出去的可见字符数（见 nextDraftLength）；0 = 没有草稿。 */
  draftLen: number;
  /** 终端打开（新开或恢复）的时间（R36：刚打开的终端不自动换新）。 */
  openedAt: number;
}

/** 终端输出去掉 ANSI 控制序列后的纯文本（只用来认对话框）。 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
}

/**
 * 输入框草稿长度的下一个值：current 是之前的长度，data 是这次写进终端的字节。
 * 鼠标上报、焦点事件、方向键等 ESC 序列不算；bracketed paste 的标记去掉但内容计入；
 * 回车（\\r）、Ctrl+C、Ctrl+U 清零，单独的 \\n 算换行加 1，退格减 1，其他控制字符忽略，可见字符加 1。
 */
export function nextDraftLength(current: number, data: string): number {
  let n = current;
  // bracketed paste 里的内容整段计入（换行也算一个，粘贴的多行文本留在输入框里）；其余部分逐字符处理。
  // eslint-disable-next-line no-control-regex
  const parts = data.split(/\x1b\[200~([\s\S]*?)(?:\x1b\[201~|$)/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      n += [...parts[i]].length;
      continue;
    }
    // CSI 参数含 <（SGR 鼠标上报），SS3 带一个字符（\x1bOA），所以不直接用 stripAnsi；其余形状同它。
    // eslint-disable-next-line no-control-regex
    const text = parts[i].replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bO.|\x1b[@-Z\\-_]/g, "");
    for (const ch of text) {
      if (ch === "\r" || ch === "\x03" || ch === "\x15") n = 0;
      else if (ch === "\x7f" || ch === "\b") n = Math.max(0, n - 1);
      else if (ch === "\n") n += 1; // Ctrl+J：在输入框里换行，不提交
      else if (ch < " ") continue;
      else n += 1;
    }
  }
  return n;
}

/**
 * claude 启动时可能先问的问题：信任这个文件夹、启用项目里的 MCP server。这时候粘贴、回车等于替用户选了默认的“是”。
 * 屏幕最后一段里出现这些字样就当对话框还在。
 */
const DIALOG_MARKERS = ["do you trust", "trust the files", "trust this folder", "yes, proceed", "yes, i trust", "new mcp server", "mcp servers found", "use this and all future"];
const DIALOG_TAIL = 1000;

export function dialogShowing(buffer: string): boolean {
  const tail = stripAnsi(buffer.slice(-DIALOG_TAIL * 4)).slice(-DIALOG_TAIL).toLowerCase();
  return DIALOG_MARKERS.some((m) => tail.includes(m));
}

/** 权限确认提示（“Do you want to proceed?” 等）和退出计划模式的提示：session 在等人点，不算卡住。 */
const PERMISSION_MARKERS = ["do you want to proceed", "do you want to make this edit", "do you want to create", "would you like to proceed"];

export function permissionPromptShowing(buffer: string): boolean {
  const tail = stripAnsi(buffer.slice(-DIALOG_TAIL * 4)).slice(-DIALOG_TAIL).toLowerCase();
  return PERMISSION_MARKERS.some((m) => tail.includes(m));
}

export interface DeliverOptions {
  /** 输出安静多久算输入框就绪。 */
  idleMs?: number;
  /** 等 SessionStart 最多多久（没装 hook 时之后只靠安静 + 对话框检查）。 */
  startWaitMs?: number;
  /** 总共最多等多久（包括用户自己处理启动对话框的时间）。 */
  timeoutMs?: number;
  /** 粘贴之后，回显安静多久再回车；最多等 settleCapMs。 */
  settleMs?: number;
  settleCapMs?: number;
  /**
   * 把换行压成空格，作为一行发送。Windows 的 ConPTY 不一定把粘贴标记交给程序，粘贴里的换行就成了回车，
   * 任务会被拆成好几条消息提交（CI 上实际出现过）。
   */
  singleLine?: boolean;
  /**
   * 粘贴前的最后一道复查（I2）：输入框就绪、马上要粘贴时调用（同步，中间不会插进别的事）。返回 false 就什么都不写，
   * deliver 返回 blocked。调用期间这一次 deliver 自己不算「在递」（autoInputInFlight），别的 deliver 还算。
   */
  recheck?: () => boolean;
}

/** blocked：recheck 在粘贴前说不行（用户刚输入过、别的自动输入在递、session 又忙了……），什么都没写。 */
export type DeliverResult = "sent" | "exited" | "timeout" | "blocked";

/** 最多保留多少个已退出终端的记录（用于快速失败的 claude 也能看到退出码）。 */
export const EXITED_LIMIT = 20;

/**
 * 回放缓冲超过上限时从头截掉。直接按字符截可能切在一个控制序列中间（回放时第一行乱码）：
 * 截完再丢到第一个换行之后（只在开头 4 KB 里找，找不到就原样保留）。
 */
export function trimBuffer(s: string): string {
  if (s.length <= BUFFER_LIMIT) return s;
  const cut = s.slice(-BUFFER_LIMIT);
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl < 4096 ? cut.slice(nl + 1) : cut;
}

/**
 * DEC 私有模式（ESC [ ? n h / l）：备用屏幕、鼠标上报、bracketed paste、光标显示等。claude 的全屏界面只在启动和改尺寸时
 * 发这些序列；回放缓冲截掉开头后它们就没了，切回页面新建的终端不上报鼠标，滚轮到不了 claude（要改一下尺寸才恢复）。
 * 截掉的部分按顺序记下每个模式最后的开关，回放时先补上。
 */
export function recordModes(modes: Map<number, boolean>, text: string): void {
  // eslint-disable-next-line no-control-regex
  for (const m of text.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    for (const n of m[1].split(";")) {
      if (n !== "") modes.set(Number(n), m[2] === "h");
    }
  }
}

export function modePrefix(modes: Map<number, boolean>): string {
  return [...modes].map(([n, on]) => `\x1b[?${n}${on ? "h" : "l"}`).join("");
}

export interface PtySnapshot {
  data: string;
  exitCode: number | null;
}

function replay(t: Term): string {
  return modePrefix(t.cutModes) + t.buffer;
}

export class PtyManager {
  private readonly terms = new Map<string, Term>();
  /** 已退出终端的回放内容（模式已经补在前面）。 */
  private readonly exited = new Map<string, { buffer: string; exitCode: number }>();
  /** 每个终端正在进行的 deliver 有几个（I2）：DeliveryGuard 看到有就当作忙，别的自动输入不往里贴。 */
  private readonly inFlight = new Map<string, number>();

  constructor(
    private readonly factory: PtyFactory,
    private readonly events: PtyEvents,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (msg: string, err?: unknown) => void = () => undefined,
  ) {}

  private guard(termId: string, what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log(`pty ${termId}: ${what} failed`, e);
    }
  }

  open(termId: string, spec: SpawnSpec, opts: { cwd: string; env: Record<string, string>; cols?: number; rows?: number }): void {
    if (this.terms.has(termId)) throw new Error(`terminal ${termId} already open`);
    this.exited.delete(termId);
    const proc = this.factory(spec.file, spec.args, { cwd: opts.cwd, env: opts.env, cols: opts.cols ?? 120, rows: opts.rows ?? 32 });
    const term: Term = { proc, buffer: "", cutModes: new Map(), lastOutputAt: 0, exited: false, started: false, lastUserInputAt: 0, draftLen: 0, openedAt: this.now() };
    this.terms.set(termId, term);
    proc.onData((data) => {
      // ConPTY 在进程退出后还可能吐出尾部数据；退出后一律丢弃，否则渲染进程会以为终端被重新打开而清掉退出提示。
      if (term.exited) return;
      term.lastOutputAt = this.now();
      const full = term.buffer + data;
      term.buffer = trimBuffer(full);
      if (term.buffer.length < full.length) recordModes(term.cutModes, full.slice(0, full.length - term.buffer.length));
      this.events.data(termId, data);
    });
    proc.onExit(({ exitCode }) => {
      term.exited = true;
      this.terms.delete(termId);
      this.exited.delete(termId);
      this.exited.set(termId, { buffer: replay(term), exitCode });
      while (this.exited.size > EXITED_LIMIT) this.exited.delete(this.exited.keys().next().value as string);
      this.events.exit(termId, exitCode);
    });
  }

  isOpen(termId: string): boolean {
    return this.terms.has(termId);
  }

  openIds(): string[] {
    return [...this.terms.keys()];
  }

  /** 打开的终端里那个进程的 pid；终端不在了返回 null。 */
  pid(termId: string): number | null {
    return this.terms.get(termId)?.proc.pid ?? null;
  }

  /** 屏幕上有权限确认或启动对话框（信任文件夹、MCP）：在等用户回答，总控不能替用户结束它。终端不在了返回 false。 */
  screenNeedsUser(termId: string): boolean {
    const t = this.terms.get(termId);
    return !!t && (permissionPromptShowing(t.buffer) || dialogShowing(t.buffer));
  }

  /** 用户的输入（渲染进程的按键）。 */
  write(termId: string, data: string): void {
    const t = this.terms.get(termId);
    if (t) {
      t.lastUserInputAt = this.now();
      t.draftLen = nextDraftLength(t.draftLen, data);
    }
    this.guard(termId, "write", () => t?.proc.write(data));
  }

  /** 用户最后一次回车之后有没有打过可见字符（还没发出去）。Butler 的 prefill 也算草稿；deliver 不算。终端不在了返回 false。 */
  hasDraft(termId: string): boolean {
    return (this.terms.get(termId)?.draftLen ?? 0) > 0;
  }

  /** 用户上一次在这个终端里输入的时间；没输入过、终端不在了返回 0。往里贴通知前看它，免得把用户打了一半的话一起提交。 */
  lastUserInputAt(termId: string): number {
    return this.terms.get(termId)?.lastUserInputAt ?? 0;
  }

  /** 终端打开（新开或恢复）的时间；终端不在了返回 0。 */
  openedAt(termId: string): number {
    return this.terms.get(termId)?.openedAt ?? 0;
  }

  /** 这个终端里有 Butler 的 deliver 正在进行（在等输入框就绪、在粘贴、在等回车）。 */
  autoInputInFlight(termId: string): boolean {
    return (this.inFlight.get(termId) ?? 0) > 0;
  }

  private hold(termId: string, delta: 1 | -1): void {
    const n = (this.inFlight.get(termId) ?? 0) + delta;
    if (n > 0) this.inFlight.set(termId, n);
    else this.inFlight.delete(termId);
  }

  resize(termId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.guard(termId, "resize", () => this.terms.get(termId)?.proc.resize(cols, rows));
  }

  kill(termId: string): void {
    this.guard(termId, "kill", () => this.terms.get(termId)?.proc.kill());
  }

  killAll(): void {
    for (const [id, t] of [...this.terms]) this.guard(id, "kill", () => t.proc.kill());
  }

  snapshot(termId: string): PtySnapshot {
    const live = this.terms.get(termId);
    if (live) return { data: replay(live), exitCode: null };
    const done = this.exited.get(termId);
    if (done) return { data: done.buffer, exitCode: done.exitCode };
    return { data: "", exitCode: null };
  }

  /** claude 的 SessionStart hook 到了：启动对话框已经过去，可以交任务了。 */
  markStarted(termId: string): void {
    const t = this.terms.get(termId);
    if (t) t.started = true;
  }

  /**
   * 把任务作为第一条消息交给刚启动的 claude（总控开子 session）：等 SessionStart（或者等满 startWaitMs）、输出安静、
   * 屏幕上没有信任文件夹 / MCP 之类的启动对话框，才把文本当作一次粘贴（bracketed paste）写进去；回显安静之后回车。
   * 对话框一直在（用户还没处理）就一直等到 timeoutMs，绝不替用户回答。text 里不能有 ESC（调用方先 sanitizeTask）。
   * 从开始到返回，这个终端都算有自动输入在递（autoInputInFlight，I2）。
   */
  async deliver(termId: string, text: string, o: DeliverOptions = {}): Promise<DeliverResult> {
    // 同步记上：调用方过完 guard 马上调 deliver，中间没有 await，别的调用方的 guard 从这一刻起就看到它。
    this.hold(termId, 1);
    try {
      return await this.deliverOnce(termId, text, o);
    } finally {
      this.hold(termId, -1);
    }
  }

  /** 复查时自己这一次不算在递。 */
  private recheckPasses(termId: string, recheck: () => boolean): boolean {
    this.hold(termId, -1);
    try {
      return recheck();
    } catch (e) {
      this.log(`pty ${termId}: deliver recheck failed`, e);
      return false;
    } finally {
      this.hold(termId, 1);
    }
  }

  private async deliverOnce(termId: string, text: string, o: DeliverOptions): Promise<DeliverResult> {
    const idleMs = o.idleMs ?? 800;
    const start = this.now();
    for (;;) {
      const t = this.terms.get(termId);
      if (!t || t.exited) return "exited";
      const now = this.now();
      const started = t.started || now - start >= (o.startWaitMs ?? 60_000);
      const idle = t.lastOutputAt > 0 && now - t.lastOutputAt >= idleMs;
      if (started && idle && !dialogShowing(t.buffer)) {
        if (o.recheck && !this.recheckPasses(termId, o.recheck)) return "blocked";
        // 粘贴里的换行按终端的惯例写成 \r（xterm 的粘贴也是这样）：Windows 的 ConPTY 会吞掉输入里的 \n。
        const body = o.singleLine ? text.replace(/\s*\r?\n\s*/g, " ") : text.replace(/\r?\n/g, "\r");
        this.guard(termId, "deliver paste", () => t.proc.write(`\x1b[200~${body}\x1b[201~`));
        break;
      }
      if (now - start >= (o.timeoutMs ?? 300_000)) return "timeout";
      await new Promise((r) => setTimeout(r, 100));
    }
    // 长文本的回显（Windows 的 ConPTY 尤其慢）停下来之后再回车，免得提交半截。
    const pasted = this.now();
    for (;;) {
      const t = this.terms.get(termId);
      if (!t || t.exited) return "exited";
      const now = this.now();
      if ((now - Math.max(t.lastOutputAt, pasted) >= (o.settleMs ?? 300)) || now - pasted >= (o.settleCapMs ?? 5000)) {
        this.guard(termId, "deliver enter", () => t.proc.write("\r"));
        return "sent";
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** 等 claude 的界面输出停下来（输入框就绪）后把文本写进去，不回车。 */
  async prefill(termId: string, text: string, idleMs = 800, timeoutMs = 20_000): Promise<boolean> {
    const start = this.now();
    for (;;) {
      const t = this.terms.get(termId);
      if (!t || t.exited) return false;
      const now = this.now();
      if (t.lastOutputAt > 0 && now - t.lastOutputAt >= idleMs) {
        this.guard(termId, "prefill write", () => t.proc.write(text));
        t.draftLen = nextDraftLength(t.draftLen, text);
        return true;
      }
      if (now - start >= timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
