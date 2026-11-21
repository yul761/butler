import { stat } from "node:fs/promises";
import type { Session } from "../../shared/types";
import type { ConvRepo, ConvTurn, QaBy, TurnKind } from "../db/conv-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import { WATCH_DEBOUNCE_MS } from "../sessions/activity-monitor";
import { DebouncedWatch, type WatchFn } from "../sessions/transcript-watch";
import { capText, convEntriesOf, type ConvEntry, type UserOpen } from "./conv-parse";
import { isQuestionLike, ruleQa, type ConvQaVerdict } from "./conv-qa";
import { readChunk } from "./jsonl-reader";

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
/** 某个 ticket 的判断一时问不了模型（花费熔断、限流、超时……）：这么久之内不再为它问（别的 ticket 照常判）。 */
export const CONV_PAUSE_RETRY_MS = CONV_SWEEP_MS;
const JUDGE_BATCH = 20;

/**
 * 和 SessionsRepo.listConvTargets 的条件一致（不看活动时间）。那边还挡掉以前的 epic session（BTL-246），Session 上没有那一列：
 * 那些 session 迁移时已经隐藏，Butler 不会再把它们跑起来。
 */
export function isConvTarget(s: Session | null): boolean {
  if (!s || s.replacedBy !== null || s.lessonRunId !== null) return false;
  return s.origin === "butler" || s.ticketKey !== null || s.featureId !== null || s.butler;
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
}

const KIND_OF: Record<UserOpen, TurnKind> = { user: "user", relay: "silent", silent: "silent", handoff: "handoff" };

export class ConvIngester {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly parents = new Map<string, Map<string, number>>();
  private readonly watches = new Map<string, { file: string; w: DebouncedWatch }>();
  private intervals: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private judging = false;
  /** ticketKey（没有 ticket 是 ""）→ 到这个时间之前不再问模型。 */
  private readonly pausedUntil = new Map<string, number>();
  private sweeping: Promise<void> | null = null;

  constructor(private readonly d: ConvIngesterDeps) {}

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
    for (const { w } of this.watches.values()) w.close();
    this.watches.clear();
  }

  /** 开着的 target head：挂上监视（重命名以后会掉，ensure 重新挂上），文件大小和游标对不上就读；已经关掉的 head 撤掉监视。 */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const heads = new Set(this.d.openHeads().filter((h) => isConvTarget(this.d.sessions.get(h))));
    for (const [h, { w }] of this.watches) {
      if (!heads.has(h)) {
        w.close();
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
        entry = undefined;
      }
      if (!entry) {
        entry = { file, w: new DebouncedWatch(file, { delayMs: WATCH_DEBOUNCE_MS, onChange: () => void this.ingest(h), watch: this.d.watch, log: (m) => this.d.log?.(m) }) };
        this.watches.set(h, entry);
      }
      entry.w.ensure();
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      const c = this.d.repo.cursor(h);
      if (!c || c.file !== file || c.ino !== st.ino || c.offset !== st.size) await this.ingest(h);
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
    const rule = ruleQa({ asked: t.asked, mutated: t.mutated, otherTools: t.otherTools, answerChars: [...this.qaText(t.id).answer].length });
    if (rule !== "judge") {
      this.verdict(t.id, rule, "rule");
      return true;
    }
    if ((t.endedAt ?? 0) < this.d.now() - CONV_JUDGE_MAX_AGE_MS) {
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
    const touched = new Set<string>();
    try {
      await this.readAll(id, touched);
    } catch (e) {
      this.parents.delete(id);
      this.d.log?.(`conv ingest ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!this.stopped) this.applyRules();
    for (const root of touched) this.appended(root);
    void this.runJudges();
  }

  private async readAll(id: string, touched: Set<string>): Promise<void> {
    const { repo } = this.d;
    const root = this.d.sessions.rootOf(id) ?? id;
    let cursor = repo.cursor(id);
    if (cursor && cursor.rootSessionId !== root) {
      // 先读到、后连上 replaced_by：整段搬到链根下。transcript 已经没了也要搬（PR #60 review 4）。
      repo.reroot(id, root);
      touched.add(root);
      cursor = repo.cursor(id);
    }
    const file = this.d.transcriptOf(id);
    if (!file) return;
    let openTurnId = cursor?.openTurnId ?? null;
    let from = { ino: cursor?.ino ?? null, offset: cursor?.offset ?? 0 };
    for (;;) {
      if (this.stopped) return;
      const chunk = await readChunk(file, from, { chunkBytes: this.d.chunkBytes, maxLineBytes: this.d.maxLineBytes });
      if (!chunk || this.stopped) return;
      if (chunk.reset) {
        // 文件换了或变短了，从头重读：游标里记的「打开的轮」不能拿来结束（第一行 user 会把它按文件开头的时间结束掉）。
        openTurnId = null;
        this.parents.delete(id);
      }
      if (chunk.skipped > 0) this.d.log?.(`conv ingest ${id}: skipped ${chunk.skipped} line(s) over the size limit at byte ${chunk.start}`);
      if (chunk.lines.length === 0 && chunk.skipped === 0) return;
      let changed = false;
      try {
        repo.transaction(() => {
          for (const line of chunk.lines) {
            for (const e of convEntriesOf(line)) {
              const r = this.apply(id, root, e, openTurnId);
              openTurnId = r.openTurnId;
              changed ||= r.changed;
            }
          }
          repo.saveCursor({ sessionId: id, rootSessionId: root, file, ino: chunk.ino, offset: chunk.next, openTurnId, updatedAt: this.d.now() });
        });
      } catch (e) {
        // 事务回滚了：parentMap 里可能有指向回滚掉的轮的 id。
        this.parents.delete(id);
        throw e;
      }
      if (changed) touched.add(root);
      from = { ino: chunk.ino, offset: chunk.next };
    }
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
