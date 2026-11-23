import type { OpenShipherdSessionRequest, OpenSessionResult, Session } from "../../shared/types";
import { JOB_PATROL, type JobsRepo } from "../db/jobs-repo";
import type { Mailbox } from "../mailbox/mailbox";
import { parseTime } from "../settings/settings-values";
import { atTime, localDate } from "./calendar";

export interface ShipherdPatrolDeps {
  /** shipherdPatrolTime 设置（HH:MM；空 = 关）。 */
  time: () => string;
  jobs: Pick<JobsRepo, "get" | "record">;
  now: () => number;
  /** 正在跑的 Shipherd 总控（SessionService.runningShipherd）。 */
  running: () => Session | null;
  /** 最近用过、没隐藏的 Shipherd 总控 session：没有在跑的时恢复它。 */
  latest: () => Session | null;
  open: (req: OpenShipherdSessionRequest) => Promise<OpenSessionResult>;
  /** 巡检排进全局总控的信箱（BTL-248，kind patrol，ref `patrol:<时刻>`）。 */
  mailbox: Pick<Mailbox, "send" | "withdraw">;
  /** 终端现在的 session（head）id。 */
  headOf: (termId: string) => string;
  /** 刚为巡检打开的终端：信箱里排着的当第一条输入交进去（Mailbox.opened 加 submitTask）。返回送到没有。 */
  opened: (sessionId: string, termId: string) => Promise<boolean>;
  /** 巡检消息（按当前语言）。 */
  message: () => string;
  onChange?: () => void;
  log?: (msg: string, err?: unknown) => void;
}

/** 记的运行时间比现在晚这么多：时钟被往回校正过，不算今天跑过（和晚间任务一样）。 */
const CLOCK_SKEW_MS = 86_400_000;

/**
 * Shipherd 总控的每日巡检（BTL-190 第 5 点）。不放进 Scheduler：那边是串行跑完就记结果的任务。复用的是 Scheduler 的触发时机
 * （启动、唤醒、解锁、每分钟的 tick）、jobs 表和日历工具。
 *
 * 到期：今天的巡检时刻已过，而 jobs 里记的上次巡检早于这个时刻（从没跑过也算）。睡过了的话醒来以后当天补，过了零点就不补昨天的。
 * 排进全局总控的信箱就算当天跑过（BTL-248）：开着的在忙时下一次调用工具读到，停着的直接输入。
 * 没开：先排进要接着用的那个 session 的信箱（hold），再恢复它（没有就新开），排着的当第一条消息交过去；开不了当天记失败，排着的撤回。
 */
export class ShipherdPatrol {
  private inflight: Promise<void> | null = null;

  constructor(private readonly d: ShipherdPatrolDeps) {}

  /** 同时到来的 check 共用一次。永不 reject。 */
  check(): Promise<void> {
    if (this.inflight) return this.inflight;
    const p = this.run().catch((e: unknown) => this.d.log?.("shipherd patrol failed", e)).finally(() => {
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

  private send(slot: number, to: string, hold = false): void {
    this.d.mailbox.send({ kind: "patrol", from: null, to, featureId: null, body: this.d.message(), ref: `patrol:${slot}`, hold });
  }

  private async run(): Promise<void> {
    const slot = this.dueSlot(this.d.now());
    if (slot === null) return;
    const running = this.d.running();
    if (running) {
      this.send(slot, running.id);
      return this.record("ok", null);
    }
    const latest = this.d.latest();
    // 先排进接着的那个的信箱：hold，马上要打开它，不让信箱再去唤醒一次。
    if (latest) this.send(slot, latest.id, true);
    const r = await this.d.open(latest ? { sessionId: latest.id } : {});
    if (!r.ok) {
      this.d.mailbox.withdraw(`patrol:${slot}`);
      return this.record("failed", r.reason);
    }
    const head = this.d.headOf(r.termId);
    // 刚好别处（例如用户点开）先开了它：照常排队（不 hold），在忙走 hook、停着直接输入。
    if (r.alreadyOpen) {
      this.send(slot, head);
      return this.record("ok", null);
    }
    this.d.onChange?.();
    if (!latest) this.send(slot, head, true);
    this.record("ok", null);
    // 没交进去也还排着：在忙的 hook 送，停下来时信箱再送。
    if (!(await this.d.opened(head, r.termId))) this.d.log?.("shipherd patrol: first message not typed in yet; it stays queued");
  }

  private record(status: "ok" | "failed", error: string | null): void {
    this.d.jobs.record(JOB_PATROL, this.d.now(), status, error);
    this.d.onChange?.();
  }
}
