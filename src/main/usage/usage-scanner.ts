import { open, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { UsageRepo, UsageRow, UsageSource } from "../db/usage-repo";
import { parseUsageLine } from "./usage-parse";

export const USAGE_SCAN_MS = 30_000;
export const USAGE_CHUNK_BYTES = 1024 * 1024;

/**
 * 后台扫描的间隔，只在这里读环境变量。e2e 等不起 30 秒（换新要先看到上下文），用 BUTLER_USAGE_SCAN_MS 调短；
 * 和 activityIntervals 一样只有 e2e 的标记 BUTLER_BACKGROUND_WINDOWS=1 在时才算数，正常运行永远是 30 秒。
 */
export function usageScanMs(env: NodeJS.ProcessEnv): number {
  const v = env.BUTLER_USAGE_SCAN_MS ?? "";
  return env.BUTLER_BACKGROUND_WINDOWS === "1" && /^[1-9]\d*$/.test(v) ? Number(v) : USAGE_SCAN_MS;
}

export interface UsageScannerDeps {
  repo: UsageRepo;
  /** 现在要扫的 session id（Butler 开的、终端开着的 head，以及刚退出的）。 */
  sessionIds: () => string[];
  transcriptFile: (sessionId: string) => string | null;
  /** 每次读多少字节，默认 USAGE_CHUNK_BYTES（测试用小值）。 */
  chunkBytes?: number;
  log?: (msg: string, err?: unknown) => void;
}

/** `<dir>/<id>.jsonl` → `<dir>/<id>/subagents`。 */
export function subagentsDir(transcriptFile: string): string {
  return join(dirname(transcriptFile), basename(transcriptFile, ".jsonl"), "subagents");
}

export class UsageScanner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly d: UsageScannerDeps) {}

  start(intervalMs = USAGE_SCAN_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scanAll(), intervalMs);
    void this.scanAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 扫一遍 sessionIds()；同一时间只跑一次，正在跑时直接返回。 */
  async scanAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const id of this.d.sessionIds()) await this.scanSession(id);
    } catch (err) {
      this.d.log?.("usage scan failed", err);
    } finally {
      this.running = false;
    }
  }

  /** 终端退出时调用：把这个 session 读到文件末尾。 */
  async scanSession(sessionId: string): Promise<void> {
    const file = this.d.transcriptFile(sessionId);
    if (!file) return;
    await this.scanFile(file, sessionId, "session", null);
    let names: string[];
    try {
      names = await readdir(subagentsDir(file));
    } catch {
      return; // 没有子代理目录
    }
    for (const name of names) {
      if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
      const agentId = name.slice("agent-".length, -".jsonl".length);
      await this.scanFile(join(subagentsDir(file), name), sessionId, "subagent", agentId);
    }
  }

  /** 从游标起分块读到当前大小；读不了就跳过，游标不动，下次再试。 */
  private async scanFile(file: string, sessionId: string, source: UsageSource, agentId: string | null): Promise<void> {
    const chunk = this.d.chunkBytes ?? USAGE_CHUNK_BYTES;
    try {
      const fh = await open(file, "r");
      try {
        const size = (await fh.stat()).size;
        const cur = this.d.repo.cursor(file);
        // 文件比记录的短：被截断或换了，从头来
        let offset = cur && size >= cur.size && size >= cur.offset ? cur.offset : 0;
        while (offset < size) {
          // 一行比一块还长时，逐步加大读取范围，直到出现换行或读到文件末尾
          let len = Math.min(chunk, size - offset);
          let buf = Buffer.alloc(0);
          let end = -1;
          for (;;) {
            buf = Buffer.alloc(len);
            const { bytesRead } = await fh.read(buf, 0, len, offset);
            buf = buf.subarray(0, bytesRead);
            end = buf.lastIndexOf(0x0a);
            if (end !== -1 || offset + len >= size || bytesRead < len) break;
            len = Math.min(len + chunk, size - offset);
          }
          if (end === -1) break; // 剩下的是半行，留到下次
          const rows: UsageRow[] = [];
          for (const text of buf.subarray(0, end).toString("utf8").split("\n")) {
            const turn = parseUsageLine(text);
            if (turn) rows.push({ ...turn, sessionId, agentId, source, job: null });
          }
          if (rows.length) this.d.repo.record(rows);
          offset += end + 1;
          this.d.repo.setCursor(file, offset, size);
        }
        // 没有新内容或只剩半行时也记下当前大小，下次才能发现文件变短
        this.d.repo.setCursor(file, offset, size);
      } finally {
        await fh.close();
      }
    } catch (err) {
      this.d.log?.(`usage scan skipped ${file}`, err);
    }
  }
}
