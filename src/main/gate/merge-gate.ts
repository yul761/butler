import { resolve } from "node:path";
import type { GateRequest, GateResult } from "../../shared/gate";
import type { GateAction } from "../../shared/gate-command";
import type { MergeEvent, TicketRepo } from "../../shared/types";
import type { MergeGateRepo } from "../db/merge-gate-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { M } from "../strings";
import type { prInfo } from "../tickets/gh";
import type * as Git from "../tickets/git";

/** 占位最多保留多久（gh 查不了时的兜底，设计文档 2026-11-04）。HoldWatcher 用。 */
export const HOLD_MAX_MS = 2 * 60 * 60 * 1000;
/** HoldWatcher 多久查一轮占位中的 PR。 */
export const HOLD_CHECK_MS = 30_000;
/** hook 最多等 5 秒；fetch 和 gh 各给 2 秒，留出 merge-tree 的时间。 */
const FETCH_TIMEOUT_MS = 2000;
const PR_TIMEOUT_MS = 2000;

const ALLOW: GateResult = { v: 1, decision: "allow" };
const deny = (reason: string): GateResult => ({ v: 1, decision: "deny", reason });

/** Windows 的路径不分大小写。 */
const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
const samePath = (a: string, b: string) => norm(a) === norm(b);

export interface MergeGateDeps {
  tickets: Pick<TicketsRepo, "list" | "listRepos">;
  repo: MergeGateRepo;
  openTerminals(ticketKey: string): number;
  git: Pick<typeof Git, "mainRepoRoot" | "mergeConflicts" | "isAncestor" | "fetchQuiet" | "upstreamRef" | "currentBranch" | "branchExists" | "defaultBranch" | "mergeTreeSupported">;
  prInfo: typeof prInfo;
  notify(e: MergeEvent): void;
  now(): number;
  log(msg: string, err?: unknown): void;
  /** 文案里的“谁”：`ticket 号（feature 名）`、`ticket 号（epic 名 / feature 名）`、独立 ticket 只有号码，没有 ticket 时是 branch 名。index.ts 用 tickets / features / epics 仓库拼。 */
  whoOf(ticketKey: string | null, branch: string): string;
  /** post 阶段之后让 HoldWatcher（Task 7）尽快检查一轮。 */
  checkSoon(): void;
}

/** 一次要审核的合并：把 branch 合进 target。 */
interface Merge {
  repo: string;
  branch: string;
  target: string;
  kind: "pr" | "local";
  prUrl: string | null;
}

/**
 * 合并总控的裁决（设计文档 2026-11-04“怎么裁决”）。冲突由 git merge-tree 算，不让模型猜；
 * 任何一步出错都放行：总控是防混乱的辅助，不能变成合不了代码的原因。
 */
export class MergeGate {
  private mergeTree: Promise<boolean> | null = null;

  constructor(private readonly d: MergeGateDeps) {}

  async handle(req: GateRequest): Promise<GateResult> {
    try {
      return req.phase === "post" ? await this.after(req) : await this.before(req);
    } catch (e) {
      this.d.log(`merge gate: checking ${req.action.kind} failed, allowing it`, e);
      return ALLOW;
    }
  }

  /** 共用目录被别的开着 session 的 ticket 占着时返回它，给“切换 branch”提示用。 */
  async dirBusy(repo: TicketRepo): Promise<{ ticket: string; branch: string } | null> {
    const others = this.d.tickets
      .list()
      .filter((t) => t.key !== repo.ticketKey && t.archivedAt === null)
      .flatMap((t) => t.repos.filter((r) => r.workMode === "branch" && samePath(r.repoPath, repo.repoPath)).map((r) => ({ ticket: t.key, branch: r.branch })))
      .filter((o) => this.d.openTerminals(o.ticket) > 0);
    if (others.length === 0) return null;
    let cur: string;
    try {
      cur = await this.d.git.currentBranch(repo.repoPath);
    } catch (e) {
      this.d.log(`merge gate: reading the branch of ${repo.repoPath} failed`, e);
      return null;
    }
    return others.find((o) => o.branch === cur) ?? null;
  }

  private async before(req: GateRequest): Promise<GateResult> {
    const a = req.action;
    const dir = resolve(req.cwd, a.dir ?? ".");
    const repo = await this.d.git.mainRepoRoot(dir);
    if (a.kind === "switch") return this.checkSwitch(req, a, repo);
    const m = await this.mergeOf(a, dir, repo);
    if (!m || !(await this.mergeTreeOk(repo))) return ALLOW;
    return this.checkMerge(req, m);
  }

  /** 命令执行完：本地合并、直接 push 的占位立刻定下来；PR 的占位交给 HoldWatcher。 */
  private async after(req: GateRequest): Promise<GateResult> {
    const a = req.action;
    if (a.kind === "switch") return ALLOW;
    if (a.kind !== "pr_merge") {
      const dir = resolve(req.cwd, a.dir ?? ".");
      const repo = await this.d.git.mainRepoRoot(dir);
      const branch = a.kind === "local_merge" ? a.source : await this.d.git.currentBranch(dir);
      const hold = this.d.repo.activeHold(repo, branch);
      if (hold?.kind === "local") {
        // push 改的是远端，成功后 origin/<target> 已经跟着更新；本地合并看本地的目标分支。
        const into = a.kind === "push" ? await this.d.git.upstreamRef(repo, hold.target) : hold.target;
        const merged = await this.d.git.isAncestor(repo, branch, into);
        this.d.repo.releaseHold(hold.id, merged ? "merged" : "cancelled", this.d.now());
      }
    }
    this.d.checkSoon();
    return ALLOW;
  }

  /** 这个动作要合并什么进哪里；不算合并进目标分支的（只推自己的 branch、把 main 合进自己的 branch）返回 null。 */
  private async mergeOf(a: Exclude<GateAction, { kind: "switch" }>, dir: string, repo: string): Promise<Merge | null> {
    if (a.kind === "pr_merge") {
      const pr = await this.d.prInfo(dir, a.pr, PR_TIMEOUT_MS);
      return pr ? { repo, branch: pr.head, target: pr.base, kind: "pr", prUrl: pr.url } : null;
    }
    const cur = await this.d.git.currentBranch(dir);
    const target = a.kind === "local_merge" ? cur : a.target === "HEAD" ? cur : a.target;
    const branch = a.kind === "local_merge" ? a.source : cur;
    if (!(await this.isMergeTarget(repo, target))) return null;
    return { repo, branch, target, kind: "local", prUrl: null };
  }

  /** 默认分支，或者某个进行中 ticket 的 PR 指向的分支。某个 ticket 自己的 branch 不算（那是在更新它，不是合并进目标）。 */
  private async isMergeTarget(repo: string, target: string): Promise<boolean> {
    if (target === (await this.d.git.defaultBranch(repo))) return true;
    const branches = [...new Set(this.ticketBranches(repo).map((t) => t.branch))];
    if (branches.includes(target)) return false;
    const prs = await Promise.all(branches.map((b) => this.d.prInfo(repo, b, PR_TIMEOUT_MS)));
    return prs.some((p) => p !== null && p.state === "OPEN" && p.base === target);
  }

  private async checkMerge(req: GateRequest, m: Merge): Promise<GateResult> {
    const { repo, branch, target } = m;
    const g = this.d.git;
    const own = this.ticketOf(repo, branch);
    // fetch 失败（没网）就用本地已有的，不因此拦人。
    await g.fetchQuiet(repo, target, FETCH_TIMEOUT_MS);
    const upstream = await g.upstreamRef(repo, target);
    // 已经在最新的目标分支里了（比如在 main 上 git merge origin/main）：带不进新东西，不用审核也不占位。
    if (await g.isAncestor(repo, branch, upstream)) return ALLOW;

    // 先看和最新的目标分支本身合不合得进去：合不进去通常是另一边已经先合了。
    const behind = await g.mergeConflicts(repo, upstream, branch);
    if (behind.length > 0) {
      const prev = this.d.repo.lastProceedAgainst(repo, branch);
      this.record({ repoPath: repo, kind: "rebase", ticketKey: own, branch, otherTicket: prev?.ticketKey ?? null, otherBranch: prev?.branch ?? null, files: behind });
      return deny(M().gateRebase(prev ? this.d.whoOf(prev.ticketKey, prev.branch) : null, behind));
    }

    // 再和同仓库里其他还在进行中的 branch 逐个比：ticket 的 branch，加上正占着同一目标的 branch（不属于 ticket 的也算）。
    const others = new Map<string, string | null>();
    for (const t of this.ticketBranches(repo)) if (t.branch !== branch && !others.has(t.branch)) others.set(t.branch, t.ticket);
    for (const h of this.d.repo.activeHolds()) {
      if (h.repoPath === repo && h.target === target && h.branch !== branch && !others.has(h.branch)) others.set(h.branch, h.ticketKey);
    }
    const conflicts: { branch: string; ticket: string | null; files: string[] }[] = [];
    for (const [other, ticket] of others) {
      if (await g.isAncestor(repo, other, upstream)) continue; // 已经合进去了
      const files = await g.mergeConflicts(repo, branch, other);
      if (files.length > 0) conflicts.push({ branch: other, ticket, files });
    }

    // 冲突的那一边已经拿到合并许可、还没合完：这次不放行，等它合完。
    for (const c of conflicts) {
      const hold = this.d.repo.activeHold(repo, c.branch);
      if (!hold || hold.target !== target) continue;
      const otherTicket = hold.ticketKey ?? c.ticket;
      this.d.repo.addWaiter({ holdId: hold.id, sessionId: req.session, ticketKey: own, branch, createdAt: this.d.now() });
      this.record({ repoPath: repo, kind: "wait", ticketKey: own, branch, otherTicket, otherBranch: c.branch, files: c.files });
      return deny(M().gateWait(this.d.whoOf(otherTicket, c.branch), c.files));
    }

    // 那一边还在写代码：先到先得，记下它之后要 rebase。
    for (const c of conflicts) {
      this.record({ repoPath: repo, kind: "proceed_conflict", ticketKey: own, branch, otherTicket: c.ticket, otherBranch: c.branch, files: c.files });
    }
    if (!this.d.repo.activeHold(repo, branch)) {
      this.d.repo.addHold({ repoPath: repo, branch, target, kind: m.kind, prUrl: m.prUrl, sessionId: req.session, ticketKey: own, createdAt: this.d.now() });
    }
    return ALLOW;
  }

  /** 只在本 session 的 ticket 在这个仓库用 branch 方式（共用目录）时审核。 */
  private async checkSwitch(req: GateRequest, a: Extract<GateAction, { kind: "switch" }>, repo: string): Promise<GateResult> {
    if (!req.ticket) return ALLOW;
    const mine = this.d.tickets.listRepos(req.ticket).find((r) => samePath(r.repoPath, repo));
    if (!mine || mine.workMode !== "branch") return ALLOW;
    // `git checkout <文件>` 也会被认成切换：不新建、又没有这个 branch 的，当作不是切换。
    if (!a.create && !(await this.d.git.branchExists(repo, a.branch))) return ALLOW;
    const busy = await this.dirBusy(mine);
    if (!busy) return ALLOW;
    this.record({ repoPath: repo, kind: "dir_busy", ticketKey: req.ticket, branch: mine.branch, otherTicket: busy.ticket, otherBranch: busy.branch, files: [] });
    return deny(M().gateDirBusy(this.d.whoOf(busy.ticket, busy.branch), busy.branch));
  }

  /** 同一仓库里未归档 ticket 的 branch。 */
  private ticketBranches(repo: string): { ticket: string; branch: string }[] {
    return this.d.tickets
      .list()
      .filter((t) => t.archivedAt === null)
      .flatMap((t) => t.repos.filter((r) => samePath(r.repoPath, repo)).map((r) => ({ ticket: t.key, branch: r.branch })));
  }

  /** branch 属于哪个 ticket：feature 总控合并 PR 时请求里没有 ticket，只能按 branch 找。 */
  private ticketOf(repo: string, branch: string): string | null {
    return this.ticketBranches(repo).find((t) => t.branch === branch)?.ticket ?? null;
  }

  /** git < 2.38 没有 merge-tree --write-tree：不审核，只记一次日志。 */
  private mergeTreeOk(repo: string): Promise<boolean> {
    this.mergeTree ??= this.d.git.mergeTreeSupported(repo).then((ok) => {
      if (!ok) this.d.log("merge gate: git is older than 2.38 (no merge-tree --write-tree); merges are not checked");
      return ok;
    });
    return this.mergeTree;
  }

  private record(e: Omit<MergeEvent, "id" | "createdAt">): void {
    const full = { ...e, createdAt: this.d.now() };
    const id = this.d.repo.addEvent(full);
    this.d.notify({ ...full, id });
  }
}
