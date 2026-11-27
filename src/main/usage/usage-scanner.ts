import { open, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { UsageRepo, UsageRow, UsageSource } from "../db/usage-repo";
import { TranscriptHub, type TailLine, type TailSink, type TailStat } from "../sessions/transcript-hub";
import { parseUsageLine, usageOfLongLine, usageOfValue } from "./usage-parse";

export const USAGE_SCAN_MS = 30_000;
export const USAGE_CHUNK_BYTES = 1024 * 1024;

/**
 * 后台扫描的间隔，只在这里读环境变量。e2e 等不起 30 秒（换新要先看到上下文），用 SHIPHERD_USAGE_SCAN_MS 调短；
 * 和 activityIntervals 一样只有 e2e 的标记 SHIPHERD_BACKGROUND_WINDOWS=1 在时才算数，正常运行永远是 30 秒。
 */
export function usageScanMs(env: NodeJS.ProcessEnv): number {
  const v = env.SHIPHERD_USAGE_SCAN_MS ?? "";
  return env.SHIPHERD_BACKGROUND_WINDOWS === "1" && /^[1-9]\d*$/.test(v) ? Number(v) : USAGE_SCAN_MS;
}

export interface UsageScannerDeps {
  repo: UsageRepo;
  /** 现在要扫的 session id（Shipherd 开的、终端开着的 head，以及刚退出的）。 */
  sessionIds: () => string[];
  transcriptFile: (sessionId: string) => string | null;
  /** 每次读多少字节，默认 USAGE_CHUNK_BYTES（测试用小值）。 */
  chunkBytes?: number;
  /** 扫完一遍以后（成本熔断按新用量看一遍）。 */
  onScanned?: () => void;
  log?: (msg: string, err?: unknown) => void;
  /** 和活动、对话另存共用的 transcript 读取（BTL-276）；没给时自己建一个（用 chunkBytes）。 */
  hub?: TranscriptHub;
}

/** `<dir>/<id>.jsonl` → `<dir>/<id>/subagents`。 */
export function subagentsDir(transcriptFile: string): string {
  return join(dirname(transcriptFile), basename(transcriptFile, ".jsonl"), "subagents");
}

export class UsageScanner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly hub: TranscriptHub;
  /** 要扫的 session 的主 transcript 一直挂在 hub 上（别的消费者读到的新行也交给这里），键 session id。 */
  private readonly sinks = new Map<string, { file: string; sink: UsageSink; detach: () => void }>();

  constructor(private readonly d: UsageScannerDeps) {
    this.hub = d.hub ?? new TranscriptHub({ chunkBytes: d.chunkBytes, log: d.log });
  }

  start(intervalMs = USAGE_SCAN_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scanAll(), intervalMs);
    void this.scanAll();
  }

  /** 停掉定时器；挂在 hub 上、还没写进库的用量写进去，摘掉。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.sinks.keys()]) this.release(id);
  }

  /** 扫一遍 sessionIds()；同一时间只跑一次，正在跑时直接返回。 */
  async scanAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const ids = this.d.sessionIds();
      for (const id of ids) await this.scanSession(id);
      const keep = new Set(ids);
      for (const id of [...this.sinks.keys()]) if (!keep.has(id)) this.release(id);
    } catch (err) {
      this.d.log?.("usage scan failed", err);
    } finally {
      this.running = false;
    }
    try {
      this.d.onScanned?.();
    } catch (err) {
      this.d.log?.("usage: the after-scan hook threw", err);
    }
  }

  /** 终端退出时调用：把这个 session 读到文件末尾。 */
  async scanSession(sessionId: string): Promise<void> {
    const file = this.d.transcriptFile(sessionId);
    if (!file) return;
    await this.scanMain(sessionId, file);
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

  /** 主 transcript：经 hub 读到最新，攒下的用量和游标写进库。 */
  private async scanMain(sessionId: string, file: string): Promise<void> {
    let s = this.sinks.get(sessionId);
    if (s && s.file !== file) {
      this.release(sessionId);
      s = undefined;
    }
    if (!s) {
      const sink = new UsageSink(this.d.repo, file, sessionId, this.d.log);
      s = { file, sink, detach: this.hub.attach(file, "usage", sink) };
      this.sinks.set(sessionId, s);
    }
    await this.hub.pump(file, "usage");
    s.sink.flush();
  }

  private release(sessionId: string): void {
    const s = this.sinks.get(sessionId);
    if (!s) return;
    this.sinks.delete(sessionId);
    s.detach();
    s.sink.flush();
  }

  /** 子代理的 transcript（别的消费者不读）：从游标起分块读到当前大小；读不了就跳过，游标不动，下次再试。 */
  private async scanFile(file: string, sessionId: string, source: UsageSource, agentId: string | null): Promise<void> {
    const chunk = this.d.chunkBytes ?? USAGE_CHUNK_BYTES;
    try {
      const fh = await open(file, "r");
      try {
        const size = (await fh.stat()).size;
        const cur = this.d.repo.cursor(file);
        // 文件比记录的短：被截断或换了，从头来
        let offset = cur && size >= cur.size && size >= cur.offset ? cur.offset : 0;
        let stored = cur;
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
          stored = { offset, size };
        }
        // 没有新内容或只剩半行时也记下当前大小，下次才能发现文件变短；和库里的一样就不再写（BTL-275：每 30 秒每个文件一次空写）
        if (stored?.offset !== offset || stored.size !== size) this.d.repo.setCursor(file, offset, size);
      } finally {
        await fh.close();
      }
    } catch (err) {
      this.d.log?.(`usage scan skipped ${file}`, err);
    }
  }
}

/**
 * 一个主 transcript 在 hub 上的用量读取。游标（offset、size）和原来一样存在 usage_cursors：文件比记录的 size 或 offset 短就从头读。
 * 读到的行先攒在内存里（别的消费者每次读都会顺带给这里，不能每次都写库），扫描时 flush 一起写；没写进库前退出了，下次从库里的游标重读，
 * messageId 去重。重置（变短、换了）当场写进库：新的偏移 0 和 size，攒着的旧行也先写掉。
 */
class UsageSink implements TailSink {
  private rows: UsageRow[] = [];
  /** 还没写进库的游标；null 是和库里一样。 */
  private cur: { offset: number; size: number } | null = null;

  constructor(
    private readonly repo: UsageRepo,
    private readonly file: string,
    private readonly sessionId: string,
    private readonly log?: (msg: string, err?: unknown) => void,
  ) {}

  begin(st: TailStat): { offset: number } {
    const cur = this.cur ?? this.repo.cursor(this.file);
    const keep = cur !== null && st.size >= cur.size && st.size >= cur.offset;
    const offset = keep ? cur.offset : 0;
    this.cur = { offset, size: st.size };
    // 被截断或换了：马上把从头读的游标写进库，这次一行都读不到也一样
    if (cur !== null && !keep) this.flush();
    return { offset };
  }

  lines(lines: TailLine[], next: number, st: TailStat): void {
    for (const l of lines) {
      if (l.skipped) {
        // 超过 hub 单行上限的行（一大段工具结果）：整行不解析，从开头、结尾的片段里抠用量。
        const turn = usageOfLongLine(l.head ?? "", l.tail ?? "");
        if (turn) this.rows.push({ ...turn, sessionId: this.sessionId, agentId: null, source: "session", job: null });
        this.log?.(`usage scan: ${this.file} has a ${l.end - l.start}-byte line at ${l.start}; ${turn ? `took its usage (${turn.messageId}) from its ends` : "found no usage in it"}`);
        continue;
      }
      // 先快速跳过不相关的行；要用的 JSON 由 hub 解析（别的消费者已经解析过就不再解析）
      if (!l.text.includes('"usage"')) continue;
      const turn = usageOfValue(l.json());
      if (turn) this.rows.push({ ...turn, sessionId: this.sessionId, agentId: null, source: "session", job: null });
    }
    this.cur = { offset: next, size: st.size };
  }

  end(st: TailStat | null): void {
    // 没有新内容或只剩半行时也记下当前大小，下次才能发现文件变短
    if (st && this.cur) this.cur = { offset: this.cur.offset, size: st.size };
  }

  /** 攒下的用量和游标写进库；写失败留着下次再写。 */
  flush(): void {
    try {
      if (this.rows.length > 0) this.repo.record(this.rows);
      this.rows = [];
      if (this.cur) this.repo.setCursor(this.file, this.cur.offset, this.cur.size);
      this.cur = null;
    } catch (err) {
      this.log?.(`usage scan: saving ${this.file} failed`, err);
    }
  }
}
