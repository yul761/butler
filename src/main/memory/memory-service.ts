import type { Handoff } from "../../shared/handoff";
import {
  MAX_NOTE_VARIANT, noteBody, noteId, noteText, parseNote, ticketScope, WORKSPACE_SCOPE, type ButlerNote, type MemoryView, type WhyEntry,
} from "../../shared/memory";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { MemorySyncRepo } from "../db/memory-sync-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { desiredNotes, isFull, planReconcile } from "./notes";
import { NOTES_CAP, withScope, type ScopeHandle } from "./statecore";

/** 一个 ticket 第一次同步（或积压很多）时最多回放多少条 handoff 的 learnings：workspace 的 notes 上限本来就是 30。 */
export const BACKFILL_HANDOFFS = 20;
/** 每次同步读多少条 handoff（决策要看全部历史）。 */
const HANDOFF_SCAN = 200;

export interface MemoryServiceDeps {
  dataDir: string;
  tickets: Pick<TicketsRepo, "get" | "list">;
  handoffs: Pick<HandoffsRepo, "listByTicket">;
  followups: Pick<FollowupsRepo, "listByTicket">;
  sync: MemorySyncRepo;
  /** 设置里的记忆开关（memoryEnabled）。 */
  enabled: () => boolean;
  now: () => number;
  /** 一次同步成功之后调用（主进程用它通知界面刷新记忆标签）。 */
  onSynced?: (key: string) => void;
  log?: (msg: string, err?: unknown) => void;
}

/** StateCore 里交接的摘要（设计文档 8.3：summary = done_today）。 */
export function handoffSummary(p: Handoff): string {
  const done = p.done_today.map((s) => s.trim()).filter(Boolean);
  return done.length ? `状态：${p.status}。完成：${done.join("；")}` : `状态：${p.status}。`;
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
 * 每次 remember 之前问一次：还能不能追加一条而不让 StateCore 挤掉别的条目（PF2）。
 * StateCore 的 notes 上限是 30，满了再追加就挤掉最旧的那条，可能正是一条要保留的 Butler 条目；
 * 被 forget 的条目也还占着位置（只有完整档位的蒸馏才清掉）。
 * 一次 remember 可能是追加，也可能是原地修订或一字不差的空操作，事先分不出来，所以一律按追加扣一个位置；
 * 扣完了再实测一次（修订和空操作不占位置）。保守：宁可这次不写，也不挤掉任何条目。
 */
function slotGuard(s: ScopeHandle): { take: () => Promise<boolean>; last: () => { used: number; cap: number } } {
  let known: { used: number; cap: number } | null = null;
  return {
    async take() {
      if (!known || known.used >= known.cap) known = await s.noteSlots();
      if (known.used >= known.cap) return false;
      known.used++;
      return true;
    },
    last: () => known ?? { used: 0, cap: NOTES_CAP },
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
  private stopped = false;

  constructor(private readonly d: MemoryServiceDeps) {}

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

  /** 所有未归档的 ticket（启动时补齐：老数据、上次退出时没写完的）。 */
  async syncAll(): Promise<void> {
    await Promise.all(this.d.tickets.list().map((t) => this.syncTicket(t.key)));
  }

  /** 队列清空时 resolve。 */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** 退出时调用：之后排队的任务直接跳过（app.db 马上要关了）。 */
  stop(): void {
    this.stopped = true;
  }

  private async syncNow(key: string): Promise<void> {
    if (!this.d.enabled() || !this.d.tickets.get(key)) return;
    const handoffs = this.d.handoffs.listByTicket(key, HANDOFF_SCAN);
    const full = handoffs.filter(isFull).sort((a, b) => a.id - b.id);
    const cursor = this.d.sync.cursor(key);
    const fresh = full.filter((h) => h.id > cursor).slice(-BACKFILL_HANDOFFS);
    const latest = full.at(-1) ?? null;
    const desired = desiredNotes(handoffs, this.d.followups.listByTicket(key));

    await withScope({ dataDir: this.d.dataDir, scope: ticketScope(key) }, async (s) => {
      // 有新的 handoff 就写最新那一条；没有新的但 StateCore 里没有交接（数据被删过）也补写一次。
      if (latest && (fresh.includes(latest) || (await s.activeHandoff()) === null)) {
        await s.handoff({ summary: handoffSummary(latest.payload), nextSteps: latest.payload.next_steps, openQuestions: latest.payload.open_questions });
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
  }

  private async reconcile(key: string, s: ScopeHandle, desired: ButlerNote[]): Promise<void> {
    const plan = planReconcile(await s.facts(), desired);
    // 先 forget 再 remember（设计文档 13.1）：新文本是旧文本的修订时，StateCore 把它们串成一条 why 链。
    for (const factKey of plan.forget) await s.forget(factKey);
    const wanted = new Map(desired.map((n) => [noteKey(n), n]));
    const queue = byPriority(plan.write).map((note) => ({ note, from: 1 }));
    const slots = slotGuard(s);
    const visible = new Set((await s.facts()).map((i) => i.text));
    // 每次重写都用更长的区分词，几轮之内必然分开；预算只是防止意外的死循环。
    let budget = desired.length * MAX_NOTE_VARIANT;
    while (queue.length > 0 && budget-- > 0) {
      const { note, from } = queue[0];
      const r = await this.writeVisible(s, note, from, slots.take, visible);
      if (!r.written) {
        // 没有空位：这一条和后面的都不写（不挤掉任何条目）；下次同步有空位时按同样的先后再写。
        const followups = queue.filter((q) => q.note.kind === "followup").length;
        const { used, cap } = slots.last();
        this.log(`memory ${key}: no free note slot (${used}/${cap}), skipped ${followups} followup(s), ${queue.length - followups} decision(s)`);
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

  /** 一条记忆（或交接）的版本链。 */
  async why(key: string, factId: string): Promise<WhyEntry[] | null> {
    if (!this.d.enabled()) return null;
    return withScope({ dataDir: this.d.dataDir, scope: ticketScope(key) }, (s) => s.why(factId));
  }
}
