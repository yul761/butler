// 终端输出攒一下再发给渲染进程（BTL-277）：claude 的界面（spinner、零碎重画）一秒吐很多小块，原来每块一次 webContents.send。
// 规矩：一个终端安静了一段（windowMs）以后来的第一块马上发，打字回显不多等；窗口里接着来的块按顺序拼起来，到窗口结束发一次。
// 所以一个终端最多每 windowMs 发一次，多出来的延迟最多 windowMs。字节不丢、不乱序：只拼接，不改内容。
// 渲染进程挂终端时按「回包之前到的数据都已包含在快照里」来丢数据（live-terminal.ts）：取快照、补段之前先 flush 这个终端，
// 攒着的那段在回包之前发出去，不会在快照之后再重复到一次。

/** 每个终端两次发送之间至少隔多久（8–16ms 之间，取下限：回显最多晚这么多）。 */
export const OUTPUT_BATCH_MS = 8;
/** 攒到这么多字符就不等了（大段输出不在主进程里堆着）。 */
export const OUTPUT_BATCH_MAX_CHARS = 64 * 1024;

export interface BatchClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: BatchClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Pending {
  parts: string[];
  chars: number;
  timer: unknown;
}

export class OutputBatcher {
  private readonly pending = new Map<string, Pending>();
  /** 每个终端上一次发出去的时间。 */
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly send: (termId: string, data: string) => void,
    private readonly opts: { windowMs?: number; maxChars?: number } = {},
    private readonly clock: BatchClock = realClock,
  ) {}

  private get windowMs(): number {
    return this.opts.windowMs ?? OUTPUT_BATCH_MS;
  }

  push(termId: string, data: string): void {
    if (data === "") return;
    const p = this.pending.get(termId);
    if (p) {
      p.parts.push(data);
      p.chars += data.length;
      if (p.chars >= (this.opts.maxChars ?? OUTPUT_BATCH_MAX_CHARS)) this.flush(termId);
      return;
    }
    const now = this.clock.now();
    const last = this.lastSent.get(termId);
    if (last === undefined || now - last >= this.windowMs) {
      this.lastSent.set(termId, now);
      this.send(termId, data);
      return;
    }
    const timer = this.clock.setTimeout(() => this.flush(termId), this.windowMs - (now - last));
    this.pending.set(termId, { parts: [data], chars: data.length, timer });
  }

  /** 把这个终端攒着的马上发出去（取快照、补段、退出之前）。 */
  flush(termId: string): void {
    const p = this.pending.get(termId);
    if (!p) return;
    this.pending.delete(termId);
    this.clock.clearTimeout(p.timer);
    this.lastSent.set(termId, this.clock.now());
    this.send(termId, p.parts.length === 1 ? p.parts[0] : p.parts.join(""));
  }

  /** 终端退出：攒着的先发完，再忘掉它。 */
  forget(termId: string): void {
    this.flush(termId);
    this.lastSent.delete(termId);
  }

  /** 攒着还没发的字符数（测试和诊断用）。 */
  pendingChars(termId: string): number {
    return this.pending.get(termId)?.chars ?? 0;
  }
}
