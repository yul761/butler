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
  lastOutputAt: number;
  exited: boolean;
  /** claude 的 SessionStart hook 到了（信任文件夹之类的启动对话框已经过去）。 */
  started: boolean;
}

/** 终端输出去掉 ANSI 控制序列后的纯文本（只用来认对话框）。 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
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
}

export type DeliverResult = "sent" | "exited" | "timeout";

/** 最多保留多少个已退出终端的记录（用于快速失败的 claude 也能看到退出码）。 */
export const EXITED_LIMIT = 20;

export interface PtySnapshot {
  data: string;
  exitCode: number | null;
}

export class PtyManager {
  private readonly terms = new Map<string, Term>();
  private readonly exited = new Map<string, { buffer: string; exitCode: number }>();

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
    const term: Term = { proc, buffer: "", lastOutputAt: 0, exited: false, started: false };
    this.terms.set(termId, term);
    proc.onData((data) => {
      // ConPTY 在进程退出后还可能吐出尾部数据；退出后一律丢弃，否则渲染进程会以为终端被重新打开而清掉退出提示。
      if (term.exited) return;
      term.lastOutputAt = this.now();
      term.buffer = (term.buffer + data).slice(-BUFFER_LIMIT);
      this.events.data(termId, data);
    });
    proc.onExit(({ exitCode }) => {
      term.exited = true;
      this.terms.delete(termId);
      this.exited.delete(termId);
      this.exited.set(termId, { buffer: term.buffer, exitCode });
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

  write(termId: string, data: string): void {
    this.guard(termId, "write", () => this.terms.get(termId)?.proc.write(data));
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
    if (live) return { data: live.buffer, exitCode: null };
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
   */
  async deliver(termId: string, text: string, o: DeliverOptions = {}): Promise<DeliverResult> {
    const idleMs = o.idleMs ?? 800;
    const start = this.now();
    for (;;) {
      const t = this.terms.get(termId);
      if (!t || t.exited) return "exited";
      const now = this.now();
      const started = t.started || now - start >= (o.startWaitMs ?? 60_000);
      const idle = t.lastOutputAt > 0 && now - t.lastOutputAt >= idleMs;
      if (started && idle && !dialogShowing(t.buffer)) {
        // 粘贴里的换行按终端的惯例写成 \r（xterm 的粘贴也是这样）：Windows 的 ConPTY 会吞掉输入里的 \n。
        this.guard(termId, "deliver paste", () => t.proc.write(`\x1b[200~${text.replace(/\r?\n/g, "\r")}\x1b[201~`));
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
        return true;
      }
      if (now - start >= timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
