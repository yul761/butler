import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  CHECK_ABSENCE_REASONS, CHECK_MODES, CHECK_OUTCOMES, CHECK_SEVERITIES,
  type CheckAbsenceReason, type CheckLogRecord,
} from "../../shared/checks";
import { BYPASS_HOWS } from "../../shared/backtest";

type Hit = Extract<CheckLogRecord, { kind: "hit" }>;
export type BypassLog = Extract<CheckLogRecord, { kind: "bypass" }>;

const isStr = (v: unknown, max = 2000): v is string => typeof v === "string" && v.length <= max;
const inList = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** hook 写的一行；认不出的返回 null（跳过，不影响同一个文件里的其他行）。 */
export function parseCheckLogRecord(line: string): CheckLogRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const session = r.session === null || r.session === undefined ? null : isStr(r.session, 200) ? r.session : undefined;
  if (session === undefined || !isTime(r.at)) return null;
  if (r.kind === "absent") {
    return inList(CHECK_ABSENCE_REASONS, r.reason) ? { kind: "absent", reason: r.reason as CheckAbsenceReason, session, at: r.at } : null;
  }
  if (r.kind === "present") return { kind: "present", session, at: r.at };
  if (r.kind === "bypass") {
    if (!Number.isSafeInteger(r.checkId) || !isStr(r.checkKey, 200) || !r.checkKey || !isStr(r.slug, 300) || !isStr(r.file, 2000) || !inList(BYPASS_HOWS, r.how)) return null;
    const ln = r.line === null || r.line === undefined ? null : Number.isSafeInteger(r.line) && (r.line as number) > 0 ? (r.line as number) : undefined;
    if (ln === undefined) return null;
    return {
      kind: "bypass", checkId: r.checkId as number, checkKey: r.checkKey, slug: r.slug, file: r.file, line: ln, how: r.how,
      detail: typeof r.detail === "string" ? r.detail.slice(0, 300) : "", session, at: r.at,
    };
  }
  if (r.kind !== "hit") return null;
  if (!Number.isSafeInteger(r.checkId) || !isStr(r.checkKey, 200) || !r.checkKey || !isStr(r.slug, 300) || !isStr(r.file, 2000)) return null;
  const line_ = r.line === null || r.line === undefined ? null : Number.isSafeInteger(r.line) && (r.line as number) > 0 ? (r.line as number) : undefined;
  if (line_ === undefined) return null;
  if (r.stage !== "edit" && r.stage !== "push") return null;
  if (!inList(CHECK_MODES, r.mode) || !inList(CHECK_SEVERITIES, r.severity) || !inList(CHECK_OUTCOMES, r.outcome)) return null;
  return {
    kind: "hit", checkId: r.checkId as number, checkKey: r.checkKey, slug: r.slug, file: r.file, line: line_, stage: r.stage, mode: r.mode, severity: r.severity,
    outcome: r.outcome, blocked: r.blocked === true, detail: typeof r.detail === "string" ? r.detail.slice(0, 2000) : "", session, at: r.at,
  };
}

export interface HitIngestOptions {
  dir: string;
  insertHits: (rows: { key: string; rec: Hit }[]) => number;
  /** 绕过记录（工作流 F）：没给就丢掉。 */
  insertBypasses?: (rows: { key: string; rec: BypassLog }[]) => number;
  /** reason 为 null：又检查上了，清掉标记。 */
  markAbsent: (session: string, reason: CheckAbsenceReason | null) => void;
  /** 有新的命中写进库之后（页面刷新）。 */
  onIngested?: (n: number) => void;
  intervalMs?: number;
  log?: (msg: string, e?: unknown) => void;
}

/** 一个文件最多读这么大：hook 一次只写几十行，大得离谱的文件不是它写的。 */
const MAX_FILE = 4 * 1024 * 1024;

/**
 * 把 hook 写的命中日志（<SHIPHERD_HOME>/checks/hits/*.jsonl，每次 hook 运行一个文件，tmp + rename 写）收进 check_hits。
 * 文件名 + 行号是 ingest_key：同一个文件读两次也不会重复记。fs.watch 加定时轮询兜底，和收件箱一样。
 */
export class HitIngest {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<number> | null = null;
  private again = false;

  constructor(private readonly o: HitIngestOptions) {}

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
    let total = 0;
    try {
      do {
        this.again = false;
        mkdirSync(this.o.dir, { recursive: true });
        const names = (await readdir(this.o.dir)).filter((n) => n.endsWith(".jsonl")).sort();
        for (const name of names) total += await this.file(name);
      } while (this.again);
    } catch (e) {
      this.o.log?.("checks: reading hit logs failed", e);
    }
    if (total > 0) this.o.onIngested?.(total);
    return total;
  }

  private async file(name: string): Promise<number> {
    const path = join(this.o.dir, name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return 0;
    }
    let n = 0;
    if (text.length <= MAX_FILE) {
      const hits: { key: string; rec: Hit }[] = [];
      const bypasses: { key: string; rec: BypassLog }[] = [];
      text.split("\n").forEach((line, i) => {
        if (!line.trim()) return;
        const rec = parseCheckLogRecord(line);
        if (!rec) return;
        if (rec.kind === "hit") hits.push({ key: `${name}:${i}`, rec });
        else if (rec.kind === "bypass") bypasses.push({ key: `${name}:${i}`, rec });
        else if (rec.session) {
          try {
            this.o.markAbsent(rec.session, rec.kind === "absent" ? rec.reason : null);
          } catch (e) {
            this.o.log?.("checks: recording missing checks failed", e);
          }
        }
      });
      // 写库失败（库忙之类）就留着文件下次再来；ingest_key 保证不会重复。
      n = this.o.insertHits(hits);
      if (bypasses.length && this.o.insertBypasses) n += this.o.insertBypasses(bypasses);
    } else this.o.log?.(`checks: ${name} is too large, dropped`);
    try {
      await unlink(path);
    } catch {
      // 删不掉（Windows 上被占着）：下次再删，ingest_key 防重复。
    }
    return n;
  }

  start(): void {
    void this.drain();
    try {
      mkdirSync(this.o.dir, { recursive: true });
      this.watcher = watch(this.o.dir, () => void this.drain());
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (e) {
      this.o.log?.("checks: watching hit logs failed, polling only", e);
    }
    this.timer = setInterval(() => void this.drain(), this.o.intervalMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
