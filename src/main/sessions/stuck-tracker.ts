/** 本地检查的间隔：每隔这么久采一次样。 */
export const STUCK_CHECK_MS = 180_000;
/** 判断为没卡住之后，这么久内不再请 Claude 判断。 */
export const STUCK_REJUDGE_MS = 600_000;
/** 子进程累计 CPU 时间至少变化这么多才算有变化。 */
export const CPU_CHANGE_MS = 2000;
/** 连续这么多次检查没有变化，才算可疑。 */
const SUSPECT_COUNT = 2;

export interface StuckSample {
  transcriptSize: number;
  outputSize: number;
  /** 子进程树累计 CPU 毫秒；读不到时为 null，只看另外两项。 */
  childCpuMs: number | null;
  /** 只有在跑、没在等人确认的 ticket session 才参与检测。 */
  eligible: boolean;
}

export interface StuckVerdict {
  stuck: boolean;
  reason: string;
  action: string;
}

interface Entry {
  last: StuckSample;
  lastAt: number;
  /** 连续没变化的检查次数。 */
  quiet: number;
  stuck: boolean;
  reason: string | null;
  action: string | null;
  /** 用户点了“忽略”：有变化之前不再标记。 */
  dismissed: boolean;
  /** 这个时间之前不再请 Claude 判断（上一次判断为没卡住）。 */
  noJudgeUntil: number;
}

/** 卡住判断的纯状态机：只管样本和结论，不碰进程、文件和 Claude。只存内存。 */
export class StuckTracker {
  private entries = new Map<string, Entry>();

  /** 记一次样本。返回 true 表示现在该请 Claude 判断。 */
  observe(id: string, sample: StuckSample, now: number): boolean {
    if (!sample.eligible) {
      this.entries.delete(id);
      return false;
    }
    let e = this.entries.get(id);
    // 隔得太久（应用休眠、暂停检测）：之前的“没变化”不能和现在连起来。
    if (e && now - e.lastAt > STUCK_CHECK_MS * 2) e = undefined;
    if (!e) {
      // 第一次观察只是基线，没有可比较的对象，不算没变化。
      this.entries.set(id, { last: sample, lastAt: now, quiet: 0, stuck: false, reason: null, action: null, dismissed: false, noJudgeUntil: this.entries.get(id)?.noJudgeUntil ?? 0 });
      return false;
    }
    const changed = this.changed(e.last, sample);
    e.last = sample;
    e.lastAt = now;
    if (changed) {
      e.quiet = 0;
      e.stuck = false;
      e.reason = null;
      e.action = null;
      e.dismissed = false;
      return false;
    }
    e.quiet++;
    return e.quiet >= SUSPECT_COUNT && !e.stuck && !e.dismissed && now >= e.noJudgeUntil;
  }

  /** 记下 Claude 的判断。verdict 为 null（调用失败）时什么都不改，下一轮可疑时再试。 */
  judged(id: string, verdict: StuckVerdict | null, now: number): "newly_stuck" | "none" {
    const e = this.entries.get(id);
    if (!e || !verdict) return "none";
    if (!verdict.stuck) {
      e.noJudgeUntil = now + STUCK_REJUDGE_MS;
      return "none";
    }
    if (e.dismissed) return "none";
    const fresh = !e.stuck;
    e.stuck = true;
    e.reason = verdict.reason;
    e.action = verdict.action;
    return fresh ? "newly_stuck" : "none";
  }

  /** 用户忽略：清掉标记，有变化之前不再标记。 */
  dismiss(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.stuck = false;
    e.reason = null;
    e.action = null;
    e.dismissed = true;
  }

  state(id: string): { stuck: boolean; reason: string | null; action: string | null } {
    const e = this.entries.get(id);
    return e ? { stuck: e.stuck, reason: e.reason, action: e.action } : { stuck: false, reason: null, action: null };
  }

  forget(id: string): void {
    this.entries.delete(id);
  }

  private changed(a: StuckSample, b: StuckSample): boolean {
    if (a.transcriptSize !== b.transcriptSize || a.outputSize !== b.outputSize) return true;
    return a.childCpuMs !== null && b.childCpuMs !== null && Math.abs(b.childCpuMs - a.childCpuMs) >= CPU_CHANGE_MS;
  }
}
