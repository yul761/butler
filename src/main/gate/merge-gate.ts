import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";
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
/** hook 最多等 5 秒（GATE_WAIT_MS）：4 秒还没判完就放行，并且什么都不记（hook 那边可能已经放行，命令已经在跑）。 */
export const GATE_DEADLINE_MS = 4000;
/** fetch 和 gh 各给 2 秒。 */
/** 检查出错被拦下以后，多久之内同一个 session 再跑同一条命令时，再出错就放行。 */
export const CHECK_RETRY_WINDOW_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;
const PR_TIMEOUT_MS = 2000;

const ALLOW: GateResult = { v: 1, decision: "allow" };
const deny = (reason: string): GateResult => ({ v: 1, decision: "deny", reason });

/** Windows 的路径不分大小写。 */
const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
const samePath = (a: string, b: string) => norm(a) === norm(b);

/**
 * 命令里写的目录（`cd`、`git -C`）换成主进程用的绝对路径。session 的命令是 bash 写法：`~` 是家目录；
 * Windows 上 Claude Code 跑的是 Git Bash，`/c/Users/me` 就是 `C:/Users/me`。认不出的路径找不到仓库，只会放行。
 */
export function commandDir(cwd: string, dir: string | null, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  let d = dir ?? ".";
  if (d === "~" || d.startsWith("~/")) d = home + d.slice(1);
  if (platform !== "win32") return posix.resolve(cwd, d);
  return win32.resolve(cwd, d.replace(/^\/([a-zA-Z])(\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`));
}

/**
 * `-R` 写的仓库（`owner/repo`、`github.com/owner/repo`、`HOST/owner/repo`，不分大小写）在 paths 里是哪个：slugsOf 给一个仓库的所有 slug
 * （origin、upstream、改名前后），和 parseRemoteSlug 的写法一样（github.com 省掉主机名，其余主机名在前）。
 */
export function findRepoBySlug(slug: string, paths: readonly string[], slugsOf: (path: string) => readonly string[]): string | null {
  const want = slug.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return [...new Set(paths)].find((p) => slugsOf(p).includes(want)) ?? null;
}

export interface MergeGateDeps {
  tickets: Pick<TicketsRepo, "list" | "listRepos">;
  repo: MergeGateRepo;
  openTerminals(ticketKey: string): number;
  git: Pick<typeof Git, "mainRepoRoot" | "mergeConflicts" | "isAncestor" | "fetchQuiet" | "upstreamRef" | "currentBranch" | "branchExists" | "defaultBranch" | "mergeTreeSupported">;
  prInfo: typeof prInfo;
  notify(e: MergeEvent): void;
  now(): number;
  log(msg: string, err?: unknown): void;
  /** 文案里的“谁”：`ticket 号（feature 名）`、独立 ticket 只有号码，没有 ticket 时是 branch 名。index.ts 用 tickets / features 仓库拼。 */
  whoOf(ticketKey: string | null, branch: string): string;
  /** post 阶段之后让 HoldWatcher（Task 7）尽快检查一轮。 */
  checkSoon(): void;
  /** PR 占位建好（或本地占位换成 PR 占位）之后：把这个 PR 链接到 ticket 上。 */
  onPrHold?: (holdId: number) => void;
  /** 一次裁决最多用多久，默认 GATE_DEADLINE_MS（测试用）。 */
  deadlineMs?: number;
  /**
   * `gh pr merge -R owner/repo`（或 PR 链接）合的仓库在本机的主 checkout：只认 ticket 用到的仓库，认不出是 null。
   * feature 总控在 feature 目录（不是 git 仓库）里合 PR，只能靠它找到仓库（BTL-267）。
   */
  repoOfSlug?: (slug: string) => string | null;
  /** 目录在不在（测试用）。 */
  exists?: (path: string) => boolean;
}

/** 确定这条命令不用审核：在这里它本来就跑不起来（目录不存在、不在 git 仓库里），或者合的仓库没有 ticket。只记日志、放行。 */
class NotChecked extends Error {}

/** git 说这里不是 git 仓库（不同版本、语言的措辞都有 "not a git repository"）。 */
const notARepo = (e: unknown): boolean => /not a git repository/i.test(e instanceof Error ? e.message : String(e));

/** 一次请求的计时：超过期限后不再写占位、等待者和事件。 */
interface Clock {
  start: number;
  timedOut: boolean;
}

/** 一次要审核的合并：把 branch 合进 target。 */
interface Merge {
  repo: string;
  branch: string;
  /** 拿来算冲突的提交：PR 用 GitHub 上的 head（origin/<head>），其余就是 branch。 */
  ref: string;
  target: string;
  kind: "pr" | "local";
  prUrl: string | null;
}

/**
 * 合并总控的裁决（设计文档 2026-11-04“怎么裁决”）。冲突由 git merge-tree 算，不让模型猜。
 * 出错时（BTL-267）：能确定这条命令不用审核的（目录不存在、不在 git 仓库里、合的仓库没有 ticket）放行并记日志；
 * 真判不了的先拦一次，告诉 session 没查成、可以再跑一次；同一个 session 在 CHECK_RETRY_WINDOW_MS 内再跑同一条命令时重新检查，
 * 还是出错才放行：总控是防混乱的辅助，不能变成合不了代码的原因，但也不能静默地什么都不查。超时照旧放行（hook 那边已经放行了）。
 */
export class MergeGate {
  private mergeTree: Promise<boolean> | null = null;
  /** 检查出错拦下过的请求（session + 命令）→ 拦下的时间。 */
  private readonly failedChecks = new Map<string, number>();

  constructor(private readonly d: MergeGateDeps) {}

  /**
   * meta.ageMs：请求文件写下到现在过了多久（收件箱一次处理一个，排队的时间 hook 也在等）。期限从写下请求时算起：
   * 已经过了期限就直接放行、什么都不记。post 阶段不扣：它只释放占位，晚一点做也是对的，跳过反而会让失败的合并一直占着。
   */
  async handle(req: GateRequest, meta: { ageMs?: number } = {}): Promise<GateResult> {
    const age = req.phase === "pre" ? Math.max(0, meta.ageMs ?? 0) : 0;
    if (age >= this.deadlineMs) {
      this.d.log(`merge gate: ${req.action.kind} request waited ${age} ms before it was read; the hook has given up, allowing it`);
      return ALLOW;
    }
    const clock: Clock = { start: this.d.now() - age, timedOut: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<GateResult>((done) => {
      timer = setTimeout(() => {
        clock.timedOut = true;
        this.d.log(`merge gate: checking ${req.action.kind} took too long, allowing it`);
        done(ALLOW);
      }, this.deadlineMs - age);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.decide(req, clock), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private get deadlineMs(): number {
    return this.d.deadlineMs ?? GATE_DEADLINE_MS;
  }

  /** 已经超过期限：hook 可能早就放行了，这时再记“等待”就是假的。 */
  private late(clock: Clock): boolean {
    if (!clock.timedOut && this.d.now() - clock.start <= this.deadlineMs) return false;
    this.d.log("merge gate: decided after the deadline, allowing without recording anything");
    return true;
  }

  private async decide(req: GateRequest, clock: Clock): Promise<GateResult> {
    try {
      return req.phase === "post" ? await this.after(req) : await this.before(req, clock);
    } catch (e) {
      if (e instanceof NotChecked) {
        this.d.log(`merge gate: not checking ${req.action.kind}: ${e.message}`);
        return ALLOW;
      }
      // post 只释放占位：出错不影响命令，放行。
      if (req.phase === "post") {
        this.d.log(`merge gate: finishing ${req.action.kind} failed`, e);
        return ALLOW;
      }
      return this.checkFailed(req, e, clock);
    }
  }

  /** 真判不了：第一次拦下并说明；窗口内同一个 session 再跑同一条命令、又出错时放行。 */
  private checkFailed(req: GateRequest, e: unknown, clock: Clock): GateResult {
    const now = this.d.now();
    for (const [k, at] of this.failedChecks) if (now - at > CHECK_RETRY_WINDOW_MS) this.failedChecks.delete(k);
    const key = JSON.stringify([req.session ?? req.cwd, req.cwd, req.action]);
    if (this.failedChecks.has(key)) {
      this.failedChecks.delete(key);
      this.d.log(`merge gate: checking ${req.action.kind} failed again on the retry, allowing it unchecked`, e);
      return ALLOW;
    }
    if (this.late(clock)) return ALLOW;
    this.failedChecks.set(key, now);
    this.d.log(`merge gate: checking ${req.action.kind} failed, denying once (the same command within ${CHECK_RETRY_WINDOW_MS / 60_000} minutes is checked again and allowed if it fails again)`, e);
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
    return deny(M().gateCheckFailed(msg));
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

  private async before(req: GateRequest, clock: Clock): Promise<GateResult> {
    const a = req.action;
    // `cd "$WT"`、`git -C $(…)`：hook 看到的是没展开的写法，不知道命令真正在哪个目录跑。
    if (a.dir !== null && /[$`]/.test(a.dir)) throw new Error(`the directory ${a.dir} in the command uses a shell variable or substitution`);
    const dir = commandDir(req.cwd, a.dir);
    // 没写 PR 号的合的是 cwd 当前分支的 PR，还得按目录找。
    if (a.kind === "pr_merge" && a.repo !== null && a.pr !== null) return this.checkPrIn(req, a, a.repo, clock);
    const repo = await this.repoAt(dir, a.kind === "pr_merge" ? "gh can't tell which repository to merge into there either" : "the git command can't run there either");
    if (a.kind === "switch") return this.checkSwitch(req, a, repo, clock);
    const m = await this.mergeOf(a, dir, repo);
    if (!m || !(await this.mergeTreeOk(repo))) return ALLOW;
    return this.checkMerge(req, m, clock);
  }

  /** dir 所在仓库的主 checkout。dir 不存在、不在 git 仓库里时命令本来就跑不起来，不用审核（NotChecked）；别的错照样抛。 */
  private async repoAt(dir: string, why: string): Promise<string> {
    if (!(this.d.exists ?? existsSync)(dir)) throw new NotChecked(`${dir} does not exist; ${why}`);
    try {
      return await this.d.git.mainRepoRoot(dir);
    } catch (e) {
      if (notARepo(e)) throw new NotChecked(`${dir} is not in a git repository; ${why}`);
      throw e;
    }
  }

  /**
   * `gh pr merge -R owner/repo` 或 PR 链接：gh 不看 cwd，仓库按 slug 找本机的主 checkout（feature 总控常在不是 git 仓库的 feature 目录里合）。
   * PR 也按这个仓库查：不能在 cwd 的仓库里查同号的 PR。
   */
  private async checkPrIn(req: GateRequest, a: Extract<GateAction, { kind: "pr_merge" }>, slug: string, clock: Clock): Promise<GateResult> {
    const repo = this.d.repoOfSlug?.(slug) ?? null;
    if (repo === null) throw new NotChecked(`no ticket uses ${slug} on this machine, nothing to check it against`);
    const ref = a.pr !== null && /^\d+$/.test(a.pr) && /^[^/]+\/[^/]+$/.test(slug) ? `https://github.com/${slug}/pull/${a.pr}` : a.pr;
    const pr = await this.d.prInfo(repo, ref, PR_TIMEOUT_MS);
    if (!pr || !(await this.mergeTreeOk(repo))) return ALLOW;
    return this.checkMerge(req, { repo, branch: pr.head, ref: pr.head, target: pr.base, kind: "pr", prUrl: pr.url }, clock);
  }

  /** 命令执行完：本地合并、直接 push 的占位立刻定下来；PR 的占位交给 HoldWatcher。 */
  private async after(req: GateRequest): Promise<GateResult> {
    const a = req.action;
    if (a.kind === "switch") return ALLOW;
    if (a.kind !== "pr_merge") {
      const dir = commandDir(req.cwd, a.dir);
      const repo = await this.repoAt(dir, "nothing ran there");
      const branch = a.kind === "local_merge" ? a.source : this.pushSource(a, await this.d.git.currentBranch(dir));
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
      return pr ? { repo, branch: pr.head, ref: pr.head, target: pr.base, kind: "pr", prUrl: pr.url } : null;
    }
    const cur = await this.d.git.currentBranch(dir);
    const target = a.kind === "local_merge" ? cur : a.target === "HEAD" ? cur : a.target;
    const branch = a.kind === "local_merge" ? a.source : this.pushSource(a, cur);
    // 推目标分支自己（在 main 上 git push origin main）：合进它的那些合并已经审核过了，再审只会重复记录、把冲突算到 main 头上。
    if (branch === target) return null;
    if (!(await this.isMergeTarget(repo, target))) return null;
    return { repo, branch, ref: branch, target, kind: "local", prUrl: null };
  }

  /** push 推的是哪个分支：source（HEAD 是当前分支）。旧版 hook 没写 `src:` 时不带 source，那时按当前分支算。 */
  private pushSource(a: Extract<GateAction, { kind: "push" }>, cur: string): string {
    return a.source && a.source !== "HEAD" ? a.source : cur;
  }

  /** 默认分支，或者某个进行中 ticket 的 PR 指向的分支。某个 ticket 自己的 branch 不算（那是在更新它，不是合并进目标）。 */
  private async isMergeTarget(repo: string, target: string): Promise<boolean> {
    if (target === (await this.d.git.defaultBranch(repo))) return true;
    const branches = [...new Set(this.ticketBranches(repo).map((t) => t.branch))];
    if (branches.includes(target)) return false;
    const prs = await Promise.all(branches.map((b) => this.d.prInfo(repo, b, PR_TIMEOUT_MS)));
    return prs.some((p) => p !== null && p.state === "OPEN" && p.base === target);
  }

  private async checkMerge(req: GateRequest, m: Merge, clock: Clock): Promise<GateResult> {
    const { repo, branch, target } = m;
    const g = this.d.git;
    const own = this.ticketOf(repo, branch);
    // fetch 失败（没网）就用本地已有的，不因此拦人。PR 合并的是 GitHub 上的 head（可能在网页上 "Update branch" 过），也拉一下。
    await Promise.all([g.fetchQuiet(repo, target, FETCH_TIMEOUT_MS), m.kind === "pr" ? g.fetchQuiet(repo, branch, FETCH_TIMEOUT_MS) : null]);
    const upstream = await g.upstreamRef(repo, target);
    const ref = m.kind === "pr" ? await g.upstreamRef(repo, m.ref) : m.ref;
    // 已经在最新的目标分支里了（比如在 main 上 git merge origin/main）：带不进新东西，不用审核也不占位。
    if (await g.isAncestor(repo, ref, upstream)) return ALLOW;

    // 先看和最新的目标分支本身合不合得进去：合不进去通常是另一边已经先合了。
    const behind = await g.mergeConflicts(repo, upstream, ref);
    if (behind.length > 0) {
      if (this.late(clock)) return ALLOW;
      const prev = this.d.repo.lastProceedAgainst(repo, branch);
      this.record({ repoPath: repo, kind: "rebase", ticketKey: own, branch, otherTicket: prev?.ticketKey ?? null, otherBranch: prev?.branch ?? null, files: behind });
      return deny(M().gateRebase(prev ? this.d.whoOf(prev.ticketKey, prev.branch) : null, behind));
    }

    // 已经拿到这次合并的许可（比如上次合并没成、再试一次）：不用再等别人，也不再重复记录、通知。之前的直接 push 没成、
    // 现在改合 PR 的，把本地占位换成 PR 占位，交给 HoldWatcher 看 PR（squash 合并后 branch 不会是目标的祖先，本地占位等不到合完）。
    const mine = this.d.repo.activeHold(repo, branch);
    if (mine && mine.target === target) {
      if (this.late(clock)) return ALLOW;
      if (mine.kind === "local" && m.kind === "pr") {
        this.d.repo.toPrHold(mine.id, { prUrl: m.prUrl, sessionId: req.session, ticketKey: own, createdAt: this.d.now() });
        this.d.onPrHold?.(mine.id);
      }
      return ALLOW;
    }

    // 再和同仓库里其他还在进行中的 branch 逐个比：ticket 的 branch，加上正占着同一目标的 branch（不属于 ticket 的也算）。
    const others = new Map<string, string | null>();
    for (const t of this.ticketBranches(repo)) if (t.branch !== branch && !others.has(t.branch)) others.set(t.branch, t.ticket);
    for (const h of this.d.repo.activeHolds()) {
      if (h.repoPath === repo && h.target === target && h.branch !== branch && !others.has(h.branch)) others.set(h.branch, h.ticketKey);
    }
    // 并行：ticket 多时逐个跑会超过 hook 的等待时间。
    const checked = await Promise.all(
      [...others].map(async ([other, ticket]) => {
        if (await g.isAncestor(repo, other, upstream)) return null; // 已经合进去了
        const files = await g.mergeConflicts(repo, ref, other);
        return files.length > 0 ? { branch: other, ticket, files } : null;
      }),
    );
    const conflicts = checked.filter((c) => c !== null);
    if (this.late(clock)) return ALLOW;

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
    // 已经占着别的目标的不再加一个（一个 branch 同时只占一处）。
    if (!mine) {
      const id = this.d.repo.addHold({ repoPath: repo, branch, target, kind: m.kind, prUrl: m.prUrl, sessionId: req.session, ticketKey: own, createdAt: this.d.now() });
      if (m.kind === "pr") this.d.onPrHold?.(id);
    }
    return ALLOW;
  }

  /** 只在本 session 的 ticket 在这个仓库用 branch 方式（共用目录）时审核。 */
  private async checkSwitch(req: GateRequest, a: Extract<GateAction, { kind: "switch" }>, repo: string, clock: Clock): Promise<GateResult> {
    if (!req.ticket) return ALLOW;
    const mine = this.d.tickets.listRepos(req.ticket).find((r) => samePath(r.repoPath, repo));
    if (!mine || mine.workMode !== "branch") return ALLOW;
    // `git checkout <文件>` 也会被认成切换：不新建、又没有这个 branch 的，当作不是切换。
    if (!a.create && !(await this.d.git.branchExists(repo, a.branch))) return ALLOW;
    const busy = await this.dirBusy(mine);
    if (!busy || this.late(clock)) return ALLOW;
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
