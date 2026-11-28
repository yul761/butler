/** 一轮巡检最多算这么久：Stop 丢了也不会让之后的 send_message 一直被当成巡检发的。 */
export const PATROL_TURN_MAX_MS = 2 * 3600_000;

/**
 * 全局总控正在做的是不是巡检那一轮（BTL-279 复核建议 3）：每日巡检的消息送到它以后、它下一次停下来之前。
 * 这段时间里它用 send_message 发给 epic 总控的，算巡检这类自动发送：不把用户点 × 关掉的 epic 总控拉起来（尊重 userEndedAt）；
 * 总控平时明确发的照旧（insisted）。
 * 从 Mailbox 记上送到的那一刻起算：hook 在一轮中间拿走的，hook 事件一到就清扫、记上；那个事件丢了的要等 Stop 时或下一次 tick 的清扫，
 * 这之前发的不算巡检（已知限制，巡检先看进度、收件箱，发消息在后面）。
 * Stop 时的清扫才记上的那一条（复核）：它送到的时间（hook 写下 .done 的时刻）不比这次停下晚，那一轮已经结束了，不再开一轮巡检，
 * 不然下一轮（可能是用户明确叫它做的）也会被当成巡检。
 */
export class PatrolTurns {
  private readonly since = new Map<string, number>();
  /** 每个 head 最近一次停下的时间：比它早送到的巡检消息，那一轮已经结束了。 */
  private readonly stoppedAt = new Map<string, number>();

  constructor(private readonly now: () => number, private readonly maxMs = PATROL_TURN_MAX_MS) {}

  /** 巡检消息在 at（送到的时间，hook 送的是 hook 写下的时刻）送到了这个 head。不比它最近一次停下晚的不算。 */
  delivered(headId: string, at: number): void {
    if (at <= (this.stoppedAt.get(headId) ?? -Infinity)) return;
    this.since.set(headId, Math.min(at, this.now()));
  }

  /** 这个 head 停下来了：巡检那一轮结束。 */
  stopped(headId: string): void {
    this.since.delete(headId);
    this.stoppedAt.set(headId, this.now());
  }

  active(headId: string): boolean {
    const at = this.since.get(headId);
    if (at === undefined) return false;
    if (this.now() - at < this.maxMs) return true;
    this.since.delete(headId);
    return false;
  }
}

/** 巡检那一轮里发出去的消息在 meta 里带这个标记（存在库里，重启后恢复时也认得）。 */
export const PATROL_AUTO = "patrol";

export const sentByPatrol = (meta: unknown): boolean =>
  typeof meta === "object" && meta !== null && (meta as { auto?: unknown }).auto === PATROL_AUTO;
