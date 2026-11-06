import type { SessionActivity } from "../../shared/activity";
import type { EpicView, FeatureView, MergeEvent, NowCounts, NowEpic, NowFeature, NowRow, NowTarget, NowView, SessionView, TicketView, WatchedPr } from "../../shared/types";

export interface NowInput {
  tickets: TicketView[];
  features: FeatureView[];
  epics: EpicView[];
  activity: (sessionId: string) => SessionActivity | null;
  needsYouReason: (sessionId: string) => string | null;
  prs: (ticketKey: string) => WatchedPr[];
  mergeQueued: (sessionId: string) => boolean;
  merges: MergeEvent[];
  /** 停在确认（权限、AskUserQuestion、ExitPlanMode）上时的理由文案，比如"等你确认"。 */
  approvalText: string;
}

/** 算进「现在」页的 session：Butler 开的、终端开着。 */
const live = (s: SessionView): boolean => s.termId !== null && s.origin === "butler";

/** 停着：没有活动记录，或者回合结束在等下一条指令。 */
const stopped = (a: SessionActivity | null): boolean => a === null || a.kind === "waiting" || a.kind === "idle";

/** PR 还在进行：开着，或者 CI 在跑。 */
const prBusy = (p: WatchedPr): boolean => p.state === "open" || p.ci === "pending";

/** 仓库目录名；Windows 路径也按反斜杠切。 */
const repoName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

interface RowBase {
  ticketKey: string | null;
  title: string | null;
  repo: string | null;
  coordinator: boolean;
  prs: WatchedPr[];
  target: NowTarget;
}

/** 一个开着的 session 的行：needsYouReason 只在确认和卡住都不是时才问（每行最多一次）。 */
function sessionRow(i: NowInput, s: SessionView, base: RowBase): NowRow {
  const activity = i.activity(s.id);
  const mergeQueued = i.mergeQueued(s.id);
  const needsYou =
    activity?.kind === "approval" ? i.approvalText : activity?.stuck === true ? (activity.reason ?? "") : i.needsYouReason(s.id);
  const idle = needsYou === null && !mergeQueued && stopped(activity) && !base.prs.some(prBusy);
  return { ...base, sessionId: s.id, activity, mergeQueued, needsYou, idle, since: activity?.startedAt ?? s.lastActivityAt };
}

/** 一个 ticket 的行：总控在前；开了几个仓库的 session 就标上仓库名；每个 PR 只挂在一行上。没有开着的 session 但有开着的 PR 时出一行只有 PR 的。 */
function ticketRows(i: NowInput, t: TicketView): NowRow[] {
  const sessions = t.sessions.filter(live).sort((a, b) => Number(b.coordinator) - Number(a.coordinator));
  const prs = i.prs(t.key);
  const target = (sessionId: string | null): NowTarget => ({ page: "ticket", key: t.key, sessionId });
  if (sessions.length === 0) {
    if (!prs.some((p) => p.state === "open")) return [];
    return [{ sessionId: null, ticketKey: t.key, title: t.title, repo: null, coordinator: false, activity: null, mergeQueued: false, needsYou: null, prs, idle: false, since: null, target: target(null) }];
  }
  const repoIds = new Set(sessions.filter((s) => !s.coordinator && s.repoId !== null).map((s) => s.repoId));
  const named = repoIds.size > 1;
  // PR 按仓库分给那个仓库的第一行；对不上的给第一行。
  const owner = new Map<WatchedPr, SessionView>();
  for (const p of prs) owner.set(p, sessions.find((s) => !s.coordinator && s.repoId === p.repoId) ?? sessions[0]);
  return sessions.map((s) => {
    const path = named && !s.coordinator ? t.repos.find((r) => r.id === s.repoId)?.repoPath : undefined;
    return sessionRow(i, s, {
      ticketKey: t.key,
      title: t.title,
      repo: path ? repoName(path) : null,
      coordinator: s.coordinator,
      prs: prs.filter((p) => owner.get(p) === s),
      target: target(s.id),
    });
  });
}

/** feature 自己的 session（总控和修复 session）：总控在前，都跳到 feature 页。 */
function featureSessionRows(i: NowInput, f: FeatureView): NowRow[] {
  const sessions = f.sessions.filter(live);
  const coordinator = (s: SessionView): boolean => s.fixesSession === null;
  return [...sessions.filter(coordinator), ...sessions.filter((s) => !coordinator(s))].map((s) =>
    sessionRow(i, s, { ticketKey: null, title: null, repo: null, coordinator: coordinator(s), prs: [], target: { page: "feature", id: f.id, sessionId: s.id } }),
  );
}

function countRows(rows: NowRow[]): NowCounts {
  return {
    active: rows.filter((r) => !r.idle).length,
    needsYou: rows.filter((r) => r.needsYou !== null).length,
    stuck: rows.filter((r) => r.activity?.stuck === true).length,
  };
}

/** 从早到晚，since 为 null 的排在最后。 */
function bySince(a: NowRow, b: NowRow): number {
  if (a.since === b.since) return 0;
  if (a.since === null) return 1;
  if (b.since === null) return -1;
  return a.since - b.since;
}

const nowFeature = (id: number | null, name: string, rows: NowRow[]): NowFeature => ({ id, name, rows, counts: countRows(rows) });

function nowEpic(id: number | null, name: string, rows: NowRow[], features: NowFeature[]): NowEpic | null {
  const kept = features.filter((f) => f.rows.length > 0);
  if (rows.length === 0 && kept.length === 0) return null;
  return { id, name, rows, features: kept, counts: countRows([...rows, ...kept.flatMap((f) => f.rows)]) };
}

/** 把 ticket、feature、epic 和各自的活动、PR、合并排队拼成「现在」页：epic → feature → 行，「无 epic」和「无 feature」的 id 为 null、放在最后。 */
export function buildNowView(i: NowInput): NowView {
  const featureIds = new Set(i.features.map((f) => f.id));
  const epicIds = new Set(i.epics.map((e) => e.id));
  // feature 里的 ticket 为准；tickets 里重复出现的跳过，feature 不在输入里的归到「无 feature」。
  const seen = new Set<string>();
  const ticketsOf = new Map<number | null, TicketView[]>();
  const add = (fid: number | null, t: TicketView): void => {
    if (seen.has(t.key)) return;
    seen.add(t.key);
    ticketsOf.set(fid, [...(ticketsOf.get(fid) ?? []), t]);
  };
  for (const f of i.features) for (const t of f.tickets) add(f.id, t);
  for (const t of i.tickets) add(t.featureId !== null && featureIds.has(t.featureId) ? t.featureId : null, t);

  const featureOf = (f: FeatureView): NowFeature =>
    nowFeature(f.id, f.name, [...featureSessionRows(i, f), ...(ticketsOf.get(f.id) ?? []).flatMap((t) => ticketRows(i, t))]);
  const epics: NowEpic[] = [];
  for (const e of i.epics) {
    const rows = e.sessions.filter(live).map((s) =>
      sessionRow(i, s, { ticketKey: null, title: null, repo: null, coordinator: true, prs: [], target: { page: "epic", id: e.id, sessionId: s.id } }),
    );
    const g = nowEpic(e.id, e.name, rows, i.features.filter((f) => f.epicId === e.id).map(featureOf));
    if (g) epics.push(g);
  }
  const loose = i.features.filter((f) => f.epicId === null || !epicIds.has(f.epicId)).map(featureOf);
  const standalone = nowFeature(null, "", (ticketsOf.get(null) ?? []).flatMap((t) => ticketRows(i, t)));
  const none = nowEpic(null, "", [], [...loose, standalone]);
  if (none) epics.push(none);

  const all = epics.flatMap((e) => [...e.rows, ...e.features.flatMap((f) => f.rows)]);
  const needsYou = all.filter((r) => r.needsYou !== null).sort(bySince);
  return { needsYou, epics, running: all.filter((r) => r.sessionId !== null).length, merges: i.merges };
}
