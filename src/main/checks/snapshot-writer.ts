import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CheckSnapshot } from "../../shared/checks";
import { renameWithRetrySync } from "../util/fs-retry";

export interface SnapshotWriterOptions {
  file: string;
  build: () => CheckSnapshot;
  /** 改动后多久再写（合并一串改动）。 */
  debounceMs?: number;
  /** 兜底：隔多久无论如何重算一次（内容没变就不写）。 */
  backstopMs?: number;
  log?: (msg: string, e?: unknown) => void;
  now?: () => number;
}

/** 比较内容时去掉生成时间。 */
const content = (s: CheckSnapshot): string => JSON.stringify({ ...s, generatedAt: 0 });

/**
 * hook 读的检查快照（addendum 第 3 节）：Shipherd 是唯一的写入者，tmp + rename 写，hook 永远读到完整的文件。
 * 内容没变就不写；改动之后防抖再写；另有定时兜底（产品成员、仓库登记这些不经过 ChecksService 的改动也会跟上）。
 */
export class SnapshotWriter {
  private timer: NodeJS.Timeout | null = null;
  private backstop: NodeJS.Timeout | null = null;
  private last: string | null = null;
  private status: { writtenAt: number | null; error: string | null } = { writtenAt: null, error: null };

  constructor(private readonly o: SnapshotWriterOptions) {}

  /** 立刻写（启动时、测试里）。返回是否真的写了文件。 */
  writeNow(): boolean {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      const snap = this.o.build();
      const c = content(snap);
      if (c === this.last && this.status.error === null) return false;
      if (this.last === null) {
        // 刚启动：磁盘上已经是这份内容就不重写（hook 正在读的文件不必换）。
        try {
          const disk = JSON.parse(readFileSync(this.o.file, "utf8")) as CheckSnapshot;
          if (content(disk) === c) {
            this.last = c;
            this.status = { writtenAt: disk.generatedAt, error: null };
            return false;
          }
        } catch {
          // 没有或读不懂：照常写。
        }
      }
      mkdirSync(dirname(this.o.file), { recursive: true });
      const tmp = `${this.o.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(snap), "utf8");
      renameWithRetrySync(tmp, this.o.file);
      this.last = c;
      this.status = { writtenAt: snap.generatedAt, error: null };
      return true;
    } catch (e) {
      this.status = { writtenAt: this.status.writtenAt, error: e instanceof Error ? e.message : String(e) };
      this.o.log?.("checks: writing the snapshot failed", e);
      return false;
    }
  }

  /** 有改动：防抖后写。 */
  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow();
    }, this.o.debounceMs ?? 150);
    this.timer.unref?.();
  }

  start(): void {
    this.writeNow();
    if (this.backstop) return;
    this.backstop = setInterval(() => this.writeNow(), this.o.backstopMs ?? 60_000);
    this.backstop.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.backstop) clearInterval(this.backstop);
    this.timer = null;
    this.backstop = null;
  }

  lastStatus(): { writtenAt: number | null; error: string | null } {
    return { ...this.status };
  }
}

/** 快照存在、读得懂、版本对（session 启动时判断「没有检查」用）。 */
export function readSnapshotState(file: string, version: number): "ok" | "missing" | "unreadable" | "version" {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "missing";
  }
  try {
    const v = (JSON.parse(text) as { v?: unknown }).v;
    return v === version ? "ok" : "version";
  } catch {
    return "unreadable";
  }
}
