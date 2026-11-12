import type { OpenButlerSessionRequest, OpenSessionResult, Session } from "../../shared/types";
import { JOB_PATROL, type JobsRepo } from "../db/jobs-repo";
import type { DeliveryGuard } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { parseTime } from "../settings/settings-values";
import { atTime, localDate } from "./calendar";

export interface ButlerPatrolDeps {
  /** butlerPatrolTime 设置（HH:MM；空 = 关）。 */
  time: () => string;
  jobs: Pick<JobsRepo, "get" | "record">;
  now: () => number;
  /** 正在跑的 Butler 总控（SessionService.runningButler）。 */
  running: () => Session | null;
  /** 最近用过、没隐藏的 Butler 总控 session：没有在跑的时恢复它。 */
  latest: () => Session | null;
  open: (req: OpenButlerSessionRequest) => Promise<OpenSessionResult>;
  guard: Pick<DeliveryGuard, "check" | "recheckAfter">;
  /** 往开着的终端里贴（pty.deliver，带 guard 的 recheck）。 */
  deliver: (termId: string, text: string, recheck: () => boolean) => Promise<DeliverResult>;
  /** 刚开的终端：当第一条消息交过去（等输入框就绪）。 */
  submit: (termId: string, text: string) => Promise<DeliverResult>;
  /** 巡检消息（按当前语言）。 */
  message: () => string;
  onChange?: () => void;
  log?: (msg: string, err?: unknown) => void;
}

/** 记的运行时间比现在晚这么多：时钟被往回校正过，不算今天跑过（和晚间任务一样）。 */
const CLOCK_SKEW_MS = 86_400_000;

/**
 * Butler 总控的每日巡检（BTL-190 第 5 点）。不放进 Scheduler：那边是串行跑完就记结果的任务，巡检可能要等 session 停下来，
 * 等的时候不能挡住晚间 handoff。复用的是 Scheduler 的触发时机（启动、唤醒、解锁、每分钟的 tick）、jobs 表和日历工具。
 *
 * 到期：今天的巡检时刻已过，而 jobs 里记的上次巡检早于这个时刻（从没跑过也算）。睡过了的话醒来以后当天补，过了零点就不补昨天的。
 * Butler 总控开着：过 DeliveryGuard，忙就不记，下一次 check（下一分钟的 tick、Stop hook）再试。
 * 没开：恢复最近的 Butler 总控（没有就新开），把巡检当第一条消息交过去；一天最多开一次，开的 session 没收到就被关了，当天放弃。
 */
export class ButlerPatrol {
  private inflight: Promise<void> | null = null;
  /** 为哪一天的巡检开过 session（时刻的毫秒数）：一天只开一次。 */
  private openedFor: number | null = null;
  /** 哪一天的巡检已经在日志里记过“在等”：不每分钟记一行。 */
  private loggedWait: number | null = null;

  constructor(private readonly d: ButlerPatrolDeps) {}

  /** 同时到来的 check 共用一次。永不 reject。 */
  check(): Promise<void> {
    if (this.inflight) return this.inflight;
    const p = this.run().catch((e: unknown) => this.d.log?.("butler patrol failed", e)).finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  /** 今天巡检的时刻，到期时返回；关着、没到点、今天已经跑过时为 null。 */
  private dueSlot(now: number): number | null {
    const t = parseTime(this.d.time());
    if (!t) return null;
    const slot = atTime(localDate(now), t.h, t.m);
    if (now < slot) return null;
    const last = this.d.jobs.get(JOB_PATROL).lastRunAt;
    if (last !== null && last >= slot && last - now <= CLOCK_SKEW_MS) return null;
    return slot;
  }

  private async run(): Promise<void> {
    const slot = this.dueSlot(this.d.now());
    if (slot === null) return;
    const running = this.d.running();
    if (running) return this.deliver(slot, running);
    if (this.openedFor === slot) return this.record("failed", "closed before the patrol was delivered");
    this.openedFor = slot;
    const latest = this.d.latest();
    const r = await this.d.open(latest ? { sessionId: latest.id } : {});
    if (!r.ok) return this.record("failed", r.reason);
    this.d.onChange?.();
    const res = await this.d.submit(r.termId, this.d.message());
    if (res === "sent") return this.record("ok", null);
    // 没送到但终端还开着：下一次 check 走 guard 再送；关了就当天放弃（见上面）。
    this.d.log?.(`butler patrol: first message not delivered (${res}), will retry`);
  }

  private async deliver(slot: number, running: Session): Promise<void> {
    const g = this.d.guard.check(running.id);
    if (!g.ok) {
      if (this.loggedWait !== slot) this.d.log?.(`butler patrol: waiting, butler session ${running.id} is ${g.block}`);
      this.loggedWait = slot;
      return;
    }
    const res = await this.d.deliver(g.termId, this.d.message(), this.d.guard.recheckAfter(running.id, g));
    if (res === "sent") return this.record("ok", null);
    this.d.log?.(`butler patrol: not delivered (${res}), will retry`);
  }

  private record(status: "ok" | "failed", error: string | null): void {
    this.d.jobs.record(JOB_PATROL, this.d.now(), status, error);
    this.d.onChange?.();
  }
}
