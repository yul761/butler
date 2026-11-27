// 总控 progress_overview 的聚合（设计文档 2026-11-17 ws-b 第 4 节）：纯函数，输入是已经读好的数据。
// 每个 PR 轮到谁取自 turn 模型（TurnService.prTurns），和首页、feature/ticket 页同一套算法。
import {
  PROGRESS_BUCKETS, titlePrefix, type ProgressBucket, type ProgressFeature, type ProgressFilter, type ProgressPr, type ProgressPrGroup,
  type ProgressStackNode, type ProgressStackRepo, type ProgressStuck, type ProgressTicket, type ProgressView,
} from "../../shared/progress";
import { prChangesRequested, type Turn } from "../../shared/turn";
import { awaitsDecision, effectiveStatus, type Ticket, type WatchedPr } from "../../shared/types";

/** 一个 feature 最新的汇总（featureRowsAll 加上 ws-b 的新鲜度）。 */
export interface ProgressSummary {
  summary: string | null;
  at: number | null;
  prStatusAt: number | null;
  stale: boolean;
}

export interface ProgressInput {
  now: number;
  /** 未归档的 ticket。 */
  tickets: Ticket[];
  /** 未归档的 feature。 */
  features: { id: number; name: string }[];
  /** Shipherd 在盯的 PR（PrWatcher.statusOf），分支行（prId null）会被跳过。 */
  prs: WatchedPr[];
  summary: (featureId: number) => ProgressSummary | null;
  /** 开工过：有过 session，或者 PR 进度里记过第一个 commit。 */
  started: (ticketKey: string) => boolean;
  /** 这个 PR 轮到谁（TurnService.prTurns）；关了的、看板上没有的为 null。 */
  turnOf: (url: string, ticketKey: string) => Turn | null;
}

/** 汇总的第一句：截到第一个句末标点（英文句号要跟空白或结尾），最多这么多字。 */
export const SUMMARY_LINE_MAX = 140;

export function firstSentence(text: string | null): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const m = /[。！？]|[.!?](?=\s|$)/.exec(t);
  const cut = m ? t.slice(0, m.index + 1) : t;
  return cut.length > SUMMARY_LINE_MAX ? `${cut.slice(0, SUMMARY_LINE_MAX - 1)}…` : cut;
}

/** 仓库目录名（两种分隔符都切）。 */
const repoName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** slug 从 PR url 里取（github.com/o/r/pull/1 → o/r）；拿不到为 null。 */
const slugOfUrl = (url: string): string | null => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? null;

function toProgressPr(p: WatchedPr, turnOf: (url: string, ticketKey: string) => Turn | null): ProgressPr | null {
  if (p.prId === null || p.number === null || p.url === null || p.state === null) return null;
  const d = p.detail;
  const slug = d?.slug ?? slugOfUrl(p.url);
  return {
    state: p.state, isDraft: d?.isDraft ?? false, ci: p.ci, review: p.review, author: d?.author ?? null, reviewers: d?.reviewers ?? [],
    reviewRequests: d?.reviewRequests ?? [], mergeable: d?.mergeable ?? null, mergeState: d?.mergeState ?? null,
    ticketKey: p.ticketKey, prId: p.prId, repo: p.repoPath !== null ? repoName(p.repoPath) : (slug ?? "?"), slug, number: p.number, url: p.url,
    title: d?.title ?? null, headBranch: p.branch || null, baseBranch: d?.baseBranch ?? null, labels: d?.labels ?? [],
    turn: turnOf(p.url, p.ticketKey), checkedAt: p.checkedAt, statusChangedAt: d?.statusChangedAt ?? null, readError: p.readError,
  };
}

/** 让 ticket 落进"阻塞"的 PR 情况：CI 挂了、有人要求修改、有冲突。draft 也一样看（turn 对 draft 只报 draft，不报冲突和要求修改，所以这里不看 turn）。 */
const blocking = (p: ProgressPr): boolean => p.ci === "failing" || prChangesRequested(p) || p.mergeable === "conflicting" || p.mergeState === "dirty";

/** 汇总条的格子：按顺序判断（定义见设计文档第 4 节）。prs 是这个 ticket 读到过的 PR。 */
export function bucketOf(t: Pick<Ticket, "status" | "statusManual">, prs: ProgressPr[], started: boolean): ProgressBucket {
  const status = effectiveStatus(t);
  if (status === "closed") return "closed";
  const open = prs.filter((p) => p.state === "open");
  if (status === "done" || status === "merged_pending_followup" || (open.length === 0 && prs.some((p) => p.state === "merged"))) return "merged";
  // needs_decision（PR 都关了没合，BTL-270）也要你动手，放进阻塞这一格；又有开着的 PR 时按 PR 算，和 Now 页一致（awaitsDecision）。
  if (status === "blocked" || awaitsDecision(status, open.length) || open.some(blocking)) return "blocked";
  if (open.some((p) => !p.isDraft)) return "in_review";
  if (open.length > 0 || started) return "in_progress";
  return "not_started";
}

const emptyCounts = (): Record<ProgressBucket, number> => Object.fromEntries(PROGRESS_BUCKETS.map((b) => [b, 0])) as Record<ProgressBucket, number>;

/** 开着的在前，然后按状态变化从新到旧。 */
const byOpenThenRecent = (a: ProgressPr, b: ProgressPr): number =>
  Number(b.state === "open") - Number(a.state === "open") || (b.statusChangedAt ?? b.checkedAt) - (a.statusChangedAt ?? a.checkedAt) || a.number - b.number;

/** 分组：key 按字母，null（没有 label / 前缀）放最后。 */
function groupBy(prs: ProgressPr[], keys: (p: ProgressPr) => (string | null)[]): ProgressPrGroup[] {
  const map = new Map<string | null, ProgressPr[]>();
  for (const p of prs) {
    for (const k of keys(p)) {
      const list = map.get(k) ?? [];
      list.push(p);
      map.set(k, list);
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([key, list]) => ({ key, prs: list.sort(byOpenThenRecent) }));
}

/** 叠放树：同一个仓库里，base 分支是另一个开着的 PR 的 head 分支，就挂在它下面。 */
export function buildStacks(prs: ProgressPr[]): ProgressStackRepo[] {
  const bySlug = new Map<string, ProgressPr[]>();
  for (const p of prs) {
    if (p.state !== "open") continue;
    const k = p.slug ?? p.repo;
    bySlug.set(k, [...(bySlug.get(k) ?? []), p]);
  }
  const out: ProgressStackRepo[] = [];
  for (const [, list] of [...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => a.number - b.number);
    const byHead = new Map<string, ProgressPr>();
    for (const p of list) if (p.headBranch && !byHead.has(p.headBranch)) byHead.set(p.headBranch, p);
    const parentOf = (p: ProgressPr): ProgressPr | null => {
      const parent = p.baseBranch ? byHead.get(p.baseBranch) : undefined;
      return parent && parent !== p ? parent : null;
    };
    // 根：没有父 PR 的；成环的（A 的 base 是 B 的 head、B 的 base 是 A 的 head）挑号最小的当根。
    const children = new Map<ProgressPr, ProgressPr[]>();
    for (const p of list) {
      const parent = parentOf(p);
      if (parent) children.set(parent, [...(children.get(parent) ?? []), p]);
    }
    const placed = new Set<ProgressPr>();
    const node = (p: ProgressPr): ProgressStackNode => {
      placed.add(p);
      return { pr: p, children: (children.get(p) ?? []).filter((c) => !placed.has(c)).map(node) };
    };
    const roots: ProgressStackNode[] = list.filter((p) => parentOf(p) === null).map(node);
    for (const p of list) if (!placed.has(p)) roots.push(node(p));
    out.push({
      repo: list[0].repo,
      stacks: roots.filter((n) => n.children.length > 0),
      single: roots.filter((n) => n.children.length === 0).map((n) => n.pr),
    });
  }
  return out;
}

/** progress_overview 的全部数据。filter 里给了 feature 就只看这个 feature；没给看全部（含不属于 feature 的 ticket）。 */
export function buildProgress(input: ProgressInput, filter: ProgressFilter = {}): ProgressView {
  const featureId = filter.featureId ?? null;
  const featureById = new Map(input.features.map((f) => [f.id, f]));
  const inScope = (fid: number | null): boolean => featureId === null || fid === featureId;
  const tickets = input.tickets.filter((t) => inScope(t.featureId));
  const keys = new Set(tickets.map((t) => t.key));
  const watched = input.prs.filter((p) => keys.has(p.ticketKey) && p.prId !== null);
  // 从没读成功过的行（checkedAt 0）只是链接时的说法（handoff 里的 URL 可能是编的），不当 PR 算。
  // 放弃读了的也不算：它的"开着"不再当真（和 PR 监视里一样不再挡 ticket），只在新鲜度里算读取失败。
  const givenUp = watched.filter((p) => p.checkedAt > 0 && p.gaveUp === true).length;
  const read = watched.filter((p) => p.checkedAt > 0 && p.gaveUp !== true).map((p) => toProgressPr(p, input.turnOf)).filter((p): p is ProgressPr => p !== null);
  const prsOf = new Map<string, ProgressPr[]>();
  for (const p of read) prsOf.set(p.ticketKey, [...(prsOf.get(p.ticketKey) ?? []), p]);
  // 同一个 PR 链接在两个 ticket 上：表、树里只出现一次（先出现的那个 ticket）。
  const seen = new Set<string>();
  const unique = read.filter((p) => !seen.has(p.url) && !!seen.add(p.url));

  const counts = { ...emptyCounts(), total: 0 };
  const ticketRows = new Map<string, ProgressTicket>();
  for (const t of tickets) {
    const prs = prsOf.get(t.key) ?? [];
    const bucket = bucketOf(t, prs, input.started(t.key));
    counts[bucket] += 1;
    counts.total += 1;
    ticketRows.set(t.key, { key: t.key, title: t.title, featureId: t.featureId, bucket, prs: prs.length, openPrs: prs.filter((p) => p.state === "open").length });
  }

  const ticketByKey = new Map(tickets.map((t) => [t.key, t]));
  const stuck: ProgressStuck[] = [];
  for (const p of unique) {
    if (p.state !== "open" || p.turn === null) continue;
    const t = ticketByKey.get(p.ticketKey);
    stuck.push({ ticketKey: p.ticketKey, ticketTitle: t?.title ?? null, featureId: t?.featureId ?? null, pr: p, turn: p.turn, since: p.statusChangedAt });
  }
  for (const t of tickets) {
    const status = effectiveStatus(t);
    const source = status === "blocked" ? "ticket_blocked" : status === "needs_decision" ? "ticket_needs_decision" : null;
    if (source === null || (ticketRows.get(t.key)?.openPrs ?? 0) > 0) continue;
    const turn: Turn = { owner: "you", kind: "stuck", source, detail: null, sessionId: null };
    stuck.push({ ticketKey: t.key, ticketTitle: t.title, featureId: t.featureId, pr: null, turn, since: null });
  }
  // 卡得最久的在最上面；不知道从什么时候起的放最后。
  stuck.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.ticketKey.localeCompare(b.ticketKey));

  // PR 表不列关掉没合的（放弃了的 PR 不是进度）。
  const table = unique.filter((p) => p.state !== "closed");
  const groups = {
    byLabel: groupBy(table, (p) => (p.labels.length > 0 ? [...new Set(p.labels)] : [null])),
    byPrefix: groupBy(table, (p) => [titlePrefix(p.title)]),
  };

  const featureGroups: ProgressFeature[] = [];
  const summaryTimes: number[] = [];
  const groupOf = (fid: number | null): ProgressFeature => {
    const f = fid === null ? undefined : featureById.get(fid);
    const s = fid === null ? null : input.summary(fid);
    if (s?.at != null) summaryTimes.push(s.at);
    const list = [...ticketRows.values()].filter((r) => r.featureId === fid);
    const c = emptyCounts();
    for (const r of list) c[r.bucket] += 1;
    return {
      id: fid, name: f?.name ?? null, line: firstSentence(s?.summary ?? null), summaryAt: s?.at ?? null,
      prStatusAt: s?.prStatusAt ?? null, stale: s?.stale ?? false, counts: c, tickets: list,
    };
  };
  for (const f of input.features) if (inScope(f.id)) featureGroups.push(groupOf(f.id));
  if (featureId === null && tickets.some((t) => t.featureId === null || !featureById.has(t.featureId))) {
    const g = groupOf(null);
    // 属于已归档 feature 的 ticket（ticket 本身没归档）也放进"不属于 feature"这一组。
    g.tickets = [...ticketRows.values()].filter((r) => r.featureId === null || !featureById.has(r.featureId));
    g.counts = emptyCounts();
    for (const r of g.tickets) g.counts[r.bucket] += 1;
    featureGroups.push(g);
  }

  const checked = read.map((p) => p.checkedAt);
  return {
    filter: { featureId },
    features: input.features.map((f) => ({ id: f.id, name: f.name })),
    counts, stuck, stacks: buildStacks(unique), groups, featureGroups,
    freshness: {
      generatedAt: input.now,
      prsCheckedOldest: checked.length > 0 ? Math.min(...checked) : null,
      prsCheckedNewest: checked.length > 0 ? Math.max(...checked) : null,
      readErrors: read.filter((p) => p.readError).length + givenUp,
      unread: watched.filter((p) => p.checkedAt === 0).length,
      summaryOldest: summaryTimes.length > 0 ? Math.min(...summaryTimes) : null,
    },
  };
}

/** 总控看的进度里换成 ISO 字符串的时间字段。 */
const TIME_KEYS = new Set(["at", "since", "checkedAt", "statusChangedAt", "summaryAt", "prStatusAt", "generatedAt", "prsCheckedOldest", "prsCheckedNewest", "summaryOldest"]);

/** PR 在总控结果里的引用："owner/仓库#号"（两个仓库同名时也分得开）；不知道 slug 用仓库目录名。 */
const prRef = (p: ProgressPr): string => `${p.slug ?? p.repo}#${p.number}`;

/**
 * progress_overview 的结果：同一份 ProgressView，但时间写成 ISO 字符串，featureId 旁边带上名字，
 * 每个 PR 的完整字段只在 prs 里出现一次，stuck、叠放树、分组里用"仓库#号"引用（省得同一个 PR 重复好几遍）。
 */
export function progressOverview(v: ProgressView): object {
  const featureName = new Map(v.features.map((f) => [f.id, f.name]));
  const prs = new Map<string, ProgressPr>();
  const ref = (p: ProgressPr): string => {
    prs.set(p.url, p);
    return prRef(p);
  };
  const tree = (n: ProgressStackNode): object => ({ pr: ref(n.pr), ...(n.children.length > 0 && { children: n.children.map(tree) }) });
  const shaped = {
    filter: v.filter, counts: v.counts,
    stuck: v.stuck.map((s) => ({ ...s, pr: s.pr ? ref(s.pr) : null })),
    stacks: v.stacks.map((r) => ({ repo: r.repo, stacks: r.stacks.map(tree), single: r.single.map(ref) })),
    groups: { byLabel: v.groups.byLabel.map((g) => ({ key: g.key, prs: g.prs.map(ref) })), byPrefix: v.groups.byPrefix.map((g) => ({ key: g.key, prs: g.prs.map(ref) })) },
    features: v.featureGroups,
    freshness: v.freshness,
  };
  const out = { ...shaped, prs: [...prs.values()].map((p) => {
    const rest: Partial<ProgressPr> = { ...p };
    delete rest.prId;
    return rest;
  }) };
  const walk = (x: unknown, key: string | null): unknown => {
    if (Array.isArray(x)) return x.map((y) => walk(y, null));
    if (x !== null && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) {
        o[k] = walk(val, k);
        if (k === "featureId" && typeof val === "number") o.feature = featureName.get(val) ?? null;
      }
      return o;
    }
    if (key !== null && TIME_KEYS.has(key) && typeof x === "number") return x > 0 ? new Date(x).toISOString() : null;
    return x;
  };
  return walk(out, null) as object;
}
