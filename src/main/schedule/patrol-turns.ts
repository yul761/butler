/** 一轮巡检最多算这么久：Stop 丢了也不会让之后的 send_message 一直被当成巡检发的。 */
export const PATROL_TURN_MAX_MS = 2 * 3600_000;

/**
 * 全局总控正在做的是不是巡检那一轮（BTL-279 复核建议 3）：每日巡检的消息直接输入进去、自己开了一轮以后，到它下一次停下来之前。
 * 这段时间里它用 send_message 发给 epic 总控的，算巡检这类自动发送：不把用户点 × 关掉的 epic 总控拉起来（尊重 userEndedAt）；
 * 总控平时明确发的照旧（insisted）。
 * 只认直接输入（via input）的（第四轮复核，总控定）：hook 在一轮中间送进去的，那一轮是用户或别人开的，用户叫全局总控做的事
 * 不能因为巡检插进来就打不开 epic 总控。从粘贴的那一刻（Mailbox 记的 deliveredAt）算起。
 * 停下之后才记上的不算：它送到的时间不比这次停下晚，那一轮已经结束了，不再开一轮巡检，不然下一轮也会被当成巡检。
 * 终端退出（关掉、/exit、崩溃）时 forget：一轮跟着进程走，记录也不留着。
 *
 * 已知限制：
 * - 标记只在内存里，Shipherd 重启后丢失；已经发出去的消息的标记存在库里（meta.auto）。
 * - 用户在全局总控里 /exit、或者 claude 进程自己退出，和崩溃一样处理：有总控的消息时照常自动恢复（epic 总控也一样，总控定）。
 */
export class PatrolTurns {
  private readonly since = new Map<string, number>();
  /** 每个 head 最近一次停下的时间：比它早送到的巡检消息，那一轮已经结束了。 */
  private readonly stoppedAt = new Map<string, number>();

  constructor(private readonly now: () => number, private readonly maxMs = PATROL_TURN_MAX_MS) {}

  /** 送到了一条消息（Mailbox 的 delivered 回调）：直接输入进去的巡检消息开一轮巡检，别的都不算。 */
  messageDelivered(headId: string, m: { kind: string; via: "hook" | "input" | null; deliveredAt: number | null }): void {
    if (m.kind === "patrol" && m.via === "input") this.delivered(headId, m.deliveredAt ?? this.now());
  }

  /** 巡检消息在 at（粘贴的时刻）送到了这个 head。不比它最近一次停下晚的不算。 */
  delivered(headId: string, at: number): void {
    if (at <= (this.stoppedAt.get(headId) ?? -Infinity)) return;
    this.since.set(headId, Math.min(at, this.now()));
  }

  /** 这个 head 停下来了：巡检那一轮结束。 */
  stopped(headId: string): void {
    this.since.delete(headId);
    this.stoppedAt.set(headId, this.now());
  }

  /** 这个 head 的终端退出了（或者 session 被移走）：两份记录都清掉。 */
  forget(headId: string): void {
    this.since.delete(headId);
    this.stoppedAt.delete(headId);
  }

  /** 记着的 head 数（测试看 forget 有没有清干净）。 */
  get size(): number {
    return new Set([...this.since.keys(), ...this.stoppedAt.keys()]).size;
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
