import { isWorking, type ActivityEvent, type SessionActivity } from "../../shared/activity";
import type { MemorySnapshot, SessionMemory } from "../../shared/mem-usage";
import type { FeatureView, InboxItemView, MergeEvent, NowCounts, NowFeature, NowNotice, NowRow, NowTarget, NowView, RefreshStep, SessionView, TicketView, WatchedPr } from "../../shared/types";

export interface NowInput {
  tickets: TicketView[];
  features: FeatureView[];
  /** 开着的 Shipherd 总控的 head（SessionService.runningShipherd 加上终端 id）；没开为 null。 */
  shipherd: SessionView | null;
  activity: (sessionId: string) => SessionActivity | null;
  needsYouReason: (sessionId: string) => string | null;
  prs: (ticketKey: string) => WatchedPr[];
  mergeQueued: (sessionId: string) => boolean;
  /** Shipherd 正在给这个 session 换新时做到哪一步（SessionRefresher.stepOf）；不在换新为 null。 */
  refreshing: (sessionId: string) => RefreshStep | null;
  merges: MergeEvent[];
  /** 停在确认（权限、AskUserQuestion、ExitPlanMode）上时的理由文案，比如"等你确认"。 */
  approvalText: string;
  /** 全部未决的「待你决定」（BTL-190 第 2+3 点），从早到晚；sessionId 是提问的 session 现在的 head。 */
  decisions: InboxItemView[];
  /** 这个 session 最近几次工具调用（实况窗口的卡片，BTL-190 第 7 点），从早到晚。 */
  recent: (sessionId: string) => ActivityEvent[];
  /** 最近的记忆读写（实况窗口的核心卡片），从早到晚。 */
  memory: ActivityEvent[];
  /** 页面顶上的提醒（buildNotices）；buildNowView 再加上撞了限额的 session。 */
  notices: NowNotice[];
  /** 每个 head 最近一次的内存读数（WS-M A）；没有就省掉。 */
  sessionMemory?: (sessionId: string) => SessionMemory | null;
  memorySnapshot?: MemorySnapshot | null;
  /** 共享 MCP（WS-M H）开着没有。 */
  sharedMcp?: boolean;
}

/**
 * 算进「现在」页的 session：Shipherd 开的、终端开着或者休眠着（WS-M B：休眠的照样在等东西）；
 * 上次自动唤醒失败的也留着，直到用户点开或者隐藏它（等的东西不会再送进去了，要让用户看见）。
 */
const live = (s: SessionView): boolean => (s.termId !== null || !!s.hibernatedAt || !!s.wakeError) && s.origin === "shipherd";

/** 停着：没有活动记录，或者回合结束在等下一条指令。 */
const stopped = (a: SessionActivity | null): boolean => a === null || a.kind === "waiting" || a.kind === "idle";

/** 仓库目录名；Windows 路径也按反斜杠切。 */
const repoName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

interface RowBase {
  ticketKey: string | null;
  title: string | null;
  repo: string | null;
  coordinator: boolean;
  /** 实况卡片上写的地方：仓库目录名，feature 的 session 写 feature 的名字。 */
  where: string | null;
  prs: WatchedPr[];
  target: NowTarget;
}

/** 总控所管的范围：这个 ticket 或这个 feature 里别的 session 提的「待你决定」，它的 Haiku 行就不出现（多半在转述同一件事）。 */
type Scope = { ticketKey: string } | { featureId: number } | null;

function childDecision(i: NowInput, s: SessionView, scope: Scope): boolean {
  if (scope === null) return false;
  return i.decisions.some((d) => d.sessionId !== s.id && ("ticketKey" in scope ? d.ticketKey === scope.ticketKey : d.featureId === scope.featureId));
}

/**
 * 一个开着的 session 的行，「需要你」按优先级（BTL-190 第 2+3 点）：确认 → 未决的 ask_user → 真的卡住 → Haiku 的判断。
 * - 有未决 ask_user 的：needsYou 为 null，decisions 记还没答的条数（卡片由 TurnService 从 inbox 出，每条一张）；行不折起来。
 *   已经在卡片上答了、还没送进去的不算进 decisions（不再等你），但 needsYou 照样为 null、行照样不折起来。
 * - 总控所管范围里有子 session 的未决条目时，总控的 Haiku 判断不算（needsYouReason 不问）。
 * 已停的 session 不因为有 PR 开着就不算空闲（BTL-190 第 7 点）：PR 和 CI 只显示在行上。
 * needsYouReason 每行最多问一次。正在换新的不折起来，也不算需要你（回复、卡住都是 Shipherd 输入的 /handoff 带来的），只有停在确认上的照样算：
 * Shipherd 的 /handoff 也可能要用户批准权限，不显示出来换新就一直卡着。
 */
function sessionRow(i: NowInput, s: SessionView, base: RowBase, scope: Scope = null): NowRow {
  const activity = i.activity(s.id);
  const mergeQueued = i.mergeQueued(s.id);
  const refreshing = i.refreshing(s.id);
  const mine = i.decisions.filter((d) => d.sessionId === s.id);
  // 还没答的才算需要你；卡片上答好、等它停下来再送的不算，但行照样不折起来，也不再问 Haiku。
  const pending = mine.length;
  const decisions = mine.filter((d) => d.answer === null).length;
  const needsYou =
    activity?.kind === "approval" ? i.approvalText
    : refreshing !== null || pending > 0 ? null
    : activity?.stuck === true ? (activity.reason ?? "")
    : childDecision(i, s, scope) ? null
    : i.needsYouReason(s.id);
  const idle = refreshing === null && activity?.limit == null && needsYou === null && pending === 0 && !mergeQueued && stopped(activity);
  return {
    ...base, sessionId: s.id, activity, working: isWorking(activity), recent: i.recent(s.id), mergeQueued, needsYou, refreshing, decisions, idle,
    since: activity?.startedAt ?? s.lastActivityAt,
    mem: s.hibernatedAt ? null : (i.sessionMemory?.(s.id) ?? null),
    hibernated: s.termId === null && s.hibernatedAt ? (s.hibernateReason ?? "idle") : null,
    wakeError: s.termId === null && !s.hibernatedAt ? (s.wakeError ?? null) : null,
  };
}

/** 一个 ticket 的行：总控在前；开了几个仓库的 session 就标上仓库名；每个 PR 只挂在一行上。没有开着的 session 但有开着的 PR 时出一行只有 PR 的。 */
function ticketRows(i: NowInput, t: TicketView): NowRow[] {
  const sessions = t.sessions.filter(live).sort((a, b) => Number(b.coordinator) - Number(a.coordinator));
  const prs = i.prs(t.key);
  const target = (sessionId: string | null): NowTarget => ({ page: "ticket", key: t.key, sessionId });
  if (sessions.length === 0) {
    if (!prs.some((p) => p.state === "open")) return [];
    return [{
      sessionId: null, ticketKey: t.key, title: t.title, repo: null, where: null, coordinator: false, activity: null, working: false, recent: [], mergeQueued: false,
      needsYou: null, refreshing: null, decisions: 0, prs, idle: false, since: null, target: target(null),
    }];
  }
  const repoIds = new Set(sessions.filter((s) => !s.coordinator && s.repoId !== null).map((s) => s.repoId));
  const named = repoIds.size > 1;
  // PR 按仓库分给那个仓库的第一行；对不上的给第一行。
  const owner = new Map<WatchedPr, SessionView>();
  for (const p of prs) owner.set(p, sessions.find((s) => !s.coordinator && s.repoId === p.repoId) ?? sessions[0]);
  return sessions.map((s) => {
    const path = s.coordinator ? undefined : t.repos.find((r) => r.id === s.repoId)?.repoPath;
    return sessionRow(i, s, {
      ticketKey: t.key,
      title: t.title,
      repo: named && path ? repoName(path) : null,
      where: path ? repoName(path) : null,
      coordinator: s.coordinator,
      prs: prs.filter((p) => owner.get(p) === s),
      target: target(s.id),
    }, s.coordinator ? { ticketKey: t.key } : null);
  });
}

/** feature 自己的 session（总控和修复 session）：总控在前，都跳到 feature 页。 */
function featureSessionRows(i: NowInput, f: FeatureView): NowRow[] {
  const sessions = f.sessions.filter(live);
  const coordinator = (s: SessionView): boolean => s.fixesSession === null;
  return [...sessions.filter(coordinator), ...sessions.filter((s) => !coordinator(s))].map((s) =>
    sessionRow(i, s, { ticketKey: null, title: null, repo: null, where: f.name, coordinator: coordinator(s), prs: [], target: { page: "feature", id: f.id, sessionId: s.id } }, coordinator(s) ? { featureId: f.id } : null),
  );
}

/** active 只数正在干活的（思考中、跑工具、后台命令；BTL-190 第 7 点），停着等 PR、等你的不算。 */
function countRows(rows: NowRow[]): NowCounts {
  return {
    active: rows.filter((r) => r.working).length,
    // 每条未决的「待你决定」算一件。
    needsYou: rows.reduce((n, r) => n + (r.needsYou !== null ? 1 : 0) + r.decisions, 0),
    stuck: rows.filter((r) => r.activity?.stuck === true).length,
  };
}

const nowFeature = (id: number | null, name: string, rows: NowRow[]): NowFeature => ({ id, name, rows, counts: countRows(rows) });

/** 把 ticket、feature 和各自的活动、PR、合并排队拼成「现在」页：feature → 行，没有行的 feature 不出现；「无 feature」的 id 为 null、放在最后。 */
export function buildNowView(i: NowInput): NowView {
  const featureIds = new Set(i.features.map((f) => f.id));
  // feature 里的 ticket 为准；tickets 里重复出现的跳过，feature 不在输入里的归到「无 feature」。
  const seen = new Set<string>();
  const ticketsOf = new Map<number | null, TicketView[]>();
  const add = (fid: number | null, t: TicketView): void => {
    if (seen.has(t.key)) return;
    seen.add(t.key);
    (ticketsOf.get(fid) ?? ticketsOf.set(fid, []).get(fid)!).push(t);
  };
  for (const f of i.features) for (const t of f.tickets) add(f.id, t);
  for (const t of i.tickets) add(t.featureId !== null && featureIds.has(t.featureId) ? t.featureId : null, t);

  const features = [
    ...i.features.map((f) => nowFeature(f.id, f.name, [...featureSessionRows(i, f), ...(ticketsOf.get(f.id) ?? []).flatMap((t) => ticketRows(i, t))])),
    nowFeature(null, "", (ticketsOf.get(null) ?? []).flatMap((t) => ticketRows(i, t))),
  ].filter((f) => f.rows.length > 0);

  // Shipherd 总控：不属于任何 feature，单独一行。它的 Haiku 判断不因为子 session 有待决条目就不算：它被判成需要你时，送给它的报告和巡检都在等。
  const shipherd = i.shipherd && live(i.shipherd)
    ? sessionRow(i, i.shipherd, { ticketKey: null, title: null, repo: null, where: null, coordinator: true, prs: [], target: { page: "shipherd", sessionId: i.shipherd.id } })
    : null;
  const all = [...(shipherd ? [shipherd] : []), ...features.flatMap((f) => f.rows)];
  const limited: NowNotice[] = all.flatMap((r) => (r.activity?.limit ? [{ kind: "session_limited" as const, target: r.target, title: r.title, limit: r.activity.limit }] : []));
  return { notices: [...i.notices, ...limited], features, shipherd, running: all.filter((r) => r.working).length, memory: i.memory, merges: i.merges, mem: i.memorySnapshot ?? null, ...(i.sharedMcp !== undefined && { sharedMcp: i.sharedMcp }) };
}
