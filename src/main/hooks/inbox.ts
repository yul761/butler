import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseEnvelope, type HookEnvelope } from "../../shared/hook-envelope";

export interface HookInboxOptions {
  dir: string;
  badDir: string;
  handle: (env: HookEnvelope) => void;
  intervalMs?: number;
  log?: (msg: string) => void;
}

/** handle 连续失败这么多次后，文件才被移到 bad/。 */
export const MAX_HANDLE_ATTEMPTS = 3;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** fs.watch 在各平台上都不完全可靠，所以同时用定时轮询兜底。 */
export class HookInbox {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<number> | null = null;
  private again = false;
  /** 每个文件名已失败的 handle 次数（仅内存）。 */
  private attempts = new Map<string, number>();
  /** handle 已成功但删除失败的文件名：之后不再重复应用。 */
  private applied = new Set<string>();

  constructor(private readonly opts: HookInboxOptions) {}

  /** 永不 reject：所有 I/O 错误都记入 log。并发调用会共享同一个进行中的 drain。 */
  drain(): Promise<number> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async run(): Promise<number> {
    let handled = 0;
    try {
      do {
        this.again = false;
        await mkdir(this.opts.dir, { recursive: true });
        const names = (await readdir(this.opts.dir))
          .filter((n) => n.endsWith(".json") && !this.applied.has(n))
          .sort();
        for (const name of names) handled += await this.processFile(name);
      } while (this.again);
    } catch (e) {
      this.log(`inbox: drain failed (${errMsg(e)})`);
    }
    return handled;
  }

  /** 返回 1 表示本文件已应用并删除（或已应用但删除失败）。 */
  private async processFile(name: string): Promise<number> {
    const file = join(this.opts.dir, name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      this.log(`inbox: ${name} read failed (${errMsg(e)}), will retry`);
      return 0;
    }
    const env = parseEnvelope(text);
    if (!env) {
      await this.quarantine(name, "invalid envelope");
      return 0;
    }
    try {
      this.opts.handle(env);
    } catch (e) {
      const n = (this.attempts.get(name) ?? 0) + 1;
      if (n >= MAX_HANDLE_ATTEMPTS) {
        this.attempts.delete(name);
        await this.quarantine(name, `handler failed ${n} times: ${errMsg(e)}`);
      } else {
        this.attempts.set(name, n);
        this.log(`inbox: ${name} handler failed (attempt ${n}), will retry: ${errMsg(e)}`);
      }
      return 0;
    }
    this.attempts.delete(name);
    try {
      await unlink(file);
    } catch (e) {
      this.applied.add(name);
      this.log(`inbox: ${name} applied but unlink failed (${errMsg(e)}); will not re-apply`);
    }
    return 1;
  }

  private async quarantine(name: string, reason: string): Promise<void> {
    this.log(`inbox: ${name} -> bad (${reason})`);
    try {
      await mkdir(this.opts.badDir, { recursive: true });
      await rename(join(this.opts.dir, name), join(this.opts.badDir, name));
    } catch (e) {
      this.log(`inbox: ${name} quarantine failed (${errMsg(e)})`);
    }
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  start(): void {
    if (this.timer) return;
    // 先同步建目录，否则 watch() 会因目录不存在而失败，只能靠轮询。
    try {
      mkdirSync(this.opts.dir, { recursive: true });
    } catch (e) {
      this.log(`inbox: cannot create ${this.opts.dir} (${errMsg(e)})`);
    }
    void this.drain();
    try {
      const watcher = watch(this.opts.dir, () => void this.drain());
      // 无 error 监听的 FSWatcher 会让 Electron 主进程崩溃；出错后只保留轮询。
      watcher.on("error", (e) => {
        this.log(`inbox: watcher error (${errMsg(e)}); polling only`);
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      });
      this.watcher = watcher;
    } catch {
      this.watcher = null;
    }
    this.timer = setInterval(() => void this.drain(), this.opts.intervalMs ?? 2000);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
