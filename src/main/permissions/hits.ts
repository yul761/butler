import { open } from "node:fs/promises";
import type { RecordEvent } from "../metrics/events";
import { matchesRule } from "./classify";

/** 一次最多读多少新内容（再多的留到下一次 Stop）。 */
const READ_MAX = 4 * 1024 * 1024;

export interface ProfileHitDeps {
  /** session 的 transcript 文件；没有为 null。 */
  transcriptOf(sessionId: string): string | null;
  /** Butler 自己就放行的工具（--settings 里本来就有的）：这些不算档案的功劳。 */
  builtIn?: readonly string[];
  recordEvent: RecordEvent;
}

/**
 * 权限档案省掉了几次确认（ws-j 设计 2.6）：session 停下来时读 transcript 新增的部分，档案规则放行的每次工具调用记一条
 * interrupt_auto_resolved（category permission，via profile）。按 tool_use id 去重。只记次数，不记命令。
 * 这是上限：用户自己的 Claude Code 设置可能本来也放行了同一条命令（见设计附录）。
 * 只按启动时真正写进这个 session 的 --settings 的规则算，只算启动以后的调用：启动之后才确认的规则、
 * Butler 重启前就开着的 session、重启后重读的旧记录，都不算。
 */
export class ProfileHitCounter {
  /** 每个文件读到了哪个字节（只在内存里：重启后从头读，dedupeKey 保证不重复记）。 */
  private readonly offsets = new Map<string, number>();
  private readonly busy = new Set<string>();
  /** 每个 session 这次启动时写进 --settings 的档案规则和启动时间。 */
  private readonly spawns = new Map<string, { rules: readonly string[]; since: number }>();

  constructor(private readonly d: ProfileHitDeps) {}

  /** Butler 启动（或恢复）这个 session 时：记下给了它哪些档案规则。 */
  spawned(sessionId: string, rules: readonly string[], at: number): void {
    if (rules.length === 0) this.spawns.delete(sessionId);
    else this.spawns.set(sessionId, { rules: [...rules], since: at });
  }

  async sessionStopped(sessionId: string): Promise<number> {
    const spawn = this.spawns.get(sessionId);
    if (!spawn || this.busy.has(sessionId)) return 0;
    const file = this.d.transcriptOf(sessionId);
    if (!file) return 0;
    this.busy.add(sessionId);
    try {
      const start = this.offsets.get(file) ?? 0;
      const fh = await open(file, "r");
      let text: string;
      try {
        const size = (await fh.stat()).size;
        if (size <= start) return 0;
        const len = Math.min(size - start, READ_MAX);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, start);
        // 只处理到最后一个换行：写到一半的那行留到下一次。
        const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (end < 0) {
          // 一整块都没有换行（比如贴进来的大图）：这一段跳过，不然每次都卡在这里。下一次从半行开始，那半行解析不了，也跳过。
          if (bytesRead === READ_MAX) this.offsets.set(file, start + bytesRead);
          return 0;
        }
        text = buf.subarray(0, end + 1).toString("utf8");
        this.offsets.set(file, start + end + 1);
      } finally {
        await fh.close();
      }
      return this.count(sessionId, text, spawn.rules, spawn.since);
    } catch {
      return 0;
    } finally {
      this.busy.delete(sessionId);
    }
  }

  private count(sessionId: string, text: string, rules: readonly string[], since: number): number {
    const builtIn = new Set(this.d.builtIn ?? []);
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line.includes("tool_use")) continue;
      let e: { message?: { content?: unknown }; timestamp?: unknown };
      try {
        e = JSON.parse(line) as typeof e;
      } catch {
        continue;
      }
      const content = e?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }[]) {
        if (!b || b.type !== "tool_use" || typeof b.id !== "string" || typeof b.name !== "string" || builtIn.has(b.name)) continue;
        const command = b.name === "Bash" && b.input && typeof b.input === "object" ? (b.input as { command?: unknown }).command : undefined;
        const call = { tool: b.name, command: typeof command === "string" ? command : undefined };
        if (b.name === "Bash" && call.command === undefined) continue;
        if (!rules.some((r) => matchesRule(r, call))) continue;
        // 没有时间、或者在这次启动之前的：不算。
        const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
        if (!Number.isFinite(at) || at < since) continue;
        this.d.recordEvent("interrupt_auto_resolved", {
          sessionId, dedupeKey: `profile:${sessionId}:${b.id}`, at, data: { category: "permission", via: "profile" },
        });
        n++;
      }
    }
    return n;
  }
}
