import { prUrlKey } from "../../shared/pr-url";
import { withTransaction, type Db } from "../db/database";
import type { MergeGateRepo } from "../db/merge-gate-repo";
import type { DailyRow, GroupKind, MetricEvent, MetricsRepo } from "../db/metrics-repo";
import { registryModelFor } from "../routing/spend";
import { USAGE_WEIGHTS } from "../usage/usage-summary";
import type { RegistryModel } from "../../shared/model-routing";
import { INTERVENTION_KINDS, type RecordEvent } from "./events";
import { readFacts, type Facts, type PrFact, type SessionFact, type UsageFact } from "./facts";
import { recordMerges } from "./interventions";

/** 重算窗口：最近这么多天。 */
export const ROLLUP_DAYS = 400;
const DAY_MS = 24 * 60 * 60_000;
export const UNRATED = "unrated";

/** 这个时刻所在那天的本地零点。 */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地日期 YYYY-MM-DD（「效果」页按用户所在时区的天看）。 */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 一行用量的加权 token（和用量页同一套权重）。 */
export const weightedOf = (u: UsageFact): number =>
  u.input * USAGE_WEIGHTS.input + u.cacheWrite5m * USAGE_WEIGHTS.cacheWrite5m + u.cacheWrite1h * USAGE_WEIGHTS.cacheWrite1h +
  u.cacheRead * USAGE_WEIGHTS.cacheRead + u.output * USAGE_WEIGHTS.output;

/** 一行用量的美元：有 CLI 给的 cost_usd 用它；没有就按注册表价格估；都没有算 partial。 */
export function usdOf(u: UsageFact, registry: readonly RegistryModel[]): { usd: number; partial: boolean } {
  if (u.costUsd !== null) return { usd: u.costUsd, partial: false };
  const m = registryModelFor(registry, u.model);
  if (!m || m.priceIn === null || m.priceOut === null) return { usd: 0, partial: true };
  const inTokens = u.input + USAGE_WEIGHTS.cacheWrite5m * u.cacheWrite5m + USAGE_WEIGHTS.cacheWrite1h * u.cacheWrite1h + USAGE_WEIGHTS.cacheRead * u.cacheRead;
  return { usd: (inTokens * m.priceIn + u.output * m.priceOut) / 1e6, partial: false };
}

/** 这个 PR 是不是 Shipherd 做的（设计第 6 节）。 */
export function isShipherdMade(pr: PrFact, f: Pick<Facts, "owners" | "holds" | "sessions">): boolean {
  return shipherdMadeOf(f)(pr);
}

/** 先把 owners、占位、session 按 PR 能对上的键建好索引，再逐个 PR 判断（每小时整窗重算，PR 和 session 都可能上千）。 */
export function shipherdMadeOf(f: Pick<Facts, "owners" | "holds" | "sessions">): (pr: PrFact) => boolean {
  const byId = new Map(f.sessions.map((s) => [s.id, s]));
  const shipherd = (id: string | null) => (id ? byId.get(id)?.shipherd === true : false);
  const k = (...parts: (string | number | null)[]) => parts.join("\u0000");
  const owned = new Set(f.owners.filter((o) => shipherd(o.sessionId)).map((o) => k(o.ticketKey, o.repoId, o.branch)));
  const held = new Set(f.holds.filter((h) => h.kind === "pr" && h.prUrl !== null && shipherd(h.sessionId)).map((h) => prUrlKey(h.prUrl as string)));
  const worked = new Set(f.sessions.filter((s) => s.shipherd && s.ticketKey && s.gitBranch).map((s) => k(s.ticketKey, s.gitBranch)));
  return (pr) =>
    (pr.headBranch !== null && owned.has(k(pr.ticketKey, pr.repoId, pr.headBranch))) ||
    held.has(prUrlKey(pr.url)) ||
    (pr.headBranch !== null && worked.has(k(pr.ticketKey, pr.headBranch)));
}

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** 一个 PR 身上的数。 */
export interface PrMetrics {
  pr: PrFact;
  shipherd: boolean;
  cycleOpenMs: number | null;
  cycleTicketMs: number | null;
  commentsHuman: number;
  commentsCopilot: number;
  commentsAvoidable: number;
  commentsAutoHandled: number;
  interventions: number;
  waitHumanMs: number;
  costWeighted: number;
  costUsd: number;
  costUsdPartial: boolean;
  costByModel: Map<string, number>;
  costByTask: Map<string, number>;
  ciFailures: number;
  reopens: number;
  reverts: number;
}

/**
 * 把 session 的东西分给 PR：git_branch 是哪个 PR 的 head 分支就归哪个（几个就平分）；对不上的平分给这个 ticket 的所有 PR。
 * 只算 PR 合并之前的。
 */
class Attribution {
  private readonly prsByTicket = new Map<string, PrFact[]>();
  private readonly sessions: Map<string, SessionFact>;

  constructor(f: Facts) {
    for (const p of f.prs) pushTo(this.prsByTicket, p.ticketKey, p);
    this.sessions = new Map(f.sessions.map((s) => [s.id, s]));
  }

  /** 这个东西（session / ticket / PR）归哪些 PR，各占多少。 */
  targets(o: { sessionId: string | null; ticketKey: string | null; prId?: number | null; at: number }): { pr: PrFact; weight: number }[] {
    const s = o.sessionId ? this.sessions.get(o.sessionId) : undefined;
    const ticket = s?.ticketKey ?? o.ticketKey;
    const all = ticket ? (this.prsByTicket.get(ticket) ?? []) : [];
    let cands: PrFact[];
    if (o.prId !== null && o.prId !== undefined) cands = all.filter((p) => p.id === o.prId);
    else {
      const onBranch = s?.gitBranch ? all.filter((p) => p.headBranch === s.gitBranch) : [];
      cands = onBranch.length > 0 ? onBranch : all;
    }
    // 合并之后发生的不算这个 PR 的。
    cands = cands.filter((p) => p.mergedAt === null || o.at <= p.mergedAt);
    return cands.map((pr) => ({ pr, weight: 1 / cands.length }));
  }

  session(id: string | null): SessionFact | undefined {
    return id ? this.sessions.get(id) : undefined;
  }

  ticketPrs(key: string): PrFact[] {
    return this.prsByTicket.get(key) ?? [];
  }
}

const blank = (pr: PrFact, shipherd: boolean): PrMetrics => ({
  pr, shipherd, cycleOpenMs: null, cycleTicketMs: null, commentsHuman: 0, commentsCopilot: 0, commentsAvoidable: 0, commentsAutoHandled: 0,
  interventions: 0, waitHumanMs: 0, costWeighted: 0, costUsd: 0, costUsdPartial: false, costByModel: new Map(), costByTask: new Map(),
  ciFailures: 0, reopens: 0, reverts: 0,
});

const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/** 每个 PR 的数（所有 PR，不只是合并了的）。shipherdMade：PR id → 是不是 Shipherd 做的。 */
export function prMetrics(f: Facts, shipherdMade: Map<number, boolean>, now: number): Map<number, PrMetrics> {
  const out = new Map<number, PrMetrics>();
  for (const p of f.prs) out.set(p.id, blank(p, shipherdMade.get(p.id) ?? false));
  const at = new Attribution(f);

  const firstSession = new Map<string, number>();
  for (const s of f.sessions) if (s.ticketKey) firstSession.set(s.ticketKey, Math.min(firstSession.get(s.ticketKey) ?? Infinity, s.createdAt));
  for (const m of out.values()) {
    const { pr } = m;
    if (pr.mergedAt === null) continue;
    if (pr.openedAt !== null && pr.openedAt <= pr.mergedAt) m.cycleOpenMs = pr.mergedAt - pr.openedAt;
    const first = firstSession.get(pr.ticketKey);
    if (first !== undefined && first <= pr.mergedAt) m.cycleTicketMs = pr.mergedAt - first;
    m.commentsAvoidable = f.avoidable.get(`${pr.slug}#${pr.number}`) ?? 0;
  }

  // 同一个 review 换了状态（比如后来被 DISMISSED）会再记一条 stage：按 review id 只算一次。
  const reviews = new Set<string>();
  for (const s of f.stages) {
    const m = out.get(s.prId);
    if (!m) continue;
    if (s.kind === "ci") {
      if (s.result === "failing") m.ciFailures += 1;
      continue;
    }
    // 只有状态、没有正文的 review（比如一个 approve）不算评论。
    if (s.kind === "review" && !s.hasBody) continue;
    if (s.kind === "review" && s.reviewId !== null) {
      const key = `${s.prId}\u0000${s.reviewId}`;
      if (reviews.has(key)) continue;
      reviews.add(key);
    }
    if (s.who === "human") m.commentsHuman += 1;
    else if (s.who === "copilot") m.commentsCopilot += 1;
  }

  for (const e of f.events) {
    if (e.prId !== null) {
      const m = out.get(e.prId);
      if (m && e.kind === "pr_reopened") m.reopens += 1;
      if (m && e.kind === "pr_reverted") m.reverts += 1;
      if (m && e.kind === "comment_auto_handled") m.commentsAutoHandled += 1;
    }
    if (!INTERVENTION_KINDS.includes(e.kind)) continue;
    for (const t of at.targets({ sessionId: e.sessionId, ticketKey: e.ticketKey, prId: e.prId, at: e.at })) {
      const m = out.get(t.pr.id);
      if (m) m.interventions += t.weight;
    }
  }

  for (const sp of f.spans) {
    if (sp.kind !== "human") continue;
    const end = sp.endedAt ?? now;
    for (const t of at.targets({ sessionId: sp.sessionId, ticketKey: sp.ticketKey, at: sp.startedAt })) {
      const m = out.get(t.pr.id);
      if (!m) continue;
      const stop = t.pr.mergedAt === null ? end : Math.min(end, t.pr.mergedAt);
      m.waitHumanMs += Math.max(0, stop - sp.startedAt) * t.weight;
    }
  }

  for (const u of f.usage) {
    if (!u.sessionId) continue;
    const w = weightedOf(u);
    const { usd, partial } = usdOf(u, f.registry);
    for (const t of at.targets({ sessionId: u.sessionId, ticketKey: null, at: u.at })) {
      const m = out.get(t.pr.id);
      if (!m) continue;
      m.costWeighted += w * t.weight;
      m.costUsd += usd * t.weight;
      m.costUsdPartial ||= partial;
      addTo(m.costByModel, u.model ?? "(default)", w * t.weight);
      addTo(m.costByTask, u.task ?? "(interactive)", w * t.weight);
    }
  }
  return out;
}

/** 一个 ticket 的花费：它所有 session 的用量（最后一个 PR 合并之前）。 */
export interface TicketMetrics {
  ticketKey: string;
  doneAt: number;
  shipherd: boolean;
  costWeighted: number;
  costUsd: number;
  groups: Group[];
}

type Group = { kind: GroupKind; key: string };

function groupsOf(pr: PrFact, f: Pick<Facts, "products" | "risk">): Group[] {
  return [
    { kind: "all", key: "" },
    { kind: "repo", key: pr.slug },
    ...(f.products.get(pr.slug) ?? []).map((name): Group => ({ kind: "product", key: name })),
    { kind: "risk", key: f.risk.get(pr.id) ?? UNRATED },
  ];
}

/** 所有 PR 都合并或关闭、至少合并了一个的 ticket 算做完。 */
export function ticketMetrics(f: Facts, prs: Map<number, PrMetrics>): TicketMetrics[] {
  const byTicket = new Map<string, PrMetrics[]>();
  for (const m of prs.values()) pushTo(byTicket, m.pr.ticketKey, m);
  const sessionsOf = new Map<string, string[]>();
  for (const s of f.sessions) if (s.ticketKey) pushTo(sessionsOf, s.ticketKey, s.id);
  // 用量按 session 分好一次：不然每个 ticket 都要扫一遍全部用量（ticket 数 × 用量行数）。
  const usageOf = new Map<string, UsageFact[]>();
  for (const u of f.usage) if (u.sessionId) pushTo(usageOf, u.sessionId, u);
  const out: TicketMetrics[] = [];
  for (const [key, list] of byTicket) {
    if (list.some((m) => m.pr.state === "open")) continue;
    const merged = list.filter((m) => m.pr.mergedAt !== null);
    if (merged.length === 0) continue;
    const doneAt = Math.max(...merged.map((m) => m.pr.mergedAt as number));
    let costWeighted = 0;
    let costUsd = 0;
    for (const id of sessionsOf.get(key) ?? []) {
      for (const u of usageOf.get(id) ?? []) {
        if (u.at > doneAt) continue;
        costWeighted += weightedOf(u);
        costUsd += usdOf(u, f.registry).usd;
      }
    }
    // 分组按最后合并的那个 PR。
    const last = merged.reduce((a, b) => ((b.pr.mergedAt as number) > (a.pr.mergedAt as number) ? b : a));
    out.push({ ticketKey: key, doneAt, shipherd: list.some((m) => m.shipherd), costWeighted, costUsd, groups: groupsOf(last.pr, f) });
  }
  return out;
}

/** 累加 metrics_daily 的行。 */
class DailyBuilder {
  private readonly rows = new Map<string, DailyRow>();

  constructor(private readonly fromDay: string) {}

  add(day: string, groups: readonly Group[], shipherd: boolean, metric: string, n: number, total: number): void {
    if (day < this.fromDay) return;
    for (const g of groups) {
      const k = [day, g.kind, g.key, shipherd ? 1 : 0, metric].join("\u0000");
      const cur = this.rows.get(k);
      if (cur) {
        cur.n += n;
        cur.total += total;
      } else this.rows.set(k, { day, groupKind: g.kind, groupKey: g.key, shipherd, metric, n, total });
    }
  }

  list(): DailyRow[] {
    return [...this.rows.values()];
  }
}

const ALL: Group[] = [{ kind: "all", key: "" }];

/** 事件的子类型（mode / via / channel 里第一个是字符串的），没有为 null。 */
export function subtypeOf(e: Pick<MetricEvent, "data">): string | null {
  for (const k of ["mode", "via", "channel"]) {
    const v = e.data[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

/** 从事实算出 fromDay 之后的全部 metrics_daily 行（纯函数）。 */
export function computeDaily(f: Facts, shipherdMade: Map<number, boolean>, now: number, fromDay: string): DailyRow[] {
  const b = new DailyBuilder(fromDay);
  const prs = prMetrics(f, shipherdMade, now);
  for (const m of prs.values()) {
    if (m.pr.mergedAt === null) continue;
    const day = dayOf(m.pr.mergedAt);
    const g = groupsOf(m.pr, f);
    const add = (metric: string, total: number) => b.add(day, g, m.shipherd, metric, 1, total);
    add("pr_merged", 1);
    if (m.cycleOpenMs !== null) add("cycle_open_ms", m.cycleOpenMs);
    if (m.cycleTicketMs !== null) add("cycle_ticket_ms", m.cycleTicketMs);
    add("comments_human", m.commentsHuman);
    add("comments_copilot", m.commentsCopilot);
    add("comments_avoidable", m.commentsAvoidable);
    add("comments_auto_handled", m.commentsAutoHandled);
    add("interventions", m.interventions);
    add("wait_human_ms", m.waitHumanMs);
    add("cost_weighted", m.costWeighted);
    add("cost_usd", m.costUsd);
    if (m.costUsdPartial) add("cost_usd_partial", 1);
    add("ci_failures", m.ciFailures);
    add("reopens", m.reopens);
    add("reverts", m.reverts);
    for (const [model, v] of m.costByModel) b.add(day, ALL, m.shipherd, `cost_model:${model}`, 1, v);
    for (const [task, v] of m.costByTask) b.add(day, ALL, m.shipherd, `cost_task:${task}`, 1, v);
  }
  for (const t of ticketMetrics(f, prs)) {
    const day = dayOf(t.doneAt);
    b.add(day, t.groups, t.shipherd, "ticket_done", 1, 1);
    b.add(day, t.groups, t.shipherd, "ticket_cost_weighted", 1, t.costWeighted);
    b.add(day, t.groups, t.shipherd, "ticket_cost_usd", 1, t.costUsd);
  }

  const sessions = new Map(f.sessions.map((s) => [s.id, s]));
  const shipherdSession = (id: string | null) => (id ? sessions.get(id)?.shipherd === true : false);
  const shipherdTickets = new Set(f.sessions.filter((s) => s.shipherd && s.ticketKey).map((s) => s.ticketKey as string));
  // 没有 session 的事件（manual_merge、按 ticket 的手动触发）：看 PR 是不是 Shipherd 做的，再看 ticket 有没有 Shipherd 的 session。
  const shipherdEvent = (e: MetricEvent): boolean => {
    if (e.sessionId) return shipherdSession(e.sessionId);
    if (e.prId !== null) return shipherdMade.get(e.prId) ?? false;
    return e.ticketKey !== null && shipherdTickets.has(e.ticketKey);
  };
  const eventGroups = (e: MetricEvent): Group[] => (e.repoSlug ? [...ALL, { kind: "repo", key: e.repoSlug }] : ALL);
  for (const e of f.events) {
    const day = dayOf(e.at);
    const g = eventGroups(e);
    const shipherd = shipherdEvent(e);
    b.add(day, g, shipherd, `event:${e.kind}`, 1, 1);
    if (e.kind === "interrupt" && typeof e.data.category === "string") b.add(day, g, shipherd, `interrupt:${e.data.category}`, 1, 1);
    // 人介入构成按子类型：终端输入的 mode、卡片的 via、手动触发的 IPC 通道。
    const sub = subtypeOf(e);
    if (sub !== null) b.add(day, ALL, shipherd, `event_sub:${e.kind}:${sub}`, 1, 1);
  }
  for (const sp of f.spans) {
    const ms = Math.max(0, (sp.endedAt ?? now) - sp.startedAt);
    const metric = sp.kind === "human" ? `wait_human:${sp.category ?? "question"}` : "wait_idle";
    b.add(dayOf(sp.startedAt), ALL, shipherdSession(sp.sessionId), metric, 1, ms);
  }
  // 全部用量按花掉的那天（不分给 PR）：后台的 headless 任务（handoff、需要你判断、打断分类、复盘）没有 session，
  // 分不到 PR 上，按任务 / 模型看花费只能从这里看。没有 session 的算 Shipherd 的。
  for (const u of f.usage) {
    const day = dayOf(u.at);
    const shipherd = u.sessionId === null || shipherdSession(u.sessionId);
    const w = weightedOf(u);
    b.add(day, ALL, shipherd, `spend_task:${u.task ?? "(interactive)"}`, 1, w);
    b.add(day, ALL, shipherd, `spend_model:${u.model ?? "(default)"}`, 1, w);
  }
  return b.list();
}

export interface RollupDeps {
  db: Db;
  repo: Pick<MetricsRepo, "events" | "spans" | "replaceDaily" | "pruneDaily">;
  holds: Pick<MergeGateRepo, "allHolds">;
  registry(): RegistryModel[];
  record: RecordEvent;
  /** 度量从什么时候开始记（ensureMetricsSince）：之前合并的 PR 不补记人工 / agent 合并。 */
  since(): number;
  now(): number;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * 每小时一次：标 shipherd_made、补记合并方式，再把最近 ROLLUP_DAYS 天的 metrics_daily 整体重算（幂等）。
 */
export class MetricsRollup {
  private lastRunAt = 0;
  /** 上次开始跑的时间（失败也算）：一直失败时，页面每次重取不会都整窗重算。 */
  private lastAttemptAt = 0;

  constructor(private readonly d: RollupDeps) {}

  get lastRun(): number {
    return this.lastRunAt;
  }

  /** 上次跑过超过 maxAgeMs 才跑。 */
  runIfStale(maxAgeMs: number): boolean {
    if (this.d.now() - Math.max(this.lastRunAt, this.lastAttemptAt) < maxAgeMs) return false;
    return this.run();
  }

  run(): boolean {
    const now = this.d.now();
    this.lastAttemptAt = now;
    try {
      // 从那天的本地零点算：窗口最早那天也是整天，不会只算到一半就被冻住。
      const windowStart = startOfDay(now - ROLLUP_DAYS * DAY_MS);
      const holds = this.d.holds.allHolds();
      const since = this.d.since();
      const base = readFacts(this.d.db, windowStart, { events: [], spans: [], holds, registry: this.d.registry() });
      // 合并方式：度量开始之后合并的 PR，看有没有 agent 的 merge gate 占位。
      const merged = base.prs
        .filter((p) => p.mergedAt !== null && p.mergedAt >= since)
        .map((p) => ({ id: p.id, ticketKey: p.ticketKey, url: p.url, slug: p.slug, mergedAt: p.mergedAt as number, headBranch: p.headBranch, repoPath: p.repoPath }));
      recordMerges(merged, holds, this.d.record);
      const facts: Facts = { ...base, events: this.d.repo.events(windowStart), spans: this.d.repo.spans(windowStart) };
      const shipherdMade = this.tagShipherdMade(facts);
      const fromDay = dayOf(windowStart);
      this.d.repo.replaceDaily(fromDay, computeDaily(facts, shipherdMade, now, fromDay));
      this.d.repo.pruneDaily(fromDay);
      this.lastRunAt = now;
      return true;
    } catch (e) {
      this.d.log?.("metrics: rollup failed", e);
      return false;
    }
  }

  /** 算一遍 shipherd_made，和库里不一样的写回去（null 的也写），一个事务里写完。 */
  private tagShipherdMade(f: Facts): Map<number, boolean> {
    const made = shipherdMadeOf(f);
    const out = new Map<number, boolean>();
    const stored = new Map(
      (this.d.db.prepare(`SELECT id, shipherd_made FROM ticket_prs`).all() as unknown as { id: number; shipherd_made: number | null }[]).map((r) => [
        Number(r.id), r.shipherd_made === null ? null : Number(r.shipherd_made) === 1,
      ]),
    );
    const upd = this.d.db.prepare(`UPDATE ticket_prs SET shipherd_made = ? WHERE id = ?`);
    withTransaction(this.d.db, () => {
      for (const p of f.prs) {
        const v = made(p);
        out.set(p.id, v);
        if (stored.get(p.id) !== v) upd.run(v ? 1 : 0, p.id);
      }
    });
    return out;
  }
}
