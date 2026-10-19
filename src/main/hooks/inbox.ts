import { watch, type FSWatcher } from "node:fs";
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

/** fs.watch 在各平台上都不完全可靠，所以同时用定时轮询兜底。 */
export class HookInbox {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private again = false;

  constructor(private readonly opts: HookInboxOptions) {}

  async drain(): Promise<number> {
    if (this.draining) {
      this.again = true;
      return 0;
    }
    this.draining = true;
    let handled = 0;
    try {
      do {
        this.again = false;
        await mkdir(this.opts.dir, { recursive: true });
        const names = (await readdir(this.opts.dir)).filter((n) => n.endsWith(".json")).sort();
        for (const name of names) {
          const file = join(this.opts.dir, name);
          try {
            const env = parseEnvelope(await readFile(file, "utf8"));
            if (!env) throw new Error("invalid envelope");
            this.opts.handle(env);
            await unlink(file);
            handled++;
          } catch (e) {
            this.opts.log?.(`inbox: ${name} -> bad (${(e as Error).message})`);
            await mkdir(this.opts.badDir, { recursive: true });
            await rename(file, join(this.opts.badDir, name)).catch(() => undefined);
          }
        }
      } while (this.again);
    } finally {
      this.draining = false;
    }
    return handled;
  }

  start(): void {
    void this.drain();
    try {
      this.watcher = watch(this.opts.dir, () => void this.drain());
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
