import { watch as fsWatch } from "node:fs";

/** 监视一个文件：type 是 fs.watch 给的事件种类（rename 说明文件被换掉或删掉了）。文件不存在时抛错。 */
export type WatchFn = (file: string, onEvent: (type: "change" | "rename") => void, onError: (e: unknown) => void) => { close(): void };

/** 真的 fs.watch：不挡住进程退出。 */
export const nodeWatch: WatchFn = (file, onEvent, onError) => {
  const w = fsWatch(file, { persistent: false }, (type) => onEvent(type === "rename" ? "rename" : "change"));
  w.on("error", onError);
  return w;
};

export interface DebouncedWatchOptions {
  delayMs: number;
  onChange: () => void;
  watch?: WatchFn;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * 一个 transcript 文件的监视（BTL-190 第 7 点）：文件一变，delayMs 之后调一次 onChange。
 * - 去抖：第一次事件起算，窗口里的事件合成一次（macOS 上同一次写常常来好几个事件）；不是“安静了才调”，一直在写也每 delayMs 至少调一次。
 * - 文件被换掉（rename）或者监视出错：关掉这个监视器，这次照样算一次变化；下一次 ensure() 对着新文件重新挂上。
 * - 文件还不存在时 ensure() 返回 false，调用方下次再试（10 秒的 tick 是退路）。
 */
export class DebouncedWatch {
  private watcher: { close(): void } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly file: string,
    private readonly o: DebouncedWatchOptions,
  ) {}

  /** 没在监视就挂上；返回现在是否在监视。 */
  ensure(): boolean {
    if (this.closed) return false;
    if (this.watcher) return true;
    try {
      this.watcher = (this.o.watch ?? nodeWatch)(
        this.file,
        (type) => {
          if (type === "rename") this.drop();
          this.schedule();
        },
        (e) => {
          this.o.log?.(`watching ${this.file} failed`, e);
          this.drop();
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.closed = true;
    this.drop();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private drop(): void {
    try {
      this.watcher?.close();
    } catch {
      // 已经关了
    }
    this.watcher = null;
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.o.onChange();
    }, this.o.delayMs);
  }
}
