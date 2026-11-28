import { IPC, INVOKE_CHANNELS } from "../../shared/ipc";
import type { ActivityKind } from "../../shared/activity";
import { prUrlKey } from "../../shared/pr-url";
import type { MergeHold } from "../db/merge-gate-repo";
import type { RecordEvent } from "./events";

/** 同一个终端、同一种对话框按键 / 打断，多久之内只算一次。 */
export const KEY_DEDUPE_MS = 2000;

/** 终端那一头的 session（head）。 */
export interface MeteredSession {
  id: string;
  ticketKey: string | null;
}

/** 这个 session 刚才在等人什么（WaitTracker 开着的 human 段的来源）。 */
export type AnsweredWhat = "ask_user" | "needs_you" | "permission" | "choice";

export interface TerminalInputDeps {
  record: RecordEvent;
  now(): number;
  /** 终端 id（SHIPHERD_SESSION）→ 现在的 head；不是 Shipherd 开着的终端（外部终端、复盘分析 session）为 null。 */
  session(termId: string): MeteredSession | null;
  /** Shipherd 正在往这个终端里递东西（回答、汇报、交任务、换新）。 */
  autoInputInFlight(termId: string): boolean;
  /** 终端停在权限确认上。 */
  permissionShowing(termId: string): boolean;
  /** 这个终端的 session 此刻的活动；startedAt 不为 null 表示一个工具正在跑（AskUserQuestion 之类的停在 approval 上时就是它）。 */
  activity(termId: string): { kind: ActivityKind; startedAt: number | null } | null;
  /** 输入之前这个 session 在等人什么（等人时间段的来源）；没在等人为 null。 */
  waitingFor(termId: string): AnsweredWhat | null;
  log?: (msg: string, err?: unknown) => void;
}

/** 对话框里的"确定"类按键：回车、数字选项、y / n、Esc（取消也是回答）。 */
const ESC = "\x1b";
export const isDialogKey = (data: string): boolean => data === "\r" || data === "\n" || data === "\r\n" || data === ESC || /^[0-9yYnN]$/.test(data);
/** 在干活（和 shared/activity 的 isWorking 一样）：等批准、等回话、空闲、还没读到都不算。 */
export const busy = (k: ActivityKind | null): boolean => k !== null && k !== "approval" && k !== "waiting" && k !== "idle";
/**
 * 停在 AskUserQuestion / ExitPlanMode 上：approval 而且有工具在跑。只有 approval、没有在跑的工具的，是屏幕上的权限确认
 * （或者刚批准完、活动还没重读的那几秒），不算选择题。
 */
export const questionToolShowing = (a: { kind: ActivityKind; startedAt: number | null } | null): boolean => a?.kind === "approval" && a.startedAt !== null;

/**
 * 人往 session 终端里的输入（契约 4.7 的第一类人介入）：
 * - prompt：UserPromptSubmit 时这个终端没有 Shipherd 在递东西；
 * - dialog：停在权限确认 / AskUserQuestion / ExitPlanMode 上时按下确定类的键；
 * - interrupt：session 在干活时单独按 Esc。
 */
export class TerminalInputMeter {
  private readonly lastKey = new Map<string, number>();

  constructor(private readonly d: TerminalInputDeps) {}

  /** UserPromptSubmit：必须在 pty.markSubmitted 之前调（之后 autoInputInFlight 就清掉了）。返回记没记。不抛。 */
  promptSubmitted(termId: string): boolean {
    try {
      const s = this.d.session(termId);
      if (!s || this.d.autoInputInFlight(termId)) return false;
      const answered = this.d.waitingFor(termId);
      return this.d.record("terminal_input", {
        sessionId: s.id, ticketKey: s.ticketKey, data: { mode: "prompt", ...(answered && { answered }) },
      });
    } catch (e) {
      this.d.log?.("metrics: recording a terminal prompt failed", e);
      return false;
    }
  }

  /** pty:write 的每一块输入。每个按键都会调：先看这个键可不可能算，再查 session 和屏幕。不抛。 */
  keys(termId: string, data: string): boolean {
    if (!isDialogKey(data)) return false;
    try {
      return this.dialogKey(termId, data);
    } catch (e) {
      this.d.log?.("metrics: recording a terminal key failed", e);
      return false;
    }
  }

  private dialogKey(termId: string, data: string): boolean {
    const s = this.d.session(termId);
    if (!s || this.d.autoInputInFlight(termId)) return false;
    const permission = this.d.permissionShowing(termId);
    const activity = this.d.activity(termId);
    let mode: "dialog" | "interrupt" | null = null;
    let answered: AnsweredWhat | null = null;
    if (permission || questionToolShowing(activity)) {
      mode = "dialog";
      answered = permission ? "permission" : "choice";
    } else if (data === ESC && busy(activity?.kind ?? null)) {
      mode = "interrupt";
    }
    if (!mode) return false;
    const key = `${termId}\0${mode}`;
    const now = this.d.now();
    const last = this.lastKey.get(key);
    if (last !== undefined && now - last < KEY_DEDUPE_MS) return false;
    this.lastKey.set(key, now);
    return this.d.record("terminal_input", {
      sessionId: s.id, ticketKey: s.ticketKey, at: now, data: { mode, ...(answered && { answered }) },
    });
  }

  /** 终端关了：去重的记录不用留着。 */
  forget(termId: string): void {
    for (const k of this.lastKey.keys()) if (k.startsWith(`${termId}\0`)) this.lastKey.delete(k);
  }
}

/**
 * 这个 UserPromptSubmit 是不是这个终端自己的 claude 的：终端里 agent 用 Bash 跑的 `claude -p`（嵌套的）继承了
 * SHIPHERD_SESSION，它的输入不是人打的。hook 的 session 要和终端在同一条 head 链上。
 */
export function promptOnTerminalChain(headOf: (id: string) => string | null, hookSessionId: string, termId: string): boolean {
  const term = headOf(termId);
  return term !== null && headOf(hookSessionId) === term;
}

/**
 * 控制面板上推动工作的操作（第四类人介入：手动触发）。成功调用一次记一条 manual_trigger。
 * 每一个 invoke 通道都必须在 MANUAL_TRIGGERS、COUNTED_ELSEWHERE、NOT_TRIGGERS 三者之一里（测试检查）。
 */
export const MANUAL_TRIGGERS: ReadonlySet<string> = new Set([
  IPC.ticketsSetStatus, IPC.ticketsClose, IPC.ticketsReopen, IPC.ticketsCloseRetry, IPC.ticketsSwitchBranch, IPC.ticketsRecheckCleanup,
  IPC.sessionsOpen, IPC.sessionOpenFix, IPC.sessionsRefresh, IPC.sessionsWake, IPC.sessionsSwitchModel, IPC.sessionsCloseIdle,
  IPC.activityDismiss, IPC.ptyKill, IPC.handoffsRun, IPC.featuresSummaryRun, IPC.featuresOpenSession,
  IPC.shipherdOpenSession, IPC.jobsRunNightly, IPC.ciResend, IPC.followupsSetStatus, IPC.lessonsRun, IPC.availabilityAct,
  // 熔断停下的「继续并提高上限」（工作流 L）
  IPC.costResume,
  // 评论：「送进 session」「再回复」推动工作；改分类、忽略不算（recordInvoke 里按 op 分）。
  IPC.loopCommentsAct,
  // 栈（工作流 K）：「现在 rebase」「从备份恢复」推动工作；改层的模式（开 draft / 降级）也是。
  IPC.stacksRebase, IPC.stacksRestore, IPC.stacksLayerMode,
  // 「重新预审」「贴到 PR」（工作流 G）：用户亲手推一步。
  IPC.preReviewRun, IPC.briefPost,
  // 自动接活（工作流 N）：「现在拉一次」、手动开工、重试、允许并行、选仓库推动工作；「跳过」不算（recordInvoke 里按 op 分）。
  IPC.intakePoll, IPC.intakeAct,
  // 「谁该动」（UI 重做第 1 层）：从看板上把 CI 结论或评论送给 agent，和 ciResend 一样推动工作；被拒（ok: false）不算。
  IPC.turnSendToAgent,
  // 对话 tab（UI 重做第 5 层）：把分叉的结论、输入框里的话送进开发 session，推动工作；被挡下（ok: false）不算。
  IPC.forkSendConclusion, IPC.convSend,
  // 信箱（BTL-269）：「现在送进去」是用户亲手把卡着的消息推进去。
  IPC.messagesDeliverNow,
]);

/** 记成别的人介入的通道（不再算手动触发）：卡片上回答是 needs_you_answer。 */
export const COUNTED_ELSEWHERE: ReadonlySet<string> = new Set([IPC.inboxAnswer, IPC.inboxBehalf]);

/** 不算人介入：只读的、配置和整理（搭环境，不是推动一次工作）。 */
export const NOT_TRIGGERS: ReadonlySet<string> = new Set([
  // 只读
  IPC.ticketsList, IPC.ticketsGlance, IPC.ticketsArchived, IPC.featuresList, IPC.featuresArchived, IPC.shipherdView,
  IPC.messagesList, IPC.metricsView, IPC.sessionsUnclaimed, IPC.sessionsUnclaimedCount, IPC.usageSummary, IPC.ptySnapshot, IPC.ptySince, IPC.healthGet, IPC.dialogPickDir, IPC.diagSnapshot, IPC.diagExport,
  // 发送反馈（BTL-254）：开浏览器、存诊断，不推动工作
  IPC.feedbackOpen, IPC.feedbackDiagPreview, IPC.feedbackDiagSave,
  // 终端里点链接（BTL-257）：开浏览器，不推动工作
  IPC.linkOpen,
  IPC.mergeEvents, IPC.prWatchList, IPC.prStages, IPC.prOpen, IPC.lessonsState, IPC.lessonsRuns, IPC.lessonsPending, IPC.lessonsBatches,
  IPC.lessonsBatch, IPC.policiesGet, IPC.checksView, IPC.checksHits, IPC.configStatus, IPC.availabilityGet, IPC.routingView,
  IPC.sessionsLimits, IPC.nowView, IPC.inboxList, IPC.followupsList, IPC.handoffsList, IPC.settingsGet, IPC.settingsFeaturePolicy,
  IPC.externalAuditList, IPC.memoryView, IPC.memoryWhy, IPC.memUsageHistory, IPC.appAutostartGet, IPC.appKeepAwakeGet,
  IPC.clipboardRead, IPC.admissionState, IPC.wizardEstimate, IPC.calibrationSample, IPC.calibrationStats,
  IPC.costView, IPC.costBreakers, IPC.backgroundStatus,
  IPC.convList, IPC.convSearch,
  // 分叉讨论（UI 重做第 5 层）：只读的旁路讨论，问、重问、写进记忆都不推动开发 session；汇报分页只读。
  IPC.forkAsk, IPC.forkReaskFull, IPC.forkList, IPC.forkRemember, IPC.inboxReports,
  IPC.clipboardRead, IPC.loopPolicyGet, IPC.loopCommentsList, IPC.loopFlakyList, IPC.loopEffect,
  IPC.prAssessment, IPC.prPolicyGet, IPC.reviewEffect, IPC.reviewQueue,
  // 预审徽标和队列（BTL-271）：只读；取消、插队只是排预审的先后（和 backgroundAct 一样），不推动开发。
  IPC.preReviewStatus, IPC.preReviewQueue, IPC.preReviewQueueAct,
  IPC.baselinesView, IPC.baselinesRules, IPC.baselinesSummary, IPC.legacyView, IPC.legacyViolations, IPC.checkExportList, IPC.backtestView,
  IPC.interruptsState, IPC.profilesGet, IPC.turnBoard,
  // 关闭框打开时列出开着的 PR（BTL-270）：只读，真关的是 tickets:close
  IPC.ticketsClosePreview,
  // 切到首页时的补查：和打开页面一样不算推动工作
  IPC.turnHomeOpened,
  // 建立、整理、归档
  IPC.ticketsCreate, IPC.ticketsArchive, IPC.ticketsUpdate, IPC.ticketsUnarchive, IPC.ticketsAddRepo, IPC.ticketsUpdateRepo, IPC.ticketsRemoveRepo,
  IPC.featuresCreate, IPC.featuresRename, IPC.featuresAddRepo, IPC.featuresRemoveRepo, IPC.featuresArchive, IPC.featuresUnarchive,
  IPC.reposScan,
  IPC.sessionsClaim, IPC.sessionsDismiss, IPC.sessionsHide, IPC.sessionsUnhide, IPC.sessionsDeleteHidden, IPC.sessionsPin, IPC.sessionsDismissLimit,
  // 配置、复盘和检查的整理
  IPC.healthInstallHooks, IPC.healthUninstallHooks, IPC.lessonsAct, IPC.policiesSet, IPC.checksAct, IPC.checksDraft,
  IPC.configExport, IPC.configImportPreview, IPC.configImportRetarget, IPC.configImportApply, IPC.configBackupNow, IPC.configOpenBackups,
  IPC.routingAct, IPC.settingsSet, IPC.settingsReset, IPC.settingsDetectTrackerTools, IPC.settingsPolicyPatch,
  IPC.appAutostartSet, IPC.appKeepAwakeSet, IPC.appLanguage, IPC.clipboardWrite,
  // 规矩的初始化向导、校准和原则（工作流 D）：和 lessonsAct 一样是整理规矩、搭环境，不是推动一次工作
  IPC.wizardAct, IPC.calibrationAct, IPC.principlesRegroup,
  // 花费上限、手动停 / 恢复一种后台任务（工作流 L）
  IPC.costSet, IPC.backgroundAct,
  IPC.loopPolicySet, IPC.loopFlakyAct,
  // 预审和就绪的策略（工作流 G）；重新生成简报只是换一份给人看的摘要，不推动工作。
  IPC.prPolicySet, IPC.briefRegenerate,
  // 仓库现状和检查的整理（扫描、采用、存量扫描、导出成 lint）：搭检查，和 checksAct、reposScan 一样不算推动一次工作。
  IPC.baselinesAct, IPC.legacyAct, IPC.checkExportAct,
  // 回测、清除复查、撤销自动升降级、阈值复查（工作流 F）：整理检查
  IPC.backtestAct,
  // 打断与通知的设置（工作流 J）：权限档案、默认答案、webhook、测试通知都是搭环境
  IPC.interruptsAct, IPC.profilesScan,
  // 栈（工作流 K）：只读和策略、移出跟踪
  IPC.stacksList, IPC.stacksPolicyGet, IPC.stacksPolicyLayers, IPC.stacksPolicySet, IPC.stacksRemove,
  // 自动接活（工作流 N）：只读、策略，改分类是校准规则（记进 intake_overrides，不推动工作）
  IPC.intakeView, IPC.intakeEffect, IPC.intakePolicyGet, IPC.intakePolicySet, IPC.intakeClassify,
  // 自动化档位（BTL-247）：读档位、给 epic 选档位都是搭环境
  IPC.automationState, IPC.featuresSetAutomationLevel,
  // 更新提示（BTL-253）：查更新、跳过、关提示条、开 release 页都和工作无关
  IPC.updateState, IPC.updateCheck, IPC.updateSkip, IPC.updateDismiss, IPC.updateOpenRelease,
  // 信息流转（BTL-272）：看要点和原话只读；照做 / 撤销是把对话里已经定了的事同步进 Shipherd，不是推动一次工作
  IPC.infoflowList, IPC.infoflowTurn, IPC.infoflowAct,
]);

/** 这个通道算不算手动触发。 */
export const isManualTrigger = (channel: string): boolean => MANUAL_TRIGGERS.has(channel);

/** 第一个参数是 session（终端）id 的手动触发。 */
const SESSION_ARG: ReadonlySet<string> = new Set([IPC.sessionsRefresh, IPC.sessionsWake, IPC.sessionsSwitchModel, IPC.activityDismiss, IPC.ptyKill]);
/** 第一个参数是 ticket key 的手动触发。 */
const TICKET_ARG: ReadonlySet<string> = new Set([IPC.ticketsSetStatus, IPC.ticketsClose, IPC.ticketsReopen, IPC.ticketsCloseRetry, IPC.ticketsRecheckCleanup, IPC.handoffsRun]);

const shortString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);

/** 调用成功了、但什么都没做（唤醒没成或者在冷却、不用唤醒；换新被拒）：不算一次手动触发。 */
export function noOpResult(channel: string, result: unknown): boolean {
  if (channel === IPC.sessionsWake) return result !== "woken";
  if (channel === IPC.loopCommentsAct) return result === null || result === undefined;
  // 「现在送进去」没送进去（草稿、确认框挡着）：什么都没推动。
  if (channel === IPC.messagesDeliverNow) return !(result as { delivered?: unknown } | null)?.delivered;
  return !!result && typeof result === "object" && (result as { ok?: unknown }).ok === false;
}

/**
 * 一次成功的 invoke（register.ts 的 handle 调）：是手动触发、而且真做了事，就记一条 manual_trigger，
 * 能看出 session / ticket 的带上（归到 PR 用）。返回记了没有。
 */
export function recordInvoke(record: RecordEvent, channel: string, args: readonly unknown[], result?: unknown): boolean {
  if (!isManualTrigger(channel) || noOpResult(channel, result)) return false;
  const first = args[0];
  if (channel === IPC.loopCommentsAct) {
    const op = first && typeof first === "object" ? (first as { op?: unknown }).op : undefined;
    if (op !== "send" && op !== "reply") return false;
  }
  if (channel === IPC.intakeAct) {
    const op = first && typeof first === "object" ? (first as { op?: unknown }).op : undefined;
    if (op === "skip") return false;
  }
  const sessionId = SESSION_ARG.has(channel) ? shortString(first) : undefined;
  let ticketKey = TICKET_ARG.has(channel) ? shortString(first) : undefined;
  if (channel === IPC.sessionsOpen && first && typeof first === "object") ticketKey = shortString((first as { ticketKey?: unknown }).ticketKey);
  if (channel === IPC.intakeAct && first && typeof first === "object") ticketKey = shortString((first as { key?: unknown }).key);
  if (channel === IPC.turnSendToAgent && first && typeof first === "object") ticketKey = shortString((first as { ticketKey?: unknown }).ticketKey);
  let resumedSession: string | undefined;
  if (channel === IPC.costResume && first && typeof first === "object") {
    // 熔断的对象是 ticket（key）或 session（链的根 id）。
    const { subjectKind, subjectId } = first as { subjectKind?: unknown; subjectId?: unknown };
    if (subjectKind === "ticket") ticketKey = shortString(subjectId);
    else if (subjectKind === "session") resumedSession = shortString(subjectId);
  }
  return record("manual_trigger", { sessionId: sessionId ?? resumedSession, ticketKey, data: { channel } });
}

/** 没归类的 invoke 通道（测试用：必须为空）。 */
export const unclassifiedChannels = (): string[] =>
  INVOKE_CHANNELS.filter((c) => !MANUAL_TRIGGERS.has(c) && !COUNTED_ELSEWHERE.has(c) && !NOT_TRIGGERS.has(c));

export interface MergedPr {
  id: number;
  ticketKey: string;
  url: string;
  slug: string;
  mergedAt: number;
  /** 本地合并（git merge + push）的占位按分支和仓库对。 */
  headBranch?: string | null;
  repoPath?: string | null;
}

/** pending：这个 PR 还有没释放的占位，先不判断（下一次 rollup 再看）。 */
export type MergeKind = "agent" | "manual" | "pending";

const pathKey = (p: string): string => {
  const k = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? k.toLowerCase() : k;
};

/** 这个占位是不是这个 PR 的：PR 占位按链接；本地合并的占位按 head 分支，再对 ticket 或仓库。 */
function holdOf(pr: MergedPr, key: string, h: MergeHold): boolean {
  if (h.kind === "pr") return h.prUrl !== null && prUrlKey(h.prUrl) === key;
  if (!pr.headBranch || h.branch !== pr.headBranch) return false;
  return (h.ticketKey !== null && h.ticketKey === pr.ticketKey) || (!!pr.repoPath && pathKey(h.repoPath) === pathKey(pr.repoPath));
}

/**
 * 合并是不是 agent 做的：session 里的 `gh pr merge`、`git merge` + push 都先过合并闸，记一个占位（merge_holds）。
 * 这个 PR 有合并之前开的、以 merged 释放的占位 → agent；还有没释放的 → 先不判断；否则（没有、cancelled、expired）是人手动合的。
 */
export function mergeKind(pr: MergedPr, holds: readonly MergeHold[]): MergeKind {
  const key = prUrlKey(pr.url);
  const mine = holds.filter((h) => h.createdAt <= pr.mergedAt && holdOf(pr, key, h));
  if (mine.some((h) => h.outcome === "merged")) return "agent";
  if (mine.some((h) => h.releasedAt === null)) return "pending";
  return "manual";
}

/** 记下合并了的 PR 是谁合的（manual_merge 是人介入，agent_merge 用来核对）。每个 PR 只记一次；还没定的不记。返回新记了几条。 */
export function recordMerges(prs: readonly MergedPr[], holds: readonly MergeHold[], record: RecordEvent): number {
  let n = 0;
  for (const pr of prs) {
    const kind = mergeKind(pr, holds);
    if (kind === "pending") continue;
    const ok = record(kind === "agent" ? "agent_merge" : "manual_merge", {
      prId: pr.id, ticketKey: pr.ticketKey, repoSlug: pr.slug, at: pr.mergedAt, dedupeKey: `merge:${pr.id}`, data: { agent: kind === "agent" },
    });
    if (ok) n++;
  }
  return n;
}
