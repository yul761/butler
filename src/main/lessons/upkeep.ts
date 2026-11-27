// 规矩的定时维护（BTL-274）：原则重新分组、找相似规矩。
// 有仓库单独开 session 全文装不下（tight）时每小时一次，不管 lessonsPrinciples 开没开；否则每天一次，归组还要 lessonsPrinciples 开着。

export const UPKEEP_TIGHT_MS = 3600_000;
export const UPKEEP_DAILY_MS = 20 * 3600_000;

export interface UpkeepDeps {
  /** 后台闸门（规矩准入）开着。 */
  gateOpen(): boolean;
  /** 有没有仓库全文装不下（要对每个仓库算一遍送法，不便宜）。 */
  tight(): boolean;
  principlesOn(): boolean;
  /** 上次做的时间（持久化在设置里）。 */
  lastAt(job: "regroup" | "merge"): number;
  setLastAt(job: "regroup" | "merge", at: number): void;
  regroup(): Promise<unknown>;
  mergeRunning(): boolean;
  suggest(): Promise<unknown>;
  log(msg: string, e: unknown): void;
}

/**
 * 每分钟调一次 tick。装不装得下每小时最多算一次（结果记在内存里）：
 * 原则关着又装得下时，归组的时间戳不会更新，不能因此每分钟都对每个仓库重算一遍。
 */
export class LessonUpkeep {
  private checkedAt = Number.NEGATIVE_INFINITY;
  private tight = false;

  constructor(private readonly d: UpkeepDeps) {}

  tick(now: number): void {
    const since = (job: "regroup" | "merge") => now - (this.d.lastAt(job) || 0);
    const due = (job: "regroup" | "merge", tight: boolean) => since(job) > (tight ? UPKEEP_TIGHT_MS : UPKEEP_DAILY_MS);
    // 什么都还不到期（按最短的一小时算）就不必算装不装得下。
    if (!(since("regroup") > UPKEEP_TIGHT_MS || since("merge") > UPKEEP_TIGHT_MS)) return;
    if (!this.d.gateOpen()) return;
    if (now - this.checkedAt >= UPKEEP_TIGHT_MS) {
      this.checkedAt = now;
      try {
        this.tight = this.d.tight();
      } catch (e) {
        this.tight = false;
        this.d.log("lessons: budget check failed", e);
      }
    }
    const tight = this.tight;
    if ((tight || this.d.principlesOn()) && due("regroup", tight)) {
      this.d.setLastAt("regroup", now);
      void this.d.regroup().catch((e: unknown) => this.d.log("lessons: principles regroup failed", e));
    }
    if (due("merge", tight) && !this.d.mergeRunning()) {
      this.d.setLastAt("merge", now);
      void this.d.suggest().catch((e: unknown) => this.d.log("lessons: merge suggestion failed", e));
    }
  }
}
