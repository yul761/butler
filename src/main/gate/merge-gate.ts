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
/** 检查出错被拦下以后，多久之内同一个 session 再跑同一条命令时，再出错就放行。 */
export const CHECK_RETRY_WINDOW_MS = 10 * 60 * 1000;
/** fetch 和 gh 各给 2 秒。 */
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

/** 一个仓库的 slug（和 parseRemoteSlug 的写法一样：github.com 省掉主机名，其余主机名在前）：origin 的（改名前后），upstream 的。 */
export interface RepoRemotes {
  origin: readonly string[];
  upstream: readonly string[];
}

/** slug 去掉主机名后的 owner/repo；不到两段的返回 null。 */
const ownerRepo = (s: string): string | null => {
  const parts = s.split("/");
  return parts.length >= 2 ? parts.slice(-2).join("/") : null;
};

/**
 * `-R` 写的仓库（`owner/repo`、`github.com/owner/repo`、`HOST/owner/repo`，不分大小写）是 paths 里的哪个、对上的是它的哪个 remote：
 * fork 的工作流里 -R 选的常是 upstream。先找连主机名都一样的；都没有再只比 owner/repo：SSH 别名主机（git@github-work:o/r）、
 * ssh.github.com:443 解析出来的主机名不是 github.com。同一个仓库 origin 优先。
 */
export function locateRepo(slug: string, paths: readonly string[], remotesOf: (path: string) => RepoRemotes): { path: string; remote: string } | null {
  const want = normSlug(slug);
  const short = ownerRepo(want);
  const uniq = [...new Set(paths)];
  const rules = [(s: string) => s === want, (s: string) => short !== null && ownerRepo(s) === short];
  for (const same of rules) {
    for (const path of uniq) {
      const r = remotesOf(path);
      if (r.origin.some(same)) return { path, remote: "origin" };
      if (r.upstream.some(same)) return { path, remote: "upstream" };
    }
  }
  return null;
}

/** `-R` 的写法换成 parseRemoteSlug 的写法：小写，去掉 https://、github.com/（含 www.）、.git 和结尾的 /。 */
export function normSlug(slug: string): string {
  return slug.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^(www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

/**
 * `-R` 写的仓库和 PR 号拼成 PR 链接，gh 就不会按 cwd 的默认 remote 查同号的 PR：`owner/repo`、`github.com/owner/repo` 是 GitHub，
 * `HOST/owner/repo` 是 GHE。认不出的写法原样返回号。
 */
export function prLink(slug: string, pr: string): string {
  const s = slug.trim().replace(/^https?:\/\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = s.split("/");
  if (parts.length === 2 && parts.every(Boolean)) return `https://github.com/${s}/pull/${pr}`;
  if (parts.length === 3 && parts.every(Boolean)) return `https://${s}/pull/${pr}`;
  return pr;
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
   * `gh pr merge -R owner/repo`（或 PR 链接）合的仓库在本机哪个 checkout、用哪个 remote 取它的分支（BTL-267）：feature 总控在
   * feature 目录（不是 git 仓库）里合 PR，只能靠它找到仓库。fork 的工作流里 -R 选的常是 upstream，这时目标分支（和同仓库 PR 的 head）
   * 要按 upstream 的算，不能拿 origin（fork）的比。
   * 不带 cwdRepo：在 ticket 用到的仓库里找，认不出是 null。带 cwdRepo（命令所在目录的主 checkout）：只看它，对不上是 null；
   * 它的 remote 读不出来时当作就是它、按 origin 算（和没写 -R 时一样查）。不给这个依赖时 cwdRepo 按 origin 算。
   */
  repoOfSlug?: (slug: string, cwdRepo?: string) => { path: string; remote: string } | null;
  /** 目录在不在（测试用）。 */
  exists?: (path: string) => boolean;
  /** 工作流程（BTL-273）：开 PR、合并之前，流程里排在前面的步骤要做完。不给就不查。 */
  workflow?: WorkflowGate;
}

/** 工作流程对闸门的回答：返回拦下的原因，放行返回 null。 */
export interface WorkflowGate {
  /** 有没有任何一层设过流程（都没有时开 PR 不用找目录、不用查）。 */
  anyWorkflow(): boolean;
  /** 开 PR：repoPath 是命令所在仓库的主 checkout（认不出是 null），branch 是 PR 的 head。 */
  prCreate(i: { ticketKey: string; repoPath: string | null; dir: string | null; branch: string | null; draft: boolean; sessionId: string | null }): Promise<string | null>;
  /** 合并这个 ticket 的分支：谁合（sessionId）、流程里合并前的步骤做完没有。 */
  merge(i: { ticketKey: string; sessionId: string | null; prUrl: string | null }): string | null;
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
  /** 目标分支在哪个 remote 上（`-R` 选了 upstream 时是 upstream）；不写是 origin。 */
  remote?: string;
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
      if (req.phase === "post") return await this.after(req);
      const r = await this.before(req, clock);
      // 查成了（不管放行还是拦下）：之前出错拦过的记录作废。不然“出错拦 → 查成、有冲突拦 → 再跑又出错”会直接放行。
      this.failedChecks.delete(this.retryKey(req));
      return r;
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
    const key = this.retryKey(req);
    if (this.failedChecks.has(key)) {
      this.failedChecks.delete(key);
      this.d.log(`merge gate: checking ${req.action.kind} failed again on the retry, allowing it unchecked`, e);
      return ALLOW;
    }
    if (this.late(clock)) return ALLOW;
    this.failedChecks.set(key, now);
    this.d.log(`merge gate: checking ${req.action.kind} failed, denying once (the same command within ${CHECK_RETRY_WINDOW_MS / 60_000} minutes is checked again and allowed if it fails again)`, e);
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
    return deny(req.action.kind === "switch" ? M().gateSwitchCheckFailed(msg) : M().gateCheckFailed(msg));
  }

  /** 出错重试认的是同一个 session 在同一个目录跑同一条命令。 */
  private retryKey(req: GateRequest): string {
    return JSON.stringify([req.session ?? req.cwd, req.cwd, req.action]);
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
    // 同一条命令里还开 PR（`git push origin HEAD && gh pr create`）：先审开 PR，过了再照常审前面那个动作。
    if (req.prCreate && a.kind !== "pr_create") {
      const r = await this.checkPrCreate(req, req.prCreate, clock);
      if (r.decision === "deny") return r;
    }
    // 推一个分支到同名的远端分支（git push -u origin feature/x）：推的是它自己，不是合并进别的分支，和目录无关。
    if (a.kind === "push" && a.source && a.source !== "HEAD" && a.source === a.target) return ALLOW;
    if (a.kind === "pr_create") return this.checkPrCreate(req, a, clock);
    // 写了仓库和 PR 号的 gh pr merge 不看目录。没写 PR 号的合的是 cwd 当前分支的 PR，还得按目录找。
    if (a.kind === "pr_merge" && a.repo !== null && a.pr !== null) return this.checkPrIn(req, a, a.repo, clock);
    // `cd "$WT"`、`git -C $(…)`：hook 看到的是没展开的写法，不知道命令真正在哪个目录跑。
    if (a.dir !== null && /[$`]/.test(a.dir)) {
      // 切 branch 只拦 branch 方式的 ticket（共用目录）；不是这种 ticket 的，在哪个目录切都不用查。
      if (a.kind === "switch" && !(req.ticket && this.d.tickets.listRepos(req.ticket).some((r) => r.workMode === "branch"))) return ALLOW;
      throw new Error(`the directory ${a.dir} in the command uses a shell variable or substitution`);
    }
    const dir = commandDir(req.cwd, a.dir);
    const repo = await this.repoAt(dir, a.kind === "pr_merge" ? "gh can't tell which repository to merge into there either" : "the git command can't run there either");
    if (a.kind === "switch") return this.checkSwitch(req, a, repo, clock);
    const m = await this.mergeOf(a, dir, repo);
    if (!m) return ALLOW;
    // 工作流程先查（不用 git）：老 git 没有 merge-tree 不审冲突，流程照样要守。
    const wf = this.workflowMerge(req, m, clock);
    if (wf) return wf;
    if (!(await this.mergeTreeOk(repo))) return ALLOW;
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
    // `-R "$REPO"`、`gh pr merge "$PR"`：和目录写成变量一样，不知道合的是哪个，先拦一次。
    if (/[$`]/.test(slug) || (a.pr !== null && /[$`]/.test(a.pr))) throw new Error(`the repository or PR in the command uses a shell variable or substitution`);
    const { repo, remote } = await this.slugRepo(req, a, slug);
    const ref = a.pr !== null && /^\d+$/.test(a.pr) ? prLink(slug, a.pr) : a.pr;
    const pr = await this.d.prInfo(repo, ref, PR_TIMEOUT_MS);
    // gh 读不到这个 PR（没登录、断网、超时、写错了号）：判不了，先拦一次，不静默放行。
    if (!pr) throw new Error(`gh couldn't read the PR ${ref} in ${repo}`);
    const m: Merge = { repo, branch: pr.head, ref: pr.head, target: pr.base, kind: "pr", prUrl: pr.url, remote };
    const wf = this.workflowMerge(req, m, clock);
    if (wf) return wf;
    if (!(await this.mergeTreeOk(repo))) return ALLOW;
    return this.checkMerge(req, m, clock);
  }

  /**
   * `-R` 的仓库在本机的主 checkout 和 remote。ticket 的仓库里认不出（SSH 别名主机、读 remote 超时）时退回按命令所在目录找，
   * 和没写 -R 时一样；目录也不是仓库、或者是别的仓库，才不查（NotChecked）。路径都过一遍 mainRepoRoot：占位按 repo_path
   * 严格相等比，大小写、斜杠、symlink 不同的同一个仓库不能变成两个。
   */
  private async slugRepo(req: GateRequest, a: Extract<GateAction, { kind: "pr_merge" }>, slug: string): Promise<{ repo: string; remote: string }> {
    const found = this.d.repoOfSlug?.(slug) ?? null;
    if (found !== null) return { repo: await this.repoAt(found.path, `the checkout of ${slug} is gone`), remote: found.remote };
    const unknown = `no ticket uses ${slug} on this machine either`;
    // 有 -R 时 gh 不看目录：目录写成变量（`cd "$WT" && gh pr merge -R o/r 12`）不是拦它的理由。
    if (a.dir !== null && /[$`]/.test(a.dir)) throw new NotChecked(`the directory ${a.dir} is a shell variable; ${unknown}`);
    const cwdRepo = await this.repoAt(commandDir(req.cwd, a.dir), unknown);
    const here = this.d.repoOfSlug ? this.d.repoOfSlug(slug, cwdRepo) : { path: cwdRepo, remote: "origin" };
    if (here === null) throw new NotChecked(`${cwdRepo} is a different repository; ${unknown}`);
    return { repo: cwdRepo, remote: here.remote };
  }

  /** 命令执行完：本地合并、直接 push 的占位立刻定下来；PR 的占位交给 HoldWatcher。 */
  private async after(req: GateRequest): Promise<GateResult> {
    const a = req.action;
    if (a.kind === "switch" || a.kind === "pr_create") return ALLOW;
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
  private async mergeOf(a: Exclude<GateAction, { kind: "switch" | "pr_create" }>, dir: string, repo: string): Promise<Merge | null> {
    if (a.kind === "pr_merge") {
      if (a.pr !== null && /[$`]/.test(a.pr)) throw new Error(`the PR ${a.pr} in the command uses a shell variable or substitution`);
      const pr = await this.d.prInfo(dir, a.pr, PR_TIMEOUT_MS);
      if (!pr) throw new Error(`gh couldn't read the PR ${a.pr ?? "of the current branch"} in ${dir}`);
      return { repo, branch: pr.head, ref: pr.head, target: pr.base, kind: "pr", prUrl: pr.url };
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
    // 目标分支按 PR 所在仓库的 remote 取（-R 选了 upstream 就是 upstream）。head 先在那个 remote 上找（同仓库的 PR）；
    // 那里没有这个分支，就是从 fork 开的 PR，head 在 origin 上。
    const remote = m.remote ?? "origin";
    const viaOther = m.kind === "pr" && remote !== "origin";
    const [, headOnRemote] = await Promise.all([
      g.fetchQuiet(repo, target, FETCH_TIMEOUT_MS, remote),
      m.kind === "pr" ? g.fetchQuiet(repo, branch, FETCH_TIMEOUT_MS, remote) : null,
      viaOther ? g.fetchQuiet(repo, branch, FETCH_TIMEOUT_MS) : null,
    ]);
    const upstream = await g.upstreamRef(repo, target, remote);
    let ref = m.ref;
    if (m.kind === "pr") {
      ref = viaOther && headOnRemote ? await g.upstreamRef(repo, m.ref, remote) : await g.upstreamRef(repo, m.ref);
      // 没网、两边都没 fetch 成：origin 上没有、remote 上有的，用 remote 的。
      if (viaOther && !headOnRemote && ref === m.ref) ref = await g.upstreamRef(repo, m.ref, remote);
    }
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

  /**
   * 工作流程管不管这次合并：合的分支是某个 ticket 的（按仓库 + 分支认），而它的流程不让这时合（不是总控、合并前的步骤没做完、
   * 流程定了由用户合）就拦下。超过期限就放行（hook 早已放行了）。
   */
  private workflowMerge(req: GateRequest, m: Merge, clock: Clock): GateResult | null {
    const wf = this.d.workflow;
    if (!wf || !wf.anyWorkflow()) return null;
    const own = this.ticketOf(m.repo, m.branch);
    if (own === null) return null;
    const reason = wf.merge({ ticketKey: own, sessionId: req.session, prUrl: m.prUrl });
    if (reason === null || this.late(clock)) return null;
    this.d.log(`merge gate: the workflow of ${own} doesn't allow merging ${m.branch} now`);
    return deny(reason);
  }

  /**
   * `gh pr create`：流程里排在开 PR 前面的步骤（预审、自审……）要先做完。按命令所在仓库 + head 分支认 ticket；
   * 目录写成变量、不在仓库里时用 session 自己的 ticket。认不出 ticket 就不管。
   */
  private async checkPrCreate(req: GateRequest, a: Extract<GateAction, { kind: "pr_create" }>, clock: Clock): Promise<GateResult> {
    const wf = this.d.workflow;
    if (!wf || !wf.anyWorkflow()) return ALLOW;
    let repo: string | null = null;
    let dir: string | null = null;
    let branch = a.head;
    if (a.dir === null || !/[$`]/.test(a.dir)) {
      dir = commandDir(req.cwd, a.dir);
      try {
        repo = await this.repoAt(dir, "gh can't open a PR from there either");
      } catch (e) {
        if (!(e instanceof NotChecked)) throw e;
        dir = null;
      }
    }
    if (repo !== null && dir !== null && branch === null) branch = await this.d.git.currentBranch(dir);
    // `-R o/r`：PR 开在那个仓库，不是命令所在目录的仓库。同一个 ticket 的几个仓库可能用同名分支，按目录认会拿 A 的预审放行 B。
    if (a.repo !== null) ({ repo, dir } = await this.prCreateRepo(a.repo, repo, dir));
    const ticketKey = repo !== null && branch !== null ? (this.ticketOf(repo, branch) ?? null) : req.ticket;
    if (ticketKey === null) return ALLOW;
    const reason = await wf.prCreate({ ticketKey, repoPath: repo, dir, branch, draft: a.draft, sessionId: req.session });
    if (reason === null || this.late(clock)) return ALLOW;
    return deny(reason);
  }

  /**
   * `gh pr create -R <slug>` 的仓库：按 slug 找 ticket 用的主 checkout；找不到时看命令所在目录的仓库是不是它。都对不上就当认不出
   * （repo 为 null），由流程按「分支对得上的仓库每个都要 clean」判断。命令目录只在就是这个仓库时才留给流程读 HEAD。
   */
  private async prCreateRepo(slug: string, cwdRepo: string | null, dir: string | null): Promise<{ repo: string | null; dir: string | null }> {
    const found = this.d.repoOfSlug?.(slug) ?? null;
    let repo: string | null = null;
    if (found !== null) {
      try {
        repo = await this.repoAt(found.path, `the checkout of ${slug} is gone`);
      } catch (e) {
        if (!(e instanceof NotChecked)) throw e;
      }
    } else if (cwdRepo !== null && this.d.repoOfSlug?.(slug, cwdRepo)) {
      repo = cwdRepo;
    }
    return { repo, dir: repo !== null && cwdRepo !== null && samePath(repo, cwdRepo) ? dir : null };
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
