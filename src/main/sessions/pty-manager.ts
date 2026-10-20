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
}

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
    const term: Term = { proc, buffer: "", lastOutputAt: 0, exited: false };
    this.terms.set(termId, term);
    proc.onData((data) => {
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
