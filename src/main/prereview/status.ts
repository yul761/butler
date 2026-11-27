// 预审看得见、查得到（BTL-271）：每个 ticket、PR、session 现在的预审状态，和整个预审队列。
// 界面徽标、队列页、两级总控的 list_tickets / list_sessions / pre_review_status / pre_review_queue 都用这里（契约 [contract:prereview-status]）。
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { BgJob } from "../db/background-repo";
import type { PreReviewBrief, PreReviewGroup, PreReviewRepo } from "../db/prereview-repo";
import type { BgGate } from "../../shared/background";
import {
  mostUrgentBadge, noPreReview, violationCount,
  type PreReviewBadge, type PreReviewPauseReason, type PreReviewQueueItem, type PreReviewQueueView, type PreReviewTicketStatus,
} from "../../shared/prereview";
import type { PreReviewPayload } from "./runner";

/**
 * 预审任务的互斥键：worktree 的真实路径（符号链接、相对路径都归到同一个）。同一个目录里两次预审会互相干扰
 * （复跑命令、查 HEAD 和干净与否），不同 worktree（哪怕同一个仓库）可以同时跑。没有 worktree 的用自己的临时目录，不受限制。
 */
export function preReviewLockKey(cwd: string | null): string | null {
  if (!cwd) return null;
  try {
    return realpathSync.native(cwd);
  } catch {
    return resolve(cwd);
  }
}

export interface PreReviewStatusDeps {
  repo: Pick<PreReviewRepo, "latestBy" | "briefs" | "history">;
  /** 预审任务：排队的（按真正取的顺序）和在跑的（background_jobs，kind = pre_review）。 */
  jobs: { queued(): BgJob[]; running(): BgJob[] };
  /** 后台闸门（BackgroundScheduler.gate("pre_review")）；给了 ticket 时连这个 ticket 的熔断一起看。 */
  gate(ticketKey: string | null): BgGate;
  /** 同时最多跑几个（设置 preReviewConcurrency）。 */
  concurrency(): number;
  /** 在跑的预审任务占着的 worktree（BackgroundQueue.locksOf("pre_review") 的值）。 */
  heldLocks(): Iterable<string>;
  /** 互斥键（默认 preReviewLockKey）；单测换掉免得碰文件系统。 */
  lockKey?(cwd: string | null): string | null;
  /** PR 的编号和链接（队列页显示）；不认识为 null。 */
  pr(prId: number): { number: number; url: string } | null;
  /**
   * 这个 ticket 现在的分支：ticket 各仓库的当前分支，加上开着的 PR 的分支。已经没有开着的 PR、也不是当前分支的旧分支
   * 不参与 ticket 的 overall（不然旧分支上的「违反」一直压着）。不给、或返回空的，所有分支都参与。
   */
  currentBranches?(ticketKey: string): { slug: string | null; branch: string }[];
  /** session 的整条接替链（自己和 /clear、换新之前的旧 id；SessionsRepo.chainOf）。预审记的是交证据时的 id，换新后靠它找回来。 */
  chainOf?(sessionId: string): string[];
  /** 这个 ticket 开着预审没有（epic 档位或全局设置）；不给算开着。 */
  enabled?(ticketKey: string): boolean;
  now(): number;
}

interface Snapshot {
  /** 预审 id → 排队的任务和第几（1 起）：前面只算真能先跑的（延后着的、ticket 被熔断停住的、等 worktree 锁的不算）。 */
  queued: Map<number, { job: BgJob; position: number }>;
  /** 预审 id → 在跑的任务。 */
  running: Map<number, BgJob>;
  held: Set<string>;
  global: BgGate;
  ticketGate: (key: string | null) => BgGate;
  concurrency: number;
}

const preReviewIdOf = (j: BgJob): number | null => {
  const id = Number((j.payload as PreReviewPayload | null)?.preReviewId);
  return Number.isFinite(id) && id > 0 ? id : null;
};

/** 还没出结论的（在跑、排队、停着）。 */
const isActive = (s: PreReviewBadge["state"]): boolean => s === "running" || s === "queued" || s === "paused";
const asReason = (g: BgGate): PreReviewPauseReason | null => (g.run ? null : g.reason);

const finishedState = (b: PreReviewBrief): "clean" | "violations" | "error" =>
  b.status === "failed" || b.verdict === "error" || b.verdict === null ? "error" : b.verdict;

export class PreReviewStatusService {
  constructor(private readonly d: PreReviewStatusDeps) {}

  private lockKey(cwd: string | null): string | null {
    return (this.d.lockKey ?? preReviewLockKey)(cwd);
  }

  /** 一次读完队列：同一次刷新里所有徽标对着同一份队列。 */
  private snapshot(): Snapshot {
    const running = new Map<number, BgJob>();
    for (const job of this.d.jobs.running()) {
      const id = preReviewIdOf(job);
      if (id !== null) running.set(id, job);
    }
    const gates = new Map<string, BgGate>();
    const global = this.d.gate(null);
    const held = new Set(this.d.heldLocks());
    const ticketGate = (key: string | null): BgGate => {
      if (!key) return global;
      let g = gates.get(key);
      if (!g) gates.set(key, (g = this.d.gate(key)));
      return g;
    };
    const jobs = this.d.jobs.queued();
    const cwdOf = new Map(this.d.repo.briefs(jobs.flatMap((j) => preReviewIdOf(j) ?? [])).map((b) => [b.id, b.cwd]));
    const now = this.d.now();
    // 和 BackgroundRepo.take 跳过的一样：延后到以后的、ticket 停着的、worktree 被在跑的占着的，轮到了也不会先跑，不算在前面。
    const canGo = (job: BgJob, id: number | null): boolean => {
      if (job.notBefore !== null && job.notBefore > now) return false;
      if (job.ticketKey !== null && !ticketGate(job.ticketKey).run) return false;
      const key = id !== null ? this.lockKey(cwdOf.get(id) ?? null) : null;
      return key === null || !held.has(key);
    };
    const queued = new Map<number, { job: BgJob; position: number }>();
    let ahead = 0;
    for (const job of jobs) {
      const id = preReviewIdOf(job);
      if (id !== null && !queued.has(id)) queued.set(id, { job, position: ahead + 1 });
      if (canGo(job, id)) ahead++;
    }
    return { queued, running, global, held, concurrency: Math.max(1, this.d.concurrency()), ticketGate };
  }

  private badge(b: PreReviewBrief, last: PreReviewBrief | null, s: Snapshot): PreReviewBadge {
    const base: PreReviewBadge = {
      ...noPreReview(b.ticketKey), id: b.id, sessionId: b.sessionId, repoSlug: b.target.repoSlug, branch: b.target.branch, headSha: b.target.headSha,
      prId: b.prId, trigger: b.trigger, enqueuedAt: b.createdAt, startedAt: b.startedAt, finishedAt: b.finishedAt, detail: b.detail,
      violations: violationCount(b.violations, b.checks),
    };
    const prev = last && last.id !== b.id ? { state: finishedState(last), id: last.id, violations: violationCount(last.violations, last.checks), headSha: last.target.headSha, finishedAt: last.finishedAt } : null;
    // 任务的状态比行准：行停在 running 而任务已经放回队列（上次退出时没来得及改行）时，按排队算。
    if (s.running.has(b.id) || (b.status === "running" && !s.queued.has(b.id))) {
      const job = s.running.get(b.id);
      return { ...base, state: "running", startedAt: b.startedAt ?? job?.startedAt ?? null, last: prev };
    }
    if (b.status === "queued" || b.status === "running") {
      const q = s.queued.get(b.id) ?? null;
      const gate = s.ticketGate(b.ticketKey);
      const reason = asReason(s.global) ?? asReason(gate);
      const until = !s.global.run ? s.global.until : !gate.run ? gate.until : q?.job.notBefore && q.job.notBefore > this.d.now() ? q.job.notBefore : null;
      const key = this.lockKey(b.cwd);
      const waiting = reason ? null : key !== null && s.held.has(key) ? "worktree" : s.running.size >= s.concurrency ? "concurrency" : null;
      // 排队的没有开跑时间（放回队列的那次的不算）。
      return { ...base, state: reason ? "paused" : "queued", startedAt: null, position: q?.position ?? null, reason, until, waiting, last: prev };
    }
    return { ...base, state: finishedState(b), last: null };
  }

  /** 按组取最近一次并做成徽标；groupKey 说一行属于哪一组（ticket 组还要分仓库、分支）。 */
  private badges(group: PreReviewGroup, keys: readonly (string | number)[], s: Snapshot): { latest: PreReviewBrief; badge: PreReviewBadge }[] {
    const { latest, finished, active } = this.d.repo.latestBy(group, keys);
    const groupKey = (b: PreReviewBrief): string =>
      group === "ticket" ? `${b.ticketKey ?? ""}\0${b.target.repoSlug}\0${b.target.branch}` : group === "session" ? (b.sessionId ?? "") : String(b.prId ?? "");
    const lastOf = new Map(finished.map((f) => [groupKey(f), f]));
    // 每组最近的一次，再加上组里其他还在排队、在跑的（比如同一个分支上一次还在跑、新提交的又排上了）：一个都不丢。
    const seen = new Set<number>();
    const rows = [...latest, ...active].filter((b) => !seen.has(b.id) && (seen.add(b.id), true)).sort((a, b) => b.id - a.id);
    return rows.map((b) => ({ latest: b, badge: this.badge(b, lastOf.get(groupKey(b)) ?? null, s) }));
  }

  /** ticket 现在的（仓库, 分支）；不知道为 null（所有分支都算）。 */
  private currentOf(ticketKey: string): Set<string> | null {
    const list = this.d.currentBranches?.(ticketKey) ?? [];
    return list.length > 0 ? new Set(list.map((c) => `${c.slug ?? ""}\0${c.branch}`)) : null;
  }

  /** 这个（仓库, 分支）是不是 ticket 现在的（总控按 ticket 重跑时，旧分支不重跑）。不知道时算是。 */
  isCurrentBranch(ticketKey: string, slug: string, branch: string): boolean {
    const current = this.currentOf(ticketKey);
    return !current || current.has(`${slug}\0${branch}`);
  }

  /** 一个 ticket 的预审状态（每个仓库、分支一条，overall 是最要紧的）。 */
  preReviewStatusFor(ticketKey: string): PreReviewTicketStatus {
    return this.forTickets([ticketKey]).get(ticketKey) ?? { ticketKey, overall: noPreReview(ticketKey), items: [], enabled: this.d.enabled?.(ticketKey) ?? true };
  }

  /** 一整张列表的 ticket 一次查完。没预审过的也在里面（state = none）。 */
  forTickets(keys: readonly string[]): Map<string, PreReviewTicketStatus> {
    const out = new Map<string, PreReviewTicketStatus>();
    if (keys.length === 0) return out;
    const s = this.snapshot();
    const by = new Map<string, PreReviewBadge[]>();
    for (const { latest, badge } of this.badges("ticket", keys, s)) {
      const k = latest.ticketKey ?? "";
      const list = by.get(k) ?? [];
      list.push(badge);
      by.set(k, list);
    }
    for (const key of keys) {
      const items = by.get(key) ?? [];
      const current = items.length > 0 ? this.currentOf(key) : null;
      // 旧分支（没有开着的 PR、也不是 ticket 现在的分支）照样列在 items 里，但不参与 overall。
      const counted = current ? items.filter((b) => current.has(`${b.repoSlug ?? ""}\0${b.branch ?? ""}`)) : items;
      out.set(key, { ticketKey: key, overall: mostUrgentBadge(counted) ?? noPreReview(key), items, enabled: this.d.enabled?.(key) ?? true });
    }
    return out;
  }

  /** session 最近一次预审（session 列表把「等 CI」和「预审中」分开）。没有的不在结果里。 */
  forSessions(ids: readonly string[]): Map<string, PreReviewBadge> {
    if (ids.length === 0) return new Map();
    // 换新过的 session：旧 id 上的预审也算它的（交证据时记的是旧 id）。
    const headOf = new Map<string, string>();
    for (const id of ids) {
      for (const old of this.d.chainOf?.(id) ?? [id]) if (!headOf.has(old)) headOf.set(old, id);
      if (!headOf.has(id)) headOf.set(id, id);
    }
    return this.urgentBy("session", [...headOf.keys()], (b) => headOf.get(b.sessionId ?? "") ?? (b.sessionId ?? ""));
  }

  /** PR 最近一次预审。没有的不在结果里。 */
  forPrs(ids: readonly number[]): Map<number, PreReviewBadge> {
    if (ids.length === 0) return new Map();
    return this.urgentBy("pr", ids, (b) => b.prId ?? 0);
  }

  /** 每个 key 最要紧的一条（在跑 > 排队 > 最近的结论）。 */
  private urgentBy<K extends string | number>(group: "session" | "pr", ids: readonly K[], keyOf: (b: PreReviewBrief) => K): Map<K, PreReviewBadge> {
    const by = new Map<K, PreReviewBadge[]>();
    for (const { latest, badge } of this.badges(group, ids, this.snapshot())) {
      const k = keyOf(latest);
      by.set(k, [...(by.get(k) ?? []), badge]);
    }
    const out = new Map<K, PreReviewBadge>();
    for (const [k, list] of by) {
      // 一个 key 可能有几组（换新链上的新旧 id）：结论只留最新的一次，不能让旧的「违反」压过新的「通过」；排队、在跑的照旧优先。
      const active = list.filter((b) => isActive(b.state));
      const newest = list.filter((b) => !isActive(b.state)).reduce<PreReviewBadge | null>((m, b) => (!m || (b.id ?? 0) > (m.id ?? 0) ? b : m), null);
      const best = mostUrgentBadge(newest ? [...active, newest] : active);
      if (!best) continue;
      // 在跑的那组自己没有上一次结论时，用整条链上最新的那次。
      const prevId = best.last?.id ?? 0;
      if (best !== newest && newest && newest.id !== null && newest.id > prevId && (newest.state === "clean" || newest.state === "violations" || newest.state === "error") && newest.headSha !== null) {
        out.set(k, { ...best, last: { state: newest.state, id: newest.id, violations: newest.violations, headSha: newest.headSha, finishedAt: newest.finishedAt } });
      } else out.set(k, best);
    }
    return out;
  }

  /** 一个 ticket 或 PR 的预审历史（新的在前），每条做成徽标（被作废的 state = none、detail 说为什么）。 */
  history(by: { ticketKey: string } | { prId: number }, limit = 20): PreReviewBadge[] {
    const s = this.snapshot();
    return this.d.repo.history(by, limit).map((b) => (b.status === "skipped" ? { ...this.badge({ ...b, status: "done" }, null, s), state: "none" as const, detail: b.detail ?? "skipped" } : this.badge(b, null, s)));
  }

  /** 预审队列：在跑的、排队的（按真正取的顺序）、整个队列为什么停着。 */
  queue(): PreReviewQueueView {
    const s = this.snapshot();
    const ids = [...s.running.keys(), ...s.queued.keys()];
    const rows = new Map(this.d.repo.briefs(ids).map((b) => [b.id, b]));
    const item = (id: number, job: BgJob, ending: PreReviewQueueItem["ending"] = null): PreReviewQueueItem | null => {
      const b = rows.get(id);
      if (!b) return null;
      // 行和任务对不上时（刚放回队列、刚开跑），按任务现在的状态算。
      const status = job.state === "running" ? "running" : "queued";
      const badge = this.badge({ ...b, status }, null, s);
      const pr = b.prId !== null ? this.d.pr(b.prId) : null;
      // 开跑时间只对在跑的用任务上的（排队的任务上的 started_at 是上一次开跑的）。
      const startedAt = status === "running" ? (badge.startedAt ?? job.startedAt) : null;
      return { ...badge, id: b.id, jobId: job.id, startedAt, prNumber: pr?.number ?? null, prUrl: pr?.url ?? null, ending };
    };
    // 任务还在跑、行已经有了结局的（被取消了正在中止、出了结论正在收尾）：单列出来，不算在跑的，不占「预审中」。
    const ended = (id: number): PreReviewQueueItem["ending"] => {
      const st = rows.get(id)?.status;
      return st === "skipped" ? "cancelling" : st === "done" || st === "failed" ? "finishing" : null;
    };
    const running: PreReviewQueueItem[] = [];
    const ending: PreReviewQueueItem[] = [];
    for (const [id, job] of s.running) {
      const e = ended(id);
      const it = item(id, job, e);
      if (it) (e ? ending : running).push(it);
    }
    // s.queued 是按真正取的顺序放进去的（position 可能并列：前面等着的不算）。
    const queued = [...s.queued].filter(([id]) => ended(id) === null).flatMap(([id, q]) => item(id, q.job) ?? []);
    const stopped = s.global.run ? null : { reason: s.global.reason, until: s.global.until };
    return { running, ending, queued, concurrency: s.concurrency, stopped };
  }

  /** 这一次预审现在排第几、为什么停着（submit_evidence 的回复用）。不在排队返回 null。 */
  placeOf(preReviewId: number): { position: number | null; ahead: number; running: number; reason: PreReviewPauseReason | null; waiting: PreReviewBadge["waiting"] } | null {
    const q = this.queue();
    const it = q.queued.find((x) => x.id === preReviewId);
    if (!it) return null;
    return { position: it.position, ahead: (it.position ?? 1) - 1, running: q.running.length, reason: it.reason, waiting: it.waiting };
  }
}
