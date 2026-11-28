import { plainNoteBody, sameBody, truncateUnits } from "../../shared/memory";
import {
  FLOW_DAILY_ASKS, FLOW_DAY_MS, FLOW_MIN_CONFIDENCE, FLOW_SOURCE_NAME_LIMIT, type FlowActionState, type FlowActionView, type FlowChange, type FlowItemView, type FlowLeftovers, type FlowMemoryState,
  type FlowScope, type FlowTarget, type FlowTurnText,
} from "../../shared/infoflow";
import { isTaskMessage } from "../../shared/control";
import { retryRequest } from "../../shared/close-ticket-outcome";
import type { RememberWriteResult } from "../../shared/fork";
import type { NowNotice, Session } from "../../shared/types";
import type { ConvRepo, ConvTurn, TurnKind } from "../db/conv-repo";
import type { FlowActionRow, FlowItemRow, InfoflowRepo } from "../db/infoflow-repo";
import {
  alreadyDone, applyChange, undoFor, autoEligible, changeSignature, parseChange, parseUndo, resolveChange, stillValid, undoChange,
  type ActionWorld, type CloseStep, type TicketActions,
} from "./actions";
import { findDuplicate } from "./dedupe";
import type { ExtractContext, ExtractedItem, ExtractOutcome, RawChange } from "./extract";
import { prefilterTurn } from "./prefilter";
import { maskSecrets } from "./secrets";
import {
  coveringScopes, narrowestScope, parseTargetLabel, recipients, resolveTargets, targetLabel, withinSource, type RecipientLookup, type SourceInfo,
  type TargetLookup,
} from "./targets";

/**
 * 信息流转（BTL-272）：每个 session 每轮说完以后——
 * 1. 预筛（太短、没有决定的不问模型）；2. 低档模型抽要点；3. 和同一范围（及盖住它的）最近的要点去重；
 * 4. 先把这一轮和它的要点记进库（一个事务），再一条条「跟进」（follow）：状态变化先处理（用户亲口说的、把握大、能撤销的直接同步，
 *    其余等你确认，确认前不记不发）；然后写进覆盖目标的最小一级记忆；最后先告诉总控（同步了什么），再把要点发给目标的 session。
 *    同一条对同一个 session 只发一条（ref 是 flow:<要点>:<session>），撤销时按 ref 撤回还在排队的。
 * 跟进只按库里那一行做：中途退出，下一遍从没跟进完的接着做。只处理最近结束的轮，不补历史；一轮只处理一次（infoflow_turns）。
 */

/** 结束超过这么久的轮不再处理（不补历史；模型一直没空时最多等这么久）。 */
export const FLOW_MAX_AGE_MS = 2 * 3600_000;
/** 最后一句话之后等这么久再处理：agent 停下来又接着说的，等它说完。 */
export const FLOW_SETTLE_MS = 20_000;
/** 去重看最近这么久抽出来的要点。 */
export const FLOW_DEDUPE_WINDOW_MS = 7 * 24 * 3600_000;
/** 同一个状态变化这么久里只提一次。 */
export const FLOW_SIGNATURE_WINDOW_MS = 7 * 24 * 3600_000;
/** 「已替你同步」的提示显示这么久，过后只在信息流转页里看得到。 */
export const FLOW_SYNCED_NOTICE_MS = 3 * 24 * 3600_000;
/** 这一轮开始前这么久之内送到的 fact 也算这一轮收到的（直接粘进去的消息，送到时间略早于这一轮开始）。 */
export const FLOW_FACT_SLACK_MS = 60_000;
/** 信息流转的记录（轮、要点、递送、状态变化）留多久；和信箱留消息一样长。还在等你的不删。 */
export const FLOW_KEEP_MS = 30 * 24 * 3600_000;
/** 多久清一次旧记录。 */
export const FLOW_PRUNE_EVERY_MS = 10 * 60_000;
/** 模型真的跑了却没给结果（超时、被中止）：算问了一次（计入每天上限），也算试了一次。 */
const RAN_LATER: ReadonlySet<string> = new Set(["timeout", "aborted"]);
/** 执行出错（不是模型忙）、超时的轮最多试这么多次，再不行记 failed。 */
export const FLOW_MAX_ATTEMPTS = 3;

/** 卡片、提醒上能点的。retry、accept 只对 partial（关了、还有 PR 没关上）。 */
export type FlowAct = "apply" | "reject" | "undo" | "dismiss" | "retry" | "accept";

function parseLeftovers(json: string | null): FlowLeftovers | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<FlowLeftovers>;
    if (!Array.isArray(v.prErrors) || !Array.isArray(v.sessionErrors)) return null;
    return { prErrors: v.prErrors, sessionErrors: v.sessionErrors, ...(v.closedMeanwhile === true ? { closedMeanwhile: true as const } : {}) };
  } catch {
    return null;
  }
}
/** 一遍最多问模型这么多次。 */
const BATCH = 4;
/** 每页取这么多轮；熔断压着的跳过，往后翻，最多翻这么多页。 */
const PAGE = 16;
const MAX_PAGES = 8;
/** 一遍最多接着跟进这么多条没做完的。 */
const RESUME = 50;
const RECENT_LIMIT = 300;
const LIST_LIMIT = 200;

/** 只有这几种写进记忆；fyi 只发不记。 */
const REMEMBERED = new Set(["decision", "convention", "constraint", "state_change"]);

export interface InfoflowDeps {
  repo: InfoflowRepo;
  conv: Pick<ConvRepo, "turn" | "turnMessages">;
  head(id: string): Session | null;
  /** 设置：自动抽要点 / 自动执行状态变化。 */
  enabled(): boolean;
  autoApply(): boolean;
  /** 来源 session 在哪（ticket、epic、是不是全局总控）。 */
  sourceOf(s: Session): SourceInfo;
  /** 给人看、给模型看的 session 名字。 */
  nameOf(id: string): string;
  /** 给模型的上下文：有哪些 epic、ticket、feature。text 是这一轮的话，里面提到的 ticket 也带上。 */
  context(src: SourceInfo, sourceName: string, text: string): ExtractContext;
  targets: TargetLookup;
  epicOfTicket(key: string): number | null;
  recipients: RecipientLookup;
  extract(ctx: ExtractContext, turn: { userText: string; agentText: string }, o: { cwd: string; ticketKey: string | null }): Promise<ExtractOutcome>;
  cwdOf(s: Session): string;
  /** 熔断压着这个 session 的后台活：先不处理，等放开。 */
  paused(headId: string): boolean;
  remember(scope: string, text: string, findDup: (existing: readonly string[]) => string | null): Promise<{ result: RememberWriteResult | "dup"; dupOf: string | null }>;
  /** 忘掉这个范围里 match 认出来的笔记（撤销同步时）；返回忘了几条，记忆用不了为 null。 */
  forget(scope: string, match: (text: string) => boolean): Promise<number | null>;
  /** 发进信箱（fact）。epic 由信箱按收件人算，不从来源带。 */
  send(m: { from: string; to: string; body: string; ref: string; meta: { item: number; wake: boolean } }): { id: string };
  /** 撤回这个 ref 还在排队的那一条。 */
  withdraw(ref: string): void;
  /** 这个 session 挂的 ticket 已经关了、做完了（或者归档了）：排队给它的要点不再送。 */
  finished(sessionId: string): boolean;
  world: ActionWorld;
  act: TicketActions;
  strings(): {
    fact: (who: string, kind: string, text: string) => string;
    synced: (who: string, label: string) => string;
    confirmed: (who: string, label: string) => string;
    undone: (who: string, label: string) => string;
    source: (who: string) => string;
    kinds: Record<string, string>;
    closeTicket: (key: string, reason: string) => string;
    /** prs 是要关的（#41），cannot 是关不了的（#43：原因）。 */
    closeTicketPrs: (key: string, reason: string, prs: string[], cannot: string[]) => string;
    /** 确认时要关的 PR 和卡片上列的对不上了：换成现在这份，再问一次。 */
    prsChanged: string;
    /** 卡片上关不了的那个 PR：「#43：原因」。 */
    unclosable: (pr: string, error: string) => string;
    interrupted: string;
    setFeature: (key: string, feature: string | null) => string;
    prioritize: (feature: string) => string;
    closeReason: string;
    /** partial 时记在 error 里的一句（逐条的原因在 leftovers 里）。 */
    prFailed: (urls: string) => string;
    /** 关的时候别人先关了这个 ticket：这次实际做了什么（记在 already 的 error 里，卡片上跟在「本来就是这样」后面）。 */
    closedMeanwhile: Record<"prs" | "sessions" | "both" | "nothing", string>;
    /** 关的时候别人先关了、有勾了的没处理成：partial 时记在 error 里的一句。 */
    closedMeanwhileFailed: (urls: string) => string;
  };
  blockName(id: number): string | null;
  notify(): void;
  now(): number;
  /** 最后一句话后等多久再处理；不给是 FLOW_SETTLE_MS（e2e 用 SHIPHERD_FLOW_SETTLE_MS 缩短）。 */
  settleMs?: number;
  /** 最近 24 小时最多问模型几次（不给是 FLOW_DAILY_ASKS）。 */
  dailyAsks?(): number;
  log(msg: string, e?: unknown): void;
}

/** 处理一轮的结果：asked 问过模型了（一遍最多 BATCH 次）；skipped 不用问；paused 熔断压着，先跳过；later 模型这会儿忙，这一遍到此为止。 */
export type TurnResult = "asked" | "skipped" | "paused" | "later" | "capped";

/** 状态变化处理到哪了：go 接着记、发；hold 等你确认；drop 不记不发；repeat 别处已经提过同一个变化。 */
type Gate = "go" | "hold" | "drop" | "repeat";

/** 记忆里同一段话写不进去时加的「 #2」…（见 MemoryService.writeNote）。 */
const stripVariant = (s: string): string => s.replace(/ #\d+$/u, "");
/**
 * 记忆里这一条是不是这条要点写的那一条：连来源注记一起比（别的 session 写的同一句话不算），「 #2」不算，
 * 空白、全半角按记忆写入时的规整方式宽松比较。
 */
const sameNote = (existing: string, note: string): boolean => sameBody(stripVariant(existing), plainNoteBody(note));

/** PR 链接给人看的写法：#41（认不出就是原链接）。 */
const prName = (url: string): string => {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? `#${m[1]}` : url;
};

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
export const flowRef = (itemId: number, to: string): string => `flow:${itemId}:${to}`;
const undoRef = (itemId: number, to: string): string => `flowundo:${itemId}:${to}`;

function parseRaw(json: string | null): RawChange | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<RawChange>;
    if (v.op !== "close_ticket" && v.op !== "set_ticket_feature" && v.op !== "prioritize_feature") return null;
    return { op: v.op, ticket: typeof v.ticket === "string" ? v.ticket : null, feature: v.feature, reason: typeof v.reason === "string" ? v.reason : null, closePrs: v.closePrs === true };
  } catch {
    return null;
  }
}

export class InfoflowService {
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 正在执行或撤销的状态变化（同一条点两下只做一次；执行中点「不用」不算数）。 */
  private acting = new Set<number>();
  /** 正在跟进的要点（后台那一遍和界面上点的确认撞上时只做一次）。 */
  private following = new Set<number>();

  constructor(private readonly d: InfoflowDeps) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poke(), intervalMs);
    this.timer.unref?.();
    // 上次没跟进完的（中途退出）马上接着做。
    this.poke();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 有新对话了（或者定时）：看看有没有该处理的轮。正在跑就跑完再来一遍。 */
  poke(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.drain()
      .catch((e) => this.d.log("infoflow drain failed", e))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.poke();
        }
      });
  }

  private prunedAt: number | null = null;
  /** 上一遍是不是到了上限（变了才通知刷新）。 */
  private wasCapped = false;

  /** 隔一阵清一次旧记录（问模型的记录只要最近 24 小时）。 */
  private prune(): void {
    const d = this.d;
    const now = d.now();
    if (this.prunedAt !== null && now - this.prunedAt < FLOW_PRUNE_EVERY_MS) return;
    this.prunedAt = now;
    d.repo.prune(now - FLOW_KEEP_MS, now - FLOW_DAY_MS);
  }

  /** 测试用：等当前这一遍跑完。 */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    const d = this.d;
    // 收拾已有的（过时的提议作废；结果被改回去的撤回还在排队的消息）不花模型的钱，关掉「自动抽要点」也照样做：
    // 不然排着的旧要点、「已替用户同步」照样会送出去。
    this.proposals(true);
    await this.recheckApplied();
    this.withdrawToFinished();
    this.prune();
    // 等上限等到老化了的轮：记成丢掉了（「现在」页上说丢了几轮）。
    if (this.d.repo.expireCapped(d.now() - FLOW_MAX_AGE_MS, d.now()) > 0) d.notify();
    // 到上限、额度回来了：「现在」页上那条提醒跟着出、跟着消失（不等别的事刷新）。
    const capped = d.enabled() && this.capped();
    if (capped !== this.wasCapped) {
      this.wasCapped = capped;
      d.notify();
    }
    // 执行到一半退出的状态变化：不管开没开「自动抽要点」都先了结（不花模型的钱）。做成了的算执行了；被人改回去的记成作废，
    // 不然关着的这段时间里你手动重开的 ticket，打开以后会被再关一次。记忆、消息仍由下面的跟进（开着时）接着做。
    for (const a of d.repo.interruptedActions(RESUME)) {
      const change = parseChange(a.change);
      if (change) await this.run(a.id, change);
    }
    // 关掉了「自动抽要点」：还在排队的要点一条都不送出去（关掉以前正在跟进的那条送出的，下一遍也撤回）。
    if (!d.enabled()) {
      this.withdrawAllQueued();
      return;
    }
    // 先把没跟进完的做完（不花模型的钱），再看新的轮。
    for (const it of d.repo.unfollowed(RESUME)) {
      if (!d.enabled()) return;
      await this.follow(it.id);
    }
    const now = d.now();
    const since = now - FLOW_MAX_AGE_MS;
    const settled = now - (d.settleMs ?? FLOW_SETTLE_MS);
    let asked = 0;
    let after: { endedAt: number; id: number } | undefined;
    for (let page = 0; ; page++) {
      // 到上限时不问模型、只记「等着」（不花钱）：翻到底，不受 MAX_PAGES 限制，等着的轮一条不漏，老化时丢了几轮才数得准；
      // 已经在等着的轮不再看（每一遍只看新来的）。没到上限时最多翻 MAX_PAGES 页。
      const cappedNow = this.capped();
      if (!cappedNow && page >= MAX_PAGES) return;
      const turns = d.repo.pendingTurns(since, settled, PAGE, after, cappedNow);
      for (const t of turns) {
        if (asked >= BATCH || !d.enabled()) return;
        const r = await this.processTurn(t);
        if (r === "asked") asked++;
        // 模型这会儿忙（熔断、限流、超时）：后面的轮问了也一样，等下一遍。
        else if (r === "later") return;
        // 今天问够了：不再问模型，但接着往后看（不花钱），把要等的轮都记成等着，等太久老化了才数得出丢了几轮。
        else if (r === "capped" && !this.wasCapped) {
          this.wasCapped = true;
          d.notify();
        }
      }
      if (turns.length < PAGE) return;
      const last = turns[turns.length - 1];
      after = { endedAt: last.endedAt ?? 0, id: last.id };
    }
  }

  /** 一轮的话：总控派的任务（TASK_PREFIX 开头）不算用户说的，不交给模型当用户的话；fromUser 是用户亲口在终端里说的一轮。 */
  private speech(turnId: number, kind: TurnKind): { userText: string; agentText: string; fromUser: boolean } {
    const msgs = this.d.conv.turnMessages(turnId);
    const users = msgs.filter((m) => m.role === "user");
    const task = users.some((m) => isTaskMessage(m.text));
    return {
      userText: users.filter((m) => !isTaskMessage(m.text)).map((m) => m.text).join("\n\n"),
      agentText: msgs.filter((m) => m.role === "assistant").map((m) => m.text).join("\n\n"),
      fromUser: kind === "user" && !task,
    };
  }

  /** 处理一轮。 */
  async processTurn(turn: ConvTurn): Promise<TurnResult> {
    const d = this.d;
    const head = d.head(turn.sessionId);
    const mark = (state: "skipped" | "done" | "failed", reason: string | null, items = 0): void => {
      if (d.repo.markTurn({ turnId: turn.id, sessionId: turn.sessionId, state, reason, items, at: d.now() })) d.notify();
    };
    if (!head || head.lessonRunId !== null) {
      mark("skipped", "session");
      return "skipped";
    }
    if (d.paused(head.id)) return "paused";
    // 已经在等上限、现在还是到上限：不用再看一遍。
    if (d.repo.turnCapped(turn.id) && this.capped()) return "capped";
    const sp = this.speech(turn.id, turn.kind);
    const pre = prefilterTurn({ kind: turn.kind, userText: sp.userText, agentText: sp.agentText });
    if (!pre.ok) {
      mark("skipped", pre.reason);
      return "skipped";
    }
    // 这一轮收到过别人发来的要点：agent 的回应（「收到，BTL-12 取消了」）只记不发，免得要点在 session 之间来回转。
    const gotFact = d.repo.factDelivered([...new Set([turn.sessionId, head.id])], turn.startedAt - FLOW_FACT_SLACK_MS, turn.lastAt);
    // 后台轮里只是收到了要点、用户什么也没说：agent 的话就是在复述它，不再花一次模型去抽。
    if (gotFact && turn.kind === "silent" && !pre.userText) {
      mark("skipped", "got_fact");
      return "skipped";
    }
    // 今天问够了：这一轮记成等着（还算没处理），等额度回来再问；等太久老化了记成丢掉。
    if (this.capped()) {
      d.repo.holdCapped({ turnId: turn.id, sessionId: turn.sessionId, at: d.now() });
      return "capped";
    }
    const src = d.sourceOf(head);
    const sourceName = d.nameOf(head.id);
    const ctx = d.context(src, sourceName, `${pre.userText}\n${pre.agentText}`);
    const out = await d.extract(ctx, { userText: pre.userText, agentText: pre.agentText }, { cwd: d.cwdOf(head), ticketKey: src.ticketKey });
    // 模型这会儿忙（熔断、限流，没真的跑）不算一次；超时、被中止的真跑了，算一次（花了钱，计进每天的上限）。
    const ran = out.ok || !out.later || RAN_LATER.has(out.error);
    if (ran) d.repo.recordAsk(d.now());
    // 等模型的时候：别处已经处理了这一轮就不管；这一轮又多了话（agent 停下来又接着说了）就丢掉这次结果，下一遍按新的话重抽。
    const cur = d.conv.turn(turn.id);
    if (d.repo.turnHandled(turn.id)) return "asked";
    if (!cur || cur.lastAt !== turn.lastAt || cur.endedAt !== turn.endedAt) return "asked";
    if (!out.ok) {
      const error = out.error.slice(0, 300);
      if ((turn.endedAt ?? 0) < d.now() - FLOW_MAX_AGE_MS) mark("skipped", `old: ${error}`);
      // 没真的跑（熔断、限流）、或者是退出时被中止的（不怪这一轮）：不算一次尝试，下一遍再来。超时算。
      else if (out.later && (!ran || out.error === "aborted")) d.log(`infoflow: turn ${turn.id} later (${error})`);
      else {
        // 执行出错、模型这次给的东西不对、超时：多半是偶然的，过一会儿再试；试够次数才算失败（次数记在库里，重启不清零），
        // 免得一轮每次都超时、每一遍都再问一次。
        const n = d.repo.retryTurn({ turnId: turn.id, sessionId: turn.sessionId, reason: error, at: d.now() });
        if (n !== null && n >= FLOW_MAX_ATTEMPTS) mark("failed", error);
        else d.log(`infoflow: turn ${turn.id} failed (${error}), attempt ${n ?? "?"}`);
      }
      return out.later ? "later" : "asked";
    }
    const kept = out.items.filter((i) => i.confidence >= FLOW_MIN_CONFIDENCE);
    // 先记下这一轮和它的要点（一个事务），再去写记忆、发消息：中途退出，下一遍从没跟进完的接着做。
    const ids = d.repo.transaction(() => {
      if (!d.repo.markTurn({ turnId: turn.id, sessionId: turn.sessionId, state: "done", reason: null, items: kept.length, at: d.now() })) return null;
      const fresh: { text: string; area: string }[] = [];
      return kept.flatMap((it, idx) => {
        const id = this.insertItem(turn, src, it, idx, fresh, !gotFact || (it.speaker === "user" && sp.fromUser));
        return id === null ? [] : [id];
      });
    });
    if (!ids) return "asked";
    d.notify();
    for (const id of ids) await this.follow(id);
    d.notify();
    return "asked";
  }

  private insertItem(turn: ConvTurn, src: SourceInfo, it: ExtractedItem, idx: number, fresh: { text: string; area: string }[], routable: boolean): number | null {
    const d = this.d;
    const resolved = resolveTargets(it.targets, d.targets, src);
    // agent 说的只在来源自己的范围里流转、不叫醒别人（agent 的话里可能有网页、文件里的内容）。
    const agent = it.speaker === "agent";
    const targets = agent ? withinSource(resolved, src, (k) => d.epicOfTicket(k)) : resolved;
    // 出了来源范围的 agent 的话落回来源自己的 ticket / epic；来源没有 ticket 也没有 epic（workspace、全局）：丢掉，不落回 workspace。
    if (targets.length === 0) return null;
    const area = narrowestScope(targets, (k) => d.epicOfTicket(k));
    // 只和同一范围、盖住它的范围比：别的 epic 说过同样的话，这边还不知道。
    const covering = coveringScopes(area, (k) => d.epicOfTicket(k));
    const recent = [
      ...fresh.filter((f) => covering.includes(f.area)).map((f) => f.text),
      ...d.repo.recentTexts(d.now() - FLOW_DEDUPE_WINDOW_MS, covering, RECENT_LIMIT),
    ];
    const dupOf = findDuplicate(it.text, recent);
    fresh.push({ text: it.text, area });
    const remembered = REMEMBERED.has(it.kind);
    // 后台轮（信箱送来的指示、汇报之后 agent 自己的话）、agent 说的不叫醒别人。
    const importance = (turn.kind === "silent" || agent) && it.importance === "high" ? "normal" : it.importance;
    const memory: FlowMemoryState = dupOf !== null ? "dup" : remembered ? "pending" : "skipped";
    const changeRaw = it.kind === "state_change" && it.change ? JSON.stringify(it.change) : null;
    const id = d.repo.addItem({
      turnId: turn.id, idx, sessionId: turn.sessionId, rootSessionId: turn.rootSessionId, featureId: src.featureId,
      targetFeatures: [...new Set(targets.flatMap((t) => this.featuresOf(t)))], text: it.text, kind: it.kind, speaker: it.speaker, quote: it.quote,
      targets: targets.map(targetLabel), importance, confidence: it.confidence, scope: remembered ? area : null, memory, dupOf, area, routable, changeRaw,
      createdAt: d.now(),
    });
    // 重复的、又没有状态变化要处理的：没什么可做了。
    if (id !== null && dupOf !== null && changeRaw === null) d.repo.setFollowed(id, d.now());
    return id;
  }

  private featuresOf(t: FlowTarget): number[] {
    if (t.kind === "epic") return [t.featureId];
    if (t.kind === "coordinator") return t.featureId === null ? [] : [t.featureId];
    if (t.kind === "ticket") {
      const f = this.d.epicOfTicket(t.key);
      return f === null ? [] : [f];
    }
    return [];
  }

  /** 不记不发了（被拒、作废、执行失败、别处已经提过）：还没写的记忆标成 dropped（重复的保持 dup），跟进完。 */
  private settle(itemId: number, memory: "dropped" | "dup"): void {
    const it = this.d.repo.item(itemId);
    if (!it) return;
    if (it.memory === "pending" || it.memory === "held") this.d.repo.setMemory(itemId, memory);
    this.d.repo.setFollowed(itemId, this.d.now());
  }

  /**
   * 跟进一条要点，只按库里那一行做（中途退出、重启后、你点了确认以后都从这里接着做）：
   * 状态变化 → 写记忆 → 告诉总控同步了什么 → 发要点。每一步都能重做：记忆按原文去重，发送按（要点，session）只记一次。
   */
  async follow(itemId: number): Promise<void> {
    const d = this.d;
    if (this.following.has(itemId)) return;
    this.following.add(itemId);
    try {
      let item = d.repo.item(itemId);
      if (!item || item.followedAt !== null) return;
      if (item.changeRaw !== null) {
        const gate = await this.gate(item);
        if (gate === "hold") {
          if (item.memory === "pending") d.repo.setMemory(itemId, "held");
          return;
        }
        if (gate === "drop" || gate === "repeat") {
          this.settle(itemId, gate === "drop" ? "dropped" : "dup");
          return;
        }
        item = d.repo.item(itemId);
        if (!item) return;
      }
      const str = d.strings();
      const sourceName = d.nameOf(item.sessionId);
      let dup = item.memory === "dup";
      if (!dup && REMEMBERED.has(item.kind) && (item.memory === "pending" || item.memory === "held")) {
        // 抽取时已经打过码；这里再过一遍（这一版以前存下的要点、session 名字里贴进去的）：密钥不进记忆。
        const text = maskSecrets(item.text);
        const note = maskSecrets(`${text}${str.source(truncateUnits(sourceName, FLOW_SOURCE_NAME_LIMIT))}`);
        const scope = item.scope ?? item.area;
        d.repo.setNote(itemId, note);
        const r = await d.remember(scope, note, (existing) => findDuplicate(text, existing));
        // 对上的是这一条自己上次写的（写完记忆、还没记下结果就退出了）：算写进去了，接着发。
        const own = r.result === "dup" && r.dupOf !== null && stripVariant(r.dupOf) === note;
        const result = own ? "written" : r.result;
        // 等记忆的时候你可能点了撤销、情况变了：重新读这一行，还在等记才写结果；已经不要了的，刚写进去的那条忘掉，也不再发。
        if (!this.stillWanted(itemId) || !d.repo.setMemoryFrom(itemId, ["pending", "held"], result)) {
          if (result === "written") {
            const n = await d.forget(scope, (t) => sameNote(t, note));
            // 一条都没忘掉（记忆用不了，或者没认出来）：照实留着 written，界面上看得到它还在记忆里。
            d.repo.setMemory(itemId, n === null || n === 0 ? "written" : "retracted");
          }
          this.settle(itemId, "dropped");
          return;
        }
        dup = r.result === "dup" && !own;
      }
      // 同步了就告诉总控（同步了什么），不管这句话是不是和以前的重复：Shipherd 确实改了东西。先告诉总控，再发要点：同一个人只收一条。
      const a = d.repo.actionForItem(itemId);
      const change = a?.state === "applied" ? parseChange(a.change) : null;
      if (a && change) this.tellCoordinators(item, a, change, sourceName);
      if (!dup && item.routable && item.importance !== "low") this.route(item, sourceName);
      d.repo.setFollowed(itemId, d.now());
    } catch (e) {
      d.log(`infoflow: follow item ${itemId} failed`, e);
    } finally {
      this.following.delete(itemId);
      d.notify();
    }
  }

  /** 这条要点还要记、要发：还在等记，带着的状态变化（有的话）也还是执行了、本来就是这样。 */
  private stillWanted(itemId: number): boolean {
    const it = this.d.repo.item(itemId);
    if (!it || (it.memory !== "pending" && it.memory !== "held")) return false;
    const a = this.d.repo.actionForItem(itemId);
    return a === null || a.state === "applied" || a.state === "already";
  }

  /** 状态变化：第一次来提出来（能自动的直接执行），之后按它现在的状态决定这条要点记不记、发不发。 */
  private async gate(item: FlowItemRow): Promise<Gate> {
    const d = this.d;
    let a = d.repo.actionForItem(item.id);
    if (!a) {
      const raw = parseRaw(item.changeRaw);
      const resolved = raw ? resolveChange(raw, d.world, item.featureId) : null;
      // 对不上 Shipherd 里的东西：当普通要点记、发。
      if (!resolved) return "go";
      // 要连 PR 一起关：先列出现在能关的、关不了的，写在卡片上，确认后只关列出来的这些（BTL-270：路由关 PR 必须点名）。
      const change = await this.withPrs(resolved);
      // 等 gh 的时候别处（界面上点的、上一遍）可能已经提过这一条：用已有的那条。
      const raced = d.repo.actionForItem(item.id);
      if (raced) return this.gateOn(raced);
      const turn = d.conv.turn(item.turnId);
      const sp = this.speech(item.turnId, turn?.kind ?? "silent");
      const signature = changeSignature(change);
      // 同一个变化最近已经提过、做过：不再提（总控转述一遍、ticket session 又说一遍）。不是用户亲口说的，用户刚拒掉、撤销的也不再提。
      // 做过的（含 partial：ticket 关了、PR 还没关上）只在结果还在时才算：之后用户自己又改回去了，再说一遍就是新的要求。
      const live = d.repo.liveBySignature(signature, d.now() - FLOW_SIGNATURE_WINDOW_MS, !sp.fromUser);
      const executed = live !== null && (live.state === "applied" || live.state === "already" || live.state === "partial");
      if (live && !(executed && !alreadyDone(change, d.world))) return "repeat";
      const already = alreadyDone(change, d.world);
      const auto = !already && autoEligible({
        enabled: d.autoApply(), change, speaker: item.speaker, fromUser: sp.fromUser, quote: item.quote, userText: sp.userText, confidence: item.confidence,
      });
      const id = d.repo.addAction({
        itemId: item.id, change: JSON.stringify(change), signature, mode: auto ? "auto" : "confirm", state: already ? "already" : "pending", createdAt: d.now(),
      });
      a = id === null ? d.repo.actionForItem(item.id) : d.repo.action(id);
      if (!a) return "drop";
      d.notify();
    }
    return this.gateOn(a);
  }

  /** closePrs 的关 ticket：带上现在能关的 PR（prUrls）和关不了的（unclosable）。别的原样返回。 */
  private async withPrs(c: FlowChange): Promise<FlowChange> {
    if (c.op !== "close_ticket" || !c.closePrs) return c;
    const p = await this.d.act.previewClose(c.ticket);
    return { ...c, prUrls: p?.closable ?? [], unclosable: p?.unclosable ?? [] };
  }

  /** 已经有了这条要点的状态变化：自动的接着执行，再按它现在的状态决定记不记、发不发。 */
  private async gateOn(row: FlowActionRow): Promise<Gate> {
    const d = this.d;
    let a = row;
    // 确认了、执行到一半退出的（pending 却已经存了撤销用的旧状态）：和自动的一样接着执行，不再问你一次。
    if (a.state === "pending" && (a.mode === "auto" || a.undo !== null)) {
      const change = parseChange(a.change);
      if (change) await this.run(a.id, change);
      a = d.repo.action(a.id) ?? a;
    }
    switch (a.state) {
      case "applied":
      case "already":
        return "go";
      case "pending":
        return a.mode === "confirm" ? "hold" : "drop";
      // 关了、还有 PR 没关上：不算完成，等你重试或者「就这样」再记、再发。
      case "partial":
        return "hold";
      default:
        return "drop";
    }
  }

  private route(item: FlowItemRow, sourceName: string): void {
    const d = this.d;
    const str = d.strings();
    const targets = item.targets.flatMap((l) => {
      const t = parseTargetLabel(l);
      return t ? [t] : [];
    });
    const body = maskSecrets(str.fact(sourceName, str.kinds[item.kind] ?? item.kind, item.text));
    for (const to of recipients(targets, d.recipients, this.sourceHead(item))) this.deliver(item, to, body, item.importance === "high");
  }

  private sourceHead(item: FlowItemRow): string {
    return this.d.head(item.sessionId)?.id ?? item.sessionId;
  }

  /** 发一条，记进 infoflow_deliveries；这条已经发给过这个 session 就不发。 */
  private deliver(item: FlowItemRow, to: string, body: string, wake: boolean): void {
    const d = this.d;
    if (d.repo.delivered(item.id, to)) return;
    try {
      const m = d.send({ from: this.sourceHead(item), to, body, ref: flowRef(item.id, to), meta: { item: item.id, wake } });
      d.repo.addDelivery(item.id, to, m.id, d.now());
    } catch (e) {
      d.log(`infoflow: send item ${item.id} to ${to} failed`, e);
    }
  }

  /** 执行一条（自动的、确认的）：执行前再看一遍现状。只改状态；记、发由 follow 接着做。 */
  private async run(id: number, change: FlowChange): Promise<boolean> {
    const d = this.d;
    if (this.acting.has(id)) return false;
    this.acting.add(id);
    try {
      // 还在 pending 却已经存了撤销用的旧状态：上次执行到一半退出了（关 ticket 在等 gh 的时候）。
      const started = d.repo.action(id)?.undo ?? null;
      if (!stillValid(change, d.world)) return d.repo.transition(id, ["pending"], "stale", { at: d.now() });
      if (alreadyDone(change, d.world)) {
        // 本来就是这样：already。是上次自己做到一半的：算执行了，撤销照样能撤（不记成 already、丢掉撤销）。
        if (started === null) return d.repo.transition(id, ["pending"], "already", { at: d.now() });
        return this.record(id, ["pending"], await this.interrupted(change), started);
      }
      // 存了撤销、现在却不是那样：存撤销和真正改状态在同一个同步段里（关 ticket 先关再等 gh 关 PR），所以只可能是之后有人改回去了
      // （你手动重开了 ticket）。不再做一遍（那会连 PR 一起再关、再发评论），记成作废。
      if (started !== null) return d.repo.transition(id, ["pending"], "stale", { at: d.now(), error: "changed back meanwhile" });
      const undo = JSON.stringify(undoFor(change, d.world));
      // 先存撤销再动手；存不进去（已经不是 pending 了：拒绝了、作废了）就不执行。
      if (!d.repo.setUndo(id, undo)) return false;
      try {
        const ok = this.record(id, ["pending"], await applyChange(change, d.world, d.act, d.strings().closeReason), undo);
        // 关了 ticket：排队发给它的 session 的要点马上撤回，不等下一遍。
        if (ok && change.op === "close_ticket") this.withdrawToFinished();
        return ok;
      } catch (e) {
        d.log(`infoflow: apply action ${id} failed`, e);
        d.repo.transition(id, ["pending"], "failed", { at: d.now(), error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
        return false;
      }
    } finally {
      this.acting.delete(id);
      d.notify();
    }
  }

  /**
   * 上次执行到一半退出了、ticket 已经关了：要关的 PR 里还开着的记成没处理完（partial，能重试、能「就这样」）；都关了（或者不关 PR）就是做完了。
   */
  private async interrupted(change: FlowChange): Promise<CloseStep> {
    if (change.op !== "close_ticket" || !change.closePrs || !change.prUrls?.length) return { kind: "done" };
    let open: string[];
    try {
      const p = await this.d.act.previewClose(change.ticket);
      const still = new Set(p?.closable ?? []);
      open = change.prUrls.filter((u) => still.has(u));
    } catch (e) {
      this.d.log(`infoflow: preview after an interrupted close of ${change.ticket} failed`, e);
      open = change.prUrls;
    }
    if (open.length === 0) return { kind: "done" };
    const error = this.d.strings().interrupted;
    return { kind: "partial", leftovers: { prErrors: open.map((url) => ({ url, error, kind: "failed" as const })), sessionErrors: [] } };
  }

  /**
   * 记下执行（或重试）的结果：都做完了 applied；ticket 关了、还有没处理完的 partial（逐条记下，等你重试或者「就这样」）；
   * 关的时候被重新打开了 stale（不算同步了）。返回是不是还算做成了（applied、partial）。
   */
  private record(id: number, from: readonly FlowActionState[], step: CloseStep, undo?: string): boolean {
    const d = this.d;
    const at = d.now();
    if (step.kind === "reopened") {
      d.repo.transition(id, from, "stale", { at, error: "reopened meanwhile" });
      return false;
    }
    if (step.kind === "pick") {
      // 什么都没做（ticket 也没关）：要关的 PR 换成现在这份，留在「轮到你」里再问一次。
      const a = d.repo.action(id);
      const change = a ? parseChange(a.change) : null;
      if (change?.op === "close_ticket") {
        d.repo.repropose(id, JSON.stringify({ ...change, prUrls: step.prs.closable, unclosable: step.prs.unclosable }), d.strings().prsChanged);
      }
      return false;
    }
    if (step.kind === "closed_meanwhile") {
      // 别人先关了：ticket 不是这里关的，撤销（重新打开）会把别人关的也打开，丢掉撤销。
      return d.repo.transition(id, from, "already", { at, undo: null, error: d.strings().closedMeanwhile[step.how] });
    }
    if (step.kind === "partial") {
      const l = step.leftovers;
      const list = [...l.prErrors.map((e) => `${e.url}: ${e.error}`), ...l.sessionErrors.map((e) => `${e.id.slice(0, 8)}: ${e.error}`)].join("; ");
      const error = l.closedMeanwhile ? d.strings().closedMeanwhileFailed(list) : d.strings().prFailed(list);
      return d.repo.transition(id, from, "partial", { at, error, leftovers: JSON.stringify(l), ...(l.closedMeanwhile ? { undo: null } : { undo }) });
    }
    return d.repo.transition(id, from, "applied", { at, undo, error: null });
  }

  /** 关了、还有没处理完的：只重试那几个（BTL-270 的 retryClose）。之后接着跟进这条要点。 */
  private async retry(a: FlowActionRow): Promise<boolean> {
    const d = this.d;
    const change = parseChange(a.change);
    const left = parseLeftovers(a.leftovers);
    if (a.state !== "partial" || !change || change.op !== "close_ticket" || !left || this.acting.has(a.id)) return false;
    const again = retryRequest(left);
    if (!again) return false;
    // 别人先关的那一种重试成了：按这次实际重试了什么说（只重试了 session 的不说「关了 PR」）。
    const how = again.prUrls.length > 0 && again.sessionIds.length > 0 ? "both" : again.prUrls.length > 0 ? "prs" : "sessions";
    this.acting.add(a.id);
    let ok = false;
    try {
      const step = await d.act.retryClose(change.ticket, left);
      // 别人先关的那一种：重试后仍然不是这里关的。剩下的还标着，做完了记成本来就是这样（没有撤销），不变成「已同步」。
      ok = this.record(a.id, ["partial"], !left.closedMeanwhile ? step
        : step.kind === "partial" ? { kind: "partial", leftovers: { ...step.leftovers, closedMeanwhile: true } }
        : step.kind === "done" ? { kind: "closed_meanwhile", how }
        : step);
    } catch (e) {
      d.log(`infoflow: retry close for action ${a.id} failed`, e);
    } finally {
      this.acting.delete(a.id);
      d.notify();
    }
    await this.follow(a.itemId);
    return ok;
  }

  /**
   * 执行了的（或者本来就是这样的），结果后来被改掉了（ticket 手动重新打开、挪走了、feature 重新排了）：「已同步」和这条要点都不成立了。
   * 先撤回还在排队的，再记 stale，记忆里那条也忘掉。
   */
  private async recheckApplied(): Promise<void> {
    const d = this.d;
    for (const a of d.repo.toRecheck(d.now() - FLOW_SYNCED_NOTICE_MS, d.now() - FLOW_KEEP_MS)) {
      if (this.acting.has(a.id)) continue;
      const change = parseChange(a.change);
      if (!change || alreadyDone(change, d.world)) continue;
      await this.supersede(a);
    }
  }

  /** 结果已经不在了：撤回还在排队的消息（不管还找不找得到接收者），再记 stale、忘掉记忆。 */
  private async supersede(a: FlowActionRow): Promise<void> {
    const d = this.d;
    this.withdrawQueued(a.itemId);
    if (d.repo.transition(a.id, ["applied", "partial", "already"], "stale", { at: d.now(), error: "changed since" })) {
      await this.unremember(a.itemId);
      this.settle(a.itemId, "dropped");
      d.notify();
    }
  }

  /** 同步了以后告诉相关的总控（全局的，和 ticket 所在 epic 的）。关掉的、归档的 ticket 也照样找得到它的 epic。 */
  private tellCoordinators(item: FlowItemRow, a: FlowActionRow, change: FlowChange, sourceName: string): void {
    const d = this.d;
    const featureId = change.op === "prioritize_feature" ? change.featureId : (d.world.ticket(change.ticket)?.featureId ?? null);
    const targets: FlowTarget[] = [{ kind: "coordinator", featureId: null }];
    if (featureId !== null) targets.push({ kind: "coordinator", featureId });
    const str = d.strings();
    const body = maskSecrets((a.mode === "auto" ? str.synced : str.confirmed)(sourceName, this.label(change)));
    for (const to of recipients(targets, d.recipients, this.sourceHead(item))) this.deliver(item, to, body, false);
  }

  /** 撤销以后：这条要点写进记忆的那一条也忘掉（不然之后的 session 还读到「BTL-12 不做了」，去重也拿它当还有效）。 */
  private async unremember(itemId: number): Promise<void> {
    const d = this.d;
    const item = d.repo.item(itemId);
    if (!item || item.memory !== "written") return;
    // 只忘这条要点自己写的那一条（记下的整条；这一版以前写的没记，按现在的来源注记拼回来）。
    const note = item.note ?? `${item.text}${d.strings().source(truncateUnits(d.nameOf(item.sessionId), FLOW_SOURCE_NAME_LIMIT))}`;
    const n = await d.forget(item.scope ?? item.area, (t) => sameNote(t, note));
    // 记忆这会儿用不了（null）、一条都没认出来（0）：留着 written，界面上看得到它还在记忆里。
    if (n !== null && n > 0) d.repo.setMemory(itemId, "retracted");
    else d.log(`infoflow: forget item ${itemId} from memory ${n === null ? "failed" : "found nothing"}`);
  }

  /** 所有还在排队的要点消息都撤回（关掉了「自动抽要点」）。「已撤销」的更正照送。 */
  private withdrawAllQueued(): void {
    const d = this.d;
    for (const ref of d.repo.queuedFlowRefs()) {
      try {
        d.withdraw(ref);
      } catch (e) {
        d.log(`infoflow: withdraw ${ref} failed`, e);
      }
    }
  }

  /**
   * 排队发给已经关了、做完了的 ticket 的 session 的要点都撤回（ticket 是排上以后才关的：关 ticket 的时候、后台每一遍核对时）。
   * 「已撤销」的更正（flowundo:）不算：那是更正已经送到的话。
   */
  private withdrawToFinished(): void {
    const d = this.d;
    for (const ref of d.repo.queuedFlowRefs()) {
      const to = ref.split(":").slice(2).join(":");
      if (!to || !d.finished(to)) continue;
      try {
        d.withdraw(ref);
      } catch (e) {
        d.log(`infoflow: withdraw ${ref} failed`, e);
      }
    }
  }

  /** 这条要点还在排队的消息（要点、同步通知）都撤回：按记下的发送记录撤，不看接收者现在还在不在。 */
  private withdrawQueued(itemId: number): void {
    const d = this.d;
    for (const r of d.repo.deliveries([itemId])) {
      try {
        d.withdraw(flowRef(itemId, r.toSession));
      } catch (e) {
        d.log(`infoflow: withdraw item ${itemId} for ${r.toSession} failed`, e);
      }
    }
  }

  /** 撤销以后：还在排队的（要点、同步通知）先撤回，已经送到的补发一条「已撤销」。 */
  private retract(itemId: number, label: string): void {
    const d = this.d;
    const item = d.repo.item(itemId);
    this.withdrawQueued(itemId);
    if (!item) return;
    const body = maskSecrets(d.strings().undone(d.nameOf(item.sessionId), label));
    // 撤回以后还在的：已经送到了（或者已经被 hook 取走、照样会送到）。
    for (const r of d.repo.deliveries([itemId])) {
      if (r.status === null) continue;
      try {
        d.send({ from: this.sourceHead(item), to: r.toSession, body, ref: undoRef(itemId, r.toSession), meta: { item: itemId, wake: false } });
      } catch (e) {
        d.log(`infoflow: tell ${r.toSession} about undo of item ${itemId} failed`, e);
      }
    }
  }

  /** 卡片、提醒、发给总控的那一句。原因、feature 名字是模型给的、用户起的：打一遍码。 */
  label(change: FlowChange): string {
    return maskSecrets(this.rawLabel(change));
  }

  private rawLabel(change: FlowChange): string {
    const str = this.d.strings();
    if (change.op === "close_ticket") {
      if (!change.closePrs) return str.closeTicket(change.ticket, change.reason);
      return str.closeTicketPrs(change.ticket, change.reason, (change.prUrls ?? []).map(prName), (change.unclosable ?? []).map((u) => str.unclosable(prName(u.url), u.error)));
    }
    if (change.op === "set_ticket_feature") return str.setFeature(change.ticket, change.blockId === null ? null : (this.d.blockName(change.blockId) ?? `#${change.blockId}`));
    return str.prioritize(this.d.blockName(change.blockId) ?? `#${change.blockId}`);
  }

  // ---- 界面 ----

  /**
   * 用户在卡片上点的：apply 照做、reject 不用、undo 撤销、dismiss 收起「已替你同步」。返回做没做成。
   * 正在执行的不能点「不用」（点了也不算数：执行完了状态会和实际对不上）。确认、拒绝以后接着跟进这条要点（记、发，或者不记不发）。
   */
  async act(id: number, what: FlowAct): Promise<boolean> {
    const d = this.d;
    const a = d.repo.action(id);
    if (!a) return false;
    if (what === "dismiss") {
      const ok = d.repo.dismiss(id, d.now());
      if (ok) d.notify();
      return ok;
    }
    if (what === "reject") {
      if (this.acting.has(id)) return false;
      const ok = d.repo.transition(id, ["pending"], "rejected", { at: d.now() });
      if (ok) {
        d.notify();
        await this.follow(a.itemId);
      }
      return ok;
    }
    if (what === "retry") return this.retry(a);
    if (what === "accept") {
      // 「就这样」：剩下的 PR 不关了，算同步完了（提醒留在 error 里），接着记、发。
      if (this.acting.has(id)) return false;
      const ok = d.repo.transition(id, ["partial"], "applied", { at: d.now() });
      if (ok) {
        d.notify();
        await this.follow(a.itemId);
      }
      return ok;
    }
    const change = parseChange(a.change);
    if (!change) return false;
    if (what === "apply") {
      if (a.state !== "pending") return false;
      const ok = await this.run(id, change);
      await this.follow(a.itemId);
      return ok;
    }
    return this.undo(a, change);
  }

  private async undo(a: FlowActionRow, change: FlowChange): Promise<boolean> {
    const d = this.d;
    const undo = parseUndo(a.undo);
    if ((a.state !== "applied" && a.state !== "partial") || !undo || this.acting.has(a.id)) return false;
    // 之后又被改过了（ticket 挪走了、又打开了、feature 重新排了）：撤销会把那次改动盖掉，不撤。
    // 旧的「已同步」、要点已经不成立：先撤回还在排队的（接收者找不找得到都撤），再记 stale。
    if (!alreadyDone(change, d.world)) {
      await this.supersede(a);
      return false;
    }
    this.acting.add(a.id);
    try {
      await undoChange(undo, d.world, d.act);
      const ok = d.repo.transition(a.id, ["applied", "partial"], "undone", { at: d.now() });
      if (ok) {
        this.retract(a.itemId, this.label(change));
        await this.unremember(a.itemId);
        // 还没跟进完的（partial 时等着、或者正在写记忆）：不再记、不再发。
        this.settle(a.itemId, "dropped");
      }
      return ok;
    } catch (e) {
      d.log(`infoflow: undo action ${a.id} failed`, e);
      return false;
    } finally {
      this.acting.delete(a.id);
      d.notify();
    }
  }

  /**
   * 等你确认的（轮到你）。自动执行的（正在执行、或者中途退出等下一遍接着执行的）和正在执行的不算。
   * sweep：情况变了的顺手作废，这条要点不记不发（拼「现在」页时不写库，只跳过；后台那一遍再作废）。
   */
  proposals(sweep = true): { id: number; label: string; source: string; text: string; at: number }[] {
    const d = this.d;
    const out: { id: number; label: string; source: string; text: string; at: number }[] = [];
    for (const a of d.repo.pending()) {
      // 存了撤销用的旧状态的是你已经点了「照做」、执行到一半退出的：后台那一遍会接着执行，不再问。
      if (a.mode !== "confirm" || a.undo !== null || this.acting.has(a.id)) continue;
      const change = parseChange(a.change);
      const item = d.repo.item(a.itemId);
      if (!change || !item || !stillValid(change, d.world)) {
        if (sweep && d.repo.transition(a.id, ["pending"], "stale", { at: d.now() })) {
          this.settle(a.itemId, "dropped");
          d.notify();
        }
        continue;
      }
      // 要关的 PR 变了、又问一次的：说一句为什么又问。
      const label = a.error ? `${this.label(change)}（${a.error}）` : this.label(change);
      out.push({ id: a.id, label, source: d.nameOf(item.sessionId), text: item.text, at: a.createdAt });
    }
    return out;
  }

  /** 关了但还有没处理完的（轮到你：重试、就这样、撤销）。 */
  partials(): { id: number; label: string; source: string; leftovers: FlowLeftovers; at: number }[] {
    const d = this.d;
    return d.repo.partial().flatMap((a) => {
      const change = parseChange(a.change);
      const item = d.repo.item(a.itemId);
      const leftovers = parseLeftovers(a.leftovers);
      return change && item && leftovers ? [{ id: a.id, label: this.label(change), source: d.nameOf(item.sessionId), leftovers, at: a.decidedAt ?? a.createdAt }] : [];
    });
  }

  /** 最近自动同步了、还没收起的（「已替你同步：……（撤销）」）。 */
  synced(): { id: number; label: string; source: string; at: number }[] {
    const d = this.d;
    return d.repo.synced(d.now() - FLOW_SYNCED_NOTICE_MS).flatMap((a) => {
      const change = parseChange(a.change);
      const item = d.repo.item(a.itemId);
      return change && item ? [{ id: a.id, label: this.label(change), source: d.nameOf(item.sessionId), at: a.decidedAt ?? a.createdAt }] : [];
    });
  }

  /** 最近 24 小时问模型的次数和上限。 */
  private usage(): { used: number; cap: number } {
    const d = this.d;
    const { count } = d.repo.asksSince(d.now() - FLOW_DAY_MS);
    return { used: count, cap: d.dailyAsks?.() ?? FLOW_DAILY_ASKS };
  }

  /**
   * 到上限以后什么时候能接着问：最近 24 小时里的问的次数要掉到上限以下，得等第 used-cap+1 早的那次满 24 小时
   * （上限调低了也准：不是最早那次满 24 小时就够）。
   */
  private resumesAt(u: { used: number; cap: number }): number | null {
    const d = this.d;
    const at = d.repo.nthAskSince(d.now() - FLOW_DAY_MS, u.used - u.cap + 1);
    return at === null ? null : at + FLOW_DAY_MS;
  }

  private capped(): boolean {
    const u = this.usage();
    return u.used >= u.cap;
  }

  /** 「轮到你」的提醒：到上限了、等确认的状态变化、关了一半的、最近替你同步了的（撤销用）。 */
  notices(): NowNotice[] {
    const d = this.d;
    if (!d.enabled()) return [];
    const u = this.usage();
    const capped: NowNotice[] =
      u.used >= u.cap
        ? [{ kind: "flow_capped", used: u.used, cap: u.cap, resumesAt: this.resumesAt(u), dropped: d.repo.cappedDropped(d.now() - FLOW_DAY_MS) }]
        : [];
    return [
      ...capped,
      ...this.proposals(false).map((p): NowNotice => ({ kind: "flow_proposal", actionId: p.id, label: p.label, source: p.source, text: p.text, at: p.at })),
      ...this.partials().map((p): NowNotice => ({ kind: "flow_partial", actionId: p.id, label: p.label, source: p.source, leftovers: p.leftovers, at: p.at })),
      ...this.synced().map((s): NowNotice => ({ kind: "flow_synced", actionId: s.id, label: s.label, source: s.source, at: s.at })),
    ];
  }

  list(scope: FlowScope): FlowItemView[] {
    const d = this.d;
    const rows = d.repo.items(scope, LIST_LIMIT);
    const ids = rows.map((r) => r.id);
    const deliveries = d.repo.deliveries(ids);
    const actions = new Map(d.repo.actionsFor(ids).map((a) => [a.itemId, a]));
    return rows.map((r) => ({
      id: r.id, text: r.text, kind: r.kind, speaker: r.speaker, importance: r.importance, confidence: r.confidence,
      sourceSession: r.sessionId, source: d.nameOf(r.sessionId), turnId: r.turnId, targets: r.targets, scope: r.scope, memory: r.memory,
      deliveries: deliveries.filter((x) => x.itemId === r.id).map((x) => ({ toSession: x.toSession, to: d.nameOf(x.toSession), status: x.status, deliveredAt: iso(x.deliveredAt) })),
      action: this.actionView(actions.get(r.id) ?? null),
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  }

  private actionView(a: FlowActionRow | null): FlowActionView | null {
    const change = a ? parseChange(a.change) : null;
    if (!a || !change) return null;
    return {
      id: a.id, change, label: this.label(change), mode: a.mode, state: a.state, error: a.error, leftovers: a.state === "partial" ? parseLeftovers(a.leftovers) : null,
      undoable: (a.state === "applied" || a.state === "partial") && parseUndo(a.undo) !== null,
      decidedAt: iso(a.decidedAt),
    };
  }

  turnText(turnId: number): FlowTurnText {
    return { turnId, messages: this.d.conv.turnMessages(turnId).map((m) => ({ role: m.role, text: m.text, at: new Date(m.at).toISOString() })) };
  }
}
