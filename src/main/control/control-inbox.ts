import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONTROL_ID_RE, parseControlRequest, type ControlRequest, type ControlResult } from "../../shared/control";
import { renameWithRetry } from "../util/fs-retry";

export interface ControlInboxOptions {
  requestsDir: string;
  resultsDir: string;
  handle: (req: ControlRequest) => Promise<ControlResult>;
  intervalMs?: number;
  /** 没人取走的结果文件（总控等超时了）保留多久。 */
  staleMs?: number;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

/** 总控请求的收件箱：fs.watch 加定时轮询，一次处理一个，结果写成同名文件（临时文件 + rename）。 */
export class ControlInbox {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<number> | null = null;
  private again = false;

  constructor(private readonly o: ControlInboxOptions) {}

  start(): void {
    void this.sweepStale();
    try {
      this.watcher = watch(this.o.requestsDir, () => void this.drain());
      this.watcher.on("error", (e) => this.o.log?.("control inbox: watch failed; polling only", e));
    } catch (e) {
      this.o.log?.("control inbox: watch failed; polling only", e);
    }
    this.timer = setInterval(() => void this.drain(), this.o.intervalMs ?? 1000);
    this.timer.unref?.();
    void this.drain();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 永不 reject。并发调用共享同一个进行中的 drain。返回处理的请求数。 */
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
        await mkdir(this.o.requestsDir, { recursive: true });
        await mkdir(this.o.resultsDir, { recursive: true });
        const names = (await readdir(this.o.requestsDir)).filter((n) => n.endsWith(".json")).sort();
        for (const n of names) handled += await this.process(n);
      } while (this.again);
    } catch (e) {
      this.o.log?.("control inbox: drain failed", e);
    }
    return handled;
  }

  private async process(name: string): Promise<number> {
    const id = name.slice(0, -".json".length);
    const file = join(this.o.requestsDir, name);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
      // 先删掉再处理：处理到一半退出也不会在下次启动时重复开 session。
      await unlink(file);
    } catch {
      return 0; // 已经被别的 drain 拿走了。
    }
    if (!CONTROL_ID_RE.test(id)) {
      this.o.log?.(`control inbox: dropped ${name} (bad id)`);
      return 0;
    }
    let result: ControlResult;
    try {
      const req = parseControlRequest(JSON.parse(raw));
      result = req ? await this.o.handle(req) : { v: 1, ok: false, error: "请求格式不对" };
    } catch (e) {
      this.o.log?.(`control inbox: ${name} failed`, e);
      result = { v: 1, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const out = join(this.o.resultsDir, name);
    const tmp = join(this.o.resultsDir, `${id}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(result), { mode: 0o600 });
      await renameWithRetry(tmp, out);
    } catch (e) {
      this.o.log?.(`control inbox: could not write the result for ${name}`, e);
    }
    return 1;
  }

  /** 启动时清掉没人取走的旧结果。 */
  private async sweepStale(): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    try {
      for (const n of await readdir(this.o.resultsDir)) {
        const f = join(this.o.resultsDir, n);
        if (now - (await stat(f)).mtimeMs > (this.o.staleMs ?? 10 * 60_000)) await unlink(f);
      }
    } catch {
      // 目录还不存在。
    }
  }
}
