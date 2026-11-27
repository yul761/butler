import { stat } from "node:fs/promises";
import type { Session } from "../../shared/types";
import type { ConvRepo, ConvTurn, QaBy, TurnKind } from "../db/conv-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import { WATCH_DEBOUNCE_MS } from "../sessions/activity-monitor";
import { TranscriptHub, type TailLine, type TailSink, type TailStat } from "../sessions/transcript-hub";
import type { WatchFn } from "../sessions/transcript-watch";
import { capText, convEntriesOfValue, type ConvEntry, type UserOpen } from "./conv-parse";
import { isQuestionLike, ruleQa, type ConvQaVerdict } from "./conv-qa";
import { inoText, sameIno } from "./ino";
import { perfOp } from "../diag/perf-stats";

/**
 * 对话另存（UI 重做第 4 层）：把 transcript 增量读进 conv_* 表。只存双方说的话；工具调用只用来给这一轮打标记。
 * 游标（字节位置、inode、打开的那一轮）存在库里，重启以后接着读；同一行重读靠 source_key 去重。
 */

/** 每个 session 记住最近这么多个 entry 属于哪一轮（只在内存里；重启以后靠游标里的 openTurnId 接上）。 */
export const PARENT_MAP_MAX = 2000;
/** 启动补读：多久以内活动过的 target。 */
export const CONV_BACKFILL_MS = 14 * 24 * 3600_000;
export const CONV_SWEEP_MS = 10 * 60_000;
/** 开着的 head：确认监视在、顺便比一下文件大小（fs.watch 会漏事件）。 */
export const CONV_TICK_MS = 10_000;
/** 结束超过这么久的轮不判，记 no / old。 */
export const CONV_JUDGE_MAX_AGE_MS = 24 * 3600_000;
/** 一直没 stop 的轮，静止这么久算结束。 */
export const CONV_STALE_TURN_MS = 30 * 60_000;
/** tick 里同一条错误最多这么久记一次。 */
const TICK_ERROR_LOG_MS = 10 * 60_000;

/** 某个 ticket 的判断一时问不了模型（花费熔断、限流、超时……）：这么久之内不再为它问（别的 ticket 照常判）。 */
export const CONV_PAUSE_RETRY_MS = CONV_SWEEP_MS;
const JUDGE_BATCH = 20;

/**
 * 和 SessionsRepo.listConvTargets 的条件一致（不看活动时间）。那边还挡掉以前的 epic session（BTL-246），Session 上没有那一列：
 * 那些 session 迁移时已经隐藏，Shipherd 不会再把它们跑起来。
 */
export function isConvTarget(s: Session | null): boolean {
  if (!s || s.replacedBy !== null || s.lessonRunId !== null) return false;
  return s.origin === "shipherd" || s.ticketKey !== null || s.featureId !== null || s.shipherd;
}

export interface ConvIngesterDeps {
  repo: ConvRepo;
  sessions: Pick<SessionsRepo, "rootOf" | "head" | "chainOf" | "get" | "listConvTargets">;
  transcriptOf: (sessionId: string) => string | null;
  onAppended: (rootSessionId: string) => void;
  now: () => number;
  chunkBytes?: number;
  maxLineBytes?: number;
  log?: (msg: string) => void;
  /** 终端开着的 head。 */
  openHeads: () => string[];
  /** 规则判不了的轮问模型（judgeConvQa）。 */
  judge: (turn: { question: string; answer: string }, session: { cwd: string; ticketKey: string | null }) => Promise<ConvQaVerdict>;
  watch?: WatchFn;
  timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  /** 和活动、用量共用的 transcript 读取（BTL-276）；没给时自己建一个（用 chunkBytes / maxLineBytes）。 */
  hub?: TranscriptHub;
}

const KIND_OF: Record<UserOpen, TurnKind> = { user: "user", relay: "silent", silent: "silent", handoff: "handoff" };

export class ConvIngester {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly parents = new Map<string, Map<string, number>>();
  /** 开着的 head：共用的监视，和一直挂在 hub 上的读取（别的消费者读到新内容时也顺带交给这里）。 */
  private readonly watches = new Map<string, { file: string; w: { ensure(): boolean; close(): void }; detach: () => void }>();
  private readonly hub: TranscriptHub;
  /** 读进了新消息、改了结论的链根，等这次读完告诉 onAppended。 */
  private readonly touched = new Set<string>();
  /** 正在 run() 的 session：它读完自己收尾，hub 那边不用再收一次。 */
  private readonly inRun = new Set<string>();
  private intervals: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private judging = false;
  /** ticketKey（没有 ticket 是 ""）→ 到这个时间之前不再问模型。 */
  private readonly pausedUntil = new Map<string, number>();
  private sweeping: Promise<void> | null = null;
  /**
   * 规则判过、要问模型的轮（BTL-242）：轮 id → 当时的样子。没变的下次读完不再取它的消息重判（原来每次 ingest
   * 把所有等模型的轮的消息都读一遍）。这次读进了它的东西（apply 碰过）的先删掉。
   */
  private readonly needsJudge = new Map<number, string>();

  constructor(private readonly d: ConvIngesterDeps) {
    this.hub = d.hub ?? new TranscriptHub({ chunkBytes: d.chunkBytes, maxLineBytes: d.maxLineBytes, log: (m) => d.log?.(m) });
  }

  /** 马上 sweep 一次，然后起 tick 和 sweep 两个定时器。 */
  start(): void {
    if (this.stopped) return;
    void this.sweep();
    const t = this.d.timers ?? { setInterval, clearInterval };
    this.intervals.push(
      t.setInterval(() => void this.tick(), CONV_TICK_MS),
      t.setInterval(() => void this.sweep(), CONV_SWEEP_MS),
    );
  }

  /** 关掉所有监视和定时器；之后的 ingest / judge 直接返回，不碰数据库。 */
  stop(): void {
    this.stopped = true;
    const t = this.d.timers ?? { setInterval, clearInterval };
    for (const iv of this.intervals) t.clearInterval(iv);
    this.intervals = [];
    for (const { w, detach } of this.watches.values()) {
      w.close();
      detach();
    }
    this.watches.clear();
  }

  /** 定时器每 10 秒调一次：任何异常都接住记日志，同一条消息 10 分钟内只记一次，不能变成 unhandledRejection。 */
  async tick(): Promise<void> {
    try {
      await this.tickOnce();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const now = this.d.now();
      if (msg !== this.lastTickError || now - this.lastTickErrorAt >= TICK_ERROR_LOG_MS) {
        this.lastTickError = msg;
        this.lastTickErrorAt = now;
        this.d.log?.(`conv tick: ${msg}`);
      }
    }
  }

  private lastTickError = "";
  private lastTickErrorAt = 0;

  /** 开着的 target head：挂上监视（重命名以后会掉，ensure 重新挂上），文件大小和游标对不上就读；已经关掉的 head 撤掉监视。 */
  private async tickOnce(): Promise<void> {
    if (this.stopped) return;
    const heads = new Set(this.d.openHeads().filter((h) => isConvTarget(this.d.sessions.get(h))));
    for (const [h, { w, detach }] of this.watches) {
      if (!heads.has(h)) {
        w.close();
        detach();
        this.watches.delete(h);
      }
    }
    for (const h of heads) {
      if (this.stopped) return;
      const file = this.d.transcriptOf(h);
      if (!file) continue;
      let entry = this.watches.get(h);
      if (entry && entry.file !== file) {
        entry.w.close();
        entry.detach();
        entry = undefined;
      }
      if (!entry) {
        entry = {
          file,
          w: this.hub.watch(file, "conv", { delayMs: WATCH_DEBOUNCE_MS, onChange: () => void this.ingest(h), watch: this.d.watch, log: (m) => this.d.log?.(m) }),
          detach: this.hub.attach(file, `conv:${h}`, this.sink(h, file)),
        };
        this.watches.set(h, entry);
      }
      entry.w.ensure();
      let st;
      try {
        st = await stat(file, { bigint: true });
      } catch {
        continue;
      }
      const c = this.d.repo.cursor(h);
      if (!c || c.file !== file || !sameIno(c.ino, inoText(st.ino)) || c.offset !== Number(st.size)) await this.ingest(h);
    }
  }

  /** 所有 target 的整条链逐个 ingest（旧段在前），然后把一直没 stop 的旧轮结束掉、跑判断队列。正在跑时返回正在跑的那一次。 */
  sweep(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.sweeping ??= this.doSweep().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async doSweep(): Promise<void> {
    try {
      for (const s of this.d.sessions.listConvTargets(this.d.now() - CONV_BACKFILL_MS)) {
        for (const id of this.d.sessions.chainOf(s.id).reverse()) {
          if (this.stopped) return;
          await this.ingest(id);
        }
      }
      if (this.stopped) return;
      // 终端还开着的不结束：一次工具调用可以跑很久，中间一句话都没有（PR #60 review 5）。关掉以后下一次 sweep 再结束。
      // 取舍：最后一轮没有 end_turn（比如按 Esc 打断后就放着）时，终端开多久这一轮就挂多久；开了超过 CONV_JUDGE_MAX_AGE_MS
      // 的，关掉后规则判不了就直接记 no / old，不问模型。
      const open = new Set(this.d.openHeads());
      this.d.repo.endStale(this.d.now() - CONV_STALE_TURN_MS, [...open]);
      // 没开着的 session 不会再交错写入，uuid → 轮的映射不用留在内存里（14 天的补读会碰到上百段）。
      for (const id of [...this.parents.keys()]) if (!open.has(id)) this.parents.delete(id);
    } catch (e) {
      this.d.log?.(`conv sweep: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.runJudges();
  }

  /** 这个 id 所在整条链 ingest 到最新（换新前用）。 */
  async syncNow(sessionId: string): Promise<void> {
    const head = this.d.sessions.head(sessionId)?.id ?? sessionId;
    const chain = this.d.sessions.chainOf(head);
    for (const id of chain.length > 0 ? chain.reverse() : [sessionId]) await this.ingest(id);
  }

  /**
   * 判断队列：串行，一次一个；正在跑就直接返回。
   * 规则能定的、太旧的当场写；要问模型的按 ticket 走：某个 ticket 一时问不了（花费熔断、限流、超时……），它的轮留着
   * （CONV_PAUSE_RETRY_MS 之后再试，结束超过 CONV_JUDGE_MAX_AGE_MS 记 no / old），后面别的 ticket 的轮照常判。
   */
  async runJudges(): Promise<void> {
    if (this.stopped || this.judging) return;
    this.judging = true;
    try {
      let after: { endedAt: number; id: number } | undefined;
      for (;;) {
        const batch = this.d.repo.pendingEnded(JUDGE_BATCH, after);
        if (batch.length === 0) return;
        for (const t of batch) {
          if (this.stopped) return;
          after = { endedAt: t.endedAt ?? 0, id: t.id };
          if (this.ruleVerdict(t)) continue;
          const s = this.d.sessions.get(t.sessionId);
          if (!s) {
            this.verdict(t.id, "no", "judge_failed");
            continue;
          }
          const key = s.ticketKey ?? "";
          if ((this.pausedUntil.get(key) ?? 0) > this.d.now()) continue;
          if ((await this.judgeOne(t, s)) === "paused") {
            if (this.stopped) return;
            this.pausedUntil.set(key, this.d.now() + CONV_PAUSE_RETRY_MS);
          }
        }
      }
    } catch (e) {
      this.d.log?.(`conv judge: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.judging = false;
    }
  }

  /** 只做不用问模型的那部分（同步）：每次读完就跑，模型判断正在跑也不耽误规则结论（换新前的恢复提示要用）。 */
  private applyRules(): void {
    perfOp("conv.rules", () => this.applyRulesNow());
  }

  private applyRulesNow(): void {
    try {
      let after: { endedAt: number; id: number } | undefined;
      for (;;) {
        const batch = this.d.repo.pendingEnded(JUDGE_BATCH, after);
        if (batch.length === 0) return;
        for (const t of batch) {
          after = { endedAt: t.endedAt ?? 0, id: t.id };
          this.ruleVerdict(t);
        }
      }
    } catch (e) {
      this.d.log?.(`conv rules: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 规则能定的写规则结论（不看新旧：规则不花钱）；要问模型但太旧的记 no / old。写了返回 true，要问模型返回 false。 */
  private ruleVerdict(t: ConvTurn): boolean {
    const stamp = `${t.lastAt}|${t.endedAt}|${t.asked}|${t.mutated}|${t.otherTools}`;
    if (this.needsJudge.get(t.id) !== stamp) {
      const rule = ruleQa({ asked: t.asked, mutated: t.mutated, otherTools: t.otherTools, answerChars: [...this.qaText(t.id).answer].length });
      if (rule !== "judge") {
        this.needsJudge.delete(t.id);
        this.verdict(t.id, rule, "rule");
        return true;
      }
      this.needsJudge.set(t.id, stamp);
      if (this.needsJudge.size > PARENT_MAP_MAX) this.needsJudge.delete(this.needsJudge.keys().next().value as number);
    }
    if ((t.endedAt ?? 0) < this.d.now() - CONV_JUDGE_MAX_AGE_MS) {
      this.needsJudge.delete(t.id);
      this.verdict(t.id, "no", "old");
      return true;
    }
    return false;
  }

  private qaText(turnId: number): { question: string; answer: string } {
    const msgs = this.d.repo.turnMessages(turnId);
    return {
      question: msgs.filter((m) => m.role === "user").map((m) => m.text).join("\n\n"),
      answer: msgs.filter((m) => m.role === "assistant").map((m) => m.text).join("\n\n"),
    };
  }

  private async judgeOne(t: ConvTurn, s: Session): Promise<"done" | "paused"> {
    const { repo } = this.d;
    let v: ConvQaVerdict;
    try {
      v = await this.d.judge(this.qaText(t.id), { cwd: s.cwd, ticketKey: s.ticketKey });
    } catch (e) {
      this.d.log?.(`conv judge ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
      v = null;
    }
    if (this.stopped || v === "paused") return "paused";
    // 等模型的时候这一轮可能又读进了改动，或者别处已经判过了：以现在的状态为准。
    const now = repo.turn(t.id);
    if (!now || now.qa !== "pending") return "done";
    if (now.mutated) return this.verdict(t.id, "no", "rule");
    return v === null ? this.verdict(t.id, "no", "judge_failed") : this.verdict(t.id, v ? "yes" : "no", "judge");
  }

  private verdict(turnId: number, qa: "yes" | "no", by: QaBy): "done" {
    if (this.d.repo.setQa(turnId, qa, by)) {
      const root = this.d.repo.turn(turnId)?.rootSessionId;
      if (root) this.appended(root);
    }
    return "done";
  }

  private appended(root: string): void {
    try {
      this.d.onAppended(root);
    } catch (e) {
      this.d.log?.(`conv onAppended ${root}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 把这个 session 的 transcript 读到最新（同一个 session 串行：前一次没完就排在它后面）。出错只记日志。 */
  ingest(sessionId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.run(sessionId));
    this.chains.set(sessionId, next);
    void next.then(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    });
    return next;
  }

  private async run(id: string): Promise<void> {
    if (this.stopped) return;
    this.inRun.add(id);
    try {
      await this.readAll(id);
    } catch (e) {
      this.parents.delete(id);
      this.d.log?.(`conv ingest ${id}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.inRun.delete(id);
    }
    this.afterRead();
  }

  /** 读完一次以后：规则判一遍，告诉 onAppended，跑判断队列。 */
  private afterRead(): void {
    if (!this.stopped) this.applyRules();
    const roots = [...this.touched];
    this.touched.clear();
    for (const root of roots) this.appended(root);
    void this.runJudges();
  }

  /** 先读到、后连上 replaced_by：整段搬到链根下。transcript 已经没了也要搬（PR #60 review 4）。返回链根和（搬过以后的）游标。 */
  private rooted(id: string): { root: string; cursor: ReturnType<ConvRepo["cursor"]>; moved: boolean } {
    const { repo } = this.d;
    const root = this.d.sessions.rootOf(id) ?? id;
    let cursor = repo.cursor(id);
    const moved = cursor !== null && cursor.rootSessionId !== root;
    if (moved) {
      repo.reroot(id, root);
      this.touched.add(root);
      cursor = repo.cursor(id);
    }
    return { root, cursor, moved };
  }

  private async readAll(id: string): Promise<void> {
    this.rooted(id);
    const file = this.d.transcriptOf(id);
    if (!file) return;
    // 开着的 head 一直挂在 hub 上；别的（链上的旧段、刚关掉的）这次读的时候挂一下。
    // 监视还挂在旧文件上（transcript 换了路径）：撤掉，免得两个读取共用一个游标、来回从头读；tickOnce 会在新文件上挂回来。
    const own = this.watches.get(id);
    if (own && own.file !== file) {
      own.w.close();
      own.detach();
      this.watches.delete(id);
    }
    const detach = own?.file === file ? null : this.hub.attach(file, `conv:${id}`, this.sink(id, file));
    try {
      await this.hub.pump(file);
    } finally {
      detach?.();
    }
  }

  /**
   * 这个 session 在 hub 上的读取：游标在库里（字节位置、inode、打开的那一轮）。inode 变了或文件比游标短就从头读：
   * 当场把重置后的游标（新 inode、偏移 0、没有打开的轮）存下，这次读不到完整的行也一样。每块一个事务，事务里存游标。
   */
  private sink(id: string, file: string): TailSink {
    const { repo } = this.d;
    let root = id;
    let openTurnId: number | null = null;
    let fed = false;
    let failed = false;
    return {
      begin: (st: TailStat) => {
        if (this.stopped) return null;
        failed = false;
        const r = this.rooted(id);
        root = r.root;
        // 这次搬到了新的链根下：就算没有新行，也要收尾（onAppended）。
        if (r.moved) fed = true;
        const c = r.cursor;
        const reset = c !== null && ((c.ino !== null && !sameIno(c.ino, st.ino)) || st.size < c.offset);
        openTurnId = reset ? null : (c?.openTurnId ?? null);
        if (reset) {
          // 文件换了或变短了，从头重读：游标里记的「打开的轮」不能拿来结束（第一行 user 会把它按文件开头的时间结束掉）。
          this.parents.delete(id);
          repo.saveCursor({ sessionId: id, rootSessionId: root, file, ino: st.ino, offset: 0, openTurnId: null, updatedAt: this.d.now() });
        }
        return { offset: reset ? 0 : (c?.offset ?? 0) };
      },
      lines: (lines: TailLine[], next: number, st: TailStat) => {
        if (this.stopped) return false;
        // 两块之间可能连上了 replaced_by（run() 里搬过）：按现在的链根写。
        root = this.rooted(id).root;
        const skipped = lines.filter((l) => l.skipped);
        if (skipped.length > 0) this.d.log?.(`conv ingest ${id}: skipped ${skipped.length} line(s) over the size limit at byte ${skipped[0].start}`);
        let changed = false;
        try {
          perfOp("conv.ingest", () => repo.transaction(() => {
            for (const l of lines) {
              if (l.skipped || !l.text) continue;
              for (const e of convEntriesOfValue(l.json(), l.text)) {
                const r = this.apply(id, root, e, openTurnId);
                openTurnId = r.openTurnId;
                changed ||= r.changed;
              }
            }
            repo.saveCursor({ sessionId: id, rootSessionId: root, file, ino: st.ino, offset: next, openTurnId, updatedAt: this.d.now() });
          }));
        } catch (e) {
          // 事务回滚了：parentMap 里可能有指向回滚掉的轮的 id。游标没动，下次从这里再读。
          this.parents.delete(id);
          if (!failed) this.d.log?.(`conv ingest ${id}: ${e instanceof Error ? e.message : String(e)}`);
          failed = true;
          return false;
        }
        if (changed) this.touched.add(root);
        fed = true;
      },
      end: () => {
        // 别的消费者读到的新内容：这里收尾（run() 里读的由 run() 收）。
        if (!fed) return;
        fed = false;
        if (!this.inRun.has(id)) this.afterRead();
      },
    };
  }

  private parentMap(id: string): Map<string, number> {
    let m = this.parents.get(id);
    if (!m) {
      m = new Map();
      this.parents.set(id, m);
    }
    return m;
  }

  private remember(id: string, key: string, turnId: number): void {
    const m = this.parentMap(id);
    m.set(key, turnId);
    while (m.size > PARENT_MAP_MAX) {
      const first = m.keys().next();
      if (first.done) break;
      m.delete(first.value);
    }
  }

  /** 处理一个 entry；返回新的打开的那一轮，以及有没有新写消息或改了问答结论。 */
  private apply(id: string, root: string, e: ConvEntry, openTurnId: number | null): { openTurnId: number | null; changed: boolean } {
    const { repo } = this.d;
    const parents = this.parentMap(id);
    const timeOf = (turnId: number | null): number => e.at ?? (turnId !== null ? repo.turn(turnId)?.lastAt : undefined) ?? this.d.now();
    let changed = false;
    const add = (turnId: number, role: "user" | "assistant", text: string, at: number): void => {
      const m = repo.addMessage({ turnId, rootSessionId: root, sessionId: id, role, text: capText(text), at, forkId: null, sourceKey: e.key });
      if (m) changed = true;
    };

    if (e.kind === "user") {
      const at = timeOf(openTurnId);
      if (openTurnId !== null) repo.touchTurn(openTurnId, { at, endedAt: at });
      const kind = KIND_OF[e.open];
      const turnId = repo.openTurn({
        rootSessionId: root, sessionId: id, sourceKey: e.key, forkId: null, kind, at,
        asked: e.open === "user" && isQuestionLike(e.text ?? ""),
      });
      if (kind !== "user") changed = repo.setQa(turnId, "no", "rule") || changed;
      if ((e.open === "user" || e.open === "relay") && e.text) add(turnId, "user", e.text, at);
      this.remember(id, e.key, turnId);
      return { openTurnId: turnId, changed };
    }

    let turnId = (e.parent !== null ? parents.get(e.parent) : undefined) ?? openTurnId;
    if (turnId !== null && e.kind !== "noise") this.needsJudge.delete(turnId);
    if (e.kind === "noise") {
      if (turnId !== null) this.remember(id, e.key, turnId);
      return { openTurnId, changed };
    }
    if (turnId === null) {
      // 前面没有用户的话（文件中间开始、或者只有 agent 在说）：开一轮 orphan，不算问答。
      turnId = repo.openTurn({ rootSessionId: root, sessionId: id, sourceKey: `orphan:${e.key}`, forkId: null, kind: "orphan", at: timeOf(null), asked: false });
      repo.setQa(turnId, "no", "rule");
      openTurnId = turnId;
    }
    const at = timeOf(turnId);
    const turn = repo.turn(turnId);
    if (e.kind === "assistant") {
      if (turn && turn.kind !== "handoff" && e.text) add(turnId, "assistant", e.text, at);
      repo.touchTurn(turnId, { at, ...(e.stop && { endedAt: at }) });
    } else {
      const mutated = e.effect === "mutate";
      repo.touchTurn(turnId, { at, mutated, otherTools: e.effect === "other", ...(e.stop && { endedAt: at }) });
      if (mutated && turn?.qa === "yes") changed = repo.setQa(turnId, "no", "rule") || changed;
    }
    this.remember(id, e.key, turnId);
    return { openTurnId, changed };
  }
}
