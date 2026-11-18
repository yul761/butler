import type { CostBreakerView, CostEventKind, CostPauseScope, CostPolicy, CostResumeResult, CostSubjectKind, CostUnit } from "../../shared/cost";
import type { RegistryModel, TaskId } from "../../shared/model-routing";
import type { CostRepo, CostRow } from "../db/cost-repo";
import type { CostVerdict } from "../handoff/headless-exec";
import type { CostRow as UsageCostRow } from "../db/usage-repo";
import { spendTotal } from "../routing/spend";

/** 暂停以后这么久还在花钱、用户也没在终端里打字：结束终端（之后能 --resume 接上）。 */
export const COST_STOP_AFTER_MS = 90_000;
/** 「接着做」这句话最多等这么久递进去（session 刚重开、还没停下来等输入时会先递不进去）。 */
export const COST_NUDGE_TTL_MS = 10 * 60_000;

/** 熔断要知道的一个 session（按链的根 id 找）。 */
export interface CostSessionInfo {
  rootId: string;
  /** 现在的 head（换新、换模型以后会变）。 */
  headId: string;
  ticketKey: string | null;
  title: string;
  /** 链上所有 id：用量按它们汇总。 */
  chainIds: string[];
  /** 解析上限用的仓库（ticket 的仓库；feature / epic / Butler 总控为空，按全局）。 */
  repos: string[];
  model: string | null;
  /** 终端开着。 */
  open: boolean;
}

export interface CostTicketInfo {
  key: string;
  title: string;
  repos: string[];
  /** 这个 ticket 所有 session 链上的 id。 */
  sessionIds: string[];
  /** 这个 ticket 下开着终端的 session（链的根 id）。 */
  openRoots: string[];
}

export interface CostBreakerDeps {
  repo: CostRepo;
  policy: { forRepos(slugs: readonly string[]): CostPolicy; anyCap(): boolean };
  usage: { totalsFor(o: { sessionIds?: readonly string[]; ticketKey?: string | null }): UsageCostRow[] };
  registry: () => readonly RegistryModel[];
  /** 用到上限的多少（百分比）先提醒：模型路由 routingThresholds 的第一个值。 */
  warnPercent: () => number;
  /** 任何 id → 它所在链的根 id；不认识为 null。 */
  rootOf: (sessionId: string) => string | null;
  session: (rootId: string) => CostSessionInfo | null;
  ticket: (key: string) => CostTicketInfo | null;
  /** 现在要看的：开着终端的 session（根 id）和它们的 ticket。 */
  active: () => { sessions: string[]; tickets: string[] };
  /** 这个模型之后用哪个（A 的 RoutingService.nextModel）；没有为 null。 */
  nextModel: (model: string | null) => string | null;
  /** A 的 SessionModelSwitcher.switch：结束终端、换模型 --resume 接上。 */
  switchModel: (headId: string, model: string) => Promise<{ ok: true; model: string } | { ok: false; reason: string }>;
  /** 正在跑一轮：发 Esc 打断。 */
  busy: (headId: string) => boolean;
  interrupt: (headId: string) => void;
  /** 结束终端（和休眠一样，之后能 --resume 接上）。 */
  kill: (headId: string) => void;
  /** 用户最近一次往这个 session 的终端里打字的时间；没有为 0。 */
  lastUserInputAt: (headId: string) => number;
  /** 过 DeliveryGuard 往 session 里递一句话；递进去了返回 true（现在递不了返回 false，下次再试）。 */
  nudge: (headId: string, text: string) => Promise<boolean>;
  /** 调度器：这个 ticket 的后台任务停下 / 可以重新跑了。 */
  scheduler?: { yieldTicket(key: string): void; changed(): void };
  texts: () => { continueAfterDowngrade: (model: string) => string; continueAfterRaise: (cap: string) => string };
  now: () => number;
  stopAfterMs?: number;
  onChange?: () => void;
  /** 熔断的每一步（H 的 recordEvent 合并后接这里，契约 4.7）。 */
  onEvent?: (kind: CostEventKind, refs: { subjectKind: CostSubjectKind; subjectId: string; spent: number; cap: number | null; unit: CostUnit; detail?: string }) => void;
  log?: (msg: string, err?: unknown) => void;
}

interface Measured {
  kind: CostSubjectKind;
  id: string;
  policy: CostPolicy;
  /** 策略里的上限（null 不限）。 */
  policyCap: number | null;
  spent: number;
  partial: boolean;
  title: string;
  /** 要动作的交互 session（session 自己；ticket 下开着的）。 */
  roots: string[];
  ticketKey: string | null;
}

/** 熔断不拦的后台调用。 */
const EXEMPT_TASKS: ReadonlySet<TaskId> = new Set<TaskId>(["stuck_judge", "needs_you"]);

const fmt = (n: number, unit: CostUnit) => (unit === "usd" ? `$${n.toFixed(2)}` : `${Math.round(n).toLocaleString("en-US")} tokens`);

/**
 * 成本熔断（工作流 L，设计 addendum 第 4 节）：每个 session（整条链）和 ticket 的花费到上限时先降档、还超就暂停。
 * 和卡住判断并列：卡住判断管「没进展」，这里只管「花了多少」，互不依赖。
 */
export class CostBreaker {
  private readonly nudges = new Map<string, { text: string; until: number }>();
  private readonly switching = new Set<string>();
  /** 这一遍里已经换过模型的 session（session 和 ticket 同时到上限时只换一档）：root → 换之前 / 之后。 */
  private switchedNow = new Map<string, { from: string | null; to: string }>();
  private checking = false;
  /** 正在看的时候又被叫了：看完再来一遍（null 表示全看）。 */
  private again: { sessions: Set<string>; tickets: Set<string> } | null | undefined;

  constructor(private readonly d: CostBreakerDeps) {}

  private stopAfter(): number {
    return this.d.stopAfterMs ?? COST_STOP_AFTER_MS;
  }

  // ---- 给别处问的 ----

  private row(kind: CostSubjectKind, id: string): CostRow | null {
    try {
      return this.d.repo.get(kind, id);
    } catch (e) {
      this.d.log?.("cost: reading the breaker state failed", e);
      return null;
    }
  }

  /** 这个 session（链上任何一个 id）被熔断暂停了，Butler 不要往里自动输入（DeliveryGuard 的 cost_paused）。 */
  sessionPaused(sessionId: string): boolean {
    const root = this.d.rootOf(sessionId);
    if (!root) return false;
    const s = this.row("session", root);
    if (s?.state === "paused" && s.scope === "session") return true;
    const key = this.d.session(root)?.ticketKey;
    if (!key) return false;
    const t = this.row("ticket", key);
    return t?.state === "paused" && t.scope === "session";
  }

  /**
   * headless 调用前问（HeadlessExecDeps.costGate）：这个 ticket 的后台调用照常、降档还是不跑。
   * 卡住判断和「需要你」判断不受影响：它们很便宜，停了用户就看不到 session 卡住了、在等他。
   */
  gate(o: { task: TaskId; ticketKey: string | null }): CostVerdict {
    if (!o.ticketKey || EXEMPT_TASKS.has(o.task)) return "ok";
    return this.ticketVerdict(o.ticketKey);
  }

  /** 调度器问的：这个 ticket 的后台任务被停了吗（N 开工前也问它）。 */
  allowBackground(ticketKey: string): boolean {
    return this.ticketVerdict(ticketKey) !== "pause";
  }

  private ticketVerdict(key: string): CostVerdict {
    const t = this.row("ticket", key);
    if (t?.state === "paused") return "pause";
    let verdict: CostVerdict = t?.state === "downgraded" ? "downgrade" : "ok";
    // session 到上限（整个 session 或只停后台都一样）：它所在 ticket 的后台调用也停 / 降档。
    try {
      for (const r of this.d.repo.all()) {
        if (r.subjectKind !== "session") continue;
        if (this.d.session(r.subjectId)?.ticketKey !== key) continue;
        if (r.state === "paused") return "pause";
        if (r.state === "downgraded") verdict = "downgrade";
      }
    } catch (e) {
      this.d.log?.("cost: reading the breaker state failed", e);
    }
    return verdict;
  }

  // ---- 计算 ----

  private measure(kind: CostSubjectKind, id: string): Measured | null {
    if (kind === "session") {
      const s = this.d.session(id);
      if (!s) return null;
      const policy = this.d.policy.forRepos(s.repos);
      const { spent, partial } = spendTotal(this.d.usage.totalsFor({ sessionIds: s.chainIds }), this.d.registry(), policy.unit);
      return { kind, id, policy, policyCap: policy.sessionCap, spent, partial, title: s.title, roots: [id], ticketKey: s.ticketKey };
    }
    const t = this.d.ticket(id);
    if (!t) return null;
    const policy = this.d.policy.forRepos(t.repos);
    const { spent, partial } = spendTotal(this.d.usage.totalsFor({ sessionIds: t.sessionIds, ticketKey: id }), this.d.registry(), policy.unit);
    return { kind, id, policy, policyCap: policy.ticketCap, spent, partial, title: t.title, roots: t.openRoots, ticketKey: id };
  }

  /**
   * 看一遍（用量扫描写完、记了 headless 用量、session 停下来、设置改了都调）。没设任何上限时只清掉旧状态。
   * subjects 不给就看所有开着的和有状态的。
   */
  async check(subjects?: { sessions?: string[]; tickets?: string[] }): Promise<void> {
    if (this.checking) {
      // 不丢：记下来，这一遍完了再看。全看的请求盖过部分的。
      if (!subjects || this.again === null) this.again = null;
      else {
        const a = (this.again ??= { sessions: new Set(), tickets: new Set() });
        for (const id of subjects.sessions ?? []) a.sessions.add(id);
        for (const k of subjects.tickets ?? []) a.tickets.add(k);
      }
      return;
    }
    this.checking = true;
    this.switchedNow = new Map();
    try {
      let rows: CostRow[] = [];
      try {
        rows = this.d.repo.all();
      } catch (e) {
        this.d.log?.("cost: reading the breaker state failed", e);
      }
      const any = this.d.policy.anyCap();
      if (!any && rows.length === 0) return;
      const active = subjects ?? this.d.active();
      const todo = new Map<string, [CostSubjectKind, string]>();
      for (const id of active.sessions ?? []) todo.set(`session:${id}`, ["session", id]);
      for (const key of active.tickets ?? []) todo.set(`ticket:${key}`, ["ticket", key]);
      if (!subjects) for (const r of rows) todo.set(`${r.subjectKind}:${r.subjectId}`, [r.subjectKind, r.subjectId]);
      let changed = false;
      for (const [kind, id] of todo.values()) {
        try {
          if (await this.evaluate(kind, id)) changed = true;
        } catch (e) {
          this.d.log?.(`cost: checking ${kind} ${id} failed`, e);
        }
      }
      await this.flushNudges();
      if (changed) this.d.onChange?.();
    } finally {
      this.checking = false;
    }
    const again = this.again;
    if (again !== undefined) {
      this.again = undefined;
      await this.check(again === null ? undefined : { sessions: [...again.sessions], tickets: [...again.tickets] });
    }
  }

  /** session 停下来等输入了：压着的「接着做」现在可能递得进去。 */
  async sessionStopped(sessionId: string): Promise<void> {
    const root = this.d.rootOf(sessionId);
    if (root && this.nudges.has(root)) await this.flushNudges([root]);
  }

  private event(m: Measured, kind: CostEventKind, cap: number | null, detail?: string): void {
    const at = this.d.now();
    const unit = m.policy.unit;
    try {
      this.d.repo.event({ at, subjectKind: m.kind, subjectId: m.id, kind, spent: m.spent, cap, unit, detail: detail ?? null });
    } catch (e) {
      this.d.log?.("cost: recording an event failed", e);
    }
    this.d.log?.(`cost: ${m.kind} ${m.id} ${kind} (${fmt(m.spent, unit)} of ${cap === null ? "no cap" : fmt(cap, unit)}${detail ? `; ${detail}` : ""})`);
    try {
      this.d.onEvent?.(kind, { subjectKind: m.kind, subjectId: m.id, spent: m.spent, cap, unit, ...(detail && { detail }) });
    } catch (e) {
      this.d.log?.("cost: the event hook threw", e);
    }
  }

  /** 返回状态有没有变。 */
  private async evaluate(kind: CostSubjectKind, id: string): Promise<boolean> {
    const prev = this.row(kind, id);
    const m = this.measure(kind, id);
    const now = this.d.now();
    if (!m) {
      // 对象没了（session 删了、ticket 删了）：状态也删掉。
      if (prev) this.d.repo.delete(kind, id);
      return prev !== null;
    }
    const unit = m.policy.unit;
    // 策略的上限（或单位）变了：用户提高过的作废，按新的算。
    const policyChanged = prev !== null && (prev.cap !== m.policyCap || prev.unit !== unit);
    const raised = policyChanged ? null : (prev?.raisedCap ?? null);
    const cap = m.policyCap === null ? null : raised ?? m.policyCap;
    // 策略变了也接着原来的状态走：暂停着的、新上限还是不够就还停着（不会再降一档、把暂停冲掉）。
    const base: CostRow = prev
      ? {
          ...prev, spent: m.spent, partial: m.partial,
          ...(policyChanged && { raisedCap: null }),
          // 单位换了：暂停时的花费也换成新单位，不然「暂停以后还在花」的比较没有意义。
          ...(prev.unit !== unit && prev.pausedSpent !== null && { pausedSpent: m.spent }),
        }
      : {
          subjectKind: kind, subjectId: id, state: "ok", cap: m.policyCap, raisedCap: null, unit, spent: m.spent, partial: m.partial, scope: m.policy.pauseScope,
          fromModel: null, toModel: null, trippedAt: null, pausedAt: null, pausedSpent: null, stoppedAt: null, takenOverAt: null, updatedAt: now,
        };
    const wasPaused = prev?.state === "paused";

    // 没上限：状态删掉（暂停着的解除）。
    if (cap === null) {
      if (!prev) return false;
      this.d.repo.delete(kind, id);
      if (wasPaused) {
        this.event(m, "resume", null, "cap removed in settings");
        this.afterResume(m, prev, null);
      }
      return true;
    }
    // 上限以下（还没到、提高过、策略放宽了）：到提醒线是 warned，否则 ok。降过的档不升回。
    if (m.spent < cap) {
      const warned = m.spent >= (cap * this.d.warnPercent()) / 100;
      if (!prev && !warned) return false;
      const next: CostRow = {
        ...base, cap: m.policyCap, raisedCap: raised, unit, state: warned ? "warned" : "ok", scope: m.policy.pauseScope,
        pausedAt: null, pausedSpent: null, stoppedAt: null, takenOverAt: null, updatedAt: now,
      };
      if (warned && prev?.state !== "warned") this.event(m, "warn", cap);
      this.d.repo.put(next);
      if (wasPaused) {
        this.event(m, "resume", cap, "cap raised in settings");
        this.afterResume(m, prev, cap);
      }
      return prev === null || prev.state !== next.state || prev.spent !== next.spent;
    }

    // 到上限了。
    const policy = m.policy;
    const graceCap = cap * (1 + policy.graceAfterDowngradePercent / 100);
    let row: CostRow = { ...base, cap: m.policyCap, raisedCap: raised, unit, scope: base.state === "paused" ? base.scope : policy.pauseScope, updatedAt: now };
    if (row.state === "ok" || row.state === "warned") {
      if (policy.action === "downgrade_then_pause") {
        const down = await this.downgrade(m, policy.pauseScope);
        if (down.ok) {
          row = { ...row, state: "downgraded", trippedAt: now, fromModel: down.from, toModel: down.to };
          this.d.repo.put(row);
          this.event(m, "downgrade", cap, down.to ? `${down.from ?? "default"} → ${down.to}` : "background calls plan one tier lower");
          if (m.ticketKey) this.d.scheduler?.changed();
          return true;
        }
      }
      row = { ...row, trippedAt: now };
      return this.pause(m, row, cap);
    }
    if (row.state === "downgraded") {
      if (m.spent >= graceCap) return this.pause(m, row, cap);
      this.d.repo.put(row);
      return prev?.spent !== row.spent;
    }
    // 已经暂停：看要不要结束终端、用户是不是自己接手了。
    return this.escalate(m, row, cap);
  }

  /** 降一档：session 换下一档模型；ticket 的后台调用按 soft 规划（gate 返回 downgrade），开着的 session 也逐个换。 */
  private async downgrade(m: Measured, scope: CostPauseScope): Promise<{ ok: true; from: string | null; to: string | null } | { ok: false }> {
    if (scope === "background") return { ok: true, from: null, to: null };
    let first: { from: string | null; to: string } | null = null;
    for (const root of m.roots) {
      const done = this.switchedNow.get(root);
      if (done) {
        // 这一遍已经因为另一个上限换过了：算降过，不再往下换。
        first ??= done;
        continue;
      }
      const s = this.d.session(root);
      if (!s || !s.open || this.switching.has(root)) continue;
      const from = s.model;
      const next = this.d.nextModel(from);
      if (!next) continue;
      this.switching.add(root);
      try {
        const r = await this.d.switchModel(s.headId, next);
        if (r.ok) {
          first ??= { from, to: r.model };
          this.switchedNow.set(root, { from, to: r.model });
          this.nudges.set(root, { text: this.d.texts().continueAfterDowngrade(r.model), until: this.d.now() + COST_NUDGE_TTL_MS });
        } else this.d.log?.(`cost: switching ${s.headId} to ${next} failed (${r.reason})`);
      } catch (e) {
        this.d.log?.(`cost: switching ${s.headId} failed`, e);
      } finally {
        this.switching.delete(root);
      }
    }
    if (first) return { ok: true, ...first };
    // ticket：交互 session 降不了也还有后台调用可以降。
    return m.kind === "ticket" ? { ok: true, from: null, to: null } : { ok: false };
  }

  private pause(m: Measured, row: CostRow, cap: number): boolean {
    const now = this.d.now();
    const next: CostRow = { ...row, state: "paused", pausedAt: now, pausedSpent: m.spent, stoppedAt: null, takenOverAt: null };
    this.d.repo.put(next);
    this.event(m, "pause", cap, next.scope === "background" ? "background only" : undefined);
    if (next.scope === "session") {
      for (const root of m.roots) {
        const s = this.d.session(root);
        if (!s?.open) continue;
        this.nudges.delete(root);
        try {
          if (this.d.busy(s.headId)) this.d.interrupt(s.headId);
        } catch (e) {
          this.d.log?.(`cost: interrupting ${s.headId} failed`, e);
        }
      }
    }
    if (m.ticketKey) this.d.scheduler?.yieldTicket(m.ticketKey);
    return true;
  }

  private escalate(m: Measured, row: CostRow, cap: number): boolean {
    const now = this.d.now();
    let next = row;
    if (row.scope === "session" && row.pausedAt !== null && row.takenOverAt === null) {
      const typed = m.roots.some((root) => {
        const s = this.d.session(root);
        return s?.open === true && this.d.lastUserInputAt(s.headId) > row.pausedAt!;
      });
      if (typed) {
        next = { ...next, takenOverAt: now };
        this.event(m, "takeover", cap);
      } else if (row.stoppedAt === null && now - row.pausedAt >= this.stopAfter() && m.spent > (row.pausedSpent ?? 0)) {
        // 只结束暂停以后还在跑的终端：Esc 之后安静了的（晚到的用量扫描、重启后重新打开的）不算还在花。
        let killed = 0;
        for (const root of m.roots) {
          const s = this.d.session(root);
          if (!s?.open || !this.busySafe(s.headId)) continue;
          try {
            this.d.kill(s.headId);
            killed++;
          } catch (e) {
            this.d.log?.(`cost: stopping ${s.headId} failed`, e);
          }
        }
        if (killed > 0) {
          next = { ...next, stoppedAt: now };
          this.event(m, "stop", cap, `still spending ${Math.round(this.stopAfter() / 1000)}s after the pause`);
        }
      }
    }
    this.d.repo.put(next);
    return next.takenOverAt !== row.takenOverAt || next.stoppedAt !== row.stoppedAt;
  }

  private busySafe(headId: string): boolean {
    try {
      return this.d.busy(headId);
    } catch {
      return false;
    }
  }

  /** 暂停解除以后：session 递「继续」，后台任务重新跑。 */
  private afterResume(m: Measured, prev: CostRow | null, cap: number | null): void {
    if (prev?.scope === "session" && prev.stoppedAt === null) {
      const text = this.d.texts().continueAfterRaise(cap === null ? "—" : fmt(cap, m.policy.unit));
      for (const root of m.roots) this.nudges.set(root, { text, until: this.d.now() + COST_NUDGE_TTL_MS });
    }
    if (m.ticketKey) this.d.scheduler?.changed();
  }

  private async flushNudges(only?: string[]): Promise<void> {
    const now = this.d.now();
    for (const [root, n] of [...this.nudges]) {
      if (only && !only.includes(root)) continue;
      if (n.until < now) {
        this.nudges.delete(root);
        continue;
      }
      if (this.nudges.get(root) !== n) continue; // 别的一遍已经递了（或换了一句）
      if (this.sessionPaused(root)) continue;
      const s = this.d.session(root);
      if (!s?.open) continue;
      // 先拿走再递：两遍同时跑（check 和 sessionStopped）时同一句不会递两次；没递进去再放回（没被换掉的话）。
      this.nudges.delete(root);
      let sent = false;
      try {
        sent = await this.d.nudge(s.headId, n.text);
      } catch (e) {
        this.d.log?.(`cost: nudging ${s.headId} failed`, e);
      }
      if (!sent && !this.nudges.has(root)) this.nudges.set(root, n);
    }
  }

  // ---- 用户操作 ----

  /** 「继续并提高上限」：新上限 = max(上限, 已花) + 上限 × raisePercent%。降过的档不升回。 */
  async resume(kind: CostSubjectKind, id: string): Promise<CostResumeResult> {
    const prev = this.row(kind, id);
    if (!prev) return { ok: false, reason: "not_found" };
    if (prev.state !== "paused" && prev.state !== "downgraded") return { ok: false, reason: "not_tripped" };
    const m = this.measure(kind, id);
    if (!m || m.policyCap === null) {
      this.d.repo.delete(kind, id);
      this.d.onChange?.();
      return { ok: false, reason: "not_found" };
    }
    const cap = prev.raisedCap ?? m.policyCap;
    const raised = Math.max(cap, m.spent) + (cap * m.policy.raisePercent) / 100;
    const next: CostRow = {
      ...prev, state: "ok", cap: m.policyCap, raisedCap: raised, unit: m.policy.unit, spent: m.spent, partial: m.partial,
      pausedAt: null, pausedSpent: null, stoppedAt: null, takenOverAt: null, updatedAt: this.d.now(),
    };
    this.d.repo.put(next);
    this.event(m, "raise", raised, `${fmt(cap, m.policy.unit)} → ${fmt(raised, m.policy.unit)}`);
    if (prev.state === "paused") {
      this.event(m, "resume", raised);
      if (prev.scope === "session") {
        for (const root of m.roots) this.nudges.set(root, { text: this.d.texts().continueAfterRaise(fmt(raised, m.policy.unit)), until: this.d.now() + COST_NUDGE_TTL_MS });
      }
    }
    if (m.ticketKey) this.d.scheduler?.changed();
    await this.flushNudges(m.roots);
    this.d.onChange?.();
    return { ok: true, cap: raised };
  }

  // ---- 显示 ----

  /** 「现在」页、session 行、托盘：不是 ok 的状态。warned / downgraded 只显示开着的；暂停的一直显示到恢复。 */
  views(): CostBreakerView[] {
    let rows: CostRow[];
    try {
      rows = this.d.repo.all();
    } catch (e) {
      this.d.log?.("cost: reading the breaker state failed", e);
      return [];
    }
    const out: CostBreakerView[] = [];
    for (const r of rows) {
      if (r.state === "ok" || r.cap === null || r.unit === null) continue;
      let sessionId: string | null;
      let ticketKey: string | null;
      let title: string;
      let open: boolean;
      if (r.subjectKind === "session") {
        const s = this.d.session(r.subjectId);
        if (!s) continue;
        sessionId = s.headId;
        ticketKey = s.ticketKey;
        title = s.title;
        open = s.open;
      } else {
        const t = this.d.ticket(r.subjectId);
        if (!t) continue;
        ticketKey = t.key;
        title = t.title;
        const root = t.openRoots[0];
        sessionId = root ? (this.d.session(root)?.headId ?? null) : null;
        open = t.openRoots.length > 0;
      }
      if (r.state !== "paused" && !open) continue;
      out.push({
        subjectKind: r.subjectKind, subjectId: r.subjectId, sessionId, ticketKey, title, state: r.state, spent: r.spent, cap: r.raisedCap ?? r.cap, unit: r.unit,
        partial: r.partial, pauseScope: r.scope ?? "session", fromModel: r.fromModel, toModel: r.toModel, trippedAt: r.trippedAt, pausedAt: r.pausedAt,
        stoppedAt: r.stoppedAt, takenOver: r.takenOverAt !== null,
      });
    }
    return out;
  }
}
