import type { Handoff } from "../../shared/handoff";
import {
  featureScope, MAX_NOTE_VARIANT, noteBody, noteId, noteText, parseNote, ticketScope, WORKSPACE_SCOPE, type ButlerNote, type MemoryView, type WhyEntry,
} from "../../shared/memory";
import type { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import type { FeaturesRepo } from "../db/features-repo";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { MemorySyncRepo } from "../db/memory-sync-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { StatecoreChatModel } from "../gateway/types";
import { desiredNotes, featureDecisionNotes, handoffSummaryFor, isFull, planReconcile } from "./notes";
import { listScopeNames, NOTES_CAP, withScope, type DigestOutcome, type ScopeHandle } from "./statecore";

/** 一个 ticket 第一次同步（或积压很多）时最多回放多少条 handoff 的 learnings：workspace 的 notes 上限本来就是 30。 */
export const BACKFILL_HANDOFFS = 20;
/** 每次同步读多少条 handoff（决策要看全部历史）。 */
const HANDOFF_SCAN = 200;
export interface MemoryServiceDeps {
  dataDir: string;
  tickets: Pick<TicketsRepo, "get" | "list">;
  handoffs: Pick<HandoffsRepo, "listByTicket">;
  followups: Pick<FollowupsRepo, "listByTicket">;
  features: Pick<FeaturesRepo, "get" | "list">;
  featureHandoffs: Pick<FeatureHandoffsRepo, "listByFeature">;
  sync: MemorySyncRepo;
  /** 设置里的记忆开关（memoryEnabled）。 */
  enabled: () => boolean;
  now: () => number;
  /** 一次同步成功之后调用（主进程用它通知界面刷新记忆标签）。 */
  onSynced?: (key: string) => void;
  log?: (msg: string, err?: unknown) => void;
}

export interface DistillResult {
  /** 有待蒸馏事件、尝试了蒸馏的 scope 数。 */
  scopes: number;
  ran: number;
  failed: number;
}

const TICKET_SCOPE_PREFIX = ticketScope("");
/** ticket scope 的 ticket key；不是 ticket scope（workspace、claude 自己建的）时为 null。 */
const scopeTicket = (scope: string): string | null =>
  scope.startsWith(TICKET_SCOPE_PREFIX) && scope.length > TICKET_SCOPE_PREFIX.length ? scope.slice(TICKET_SCOPE_PREFIX.length) : null;

/** StateCore 里交接的摘要（设计文档 8.3：summary = done_today）。 */
export function handoffSummary(p: Handoff): string {
  return handoffSummaryFor(p);
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const noteKey = (n: { kind: string; id: string }): string => `${n.kind}:${n.id}`;

/**
 * 写入的先后（PF2）：位置不够时先写的才写得进去。未完成的 followup 优先，然后是决策；各自新的在前。
 * desiredNotes 里 followup 按创建时间从旧到新、决策从新到旧，所以只需要把 followup 倒过来。
 */
function byPriority(notes: ButlerNote[]): ButlerNote[] {
  return [...notes.filter((n) => n.kind === "followup").reverse(), ...notes.filter((n) => n.kind !== "followup")];
}

/**
 * 每次 remember 之前实测一次：还能不能追加一条而不让 StateCore 挤掉别的条目（PF2）。
 * StateCore 的 notes 上限是 30，满了再追加就挤掉最旧的那条，可能正是一条要保留的 Butler 条目；
 * claude 里挂的记忆 MCP 写的 note 和 Butler 的一样会挤掉最旧的（见 statecore.ts 的 NOTES_CAP）。
 * 一次 remember 可能是追加，也可能是原地修订或一字不差的空操作，事先分不出来，所以一律当成追加：没有空位就不写。
 * 每次都重新数，而不是数一次再自己扣：claude 里挂的记忆 MCP 可能同时在往这个 scope 写。一次同步只写几条，开销很小。
 */
function slotGuard(s: ScopeHandle): { take: () => Promise<boolean>; last: () => { used: number; cap: number } } {
  let known: { used: number; cap: number } = { used: 0, cap: NOTES_CAP };
  return {
    async take() {
      known = await s.noteSlots();
      return known.used < known.cap;
    },
    last: () => known,
  };
}

type WriteResult = { written: boolean; displaced: { key: string; variant: number } | null };

/**
 * StateCore 记忆的唯一写入方（设计文档 8.3，全部是确定性路径）。
 * 所有写入串行执行（同一个 statecore.db 还会被 claude 里挂的 MCP 进程打开）；任何失败只写日志，永不 reject。
 */
export class MemoryService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, Promise<void>>();
  /** 每个 ticket 上一次同步记过的提示（没有空位、登记失败）：一样的就不再记（情况不变时每次同步都会一样）。 */
  private readonly notices = new Map<string, string>();
  private stopped = false;

  constructor(private readonly d: MemoryServiceDeps) {}

  /** 和上一次同步记的同一类提示不一样时才写日志；msg 为 null 表示这次没有这类情况。 */
  private notice(id: string, msg: string | null): void {
    if (msg !== null && this.notices.get(id) !== msg) this.log(msg);
    if (msg === null) this.notices.delete(id);
    else this.notices.set(id, msg);
  }

  private log(msg: string, err?: unknown): void {
    try {
      this.d.log?.(msg, err);
    } catch {
      // 写日志失败不能影响记忆，更不能影响调用方。
    }
  }

  /** 排进串行队列；fn 抛错时记日志并返回 fallback。 */
  private enqueue<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.stopped) return fallback;
      try {
        return await fn();
      } catch (e) {
        this.log(`${label} failed`, e);
        return fallback;
      }
    });
    this.queue = run;
    return run;
  }

  /** 把一个 ticket 的记忆写进 StateCore。还在排队的同一个 ticket 只同步一次；正在同步时又来的请求会再排一次。 */
  syncTicket(key: string): Promise<void> {
    const waiting = this.pending.get(key);
    if (waiting) return waiting;
    const p = this.enqueue(
      `memory sync ${key}`,
      async () => {
        this.pending.delete(key);
        await this.syncNow(key);
      },
      undefined,
    );
    this.pending.set(key, p);
    return p;
  }

  /** 把一个 feature 最新的有效汇总写进 feature scope（设计文档 2026-10-28）。排队、合并的规则同 syncTicket。 */
  syncFeature(featureId: number): Promise<void> {
    const key = featureScope(featureId);
    const waiting = this.pending.get(key);
    if (waiting) return waiting;
    const p = this.enqueue(
      `memory sync ${key}`,
      async () => {
        this.pending.delete(key);
        await this.syncFeatureNow(featureId);
      },
      undefined,
    );
    this.pending.set(key, p);
    return p;
  }

  /** 所有未归档的 ticket 和 feature（启动时补齐：老数据、上次退出时没写完的）。 */
  async syncAll(): Promise<void> {
    await Promise.all([
      ...this.d.tickets.list().map((t) => this.syncTicket(t.key)),
      ...this.d.features.list().map((f) => this.syncFeature(f.id)),
    ]);
  }

  /** 队列清空时 resolve。 */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** 退出时调用：之后排队的任务直接跳过（app.db 马上要关了）。 */
  stop(): void {
    this.stopped = true;
  }

  /** 同步一个 ticket；返回这次要保留的条目（记忆关了或没有这个 ticket 时什么都不做，返回 null）。 */
  private async syncNow(key: string): Promise<ButlerNote[] | null> {
    if (!this.d.enabled() || !this.d.tickets.get(key)) return null;
    const handoffs = this.d.handoffs.listByTicket(key, HANDOFF_SCAN);
    const full = handoffs.filter(isFull).sort((a, b) => a.id - b.id);
    const cursor = this.d.sync.cursor(key);
    const fresh = full.filter((h) => h.id > cursor).slice(-BACKFILL_HANDOFFS);
    const latest = full.at(-1) ?? null;
    const desired = desiredNotes(handoffs, this.d.followups.listByTicket(key));

    await withScope({ dataDir: this.d.dataDir, scope: ticketScope(key) }, async (s) => {
      // 有新的 handoff 就写最新那一条；没有新的但 StateCore 里没有交接（数据被删过）也补写一次。
      if (latest && (fresh.includes(latest) || (await s.activeHandoff()) === null)) {
        // 传 createdAt：上一次同步写了交接、却在后面失败了的话，这次重试不再多写一个一样的版本。
        await s.handoff(
          { summary: handoffSummary(latest.payload), nextSteps: latest.payload.next_steps, openQuestions: latest.payload.open_questions },
          latest.createdAt,
        );
      }
      await this.reconcile(key, s, desired);
    });

    const learnings = fresh.flatMap((h) => h.payload.learnings.map(noteBody).filter(Boolean).map((l) => `[learning:${noteId(key)}] ${l}`));
    if (learnings.length > 0) {
      // workspace 的经验本来就只保留最近的 30 条（StateCore 挤掉最旧的）；一次同步超过上限时只写最新的那些，不让这次写的互相挤掉。
      const kept = learnings.slice(-NOTES_CAP);
      if (kept.length < learnings.length) this.log(`memory ${key}: skipped ${learnings.length - kept.length} older learning(s) of this sync`);
      await withScope({ dataDir: this.d.dataDir, scope: WORKSPACE_SCOPE }, async (s) => {
        for (const text of kept) await s.remember(text);
      });
    }
    const last = fresh.at(-1);
    if (last) this.d.sync.setCursor(key, last.id, this.d.now());
    try {
      this.d.onSynced?.(key);
    } catch (e) {
      this.log("memory onSynced callback failed", e);
    }
    return desired;
  }

  /**
   * 同步一个 feature：交接是最新一份有效汇总（summary、next_steps 的文字、open_questions），决策按 key 写成 note。
   * 汇总没有 followups 和 learnings，不写 workspace。还没有有效汇总时不打开 scope。
   * 不用 memory_sync 的游标：那张表的 key 引用 tickets(key)（外键开着），feature 写不进去。
   * 改用 StateCore 自己的记录判断“这份汇总写过没有”：handoff 的 retryAfter 传汇总的 createdAt，
   * 正文相同、又是在这份汇总生成之后写的，就不再写；正文不同（新汇总、数据被删过）就写。
   * 所以没有新汇总时不会重复写，内容相同的新汇总也照样记一个版本（同 ticket 的 N1）。
   */
  private async syncFeatureNow(featureId: number): Promise<void> {
    if (!this.d.enabled() || !this.d.features.get(featureId)) return;
    const latest = this.d.featureHandoffs.listByFeature(featureId, HANDOFF_SCAN).find((h) => h.payload !== null && !h.degraded);
    const p = latest?.payload;
    if (!latest || !p) return;
    const key = featureScope(featureId);
    await withScope({ dataDir: this.d.dataDir, scope: key }, async (s) => {
      await s.handoff(
        { summary: p.summary, nextSteps: p.next_steps.map((n) => n.text), openQuestions: p.open_questions },
        latest.createdAt,
      );
      await this.reconcile(key, s, featureDecisionNotes(p.decisions));
    });
    try {
      this.d.onSynced?.(key);
    } catch (e) {
      this.log("memory onSynced callback failed", e);
    }
  }

  private async reconcile(key: string, s: ScopeHandle, desired: ButlerNote[]): Promise<void> {
    const slots = slotGuard(s);
    const before = await s.facts();
    const plan = planReconcile(before, desired);
    // 先 forget 再 remember（设计文档 13.1）：新文本是旧文本的修订时，StateCore 把它们串成一条 why 链。
    // statecore-mcp 1.1 起 forget 会释放位置（没登记的条目也一样），不再需要先登记再 forget。
    for (const factKey of plan.forget) await s.forget(factKey);
    // 按现状重新比对一次再写（claude 里的 MCP 可能同时在写）。
    const after = await s.facts();
    const wanted = new Map(desired.map((n) => [noteKey(n), n]));
    const queue = byPriority(planReconcile(after, desired).write).map((note) => ({ note, from: 1 }));
    const visible = new Set(after.map((i) => i.text));
    // 每次重写都用更长的区分词，几轮之内必然分开；预算只是防止意外的死循环。
    let budget = desired.length * MAX_NOTE_VARIANT;
    while (queue.length > 0 && budget-- > 0) {
      const { note, from } = queue[0];
      const r = await this.writeVisible(s, note, from, slots.take, visible);
      if (!r.written) {
        // 没有空位：这一条和后面的都不写（不挤掉任何条目）；下次同步有空位时按同样的先后再写。
        const followups = queue.filter((q) => q.note.kind === "followup").length;
        const { used, cap } = slots.last();
        this.notice(`${key}|slots`, `memory ${key}: no free note slot (${used}/${cap}), skipped ${followups} followup(s), ${queue.length - followups} decision(s)`);
        return;
      }
      queue.shift();
      // 新写的这条被 StateCore 当成了另一条看得见的 Butler 条目的修订，那一条被挤掉了：用更长的区分词马上把它写回去。
      // 排在最前面：挤掉它的那次写入是原地修订、没占位置，这个位置留给它，不让后面的条目先占走（PF2）。
      const displaced = r.displaced;
      const other = displaced ? wanted.get(displaced.key) : undefined;
      if (displaced && other && !queue.some((q) => noteKey(q.note) === displaced.key)) {
        queue.unshift({ note: other, from: Math.min(MAX_NOTE_VARIANT, Math.max(2, displaced.variant + 1)) });
      }
    }
    this.notice(`${key}|slots`, null);
  }

  /**
   * 从第 from 个变体开始写，直到 facts() 里看得见为止：和已遗忘的条目一字不差时 StateCore 会永久隐藏它。
   * displaced：被它挤掉的另一条看得见的 Butler 条目（StateCore 把这次写入当成了那一条的修订）。
   * 被修订掉的如果是一条早就 forget 过、本来就看不见的旧文本，不算挤掉：它要的那一条还好好地看得见，不用重写。
   * written 为 false：还没写到看得见就没有空位了（take 返回 false）。visible：当前看得见的文本，这里跟着更新。
   */
  private async writeVisible(
    s: ScopeHandle,
    note: ButlerNote,
    from: number,
    take: () => Promise<boolean>,
    visible: Set<string>,
  ): Promise<WriteResult> {
    let displaced: WriteResult["displaced"] = null;
    for (let v = from; v <= MAX_NOTE_VARIANT; v++) {
      if (!(await take())) return { written: false, displaced };
      const text = noteText(note, v);
      const r = await s.remember(text);
      const old = r.superseded === null || !visible.has(r.superseded) ? null : parseNote(r.superseded);
      if (old && noteKey(old) !== noteKey(note)) displaced = { key: noteKey(old), variant: old.variant };
      const now = (await s.facts()).map((i) => i.text);
      visible.clear();
      for (const t of now) visible.add(t);
      if (visible.has(text)) return { written: true, displaced };
    }
    this.log(`memory: ${noteKey(note)} stays hidden after ${MAX_NOTE_VARIANT} variants`);
    return { written: true, displaced };
  }

  /** ticket 详情页“记忆”标签（设计文档 8.4）。读失败时把原因放进 error，不抛错。 */
  async view(key: string): Promise<MemoryView> {
    const scope = ticketScope(key);
    if (!this.d.enabled()) return { enabled: false, scope, handoff: null, items: [], error: null };
    try {
      return await withScope({ dataDir: this.d.dataDir, scope }, async (s) => ({
        enabled: true,
        scope,
        handoff: await s.activeHandoff(),
        items: await s.facts(),
        error: null,
      }));
    } catch (e) {
      this.log(`memory view ${key} failed`, e);
      return { enabled: true, scope, handoff: null, items: [], error: errorText(e) };
    }
  }

  /**
   * full 档位：把 claude 里 consolidate 进来的原始事件蒸馏成记忆（计划 4 R1：模型只能是 PrivacyGateway.statecoreModel() 的结果）。
   * model 为 null（不是 full 档位等）或记忆关闭时什么都不做。永不 reject；一个 scope 失败不影响其他 scope。
   * 每个 scope 单独排进同步队列（审查 M1）：和写入不并发，但这期间 handoff 触发的同步可以插在两个 scope 之间，不用等整轮蒸馏。
   * 轮到一个 scope 时再检查：已经 stop()、记忆关了、allowed() 为 false（档位降了、开了发送前确认、开始退出）就停下，剩下的 scope 留到下次。
   * statecore-mcp 1.1 起，蒸馏提炼的 note 不会挤掉调用方（Butler、claude 里的 remember）写的 note：位置满了就丢掉自己提炼的那条，
   * 所以不再要求蒸馏前留空位。蒸馏加重新同步之后还有要保留的条目看不见，只记条数（同样的情况不重复记）。
   * 一个 ticket scope 蒸馏成功后马上重新同步这个 ticket（任务 4 审查 F3）：蒸馏会按相似度改写、合并、挤掉 notes，
   * Butler 要保留的条目可能被改掉或没了登记；重新同步按现状比对、每次写之前重新数位置，不沿用蒸馏之前的任何估计。
   * "partial"：有的事件没处理到（失败的分块、超出预算），statecore-mcp 1.1 起如实报告；和 "ran" 一样算跑过并重新同步，另外记一笔。
   * 完全失败时 StateCore 不写摘要，事件留着下次再试（连续失败三次后它写一份降级摘要，以免卡住）。
   */
  async distill(model: StatecoreChatModel | null, allowed: () => boolean = () => true): Promise<DistillResult> {
    const r: DistillResult = { scopes: 0, ran: 0, failed: 0 };
    if (!model || !this.d.enabled()) return r;
    const scopes = await this.enqueue("memory distill", () => listScopeNames(this.d.dataDir), []);
    for (const scope of scopes) {
      const step = await this.enqueue(`memory distill ${scope}`, () => this.distillScope(scope, model, allowed), "stop" as const);
      if (step === "stop") break;
      if (step === "skipped") continue;
      r.scopes++;
      if (step === "ran" || step === "partial") r.ran++;
      else if (step === "failed") r.failed++;
    }
    return r;
  }

  /** 蒸馏一个 scope（已经在队列里）。"skipped"：没有待蒸馏的事件；"stop"：整轮停下。 */
  private async distillScope(
    scope: string,
    model: StatecoreChatModel,
    allowed: () => boolean,
  ): Promise<DigestOutcome | "skipped" | "stop"> {
    if (this.stopped || !this.d.enabled()) return "stop";
    if (!allowed()) {
      this.log("memory distill stopped: the model is no longer allowed");
      return "stop";
    }
    const key = scopeTicket(scope);
    try {
      const outcome = await withScope({ dataDir: this.d.dataDir, scope, model }, async (s): Promise<DigestOutcome | "skipped"> => {
        if ((await s.pendingEvents()) === 0) return "skipped";
        return s.digestNow();
      });
      if (outcome === "partial") this.log(`memory distill ${scope}: partial (some events were not processed)`);
      if ((outcome === "ran" || outcome === "partial") && key !== null) await this.resyncAfterDigest(key);
      return outcome;
    } catch (e) {
      this.log(`memory distill ${scope} failed`, e);
      return "failed";
    }
  }

  /**
   * 蒸馏之后重新同步一个 ticket（已经在队列里，直接执行）。失败只写日志，不算蒸馏失败。
   * 同步完再看一次：要保留的条目还有看不见的（被蒸馏挤掉、又没有空位写回去），记下条数，同样的条数不重复记。
   */
  private async resyncAfterDigest(key: string): Promise<void> {
    if (this.stopped) return;
    try {
      const desired = await this.syncNow(key);
      if (desired === null) return;
      const items = await withScope({ dataDir: this.d.dataDir, scope: ticketScope(key) }, (s) => s.facts());
      const missing = planReconcile(items, desired).write.length;
      this.notice(`${key}|digest`, missing ? `memory ${key}: ${missing} desired note(s) still missing after distill and resync` : null);
    } catch (e) {
      this.log(`memory sync ${key} after distill failed`, e);
    }
  }

  /** 一条记忆（或交接）的版本链。 */
  async why(key: string, factId: string): Promise<WhyEntry[] | null> {
    if (!this.d.enabled()) return null;
    return withScope({ dataDir: this.d.dataDir, scope: ticketScope(key) }, (s) => s.why(factId));
  }
}

/** nightlyDistill 用到的 gateway 部分（PrivacyGateway 满足它）。 */
export interface StatecoreModelSource {
  statecoreModel(signal?: AbortSignal): StatecoreChatModel | null;
}

/**
 * 晚间任务的蒸馏一步（主进程的 dailyDeps.distill）。每次运行都重新向 gateway 要模型：
 * 用户把档位调到 full 或调回去，下一次晚间任务就生效，不用重启；只有 full 档位、关了发送前确认时才有模型（P4-R5）。
 * 每个 scope 开始前再问一次：途中档位降了或开始退出，就停下（已经开始的那个 scope 的调用由 gateway 拒绝，StateCore 记一次失败，事件留着）。
 * 永不 reject：失败只写日志。
 */
export async function nightlyDistill(d: {
  memory: Pick<MemoryService, "distill">;
  gateway: StatecoreModelSource;
  signal: AbortSignal;
  log: (msg: string, err?: unknown) => void;
}): Promise<DistillResult> {
  const empty: DistillResult = { scopes: 0, ran: 0, failed: 0 };
  try {
    if (d.signal.aborted) return empty;
    const allowed = () => !d.signal.aborted && d.gateway.statecoreModel() !== null;
    const r = await d.memory.distill(d.gateway.statecoreModel(d.signal), allowed);
    if (r.scopes > 0) d.log(`memory distill: ${r.scopes} scope(s), ${r.ran} ran, ${r.failed} failed`);
    return r;
  } catch (e) {
    // 意外错误（例如读设置失败）：只记消息和错误本身，没有记忆内容；key 只在 gateway 的请求头里，不会出现在这里。
    try {
      d.log("memory distill failed", e);
    } catch {
      // 写日志失败也不能让晚间任务出错。
    }
    return empty;
  }
}
