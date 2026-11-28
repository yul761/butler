import type { RememberWriteResult } from "../../shared/fork";
import type { Handoff } from "../../shared/handoff";
import { EPIC_PLAN_MAX_CHARS } from "../../shared/control";
import {
  epicScope, featureScope, MAX_NOTE_VARIANT, noteBody, noteId, noteText, parseNote, plainNoteBody, ticketScope, truncateUnits, WORKSPACE_SCOPE,
  type ShipherdNote, type MemoryView, type WhyEntry,
} from "../../shared/memory";
import { currentLang } from "../i18n";
import type { EpicArchiveEntry, EpicArchiveRepo } from "../db/epic-archive-repo";
import type { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import type { FeaturesRepo } from "../db/features-repo";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { MemorySyncRepo } from "../db/memory-sync-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { desiredNotes, featureDecisionNotes, handoffSummaryFor, isFull, planReconcile } from "./notes";
import { NOTES_CAP, withScope, type ScopeHandle } from "./statecore";

/**
 * epic 记忆（内部是 feature scope，BTL-246 §5）：StateCore 每个 scope 只有 30 个笔记位。
 * 看得见的笔记到 EPIC_ARCHIVE_AT 条时，Shipherd 把最旧的挪进存档，留 EPIC_ARCHIVE_KEEP 条，给下一轮留几个空位；
 * 存档只留最新的 EPIC_ARCHIVE_MAX 条，渲染进 handoff 的「以前的约定」。
 */
export const EPIC_ARCHIVE_AT = 26;
export const EPIC_ARCHIVE_KEEP = 20;
export const EPIC_ARCHIVE_MAX = 40;
/** 只有 StateCore 的 Notes 分组算笔记位（statecore.ts 的 NOTES_GROUP）。 */
const NOTES_GROUP = "Notes";

const epicHeads = () =>
  currentLang() === "en"
    ? { plan: "Plan:", conventions: "Conventions:", earlier: "Earlier conventions (older notes moved out of the epic memory; to change one, remember the new version):" }
    : { plan: "规划：", conventions: "约定：", earlier: "以前的约定（从 epic 记忆里挪出来的旧笔记；要改哪一条，用 remember 记下新版本）：" };

/** epic 记忆 handoff 的正文：汇总，然后是规划、约定（汇总里的决策）和以前的约定（存档）；都没有时是空串。 */
function epicHandoffSummary(summary: string | null, brief: string | null, decisions: string[], archive: EpicArchiveEntry[]): string {
  const h = epicHeads();
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [
    summary?.trim() || null,
    brief ? `${h.plan}\n${brief}` : null,
    decisions.length ? `${h.conventions}\n${decisions.map((d) => `- ${d}`).join("\n")}` : null,
    archive.length ? `${h.earlier}\n${archive.map((e) => `- [${day(e.notedAt)}] ${e.text}`).join("\n")}` : null,
  ].filter((x): x is string => x !== null).join("\n\n");
}

/** 一个 ticket 第一次同步（或积压很多）时最多回放多少条 handoff 的 learnings：workspace 的 notes 上限本来就是 30。 */
export const BACKFILL_HANDOFFS = 20;
/** 每次同步读多少条 handoff（决策要看全部历史）。 */
const HANDOFF_SCAN = 200;
export interface MemoryServiceDeps {
  dataDir: string;
  tickets: Pick<TicketsRepo, "get" | "list">;
  handoffs: Pick<HandoffsRepo, "listByTicket">;
  followups: Pick<FollowupsRepo, "listByTicket">;
  features: Pick<FeaturesRepo, "get" | "list" | "legacyEpics">;
  featureHandoffs: Pick<FeatureHandoffsRepo, "listByFeature">;
  /** epic 记忆的溢出存档（BTL-246 §5）；不给就不挪笔记、不搬旧 epic 记忆。 */
  epicArchive?: Pick<EpicArchiveRepo, "add" | "list" | "has" | "trim">;
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
  return handoffSummaryFor(p);
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const noteKey = (n: { kind: string; id: string }): string => `${n.kind}:${n.id}`;

/**
 * 写入的先后（PF2）：位置不够时先写的才写得进去。未完成的 followup 优先，然后是决策；各自新的在前。
 * desiredNotes 里 followup 按创建时间从旧到新、决策从新到旧，所以只需要把 followup 倒过来。
 */
function byPriority(notes: ShipherdNote[]): ShipherdNote[] {
  return [...notes.filter((n) => n.kind === "followup").reverse(), ...notes.filter((n) => n.kind !== "followup")];
}

/**
 * 每次 remember 之前实测一次：还能不能追加一条而不让 StateCore 挤掉别的条目（PF2）。
 * StateCore 的 notes 上限是 30，满了再追加就挤掉最旧的那条，可能正是一条要保留的 Shipherd 条目；
 * claude 里挂的记忆 MCP 写的 note 和 Shipherd 的一样会挤掉最旧的（见 statecore.ts 的 NOTES_CAP）。
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

  /**
   * 所有未归档的 ticket 和 feature（启动时补齐：老数据、上次退出时没写完的）。
   * 先把旧 epic 的记忆搬进它下面每个 epic 的存档（只搬一次），epic 的同步才渲染得出来。
   */
  async syncAll(): Promise<void> {
    await this.enqueue("memory: copying old epic notes", () => this.copyLegacyEpics(), undefined);
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
  private async syncNow(key: string): Promise<ShipherdNote[] | null> {
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
   * 旧 epic 的记忆（BTL-246 §3）：每个旧 epic:<id> scope 里 Claude 写的笔记，复制进它下面每个 epic 的存档（source 记 epic:<id>，所以只搬一次）。
   * 旧 scope 本身不动；没有笔记的也记一条空的，下次不再打开它。
   */
  private async copyLegacyEpics(): Promise<void> {
    const archive = this.d.epicArchive;
    if (!archive || !this.d.enabled()) return;
    const todo = this.d.features.legacyEpics().filter((x) => !archive.has(x.featureId, epicScope(x.epicId)));
    const notesOf = new Map<number, { text: string; at: number }[]>();
    const now = this.d.now();
    for (const { featureId, epicId } of todo) {
      let notes = notesOf.get(epicId);
      if (!notes) {
        notes = await withScope({ dataDir: this.d.dataDir, scope: epicScope(epicId) }, async (s) =>
          (await s.facts()).filter((i) => i.group === NOTES_GROUP && parseNote(i.text) === null)
            .map((i) => ({ text: i.text, at: (i.createdAt && Date.parse(i.createdAt)) || now })));
        notesOf.set(epicId, notes);
      }
      const source = epicScope(epicId);
      if (notes.length === 0) archive.add({ featureId, text: "", source, notedAt: now, archivedAt: now });
      for (const n of notes) archive.add({ featureId, text: n.text, source, notedAt: n.at, archivedAt: now });
      this.trimArchive(featureId);
      if (notes.length > 0) this.log(`memory ${featureScope(featureId)}: copied ${notes.length} note(s) of the old ${source}`);
    }
  }

  private trimArchive(featureId: number): void {
    const dropped = this.d.epicArchive?.trim(featureId, EPIC_ARCHIVE_MAX) ?? [];
    if (dropped.length > 0) this.log(`memory ${featureScope(featureId)}: archive full, dropped ${dropped.length} oldest note(s)`);
  }

  /**
   * 笔记位快满时（EPIC_ARCHIVE_AT 条），把最旧的 Claude 笔记挪进存档、在 StateCore 里 forget（审计链里还在），留 EPIC_ARCHIVE_KEEP 条。
   * Shipherd 自己的条目（[decision:…] 这类）不挪：同步时已经 forget 了。返回挪了几条。
   */
  private async archiveOverflow(featureId: number, s: ScopeHandle): Promise<number> {
    const archive = this.d.epicArchive;
    if (!archive) return 0;
    const notes = (await s.facts()).filter((i) => i.group === NOTES_GROUP);
    if (notes.length < EPIC_ARCHIVE_AT) return 0;
    const now = this.d.now();
    const at = (i: { createdAt: string | null }) => (i.createdAt && Date.parse(i.createdAt)) || now;
    const oldest = notes.filter((i) => parseNote(i.text) === null).sort((a, b) => at(a) - at(b)).slice(0, notes.length - EPIC_ARCHIVE_KEEP);
    for (const i of oldest) {
      archive.add({ featureId, text: i.text, source: "notes", notedAt: at(i), archivedAt: now });
      await s.forget(i.factKey);
    }
    this.trimArchive(featureId);
    return oldest.length;
  }

  /**
   * 同步一个 epic（内部是 feature）：交接是最新一份有效汇总（summary、next_steps 的文字、open_questions），
   * summary 后面接规划（brief）、约定（汇总里的决策）和以前的约定（存档）（BTL-246 §5）。
   * Shipherd 不再占这个 scope 的笔记位：以前写的决策笔记一律 forget；笔记快满时先把最旧的挪进存档（每次 Stop 和启动时都会同步）。
   * 汇总没有 followups 和 learnings，不写 workspace。什么都没有可写时不写交接。
   * 不用 memory_sync 的游标：那张表的 key 引用 tickets(key)（外键开着），feature 写不进去。
   * 改用 StateCore 自己的记录判断“这份汇总写过没有”：handoff 的 retryAfter 传汇总的 createdAt，
   * 正文相同、又是在这份汇总生成之后写的，就不再写；正文不同（新汇总、数据被删过）就写。
   * 所以没有新汇总时不会重复写，内容相同的新汇总也照样记一个版本（同 ticket 的 N1）。
   */
  private async syncFeatureNow(featureId: number): Promise<void> {
    const feature = this.d.enabled() ? this.d.features.get(featureId) : null;
    if (!feature) return;
    const latest = this.d.featureHandoffs.listByFeature(featureId, HANDOFF_SCAN).find((h) => h.payload !== null && !h.degraded);
    const p = latest?.payload ?? null;
    const brief = feature.brief?.trim() ? truncateUnits(feature.brief.trim(), EPIC_PLAN_MAX_CHARS) : null;
    const key = featureScope(featureId);
    const touched = await withScope({ dataDir: this.d.dataDir, scope: key }, async (s) => {
      await this.reconcile(key, s, []);
      const moved = await this.archiveOverflow(featureId, s);
      const archive = this.d.epicArchive?.list(featureId) ?? [];
      const decisions = featureDecisionNotes(p?.decisions ?? []).map((n) => n.body);
      const summary = epicHandoffSummary(p?.summary ?? null, brief, decisions, archive);
      if (!summary && !p) return moved > 0;
      // 同一份内容写过就不再写：汇总的时间和最后一次挪进存档的时间里取晚的（见 ScopeHandle.handoff 的 retryAfter）。
      const stamp = Math.max(latest?.createdAt ?? 0, ...archive.map((e) => e.archivedAt));
      await s.handoff({ summary, nextSteps: p?.next_steps.map((n) => n.text) ?? [], openQuestions: p?.open_questions ?? [] }, stamp);
      return true;
    });
    if (!touched) return;
    try {
      this.d.onSynced?.(key);
    } catch (e) {
      this.log("memory onSynced callback failed", e);
    }
  }

  private async reconcile(key: string, s: ScopeHandle, desired: ShipherdNote[]): Promise<void> {
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
      // 新写的这条被 StateCore 当成了另一条看得见的 Shipherd 条目的修订，那一条被挤掉了：用更长的区分词马上把它写回去。
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
   * displaced：被它挤掉的另一条看得见的 Shipherd 条目（StateCore 把这次写入当成了那一条的修订）。
   * 被修订掉的如果是一条早就 forget 过、本来就看不见的旧文本，不算挤掉：它要的那一条还好好地看得见，不用重写。
   * written 为 false：还没写到看得见就没有空位了（take 返回 false）。visible：当前看得见的文本，这里跟着更新。
   */
  private async writeVisible(
    s: ScopeHandle,
    note: ShipherdNote,
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
   * 精简分叉用：这个范围的记忆条目在前、交接摘要在后，各带一个短标签，拼成文本，最多 maxChars 个字符
   * （交接再长也挤不掉记忆条目）。记忆关着、读失败（记日志）时返回 ""；永不 reject。和 view 一样只读，不进写入队列。
   */
  async recallText(scope: string, maxChars: number): Promise<string> {
    if (!this.d.enabled()) return "";
    try {
      const text = await withScope({ dataDir: this.d.dataDir, scope }, async (s) => {
        const handoff = await s.activeHandoff();
        const items = await s.facts();
        const parts: string[] = [];
        if (items.length > 0) parts.push(`${currentLang() === "en" ? "Notes" : "记忆"}：\n${items.map((i) => i.text).join("\n")}`);
        if (handoff?.content) parts.push(`${currentLang() === "en" ? "Handoff" : "交接"}：\n${handoff.content}`);
        return parts.join("\n\n");
      });
      return truncateUnits(text, maxChars);
    } catch (e) {
      this.log(`memory recallText ${scope} failed`, e);
      return "";
    }
  }

  /**
   * 把一段纯文本记进这个范围（不带 Shipherd 的 kind:id 前缀，所以 reconcile 不认它，也就不会删它）。
   * 每次写之前过 slotGuard：没有空位就不写（不挤掉别的条目），返回 "full"。正文压空白、截到 NOTE_BODY_LIMIT。
   * 和已遗忘的条目一字不差时 StateCore 会永久隐藏它（见 writeVisible）：写完看不见就加 " #2"…" #5" 再写，
   * 到 MAX_NOTE_VARIANT 还是看不见就返回 "failed"。
   * 走写入队列，永不 reject：失败只写日志，返回 "failed"。
   */
  rememberText(scope: string, text: string): Promise<RememberWriteResult> {
    return this.rememberUnlessDup(scope, text, null).then((r) => (r.result === "dup" ? "written" : r.result));
  }

  /**
   * 同 rememberText，但先拿这个范围现有的条目问 findDup：它说已经有了（返回那一条）就不写，结果是 dup。
   * 查和写在同一个写入队列的任务里，两条同样的话前后脚来也只写一次（信息流转，BTL-272）。
   */
  rememberUnlessDup(
    scope: string,
    text: string,
    findDup: ((existing: readonly string[]) => string | null) | null,
  ): Promise<{ result: RememberWriteResult | "dup"; dupOf: string | null }> {
    return this.enqueue<{ result: RememberWriteResult | "dup"; dupOf: string | null }>(
      `memory rememberText ${scope}`,
      async () => {
        if (!this.d.enabled()) return { result: "disabled", dupOf: null };
        const body = plainNoteBody(text);
        if (!body) return { result: "failed", dupOf: null };
        return withScope({ dataDir: this.d.dataDir, scope }, async (s) => {
          const dupOf = findDup ? findDup((await s.facts()).map((i) => i.text)) : null;
          if (dupOf !== null) return { result: "dup" as const, dupOf };
          return { result: await this.writeNote(s, scope, body), dupOf: null };
        });
      },
      { result: "failed", dupOf: null },
    );
  }

  /**
   * 忘掉这个范围里 match 认出来的纯文本笔记（信息流转撤销同步时，BTL-272）。走写入队列，和 rememberUnlessDup 不会交错。
   * 返回忘了几条；记忆关着或者出错为 null（永不 reject）。StateCore 的审计链里还在。
   */
  forgetText(scope: string, match: (text: string) => boolean): Promise<number | null> {
    return this.enqueue<number | null>(
      `memory forgetText ${scope}`,
      async () => {
        if (!this.d.enabled()) return null;
        return withScope({ dataDir: this.d.dataDir, scope }, async (s) => {
          let n = 0;
          for (const i of await s.facts()) {
            if (!match(i.text)) continue;
            await s.forget(i.factKey);
            n++;
          }
          return n;
        });
      },
      null,
    );
  }

  private async writeNote(s: ScopeHandle, scope: string, body: string): Promise<RememberWriteResult> {
    const slots = slotGuard(s);
    for (let v = 1; v <= MAX_NOTE_VARIANT; v++) {
      if (!(await slots.take())) return "full";
      const t = v === 1 ? body : `${body} #${v}`;
      await s.remember(t);
      if ((await s.facts()).some((i) => i.text === t)) return "written";
    }
    this.log(`memory rememberText ${scope}: stays hidden after ${MAX_NOTE_VARIANT} variants`);
    return "failed";
  }

  /** 一条记忆（或交接）的版本链。 */
  async why(key: string, factId: string): Promise<WhyEntry[] | null> {
    if (!this.d.enabled()) return null;
    return withScope({ dataDir: this.d.dataDir, scope: ticketScope(key) }, (s) => s.why(factId));
  }
}
