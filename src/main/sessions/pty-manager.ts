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

export class PtyManager {
  private readonly terms = new Map<string, Term>();

  constructor(
    private readonly factory: PtyFactory,
    private readonly events: PtyEvents,
    private readonly now: () => number = () => Date.now(),
  ) {}

  open(termId: string, spec: SpawnSpec, opts: { cwd: string; env: Record<string, string>; cols?: number; rows?: number }): void {
    if (this.terms.has(termId)) throw new Error(`terminal ${termId} already open`);
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
    this.terms.get(termId)?.proc.write(data);
  }

  resize(termId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.terms.get(termId)?.proc.resize(cols, rows);
  }

  kill(termId: string): void {
    this.terms.get(termId)?.proc.kill();
  }

  killAll(): void {
    for (const t of [...this.terms.values()]) t.proc.kill();
  }

  snapshot(termId: string): string {
    return this.terms.get(termId)?.buffer ?? "";
  }

  /** 等 claude 的界面输出停下来（输入框就绪）后把文本写进去，不回车。 */
  async prefill(termId: string, text: string, idleMs = 800, timeoutMs = 20_000): Promise<boolean> {
    const start = this.now();
    for (;;) {
      const t = this.terms.get(termId);
      if (!t || t.exited) return false;
      const now = this.now();
      if (t.lastOutputAt > 0 && now - t.lastOutputAt >= idleMs) {
        t.proc.write(text);
        return true;
      }
      if (now - start >= timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
