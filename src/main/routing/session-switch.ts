import type { LimitHit } from "../../shared/availability";
import type { SessionLimitView, SwitchModelResult } from "../../shared/model-routing";
import type { OpenSessionResult, Session } from "../../shared/types";

/** 等终端退出最多这么久，之后不再换（session 可能还在写东西）。 */
export const SWITCH_EXIT_WAIT_MS = 15_000;
/** session 上的撞限提示没有恢复时间时最多挂这么久。 */
export const SESSION_LIMIT_TTL_MS = 6 * 3_600_000;

export type SwitchResult = SwitchModelResult;

export interface SessionSwitchDeps {
  head: (sessionId: string) => Session | null;
  setModel: (sessionId: string, model: string | null) => void;
  /** 这个 session 现在的终端 id；没开着为 null。 */
  termIdOf: (sessionId: string) => string | null;
  kill: (termId: string) => void;
  /** 终端还开着吗。 */
  running: (termId: string) => boolean;
  /** 按 session 的种类（ticket / feature / Butler）用 --resume 重新打开。 */
  reopen: (head: Session) => Promise<OpenSessionResult>;
  /** 这个模型之后用哪个（RoutingService.nextModel）；没有为 null。 */
  nextModel: (current: string | null) => string | null;
  /** 设置里的「撞限自动换下一档」（默认关）。 */
  autoSwitch: () => boolean;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  onChange?: () => void;
  /** 换成功了（记进模型路由的事件记录）。 */
  onSwitched?: (sessionId: string, from: string | null, to: string) => void;
  log?: (msg: string, err?: unknown) => void;
}

interface Limited {
  model: string | null;
  kind: LimitHit["kind"];
  message: string;
  at: number;
  resetsAt: number | null;
}

/**
 * 交互 session 撞限之后（3.0 模型路由）：在 session 行上提示，用户点「换下一档继续」时结束终端、记下新模型、
 * 用 --resume + --model 接着这段对话。设置打开了自动切换时撞限就直接换。
 */
export class SessionModelSwitcher {
  private readonly limited = new Map<string, Limited>();
  private readonly switching = new Set<string>();
  /** 每个 session 最近一次开始换模型的时间：恢复后的记录里还是那条旧报错，它不算新的撞限。 */
  private readonly switchedAt = new Map<string, number>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: SessionSwitchDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 这条撞限记录（at 是记录的时间）早于最近一次换模型：是换之前那条，不是新模型撞的。 */
  staleHit(sessionId: string, at: number): boolean {
    const id = this.d.head(sessionId)?.id ?? sessionId;
    const t = this.switchedAt.get(id);
    return t !== undefined && at <= t;
  }

  /** ActivityMonitor 看到 session 撞限。换模型之前的那条（恢复后又被读到）不算。 */
  noteLimit(sessionId: string, hit: LimitHit, at: number): void {
    const head = this.d.head(sessionId);
    if (!head || this.staleHit(head.id, at)) return;
    this.limited.set(head.id, { model: head.model, kind: hit.kind, message: hit.message, at, resetsAt: hit.resetsAt });
    this.d.onChange?.();
    if (this.d.autoSwitch() && this.d.nextModel(head.model) !== null) {
      void this.switch(head.id).then((r) => {
        if (!r.ok) this.d.log?.(`routing: auto-switching ${head.id} failed (${r.reason})`);
      });
    }
  }

  /** session 行上的提示（过期的去掉）。 */
  views(): SessionLimitView[] {
    const now = this.d.now();
    const out: SessionLimitView[] = [];
    for (const [id, l] of this.limited) {
      const until = l.resetsAt ?? l.at + SESSION_LIMIT_TTL_MS;
      if (until <= now) {
        this.limited.delete(id);
        continue;
      }
      out.push({ sessionId: id, model: l.model, kind: l.kind, message: l.message, at: l.at, resetsAt: l.resetsAt, next: this.d.nextModel(l.model), switching: this.switching.has(id) });
    }
    return out;
  }

  dismiss(sessionId: string): void {
    const head = this.d.head(sessionId);
    if (this.limited.delete(head?.id ?? sessionId)) this.d.onChange?.();
  }

  /** 换成 model（省略时用下一档），用 --resume 接着。 */
  async switch(sessionId: string, model?: string): Promise<SwitchResult> {
    const head = this.d.head(sessionId);
    if (!head) return { ok: false, reason: "no_session" };
    const target = model ?? this.d.nextModel(head.model);
    if (!target) return { ok: false, reason: "no_next" };
    if (this.switching.has(head.id)) return { ok: false, reason: "busy" };
    this.switching.add(head.id);
    this.switchedAt.set(head.id, this.d.now());
    this.d.onChange?.();
    try {
      const term = this.d.termIdOf(head.id);
      if (term) {
        this.d.kill(term);
        const deadline = this.d.now() + SWITCH_EXIT_WAIT_MS;
        while (this.d.running(term)) {
          if (this.d.now() >= deadline) return { ok: false, reason: "still_running" };
          await this.sleep(100);
        }
      }
      this.d.setModel(head.id, target);
      const r = await this.d.reopen({ ...head, model: target });
      if (!r.ok) {
        // 没开起来：记下的模型改回原来的，下次手动重开还是原模型。
        this.d.setModel(head.id, head.model);
        this.d.log?.(`routing: reopening ${head.id} on ${target} failed (${r.reason})`);
        return { ok: false, reason: "open_failed", detail: r.reason };
      }
      this.limited.delete(head.id);
      this.d.log?.(`routing: session ${head.id} switched ${head.model ?? "(default)"} → ${target}`);
      this.d.onSwitched?.(head.id, head.model, target);
      return { ok: true, model: target, termId: r.termId };
    } finally {
      this.switching.delete(head.id);
      this.d.onChange?.();
    }
  }
}
