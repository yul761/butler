import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExternalActionKind } from "../../shared/external";
import type { PolicyScope } from "../../shared/admission-policy";
import {
  isSettledOutcome,
  type StackActionResult, type StackActor, type StackAutoRebaseBy, type StackConfirmWhy, type StackEpicNote, type StackLayerMode, type StackLayerView, type StackNoticeInfo,
  type StackPolicy, type StackRunMode, type StackRunView, type StackTrigger, type StackView, type StacksFilter, type StacksView,
} from "../../shared/stacks";
import { JOB_STACKS_DAILY, type JobsRepo } from "../db/jobs-repo";
import type { LayerRow, NewLayer, RunDetail, RunRow, StackRow, StacksRepo } from "../db/stacks-repo";
import type { AttemptResult, ExternalDetail } from "../external/actions";
import { withRepoLock } from "../tickets/repo-lock";
import { applyTips, deferText, deleteBackups, type ApplyLayer } from "./apply";
import {
  behind, fetchRemote, gitVersion, hasFixups, isAncestor, mergeBase, pushBranch, refTips, remoteFor, remoteTip, revParse, runGit, subjects, supportsUpdateRefs, worktreeBranches,
} from "./git-stack";
import * as gh from "./gh-stack";
import { bottomBody, dependsLine, draftBody, draftTitle, overviewBody, stripPrefix, T, withDependsLine, withoutDependsLine, type GraphLayer } from "./pr-text";
import { markersAdded, runEngine, type EngineLayer, type NewTip } from "./rebase-engine";
import type { StackPolicyService } from "./stack-policy";
import { prUrlKey, prUrlParts } from "../../shared/pr-url";
import { parseRemoteSlug } from "../../shared/repo-slug";

/**
 * 栈式 PR（工作流 K，设计 2026-11-17-ws-k-stacks-design）：维护本地栈表，整栈自动 rebase，栈底合并后提升新栈底，
 * 管 draft 层、提醒、栈的总览 issue。所有改本地分支的事要 autoRebase 开着；所有对外的事走 ExternalActions。
 */

/** 分支属于哪个 Shipherd ticket。 */
export interface OwnedBranch {
  ticketKey: string;
  ticketRepoId: number;
  ticketTitle: string | null;
  /** 这个 ticket 由 Shipherd 管理的 worktree（workMode = worktree、没清理、目录在）；没有为 null。 */
  worktree: string | null;
}

export interface BriefLayer {
  repoSlug: string;
  branch: string;
  headSha: string | null;
  ticketKey: string | null;
  prNumber: number | null;
}

export interface StackServiceDeps {
  repo: StacksRepo;
  policy: StackPolicyService;
  /**
   * 自动化档位（BTL-247）：栈里各层 ticket（还没合并的）所在的 epic 自己选了档位时，盖在三层策略上。
   * 不给就是原来的三层策略。
   */
  overlay?(base: StackPolicy, ticketKeys: (string | null)[]): StackPolicy;
  /** 有 ticket 在「半自动」epic 里的仓库：三层策略没开 autoRebase 也要做栈检测。 */
  autoRebaseRepos?(): string[];
  external: {
    attempt<T>(kind: ExternalActionKind, detail: ExternalDetail, run: () => Promise<T>): Promise<AttemptResult<T>>;
    allowed(kind: ExternalActionKind, scope?: ExternalDetail["scope"]): boolean;
  };
  /** 临时 worktree 的目录（<SHIPHERD_HOME>/stack-work）。 */
  workRoot: string;
  /** 跑 sequence editor 的 node。 */
  execPath: string;
  now(): number;
  log(msg: string, err?: unknown): void;
  /** 分支是不是 Shipherd 的（ticket_repos.branch 或 branch_owners）。 */
  owned(repoPath: string, branch: string): OwnedBranch | null;
  /** 仓库 slug（gh 的 GH_REPO）。 */
  slugOf(repoPath: string): Promise<string | null>;
  /** origin 和 upstream 的 slug（fork 工作流里 PR 开在 upstream 上，BTL-278）。不给时只看 slugOf。 */
  remoteSlugs?(repoPath: string): Promise<string[]>;
  /** 这个目录里的 session 在忙。 */
  sessionBusy(path: string): boolean;
  /** 这个分支有合并闸的活动占位。 */
  gateHeld(repoPath: string, branch: string): boolean;
  /** 有别的分支正占着往 trunk 合（ignore 里的分支不算）。 */
  trunkBusy(repoPath: string, trunk: string, ignore: string[]): boolean;
  /** 工作流 I：这个 PR 有送进 session、还没核对的评论。 */
  awaitingCheck?(prUrl: string): boolean;
  /**
   * 把一段话送进这一层的 session（ticket 的这个仓库、这个分支）；true = 递进去了。同一层、同一个 topic 新的一条换掉还没送的旧的。
   * topic 不给是冲突；verify 是自动改写后请它编译、跑测试（BTL-278），和冲突分开排，撤回冲突不撤它。
   */
  deliver(to: { ticketKey: string; ticketRepoId: number | null; branch: string }, text: string, topic?: "verify"): Promise<boolean>;
  /** 撤回还排在信箱里没送的那条冲突（BTL-278：层收回来了、冲突没了，旧的 rebase 指令不能再送进去）。 */
  withdraw?(to: { ticketKey: string; branch: string }, topic?: "verify"): void;
  /** 工作流 G 的 review 简报。 */
  briefProvider?(layer: BriefLayer): { markdown: string; posted(prUrl: string): void } | null;
  /** 度量（契约 4.7）。 */
  record?(kind: string, data: Record<string, string | number | boolean | null>, dedupeKey?: string): void;
  /** 栈或提醒变了（推给界面）。 */
  onChange?(): void;
  /** Shipherd 自己关掉了一个 draft（退回普通分支）：记下来，ticket 不因为它变成「待决定」（BTL-270）。 */
  closedByShipherd?(prUrl: string): void;
  /** 每日任务的记录（jobs 表）。 */
  jobs?: Pick<JobsRepo, "get" | "record">;
  /** 自动检测栈的仓库（Shipherd 管的仓库）。 */
  repos?(): string[];
  /** 测试用：强制逐层模式。 */
  forceMode?: StackRunMode;
}

export interface DefineInput {
  repoPath: string;
  branches: string[];
  name?: string | null;
  featureId?: number | null;
  source: "mcp" | "ticket" | "detected";
  /** 已有的栈：整个换掉它的层。 */
  stackId?: number | null;
}

export interface MergedPr {
  url: string;
  number: number;
  headSha: string | null;
  headBranch: string | null;
}

interface RunOpts {
  /** 手动和栈底合并：要 autoRebase 开着，但不看 rebaseOnMainUpdate / dailyRebase。 */
  autosquash?: boolean;
}

const FETCH_EVERY_MS = 5 * 60_000;
const FAILED_RETRY_MS = 60 * 60_000;
/** 同样的输入、同样的原因连着失败：每多一次等的时间翻倍，最多等一天（确定性的失败不用每小时重跑一遍）。 */
const FAILED_RETRY_MAX_MS = 24 * 3600_000;
/** 读不到开着的 PR（gh 没登录、网络断了）推迟的：等 5 分钟再读，每次翻倍，最多一小时（BTL-278：原来每个 tick 都起一次 gh）。 */
const PRS_UNREADABLE = "can't read the open PRs";
const PRS_RETRY_MS = 5 * 60_000;
const PRS_RETRY_MAX_MS = 60 * 60_000;
const DETECT_EVERY_MS = 15 * 60_000;
const CONFLICT_NOTICE_AFTER_MS = 30 * 60_000;
const STUCK_AFTER_MS = 24 * 3600_000;
/** 自动改写后「没编译过」的提醒挂多久。 */
const REWRITTEN_NOTICE_MS = 24 * 3600_000;
export const BACKUP_KEEP_MS = 30 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
const DAILY_RETRY_MS = 30 * 60_000;

const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

const sha7 = (s: string | null) => (s ? s.slice(0, 7) : "");

/**
 * conflictKey 是 `${branch}:${onto}:${upstream}:${ident}`（分支名里不会有冒号）：冲突交给 session（或用户）后记在层上。
 * ident 是「同一个冲突」的判断（冲突的文件和它们在 onto 里的内容，BTL-278）。取 onto。
 */
export function conflictOnto(key: string | null): string | null {
  return key ? (key.split(":")[1] ?? null) : null;
}

function conflictUpstream(key: string): string | null {
  return key.split(":")[2] ?? null;
}

function conflictIdentOf(key: string | null): string | null {
  return key ? (key.split(":")[3] ?? null) : null;
}

/**
 * 一次 needs_confirm 现在还在等确认的那几层（BTL-278）：ready_pr 只剩还开着、可以 review 的层；
 * handoff 只在还有层的冲突在 session 手里时算数。空的就是不用再确认了（提醒消掉、自动 run 放行）。
 */
function confirmPending(r: RunRow, open: LayerRow[]): string[] {
  const c = r.detail.confirm;
  if (!c) return [];
  const live = c.branches.filter((b) => open.some((l) => l.branch === b));
  if (c.why === "ready_pr") return live.filter((b) => open.find((l) => l.branch === b)!.state === "ready");
  return open.some((l) => l.conflictKey !== null) ? live : [];
}

/** ref（完整名字）现在指向的提交，没有为 null。 */
type TipOf = (ref: string) => Promise<string | null>;

type RemoteKind = "none" | "github" | "other" | "unknown";

/** 确定不是 GitHub 的托管（这些仓库没有 GitHub PR）。别的认不出的主机（SSH 别名之类）按 unknown 算。 */
const OTHER_HOSTS = /(^|\.)(gitlab|bitbucket|codeberg|gitea|gitee|sr\.ht|sourceforge|dev\.azure|visualstudio)(\.|$)|^gitlab[.-]|^bitbucket[.-]/i;

/** 一个 remote 地址指向哪里：本地路径、GitHub（github.com 或主机名里带 github 的）、别家托管，还是认不出。 */
export function remoteKind(url: string): RemoteKind {
  const u = url.trim();
  if (!u) return "unknown";
  if (/^file:\/\//i.test(u) || u.startsWith("/") || u.startsWith(".") || /^[A-Za-z]:[\\/]/.test(u) || u.startsWith("\\\\")) return "none";
  const sl = parseRemoteSlug(u);
  if (!sl) return "unknown";
  const parts = sl.split("/");
  if (parts.length === 2) return "github";
  const host = parts[0]!;
  if (host.includes("github")) return "github";
  return OTHER_HOSTS.test(host) ? "other" : "unknown";
}

/**
 * 比较两次失败是不是同一个原因用（退避，BTL-278）：去掉每次 run 都不一样的部分——工作目录（workRoot/run-<id>）、
 * 临时 ref（refs/heads/shipherd-stack/<id>/）、锁的说明里的「stack run <id>」和等了多少秒。
 */
export function reasonKey(reason: string, workRoot: string): string {
  let r = reason;
  if (workRoot) r = r.split(workRoot).join("<work>");
  return r
    .replace(/run-\d+/g, "run-")
    .replace(/shipherd-stack\/\d+\//g, "shipherd-stack/<id>/")
    .replace(/stack run \d+/g, "stack run <id>")
    .replace(/gave up after \d+s/g, "gave up after <n>s");
}

export class StackService {
  private readonly running = new Set<number>();
  /** 等某个栈跑完的（onMerged 碰上 tick 正在跑时）。 */
  private readonly idleWaiters = new Map<number, (() => void)[]>();
  /** 「远端还没更新，先不开」已经记过日志的（层 id:本地:远端），每个 tick 都会重试，不重复记。 */
  private readonly notPromotedLogged = new Set<string>();
  private readonly fetching = new Map<string, Promise<void>>();
  private readonly lastFetch = new Map<string, number>();
  private lastDetect = 0;
  /** 交给 session 的冲突还在不在它手里（conflictKey、层顶端、父层顶端 → 是不是）：提交不会变，答案也不会变。 */
  private readonly handoffOf = new Map<string, boolean>();
  /** 栈底落后 trunk 多少（tick 里算，界面和提醒用）。 */
  private readonly behindCache = new Map<number, { commits: number; oldestAt: number | null }>();
  private ticking = false;
  /** 每个栈上次试 autosquash 时各层的顶端。 */
  private readonly autosquashTried = new Map<number, string>();
  /** 每个信箱 ref（ticket:分支）开始递送了几次冲突：递完发现过时时，期间有更新的递送就不撤（信箱里那条是它的）。 */
  private readonly deliverSeq = new Map<string, number>();
  /** 这次运行里已经核对过旧 rerere 配置的仓库。 */
  private readonly rerereChecked = new Set<string>();
  /** behindCache 是按哪一对（栈底顶端、trunk）算的（BTL-275）：两头都没动就不再起 git。 */
  private readonly behindOf = new Map<number, string>();
  /** 一段提交（仓库、base..tip）里有没有 fixup 提交：提交不会变，答案也不会变（BTL-275：原来每分钟每层一个 git log）。 */
  private readonly fixupsOf = new Map<string, boolean>();
  /** 上一次 tick 末尾界面能看到的栈状态（BTL-275）：没变就不发 onChange（原来每分钟一次 data notify，整个界面重取）。 */
  private lastSeen: string | null = null;

  constructor(private readonly d: StackServiceDeps) {}

  // ---------------------------------------------------------------- 栈的来源

  /** stack_define：建一个栈，或者整个替换已有栈的层。 */
  async define(i: DefineInput, prs?: gh.PrSnapshot[]): Promise<StackActionResult & { stackId?: number }> {
    const t = T().errors;
    const repoPath = resolve(i.repoPath);
    if (i.branches.length < 2) return { ok: false, message: t.tooFew };
    const seen = new Set<string>();
    const layers: NewLayer[] = [];
    for (const b of i.branches) {
      if (seen.has(b)) return { ok: false, message: t.duplicate(b) };
      seen.add(b);
      const o = this.d.owned(repoPath, b);
      if (!o) return { ok: false, message: t.notOwned(b) };
      const tip = await revParse(repoPath, `refs/heads/${b}`);
      if (!tip) return { ok: false, message: t.missing(b) };
      const other = this.d.repo.findBranch(repoPath, b);
      if (other && other.stack.id !== i.stackId) return { ok: false, message: t.inOther(b, other.stack.name) };
      layers.push({ branch: b, ticketKey: o.ticketKey, ticketRepoId: o.ticketRepoId, tipSha: tip });
    }
    // 每层的起点：下一层现在的顶端（是祖先时）
    for (let k = 1; k < layers.length; k++) {
      const below = layers[k - 1]!.tipSha!;
      if (await isAncestor(repoPath, below, layers[k]!.tipSha!)) layers[k]!.baseSha = below;
    }
    if (i.stackId) {
      const s = this.d.repo.get(i.stackId);
      if (!s || s.removedAt) return { ok: false, message: t.notFound };
      this.d.repo.replaceLayers(s.id, layers);
      for (const l of this.d.repo.layers(s.id)) {
        const nl = layers.find((x) => x.branch === l.branch);
        if (nl && l.tipSha === null) this.d.repo.updateLayer(l.id, { tipSha: nl.tipSha ?? null, baseSha: nl.baseSha ?? null });
      }
      await this.readPrs(s, prs);
      this.changed();
      return { ok: true, stackId: s.id };
    }
    const slug = await this.d.slugOf(repoPath).catch(() => null);
    const trunk = await this.trunkOf(repoPath);
    const remote = await remoteFor(repoPath, trunk);
    const name = i.name?.trim() || layers.map((l) => l.ticketKey ?? l.branch).join(" → ");
    const id = this.d.repo.create(
      { repoPath, repoSlug: slug, trunk, remote, name, featureId: i.featureId ?? null, source: i.source },
      layers,
    );
    this.d.log(`stacks: defined stack ${id} (${name}) in ${repoPath}`);
    await this.readPrs(this.d.repo.get(id)!, prs);
    this.changed();
    return { ok: true, stackId: id };
  }

  /** create_ticket 的 stack_on：新分支接到 parent 分支所在栈的顶上（没有栈就新建两层的栈）。 */
  async stackOn(p: { repoPath: string; parentBranch: string; branch: string; featureId: number | null }): Promise<StackActionResult & { stackId?: number }> {
    const repoPath = resolve(p.repoPath);
    const hit = this.d.repo.findBranch(repoPath, p.parentBranch);
    if (!hit) return this.define({ repoPath, branches: [p.parentBranch, p.branch], featureId: p.featureId, source: "ticket" });
    const layers = this.d.repo.layers(hit.stack.id);
    const top = layers[layers.length - 1]!;
    if (top.branch !== p.parentBranch) return { ok: false, message: T().errors.notTop(p.parentBranch) };
    const o = this.d.owned(repoPath, p.branch);
    if (!o) return { ok: false, message: T().errors.notOwned(p.branch) };
    const tip = await revParse(repoPath, `refs/heads/${p.branch}`);
    this.d.repo.addLayer(hit.stack.id, { branch: p.branch, ticketKey: o.ticketKey, ticketRepoId: o.ticketRepoId, tipSha: tip, baseSha: top.tipSha });
    await this.readPrs(hit.stack);
    this.changed();
    return { ok: true, stackId: hit.stack.id };
  }

  /** stack_on 用：create_ticket 校验 parent 能不能接（在建 worktree 之前）。 */
  canStackOn(repoPath: string, parentBranch: string): StackActionResult {
    const hit = this.d.repo.findBranch(resolve(repoPath), parentBranch);
    if (!hit) return { ok: true };
    const layers = this.d.repo.layers(hit.stack.id);
    return layers[layers.length - 1]!.branch === parentBranch ? { ok: true } : { ok: false, message: T().errors.notTop(parentBranch) };
  }

  /** 自动检测：Shipherd 的开着的 PR 里 base 是另一个 Shipherd PR 的 head 的，连成链（两层以上、都不在栈里）就建栈。 */
  async detect(repoPath: string): Promise<number[]> {
    repoPath = resolve(repoPath);
    const slug = await this.d.slugOf(repoPath).catch(() => null);
    // fork 工作流：PR 开在 upstream 上，也读（BTL-278）
    const prs = (await this.openPrsOf(repoPath, slug ? [slug] : [], null)).prs;
    if (!prs) return [];
    // 已有的栈（不管怎么建的）：层的 PR 状态按 GitHub 现在的对一遍
    for (const st of this.d.repo.list()) if (st.repoPath === repoPath) this.reconcilePrs(st, prs, (await this.remoteInfo(st)).own);
    // 层的分支推到哪个 remote，就只认 head 在那个仓库的 PR（别人 fork 里的同名分支不算）
    const remote = await remoteFor(repoPath, await this.trunkOf(repoPath));
    const own = (await this.remoteInfo({ repoPath, remote, repoSlug: slug })).own;
    const ours = (p: gh.PrSnapshot) => (p.headRepo && own.length > 0 ? own.includes(p.headRepo) : !p.crossRepo);
    // 用户删掉过的栈里的分支不再自动建回来
    const mine = prs.filter((p) => ours(p) && this.d.owned(repoPath, p.head) && !this.d.repo.findBranch(repoPath, p.head) && !this.d.repo.inRemovedStack(repoPath, p.head));
    const byHead = new Map(mine.map((p) => [p.head, p]));
    const childOf = new Map<string, gh.PrSnapshot>();
    for (const p of mine) if (byHead.has(p.base)) childOf.set(p.base, p);
    const created: number[] = [];
    for (const p of mine) {
      if (byHead.has(p.base)) continue; // 不是链底
      // 不限层数；记下走过的分支，万一 base 绕成一圈也不会一直走下去。
      const chain = [p];
      const seen = new Set([p.head]);
      let cur = p;
      while (childOf.has(cur.head) && !seen.has(childOf.get(cur.head)!.head)) {
        cur = childOf.get(cur.head)!;
        seen.add(cur.head);
        chain.push(cur);
      }
      if (chain.length < 2) continue;
      const r = await this.define({ repoPath, branches: chain.map((c) => c.head), source: "detected" }, prs);
      if (!r.ok || !r.stackId) continue;
      created.push(r.stackId);
    }
    return created;
  }

  /**
   * 层的 PR 号、链接、状态按 GitHub 上开着的 PR 对齐（BTL-278）。所有建栈、加层的入口和每次自动 run 都走这里：
   * 原来只有自动检测的栈记 PR，stack_define、stack_on 建的栈层上一直是 branch_only / 没有 PR，正在 review 的 PR 也被当成纯分支强推。
   * 按 head 分支对：head 仓库是栈的 remote 对应的仓库（own）的才算，fork 工作流里开在 upstream 上的也认得出；
   * gh 没给 head 仓库、或者认不出 own 时退回「不是从 fork 来的」。GitHub 上没开着的不动（关掉、合并另有路径处理）。
   */
  private reconcilePrs(stack: StackRow, prs: gh.PrSnapshot[], own: string[]): void {
    const ours = (p: gh.PrSnapshot) => (p.headRepo && own.length > 0 ? own.includes(p.headRepo) : !p.crossRepo);
    for (const l of this.d.repo.layers(stack.id)) {
      if (l.state === "merged") continue;
      const pr = prs.find((p) => p.head === l.branch && p.state === "OPEN" && ours(p));
      if (!pr) continue;
      const state = pr.isDraft ? "draft" : "ready";
      if (l.prNumber === pr.number && l.prUrl === pr.url && l.state === state) continue;
      // mode 说的是「这一层的 PR 是不是 Shipherd 开的 draft」（syncDrafts 会改它的标题和正文）：只有自动检测的栈
      // （PR 本来就是 Shipherd 的）按 PR 认；别的栈里用户自己开的 draft 不算 Shipherd 的，Shipherd 的 draft 被转成 ready 了才回到 branch（BTL-278）
      this.d.repo.updateLayer(l.id, {
        prNumber: pr.number, prUrl: pr.url, state, mode: stack.source === "detected" || !pr.isDraft ? (pr.isDraft ? "draft" : "branch") : l.mode,
        draftSince: pr.isDraft ? (l.state === "draft" ? l.draftSince : this.d.now()) : null,
      });
    }
  }

  /**
   * 读一次开着的 PR 再对齐；读不到返回 false。栈没记仓库 slug（建栈时没读到）先补上。
   * origin 和 upstream 都读（openPrsOf）：有一个读不到就算读不到。
   * 一个 slug 都认不出、gh 又读不到时看栈的 remote：没有这个 remote、是本地路径，或者确定是别家的托管（GitLab 之类）才当作没有 PR；
   * GitHub 的、认不出的主机（SSH 别名之类）、git 出错，都当作读不到。
   */
  private async readPrs(stack: StackRow, known?: gh.PrSnapshot[]): Promise<boolean> {
    const info = await this.remoteInfo(stack);
    if (known) {
      this.reconcilePrs(stack, known, info.own);
      return true;
    }
    let slug = stack.repoSlug;
    if (!slug) {
      slug = await this.d.slugOf(stack.repoPath).catch(() => null);
      if (slug) this.d.repo.updateStack(stack.id, { repoSlug: slug });
    }
    const heads = this.d.repo.layers(stack.id).filter((l) => l.state !== "merged").map((l) => l.branch);
    const r = await this.openPrsOf(stack.repoPath, slug ? [slug] : [], heads);
    let prs = r.prs;
    // 一个 slug 都认不出、gh 也读不到：remote 确定不在 GitHub 上（本地路径、别家托管、没有这个 remote）才当作没有 PR
    if (!prs && !r.anySlug && (info.kind === "none" || info.kind === "other")) prs = [];
    if (!prs) return false;
    this.reconcilePrs(stack, prs, info.own);
    return true;
  }

  /**
   * 仓库的 origin 和 upstream 上开着的 PR（fork 工作流里层的 PR 开在 upstream 上，BTL-278），按 url 去重。
   * 有一个读不到就返回 null。给了 heads 时，读满一页的再逐层查（查不全也是 null）。
   */
  private async openPrsOf(repoPath: string, known: string[], heads: string[] | null): Promise<{ prs: gh.PrSnapshot[] | null; anySlug: boolean }> {
    const extra = (await this.d.remoteSlugs?.(repoPath).catch(() => [] as string[])) ?? [];
    const slugs: (string | null)[] = [...new Set([...known, ...extra].filter((x) => !!x))];
    const anySlug = slugs.length > 0;
    // 一个 slug 都没有：让 gh 按目录认一次仓库
    if (!anySlug) slugs.push(null);
    const all = new Map<string, gh.PrSnapshot>();
    for (const sl of slugs) {
      let prs = await gh.openPrs(repoPath, sl);
      if (prs && heads && prs.length >= gh.OPEN_PR_LIMIT) {
        const more = await gh.openPrsForHeads(repoPath, sl, heads);
        prs = more ? [...prs, ...more] : null;
      }
      if (!prs) return { prs: null, anySlug };
      for (const p of prs) all.set(p.url, p);
    }
    return { prs: [...all.values()], anySlug };
  }


  /**
   * 栈的 remote 是什么（BTL-278）：git remote get-url（套了 insteadOf 的，git 真正用的地址）为主，配置里的原值是 GitHub 的也算 GitHub。
   * own：这个 remote 对应的 GitHub 仓库（原样的和改名后的），认 PR 的 head 仓库用。
   */
  private async remoteInfo(stack: Pick<StackRow, "repoPath" | "remote" | "repoSlug">): Promise<{ kind: RemoteKind; own: string[] }> {
    const run = (args: string[]) => runGit(stack.repoPath, args).catch(() => null);
    const url = await run(["remote", "get-url", stack.remote]);
    const raw = await run(["config", "--get", `remote.${stack.remote}.url`]);
    // 没有这个 remote：get-url 报 2、config 报 1
    if (url && url.code === 2 && raw?.code === 1) return { kind: "none", own: [] };
    const urls = [url, raw].map((r) => (r?.code === 0 ? r.stdout.trim() : null));
    const kinds = urls.map((u) => (u === null ? "unknown" : remoteKind(u)));
    // 保守地取：有一个是 GitHub 就是 GitHub，有一个认不出就是认不出（按读不到处理），都确定不是才当没有 PR
    const kind: RemoteKind = kinds.includes("github") ? "github" : kinds.includes("unknown") ? "unknown" : kinds.includes("other") ? "other" : "none";
    // 层的分支在哪个仓库：栈的 remote，再加上 origin（fork 工作流里 trunk 常常跟着 upstream，ticket 分支却推在自己的 fork 上）
    const originUrls = stack.remote === "origin" ? [] : [await run(["remote", "get-url", "origin"]), await run(["config", "--get", "remote.origin.url"])]
      .map((r) => (r?.code === 0 ? r.stdout.trim() : null));
    const own = new Set<string>();
    for (const u of [...urls, ...originUrls]) {
      const sl = u ? parseRemoteSlug(u) : null;
      if (sl && sl.split("/").length === 2) own.add(sl.toLowerCase());
    }
    // origin 的改名后的名字（slugOf 给的；PR 上 GitHub 给的是现在的名字）
    if (own.size > 0 && stack.repoSlug) own.add(stack.repoSlug.toLowerCase());
    return { kind, own: [...own] };
  }

  remove(stackId: number): StackActionResult {
    const s = this.d.repo.get(stackId);
    if (!s || s.removedAt) return { ok: false, message: T().errors.notFound };
    this.d.repo.remove(stackId);
    this.behindCache.delete(stackId);
    this.changed();
    return { ok: true };
  }

  // ---------------------------------------------------------------- 整栈 rebase

  /** 手动（界面、stack_rebase）。by：谁点的，记进这次 run（BTL-278）。 */
  async rebaseNow(stackId: number, by: StackActor = "user"): Promise<StackActionResult> {
    const s = this.d.repo.get(stackId);
    if (!s || s.removedAt) return { ok: false, message: T().errors.notFound };
    if (!this.policyOf(s).autoRebase) return { ok: false, message: T().errors.autoRebaseOff };
    if (this.running.has(stackId)) return { ok: false, message: T().errors.busy };
    // 手动就是确认（BTL-278）：上一次等确认的是 autosquash，这次也 autosquash；跑完把等着的强推推出去
    const lr = this.d.repo.lastRun(stackId);
    const asked = lr?.outcome === "needs_confirm" ? lr : null;
    let run = await this.run(s, "manual", { autosquash: asked?.detail.autosquash === true });
    if (run?.trigger === "manual") {
      this.patchRun(run.id, { actor: by, ...(asked ? { confirms: asked.id } : {}) });
      run = this.d.repo.run(run.id);
    }
    if (asked) this.d.record?.("stack.confirmed", { by, why: asked.detail.confirm?.why ?? null, outcome: run?.outcome ?? null });
    // 等着的强推：这次 run 刚读过 PR；推的时候按 lease 推（远端被别人推过就不盖）
    if (run && isSettledOutcome(run.outcome)) await this.pushPending(this.d.repo.get(stackId)!, true);
    return { ok: true, message: run ? this.runSummary(run) : undefined };
  }

  private runSummary(r: RunRow): string {
    return r.reason ? `${r.outcome}: ${r.reason}` : r.outcome;
  }

  /**
   * 一次 run。返回记下的 run（没记的 noop 返回 null）。同一个栈同一时间只跑一个。
   * 调用前调用方已经看过 autoRebase。
   */
  async run(stack: StackRow, trigger: StackTrigger, o: RunOpts = {}): Promise<RunRow | null> {
    if (this.running.has(stack.id)) return null;
    this.running.add(stack.id);
    try {
      return await this.runLocked(stack, trigger, o);
    } catch (e) {
      this.d.log(`stacks: run on stack ${stack.id} failed`, e);
      this.d.repo.recordRepeatable(stack.id, trigger, "failed", (e as Error).message);
      return this.d.repo.lastRun(stack.id);
    } finally {
      this.release(stack.id);
      this.changed();
    }
  }

  private release(id: number): void {
    this.running.delete(id);
    const w = this.idleWaiters.get(id);
    this.idleWaiters.delete(id);
    for (const f of w ?? []) f();
  }

  /** 这个栈正在跑（tick 的 rebase、恢复）：等它跑完。 */
  private async whenIdle(id: number): Promise<void> {
    while (this.running.has(id)) await new Promise<void>((r) => this.idleWaiters.set(id, [...(this.idleWaiters.get(id) ?? []), r]));
  }

  private async runLocked(stack0: StackRow, trigger: StackTrigger, o: RunOpts): Promise<RunRow | null> {
    const repo = stack0.repoPath;
    await this.cleanLegacyRerere(repo);
    const policy = this.policyOf(stack0);
    const auto = trigger !== "manual";
    await this.fetch(repo, stack0.remote, true);
    const stack = this.d.repo.get(stack0.id)!;
    // 改写前先把层的 PR 状态读对（BTL-278）；读不到就不动，手动确认也一样（确认的是读对了的状态）
    if (!(await this.readPrs(stack))) return this.defer(stack, trigger, PRS_UNREADABLE, "deferred");
    const trunkSha = (await remoteTip(repo, stack.remote, stack.trunk)) ?? (await revParse(repo, `refs/heads/${stack.trunk}`));
    if (!trunkSha) return this.defer(stack, trigger, `no ${stack.trunk}`, "failed");
    const all = this.d.repo.layers(stack.id);
    const open = all.filter((l) => l.state !== "merged");
    if (open.length === 0) {
      this.d.repo.updateStack(stack.id, { trunkSha });
      return null;
    }
    const engineLayers: EngineLayer[] = [];
    for (const l of open) {
      const tip = await revParse(repo, `refs/heads/${l.branch}`);
      if (!tip) return this.defer(stack, trigger, `branch ${l.branch} is missing`, "failed");
      engineLayers.push({ position: l.position, branch: l.branch, tip, base: l.baseSha, conflictOnto: conflictOnto(l.conflictKey) });
    }

    const bottom = open[0]!;
    const below = all.filter((l) => l.position < bottom.position).at(-1) ?? null;
    let bottomOldParent: string | null = null;
    if (below && below.state === "merged" && below.mergedHead && (bottom.lastRebaseAt ?? 0) <= (below.mergedAt ?? 0)) {
      const method = await this.mergeMethodOf(stack, below.mergedHead, trunkSha, policy);
      if (method === "squash") bottomOldParent = below.mergedHead;
    }

    const version = await gitVersion();
    const mode: StackRunMode = this.d.forceMode ?? (supportsUpdateRefs(version) ? "update_refs" : "per_layer");
    const runId = this.d.repo.startRun(stack.id, trigger, mode);
    mkdirSync(this.d.workRoot, { recursive: true });
    const res = await runEngine({
      repo, workRoot: this.d.workRoot, runId, trunk: trunkSha, layers: engineLayers, bottomOldParent, mode, autosquash: o.autosquash,
      execPath: this.d.execPath, log: (m) => this.d.log(m),
    });

    if (res.kind === "failed") {
      this.d.repo.finishRun(runId, { outcome: "failed", reason: res.reason, detail: { inputs: await this.inputsOf(stack) } });
      return this.d.repo.run(runId);
    }
    if (res.kind === "conflict") {
      // 冲突在要 review 的 PR 上（或它下面这次真要改写的层有 ready 的）：自动跑时先问人，不把「rebase 再强推」交给 session（BTL-278）。
      // 下面没动的 ready 层（比如本来就在 trunk 上、只是作者推了 review 修改）不算。
      const moved = new Set(res.below.filter((t) => t.newTip !== t.oldTip).map((t) => t.branch));
      const ready = open
        .filter((l) => l.state === "ready" && (l.position === res.position || (l.position < res.position && moved.has(l.branch))))
        .map((l) => l.branch);
      if (auto && ready.length > 0) return this.needsConfirm(stack, runId, "ready_pr", ready, o);
      // 下面有一层的冲突还在 session 手里：新冲突的指令是接到这次 run 临时改写的下层上，那层 session 解完会再变，先问人（BTL-278）
      if (auto) {
        const handed = await this.handedOff(stack, open);
        if (handed && res.position > handed.position) {
          const over = open.filter((l) => l.position >= handed.position && l.position <= res.position).map((l) => l.branch);
          return this.needsConfirm(stack, runId, "handoff", over, o);
        }
      }
      return this.onConflict(stack, open, runId, res, policy);
    }

    if (res.kind === "noop") {
      this.syncRecords(stack, open, res.tips, trunkSha, false, bottomOldParent !== null);
      // 上一次是冲突、回滚、推迟或失败时这次的 noop 要留下来：它说明问题没了（比如 session 照提示解完了冲突）
      const prev = this.d.repo.lastRun(stack.id, runId);
      const settledBefore = !prev || prev.outcome === "rebased" || prev.outcome === "noop" || prev.outcome === "restored";
      if (settledBefore && (trigger === "layer_commits" || trigger === "main_updated")) {
        // 没变化的自动触发不留 run，免得每分钟一行。
        this.d.repo.deleteRun(runId);
        await this.afterRun(stack, trigger);
        return null;
      }
      this.d.repo.finishRun(runId, { outcome: "noop" });
      await this.afterRun(stack, trigger);
      return this.d.repo.run(runId);
    }

    // rebased：落到真分支上
    const changed = res.tips.filter((t) => t.newTip !== t.oldTip);
    if (auto) {
      // 第 2、3 条护栏（BTL-278）：要改写正在 review 的 PR，或者冲突交给了 session、还在它手里的层（和它上面的层）：先问人
      const ready = changed.filter((t) => open.find((l) => l.branch === t.branch)?.state === "ready").map((t) => t.branch);
      const handed = await this.handedOff(stack, open);
      const over = handed ? changed.filter((t) => t.position >= handed.position).map((t) => t.branch) : [];
      if (ready.length > 0) return this.needsConfirm(stack, runId, "ready_pr", ready, o);
      if (over.length > 0) return this.needsConfirm(stack, runId, "handoff", over, o);
    }
    const deferReason = this.externalDefer(stack, open, changed);
    if (deferReason) {
      this.d.repo.deleteRun(runId);
      return this.defer(stack, trigger, deferReason, "deferred");
    }
    const checkouts = await worktreeBranches(repo);
    const applyLayers: ApplyLayer[] = [];
    for (const t of res.tips) {
      const l = open.find((x) => x.branch === t.branch)!;
      const path = checkouts.get(t.branch) ?? null;
      const managed = path !== null && this.isManaged(repo, t.branch, path);
      applyLayers.push({
        position: t.position, branch: t.branch, oldTip: t.oldTip, newTip: t.newTip, checkout: path ? { path, managed } : null,
        remoteTip: await remoteTip(repo, stack.remote, t.branch), remoteOkSha: l.remoteOkSha,
      });
    }
    const applied = await applyTips({
      repo, stackId: stack.id, runId, layers: applyLayers, sessionBusy: (p) => this.d.sessionBusy(p),
      push: (l) => this.forcePush(stack, l, open.find((x) => x.branch === l.branch)!), log: (m) => this.d.log(m),
    });
    if (applied.kind === "deferred") {
      this.d.repo.deleteRun(runId);
      return this.defer(stack, trigger, deferText(applied.reason), "deferred");
    }
    if (applied.kind === "rolled_back") {
      this.d.repo.finishRun(runId, { outcome: "rolled_back", reason: applied.reason, detail: { layers: applied.layers, inputs: await this.inputsOf(stack) } });
      // 真分支都改回去了：记下现在的顶端和 trunk，同一个触发不再每分钟重来一次（等人看，或者有新提交）
      for (const t of res.tips) {
        const l = open.find((x) => x.branch === t.branch);
        if (l) this.d.repo.updateLayer(l.id, { tipSha: t.oldTip });
      }
      this.d.repo.updateStack(stack.id, { trunkSha });
      this.d.record?.("stack.rollback", { trigger, layers: changed.length });
      return this.d.repo.run(runId);
    }
    this.syncRecords(stack, open, res.tips, trunkSha, true, bottomOldParent !== null);
    for (const t of changed) {
      const l = open.find((x) => x.branch === t.branch)!;
      const at = applyLayers.find((x) => x.branch === t.branch)!;
      if (applied.pushed.includes(t.branch)) this.d.repo.updateLayer(l.id, { remoteOkSha: null });
      else if (at.remoteTip) this.d.repo.updateLayer(l.id, { remoteOkSha: l.remoteOkSha ?? at.remoteTip });
    }
    const detail: RunDetail = {
      layers: applied.layers, pushed: applied.pushed, unpushed: applied.unpushed,
      mergeMethod: bottomOldParent ? "squash" : below?.state === "merged" ? "merge" : undefined,
    };
    const reason = applied.pushFailed.length ? applied.pushFailed.map((f) => `push ${f.branch}: ${f.error}`).join("; ") : null;
    this.d.repo.finishRun(runId, { outcome: "rebased", reason, detail });
    this.d.record?.(o.autosquash ? "stack.autosquash" : "stack.rebase", {
      trigger, mode, layers: changed.length, mergeMethod: detail.mergeMethod ?? null, pushed: applied.pushed.length, unpushed: applied.unpushed.length,
    });
    this.d.log(`stacks: stack ${stack.id} ${trigger}: rebased ${changed.map((t) => `${t.branch} ${sha7(t.oldTip)}→${sha7(t.newTip)}`).join(", ")}`);
    await this.askToVerify(open, changed, applied.pushed);
    await this.afterRun(stack, trigger);
    return this.d.repo.run(runId);
  }

  /**
   * 改写过的层没人编译、跑过测试（BTL-278）：请每一层的 session 核对一次。和冲突分开排（topic verify），
   * 同一层新的一条换掉还没送的旧的。没有 session 的层由「刚自动改写」的提醒告诉用户。
   */
  private async askToVerify(open: LayerRow[], changed: NewTip[], pushed: string[]): Promise<void> {
    for (const t of changed) {
      const l = open.find((x) => x.branch === t.branch);
      if (!l?.ticketKey) continue;
      const text = T().verify({ branch: t.branch, onto: t.newBase, tip: t.newTip, pushed: pushed.includes(t.branch) });
      await this.d.deliver({ ticketKey: l.ticketKey, ticketRepoId: l.ticketRepoId, branch: l.branch }, text, "verify")
        .catch((e) => (this.d.log(`stacks: asking ${l.branch}'s session to verify failed`, e), false));
    }
  }

  /**
   * 自动跑出来要改写不该悄悄改写的层：什么都不落地（本地、远端都不动），记一次 needs_confirm 等人点「马上 rebase」。
   * 同样的原因、同样的层连着来只留一行。
   */
  private async needsConfirm(stack: StackRow, runId: number, why: StackConfirmWhy, branches: string[], o: RunOpts): Promise<RunRow | null> {
    const reason = `${why}: ${branches.join(", ")}`;
    const inputs = await this.inputsOf(stack);
    const prev = this.d.repo.lastRun(stack.id, runId);
    // 只并同一种：autosquash 的和整栈 rebase 的分开记，确认时跑的就是最近要确认的那种
    if (prev?.outcome === "needs_confirm" && prev.reason === reason && (prev.detail.autosquash === true) === (o.autosquash === true)) {
      this.d.repo.deleteRun(runId);
      this.d.repo.finishRun(prev.id, { outcome: "needs_confirm", reason, detail: { ...prev.detail, inputs, repeats: (prev.detail.repeats ?? 1) + 1 } });
      return this.d.repo.run(prev.id);
    }
    this.d.repo.finishRun(runId, { outcome: "needs_confirm", reason, detail: { confirm: { why, branches }, inputs, autosquash: o.autosquash || undefined } });
    this.d.record?.("stack.needs_confirm", { why, layers: branches.length });
    this.d.log(`stacks: stack ${stack.id}: not rewriting ${branches.join(", ")} without a confirm (${why})`);
    return this.d.repo.run(runId);
  }

  /**
   * 交给 session 的冲突还在它手里的那一层（最下面的一层）：层上记着 conflictKey，它的顶端既不包含送过去的 onto，
   * 也不包含父层（栈底是 trunk）后来的新顶端。session 照提示 rebase 了、或者自己接到了父层的新顶端，就算交回来了。
   */
  private async handedOff(s: StackRow, open: LayerRow[], tipOf: TipOf = (ref) => revParse(s.repoPath, ref)): Promise<LayerRow | null> {
    for (let k = 0; k < open.length; k++) {
      const l = open[k]!;
      const onto = conflictOnto(l.conflictKey);
      if (!l.conflictKey || !onto) continue;
      const tip = await tipOf(`refs/heads/${l.branch}`);
      if (!tip) continue;
      const parent = k === 0
        ? ((await tipOf(`refs/remotes/${s.remote}/${s.trunk}`)) ?? (await tipOf(`refs/heads/${s.trunk}`)))
        : await tipOf(`refs/heads/${open[k - 1]!.branch}`);
      const key = `${s.repoPath}\0${l.conflictKey}\0${tip}\0${parent ?? ""}`;
      let held = this.handoffOf.get(key);
      if (held === undefined) {
        // git 出错时按「还在 session 手里」算（不改写），但不记下来：下次再看
        let failed = false;
        const has = (c: string) => isAncestor(s.repoPath, c, tip).catch(() => ((failed = true), false));
        held = !(await has(onto)) && !(parent !== null && parent !== conflictUpstream(l.conflictKey) && (await has(parent)));
        if (!failed) {
          if (this.handoffOf.size >= 1000) this.handoffOf.clear();
          this.handoffOf.set(key, held);
        }
      }
      if (held) return l;
    }
    return null;
  }

  /**
   * 引擎的输入：trunk 和各层顶端；有冲突在 session 手里时只算它下面的层（它和上面的层 session 自己动不算新输入）。
   * 没落地的 run 记下它，dueTrigger 在输入没变时不再跑（BTL-278：原来冲突时每分钟重跑、重发一次）。
   */
  private async inputsOf(s: StackRow, tipOf: TipOf = (ref) => revParse(s.repoPath, ref)): Promise<string> {
    const open = this.d.repo.layers(s.id).filter((l) => l.state !== "merged");
    const held = await this.handedOff(s, open, tipOf);
    const counted = held ? open.filter((l) => l.position < held.position) : open;
    const trunk = (await tipOf(`refs/remotes/${s.remote}/${s.trunk}`)) ?? (await tipOf(`refs/heads/${s.trunk}`));
    const tips: (string | null)[] = [];
    for (const l of counted) tips.push(await tipOf(`refs/heads/${l.branch}`));
    return `${held?.branch ?? "-"}|${trunk ?? ""}|${tips.join(",")}`;
  }

  /** 第 3.5 节：I 还在核对、合并闸占位、trunk 有合并在途。 */
  private externalDefer(stack: StackRow, open: LayerRow[], changed: NewTip[]): string | null {
    for (const t of changed) {
      const l = open.find((x) => x.branch === t.branch)!;
      if (l.prUrl && this.d.awaitingCheck?.(l.prUrl)) return `review comments on ${t.branch} are being checked`;
      if (this.d.gateHeld(stack.repoPath, t.branch)) return `${t.branch} holds the merge gate`;
    }
    const ignore = this.d.repo.layers(stack.id).map((l) => l.branch);
    if (this.d.trunkBusy(stack.repoPath, stack.trunk, ignore)) return `a merge into ${stack.trunk} is in progress`;
    return null;
  }

  private defer(stack: StackRow, trigger: StackTrigger, reason: string, outcome: "deferred" | "failed"): RunRow | null {
    const fresh = this.d.repo.recordRepeatable(stack.id, trigger, outcome, reason);
    if (fresh) {
      this.d.log(`stacks: stack ${stack.id} ${trigger} ${outcome}: ${reason}`);
      if (outcome === "deferred") this.d.record?.("stack.deferred", { trigger, reason: reason.slice(0, 80) }, `${stack.id}:${reason}:${Math.floor(this.d.now() / 3600_000)}`);
    }
    return this.d.repo.lastRun(stack.id);
  }

  /**
   * 记下各层新的起点和顶端；changed = 这次真的改写过。走到这里就没有冲突了：冲突记号都清掉。
   * bottomDone = 这次处理了合并掉的栈底（squash 后的 --onto）：新栈底记一次 lastRebaseAt，下次不再按旧父层算。
   */
  private syncRecords(stack: StackRow, open: LayerRow[], tips: NewTip[], trunkSha: string, changed: boolean, bottomDone = false): void {
    const at = this.d.now();
    for (const t of tips) {
      const l = open.find((x) => x.branch === t.branch);
      if (!l) continue;
      const moved = t.newTip !== t.oldTip;
      const stamp = (moved && changed) || (bottomDone && l.id === open[0]!.id);
      this.d.repo.updateLayer(l.id, { tipSha: t.newTip, baseSha: t.newBase, conflictKey: null, ...(stamp ? { lastRebaseAt: at } : {}) });
      // 交出去的冲突没了：还没送进去的那条旧指令撤回
      if (l.conflictKey && l.ticketKey) this.d.withdraw?.({ ticketKey: l.ticketKey, branch: l.branch });
    }
    // 引擎没列出来的层（noop 时它只列到第一层要动的为止）：顶端照实记
    this.d.repo.updateStack(stack.id, { trunkSha });
  }

  private async forcePush(stack: StackRow, l: ApplyLayer, row: LayerRow): Promise<boolean> {
    if (!this.d.owned(stack.repoPath, l.branch)) {
      this.d.log(`stacks: not pushing ${l.branch}: not a Shipherd branch`);
      return false;
    }
    const r = await this.d.external.attempt(
      "force_push",
      { scope: { repoSlug: stack.repoSlug, ticketKey: row.ticketKey }, target: l.branch, summary: `stack rebase: ${l.branch} ${sha7(l.remoteTip)} → ${sha7(l.newTip)}` },
      () => pushBranch(stack.repoPath, stack.remote, l.branch, l.remoteTip),
    );
    return r.ran;
  }

  /**
   * 冲突（BTL-278）：同一个冲突（同一层、同样的冲突文件、文件在 onto 里的内容一样）只交出去一次。
   * 上一次就是它：并进上一行（不新记、不重发）；已经交给 session 的：记下来但不重发。
   * 交给 session（送进去了）或者交给用户（conflictToSession 关着）以后才在层上记 conflictKey：从这时起自动 rebase 不再改写它。
   */
  private async onConflict(
    stack: StackRow, open: LayerRow[], runId: number,
    res: { position: number; branch: string; files: string[]; commit: string | null; onto: string; upstream: string }, policy: StackPolicy,
  ): Promise<RunRow | null> {
    const layer = open.find((l) => l.branch === res.branch)!;
    const ident = await this.conflictIdent(stack.repoPath, res.onto, res.files);
    const key = `${res.branch}:${res.onto}:${res.upstream}:${ident}`;
    const handed = conflictIdentOf(layer.conflictKey) === ident && layer.conflictKey?.split(":")[0] === res.branch;
    const prev = this.d.repo.lastRun(stack.id, runId);
    const pc = prev?.outcome === "conflict" ? prev.detail.conflict : undefined;
    // 手动的不并进上一行：谁点的、点了以后还是这个冲突，都要留一行
    const manual = this.d.repo.run(runId)?.trigger === "manual";
    if (!manual && prev && pc && pc.branch === res.branch && pc.ident === ident) {
      this.d.repo.deleteRun(runId);
      this.patchRun(prev.id, { inputs: await this.inputsOf(stack), repeats: (prev.detail.repeats ?? 1) + 1 });
      return this.d.repo.run(prev.id);
    }
    const detail: RunDetail = {
      conflict: { branch: res.branch, files: res.files, commit: res.commit, onto: res.onto, upstream: res.upstream, ident, key: handed ? layer.conflictKey! : key },
      ...(handed ? { delivered: true } : {}),
    };
    this.d.repo.finishRun(runId, { outcome: "conflict", reason: `${res.branch}: ${res.files.join(", ")}`, detail });
    if (!handed) {
      this.d.record?.("stack.conflict", { files: res.files.length });
      if (policy.conflictToSession) await this.deliverConflict(stack, runId);
      else this.d.repo.updateLayer(layer.id, { conflictKey: key });
    }
    this.patchRun(runId, { inputs: await this.inputsOf(stack) });
    return this.d.repo.run(runId);
  }

  /** 冲突的文件在 onto 里的内容（ls-tree 一次）：同一个冲突的判断。onto 每次都是新 rebase 出来的提交，不能直接比。 */
  private async conflictIdent(repo: string, onto: string, files: string[]): Promise<string> {
    const sorted = [...files].sort();
    const r = await runGit(repo, ["ls-tree", "-r", onto, "--", ...sorted]);
    return simpleHash(`${sorted.join("\0")}\n${r.code === 0 ? r.stdout : onto}`);
  }

  private patchRun(id: number, patch: Partial<RunDetail>): void {
    const r = this.d.repo.run(id);
    if (r) this.d.repo.finishRun(id, { outcome: r.outcome, reason: r.reason, detail: { ...r.detail, ...patch } });
  }

  /** 把冲突送进那一层的 session；送进去了在 run 的 detail 里记 delivered。 */
  private async deliverConflict(stack: StackRow, runId: number): Promise<void> {
    const run = this.d.repo.run(runId);
    const c = run?.detail.conflict;
    if (!run || !c) return;
    const layers = this.d.repo.layers(stack.id).filter((l) => l.state !== "merged");
    const layer = layers.find((l) => l.branch === c.branch);
    if (!layer?.ticketKey) return;
    const above = layers.filter((l) => l.position > layer.position).map((l) => l.branch);
    const push = this.d.external.allowed("force_push", { repoSlug: stack.repoSlug, ticketKey: layer.ticketKey });
    // 强推命令锁定这时远端的完整 sha（BTL-278）：跟踪 ref 每 5 分钟 fetch 一次、所有 worktree 共用，不带 sha 的 lease 可能盖掉 reviewer 推的提交
    const remoteSha = push ? await remoteTip(stack.repoPath, stack.remote, c.branch) : null;
    const text = T().conflict({ branch: c.branch, files: c.files, onto: c.onto, upstream: c.upstream, above, push, remote: stack.remote, remoteSha });
    // 这次 run 已经不是最近一次（之后又跑过）：它的冲突过时了，不送
    if (this.d.repo.lastRun(stack.id)?.id !== runId) return;
    const to = { ticketKey: layer.ticketKey, ticketRepoId: layer.ticketRepoId, branch: layer.branch };
    // 还没送进去的「改写后核对」说的是上一次改写的顶端：这一层又要交冲突了，先撤掉（BTL-278）
    this.d.withdraw?.(to, "verify");
    const ref = `${to.ticketKey}:${to.branch}`;
    const seq = (this.deliverSeq.get(ref) ?? 0) + 1;
    this.deliverSeq.set(ref, seq);
    let ok = false;
    try {
      ok = await this.d.deliver(to, text);
    } catch (e) {
      this.d.log(`stacks: delivering the conflict on ${c.branch} failed`, e);
    }
    if (!ok) return;
    // 递送时等过：重读这次 run。期间又跑过（或者它不再是冲突）：刚排进去的这条过时了，撤回，不记交接。
    // 新的那次也是这一层的冲突、已经送过：同一个 ref 的消息被这次撤掉了，按新的那次重送。
    const fresh = this.d.repo.run(runId);
    const latest = this.d.repo.lastRun(stack.id);
    if (!fresh || fresh.outcome !== "conflict" || latest?.id !== runId) {
      // 等的时候又有一次递送开始了：同一个 ref 的那条换掉了这条，撤回会撤掉它的；它回来时自己核对
      if (this.deliverSeq.get(ref) !== seq) return;
      this.d.withdraw?.(to);
      if (latest && latest.id !== runId && latest.outcome === "conflict" && latest.detail.conflict?.branch === c.branch && latest.detail.delivered) {
        await this.deliverConflict(stack, latest.id);
      }
      return;
    }
    this.d.repo.finishRun(runId, { outcome: "conflict", reason: fresh.reason, detail: { ...fresh.detail, delivered: true } });
    // 交出去了：从现在起这一层（和上面的层）归 session，自动 rebase 不再改写
    if (c.key) this.d.repo.updateLayer(layer.id, { conflictKey: c.key });
  }

  // ---------------------------------------------------------------- 栈底合并

  /** PrWatcher.onMerged：PR 属于某个栈的层时，标成合并、整栈 rebase、提升新栈底。 */
  async onMerged(pr: MergedPr, repoPath: string): Promise<void> {
    const branch = pr.headBranch;
    if (!branch) return;
    const hit = this.d.repo.findBranch(resolve(repoPath), branch) ?? this.d.repo.findBranchAnyRepo(branch).find((h) => h.layer.prUrl === pr.url) ?? null;
    if (!hit || hit.layer.state === "merged") return;
    const { stack, layer } = hit;
    this.d.repo.updateLayer(layer.id, { state: "merged", mergedAt: this.d.now(), mergedHead: pr.headSha ?? layer.tipSha, prNumber: pr.number, prUrl: pr.url });
    this.d.log(`stacks: ${branch} (#${pr.number}) merged; stack ${stack.id}`);
    const open = this.d.repo.layers(stack.id).filter((l) => l.state !== "merged");
    if (open.length === 0) {
      this.changed();
      return;
    }
    // 合并方式：确定一次记下来（auto 时看合并时的 head 是不是 trunk 的祖先）
    const policy = this.policyOf(stack);
    await this.fetch(stack.repoPath, stack.remote, true);
    const trunkSha = (await remoteTip(stack.repoPath, stack.remote, stack.trunk)) ?? null;
    if (trunkSha) await this.mergeMethodOf(this.d.repo.get(stack.id)!, pr.headSha ?? layer.tipSha ?? "", trunkSha, policy, true);
    if (policy.autoRebase) {
      // tick 正在跑这个栈时 run 会直接返回 null：先等它跑完，不然下一层没 rebase 就被开成 PR。
      await this.whenIdle(stack.id);
      const run = await this.run(this.d.repo.get(stack.id)!, "bottom_merged");
      if (run && run.outcome !== "rebased" && run.outcome !== "noop") return;
    }
    // autoRebase 关着时新栈底没 rebase（squash 合并后它还带着合并掉的提交）：不开成可以 review 的 PR
    if (policy.autoRebase && policy.autoOpenBottomPr) await this.promoteBottom(this.d.repo.get(stack.id)!);
    await this.syncDrafts(this.d.repo.get(stack.id)!);
    await this.syncOverview(this.d.repo.get(stack.id)!);
    this.changed();
  }

  private async mergeMethodOf(stack: StackRow, mergedHead: string, trunkSha: string, policy: StackPolicy, store = false): Promise<"squash" | "merge"> {
    if (!store && stack.mergeMethod) return stack.mergeMethod;
    let m: "squash" | "merge";
    if (policy.mergeMethod !== "auto") m = policy.mergeMethod;
    else m = mergedHead && (await isAncestor(stack.repoPath, mergedHead, trunkSha).catch(() => false)) ? "merge" : "squash";
    if (stack.mergeMethod !== m) this.d.repo.updateStack(stack.id, { mergeMethod: m });
    return m;
  }

  /** 栈底下面有合并掉的层、自己还不是 ready：要提升。 */
  private needsPromotion(stack: StackRow): LayerRow | null {
    const all = this.d.repo.layers(stack.id);
    const bottom = all.find((l) => l.state !== "merged");
    if (!bottom || bottom.state === "ready") return null;
    return all.some((l) => l.state === "merged" && l.position < bottom.position) ? bottom : null;
  }

  /** 第 4 节第 4 步：新栈底开成（或改成）可以 review 的 PR。每一步一个开关，关着的下次补做。 */
  async promoteBottom(stack: StackRow): Promise<void> {
    const layer = this.needsPromotion(stack);
    if (!layer) return;
    const repo = stack.repoPath;
    const slug = stack.repoSlug;
    const scope = { repoSlug: slug, ticketKey: layer.ticketKey };
    const tip = await revParse(repo, `refs/heads/${layer.branch}`);
    const remote = await remoteTip(repo, stack.remote, layer.branch);
    if (remote && tip && remote !== tip) {
      // 改写后还没推上去（force_push 关着）：远端的内容不对，先不开
      const k = `${layer.id}:${tip}:${remote}`;
      if (!this.notPromotedLogged.has(k)) {
        this.notPromotedLogged.add(k);
        this.d.log(`stacks: not promoting ${layer.branch}: the remote branch is not up to date`);
      }
      return;
    }
    const all = this.d.repo.layers(stack.id);
    const open = all.filter((l) => l.state !== "merged");
    const graph = await this.graph(stack, all);
    const commits = tip ? await subjects(repo, stack.trunkSha ?? (await remoteTip(repo, stack.remote, stack.trunk)), tip).catch(() => []) : [];
    const brief = slug ? (this.d.briefProvider?.({ repoSlug: slug, branch: layer.branch, headSha: tip, ticketKey: layer.ticketKey, prNumber: layer.prNumber }) ?? null) : null;
    const owned = this.d.owned(repo, layer.branch);
    const k = all.indexOf(all.find((l) => l.id === layer.id)!) + 1;
    const body = bottomBody({
      k, n: all.length, brief: brief?.markdown ?? null, commits, graph, current: k - 1, above: open.slice(1).map((l) => l.branch),
    });
    try {
      if (layer.prNumber) {
        const pr = await gh.prView(repo, slug, layer.prNumber);
        if (!pr || pr.state !== "OPEN") return;
        if (pr.base !== stack.trunk) {
          const r = await this.d.external.attempt("pr_open", { scope, target: pr.url, summary: `retarget #${pr.number} to ${stack.trunk}` }, () => gh.prEditBase(repo, slug, pr.number, stack.trunk));
          if (!r.ran) return;
        }
        let ready = !pr.isDraft;
        if (pr.isDraft) {
          const r = await this.d.external.attempt("pr_open", { scope, target: pr.url, summary: `mark #${pr.number} ready for review` }, () => gh.prReady(repo, slug, pr.number));
          ready = r.ran;
        }
        const title = stripPrefix(pr.title);
        if (title !== pr.title) await this.d.external.attempt("pr_title_edit", { scope, target: pr.url, summary: `drop the stack prefix`, payload: title }, () => gh.prEditTitle(repo, slug, pr.number, title));
        const label = this.policyOf(stack).draftLabel;
        if (pr.labels.includes(label)) await this.d.external.attempt("pr_label", { scope, target: pr.url, summary: `remove ${label}` }, () => gh.prLabel(repo, slug, pr.number, label, false));
        const newBody = withoutDependsLine(body);
        const b = await this.d.external.attempt("pr_description_edit", { scope, target: pr.url, summary: `bottom-of-stack description`, payload: newBody }, () => gh.prEditBody(repo, slug, pr.number, newBody));
        if (b.ran) brief?.posted(pr.url);
        if (ready) {
          this.d.repo.updateLayer(layer.id, { state: "ready", mode: "branch", draftSince: null });
          this.d.record?.("stack.pr_open", { kind: "ready" });
        }
        return;
      }
      if (!remote) {
        const r = await this.d.external.attempt("branch_push", { scope, target: layer.branch, summary: `push ${layer.branch} before opening its PR` }, () =>
          pushBranch(repo, stack.remote, layer.branch, null));
        if (!r.ran) return;
      }
      const title = owned?.ticketTitle ? `${owned.ticketKey} ${owned.ticketTitle}` : (commits[0] ?? layer.branch);
      const r = await this.d.external.attempt("pr_open", { scope, target: layer.branch, summary: `open the bottom-of-stack PR for ${layer.branch}`, payload: title }, () =>
        gh.prCreate(repo, slug, { base: stack.trunk, head: layer.branch, title, body, draft: false, labels: [] }));
      if (!r.ran) return;
      brief?.posted(r.value.url);
      this.d.repo.updateLayer(layer.id, { state: "ready", mode: "branch", prNumber: r.value.number, prUrl: r.value.url, draftSince: null });
      this.d.record?.("stack.pr_open", { kind: "create" });
    } catch (e) {
      this.d.log(`stacks: promoting ${layer.branch} failed`, e);
    }
  }

  /** Shipherd 开的 draft 层的 k/n 和「依赖 #N」按现在的顺序改（只在变了时改）。 */
  async syncDrafts(stack: StackRow): Promise<void> {
    const all = this.d.repo.layers(stack.id);
    for (let i = 0; i < all.length; i++) {
      const l = all[i]!;
      if (l.state !== "draft" || !l.prNumber) continue;
      // 只改 Shipherd 自己开的 draft（BTL-278）：用户自己开的 draft PR 的标题、正文不动
      if (stack.source !== "detected" && l.mode !== "draft") continue;
      const parent = all[i - 1];
      if (!parent) continue;
      const pr = await gh.prView(stack.repoPath, stack.repoSlug, l.prNumber);
      if (!pr || pr.state !== "OPEN") continue;
      const scope = { repoSlug: stack.repoSlug, ticketKey: l.ticketKey };
      const title = draftTitle(i + 1, all.length, pr.title);
      try {
        if (title !== pr.title) await this.d.external.attempt("pr_title_edit", { scope, target: pr.url, summary: `stack position ${i + 1}/${all.length}`, payload: title }, () => gh.prEditTitle(stack.repoPath, stack.repoSlug, pr.number, title));
        const body = withDependsLine(pr.body, dependsLine(parent));
        if (body !== pr.body) await this.d.external.attempt("pr_description_edit", { scope, target: pr.url, summary: `depends line`, payload: body.split("\n")[0] }, () => gh.prEditBody(stack.repoPath, stack.repoSlug, pr.number, body));
      } catch (e) {
        this.d.log(`stacks: syncing draft #${l.prNumber} failed`, e);
      }
    }
  }

  // ---------------------------------------------------------------- draft 层

  async setLayerMode(layerId: number, mode: StackLayerMode): Promise<StackActionResult> {
    const t = T().errors;
    const layer = this.d.repo.layer(layerId);
    if (!layer) return { ok: false, message: t.layerNotFound };
    const stack = this.d.repo.get(layer.stackId);
    if (!stack || stack.removedAt) return { ok: false, message: t.notFound };
    if (layer.state === "merged") return { ok: false, message: t.merged };
    const all = this.d.repo.layers(stack.id);
    const idx = all.findIndex((l) => l.id === layer.id);
    const scope = { repoSlug: stack.repoSlug, ticketKey: layer.ticketKey };
    const repo = stack.repoPath;
    const slug = stack.repoSlug;
    try {
      if (mode === "branch") {
        // 已经可以 review 的 PR（包括栈底）不能悄悄丢掉 PR 号：不然 promoteBottom 每轮都去 gh pr create
        if (layer.prNumber && layer.state === "ready") return { ok: false, message: t.readyPr };
        if (layer.prNumber && layer.state === "draft") {
          const n = layer.prNumber;
          const r = await this.d.external.attempt("pr_open", { scope, target: layer.prUrl, summary: `close draft #${n} (back to a plain branch)` }, () => gh.prClose(repo, slug, n, T().demoteComment));
          if (!r.ran) return { ok: false, message: t.switchOff("pr_open") };
          if (layer.prUrl) this.d.closedByShipherd?.(layer.prUrl);
        }
        this.d.repo.updateLayer(layer.id, { mode: "branch", state: "branch_only", prNumber: null, prUrl: null, draftSince: null });
        this.changed();
        return { ok: true };
      }
      const firstOpen = all.find((l) => l.state !== "merged");
      if (firstOpen?.id === layer.id) return { ok: false, message: t.isBottom };
      if (layer.prNumber) return { ok: true };
      const parent = all[idx - 1]!;
      for (const b of [parent, layer]) {
        if (b.state === "merged") continue;
        if (!(await remoteTip(repo, stack.remote, b.branch))) {
          const r = await this.d.external.attempt("branch_push", { scope: { repoSlug: slug, ticketKey: b.ticketKey }, target: b.branch, summary: `push ${b.branch} before opening a draft` }, () =>
            pushBranch(repo, stack.remote, b.branch, null));
          if (!r.ran) return { ok: false, message: t.switchOff("branch_push") };
        }
      }
      const label = this.policyOf(stack).draftLabel;
      const lr = await this.d.external.attempt("pr_label", { scope, target: label, summary: `create label ${label}` }, () => gh.ensureLabel(repo, slug, label, T().labelDescription));
      const owned = this.d.owned(repo, layer.branch);
      const tip = await revParse(repo, `refs/heads/${layer.branch}`);
      const base0 = parent.state === "merged" ? stack.trunk : parent.branch;
      const commits = tip ? await subjects(repo, layer.baseSha ?? parent.tipSha, tip).catch(() => []) : [];
      const plain = owned?.ticketTitle ? `${owned.ticketKey} ${owned.ticketTitle}` : (commits[0] ?? layer.branch);
      const title = draftTitle(idx + 1, all.length, plain);
      const body = draftBody(parent, await this.graph(stack, all), idx);
      const r = await this.d.external.attempt("pr_open", { scope, target: layer.branch, summary: `open draft for ${layer.branch}`, payload: title }, () =>
        gh.prCreate(repo, slug, { base: base0, head: layer.branch, title, body, draft: true, labels: lr.ran ? [label] : [] }));
      if (!r.ran) return { ok: false, message: t.switchOff("pr_open") };
      this.d.repo.updateLayer(layer.id, { mode: "draft", state: "draft", prNumber: r.value.number, prUrl: r.value.url, draftSince: this.d.now() });
      this.d.record?.("stack.pr_open", { kind: "draft" });
      this.changed();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  // ---------------------------------------------------------------- 恢复备份

  async restore(stackId: number): Promise<StackActionResult> {
    const t = T().errors;
    const stack = this.d.repo.get(stackId);
    if (!stack || stack.removedAt) return { ok: false, message: t.notFound };
    if (this.running.has(stackId)) return { ok: false, message: t.busy };
    const from = this.d.repo.lastRestorable(stackId);
    if (!from) return { ok: false, message: t.nothingToRestore };
    this.running.add(stackId);
    try {
      const repo = stack.repoPath;
      await this.fetch(repo, stack.remote, true);
      const checkouts = await worktreeBranches(repo);
      const layers: ApplyLayer[] = [];
      const rows = this.d.repo.layers(stackId);
      for (const l of from.detail.layers ?? []) {
        if (!l.backupRef) continue;
        const backup = await revParse(repo, l.backupRef);
        const cur = await revParse(repo, `refs/heads/${l.branch}`);
        if (!backup || cur !== l.newTip) return { ok: false, message: t.restoreMoved(l.branch) };
        const path = checkouts.get(l.branch) ?? null;
        layers.push({
          position: l.position, branch: l.branch, oldTip: cur, newTip: backup, checkout: path ? { path, managed: this.isManaged(repo, l.branch, path) } : null,
          remoteTip: await remoteTip(repo, stack.remote, l.branch), remoteOkSha: rows.find((r) => r.branch === l.branch)?.remoteOkSha ?? null,
        });
      }
      const runId = this.d.repo.startRun(stackId, "restore", null);
      const res = await applyTips({
        repo, stackId, runId, layers, backup: false, sessionBusy: (p) => this.d.sessionBusy(p),
        push: (l) => this.forcePush(stack, l, rows.find((r) => r.branch === l.branch)!), log: (m) => this.d.log(m),
      });
      if (res.kind === "deferred") {
        this.d.repo.finishRun(runId, { outcome: "deferred", reason: deferText(res.reason) });
        return { ok: false, message: deferText(res.reason) };
      }
      if (res.kind === "rolled_back") {
        this.d.repo.finishRun(runId, { outcome: "rolled_back", reason: res.reason });
        return { ok: false, message: res.reason };
      }
      for (const l of layers) {
        const row = rows.find((r) => r.branch === l.branch);
        if (row) this.d.repo.updateLayer(row.id, { tipSha: l.newTip, baseSha: null, remoteOkSha: res.pushed.includes(l.branch) ? null : (row.remoteOkSha ?? l.remoteTip) });
        // 改回去了：还排着的「改写后核对」说的是被撤销的那次改写，撤掉
        if (row?.ticketKey) this.d.withdraw?.({ ticketKey: row.ticketKey, branch: row.branch }, "verify");
      }
      this.d.repo.finishRun(runId, { outcome: "restored", detail: { layers: res.layers, pushed: res.pushed, unpushed: res.unpushed, restoredFrom: from.id } });
      return { ok: true };
    } finally {
      this.release(stackId);
      this.changed();
    }
  }

  // ---------------------------------------------------------------- 触发

  /** 每分钟（index.ts 的 TICK）。 */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.d.now();
      const stacks = this.d.repo.list();
      const repos = new Map<string, StackRow[]>();
      for (const s of stacks) repos.set(s.repoPath, [...(repos.get(s.repoPath) ?? []), s]);
      const epicRepos = new Set(this.epicAutoRebaseRepos());
      if (now - this.lastDetect >= DETECT_EVERY_MS && this.d.repos && (this.d.policy.anyAutoRebase() || epicRepos.size > 0)) {
        this.lastDetect = now;
        // 自动检测只在开了 autoRebase 的仓库（或有「半自动」epic 的 ticket 的仓库）里做（gh 调用不白跑）
        for (const r of this.d.repos()) {
          if (!existsSync(r)) continue;
          if (!epicRepos.has(r)) {
            const slug = await this.d.slugOf(r).catch(() => null);
            if (!this.d.policy.forSlug(slug).autoRebase) continue;
          }
          await this.detect(r).catch((e) => this.d.log(`stacks: detect in ${r}`, e));
        }
      }
      for (const [repoPath, list] of repos) {
        if (!existsSync(repoPath)) continue;
        await this.cleanLegacyRerere(repoPath);
        const fetched = await this.fetch(repoPath, list[0]!.remote, false);
        for (const s0 of list) {
          const s = this.d.repo.get(s0.id)!;
          const p = this.policyOf(s);
          // 各层和 trunk 的顶端一次读（BTL-275），updateBehind、dueTrigger 共用；它们之间不动 ref。
          const tipOf = await this.tipsOf(s).catch((e) => (this.d.log(`stacks: tips for stack ${s.id}`, e), undefined));
          await this.updateBehind(s, tipOf).catch((e) => this.d.log(`stacks: behind for stack ${s.id}`, e));
          if (!p.autoRebase) continue;
          const trigger = await this.dueTrigger(s, p, fetched, tipOf);
          if (trigger) {
            if (trigger === "daily") this.d.repo.updateStack(s.id, { lastDailyAt: now });
            await this.run(s, trigger);
          } else if (p.autosquash) {
            await this.maybeAutosquash(s);
          }
          await this.retryPending(this.d.repo.get(s.id)!, p);
        }
      }
      // 界面看得到的栈状态（栈、层、最近的 run、落后多少、提醒）真变了才发；run 等自己改了东西的地方照旧当场发。
      const seen = this.visibleState();
      if (seen !== this.lastSeen) {
        this.lastSeen = seen;
        this.changed();
      }
    } finally {
      this.ticking = false;
    }
  }

  /** session 停下来：看它的 ticket 所在的栈有没有新提交。 */
  async sessionStopped(ticketKey: string): Promise<void> {
    for (const s of this.d.repo.list()) {
      const layers = this.d.repo.layers(s.id);
      if (!layers.some((l) => l.ticketKey === ticketKey && l.state !== "merged")) continue;
      const p = this.policyOf(s);
      if (!p.autoRebase) continue;
      // 上次没递进去的冲突（session 当时在忙）趁现在递。
      const lr = this.d.repo.lastRun(s.id);
      const c = lr?.outcome === "conflict" ? lr.detail.conflict : undefined;
      if (lr && c && !lr.detail.delivered && p.conflictToSession && layers.some((l) => l.branch === c.branch && l.ticketKey === ticketKey)) {
        await this.deliverConflict(s, lr.id);
        // 交出去以后输入只算冲突层下面的：重记一次，免得下一个 tick 以为输入变了又跑一遍
        if (this.d.repo.run(lr.id)?.detail.delivered) this.patchRun(lr.id, { inputs: await this.inputsOf(s) });
        continue;
      }
      if ((await this.dueTrigger(s, p, false)) === "layer_commits") await this.run(s, "layer_commits");
    }
  }

  /** 一个 ref 现在指向的提交。tick 里传一次读好的（tipsOf），别处默认现查。 */
  private async dueTrigger(s: StackRow, p: StackPolicy, fetched: boolean, tipOf: TipOf = (ref) => revParse(s.repoPath, ref)): Promise<StackTrigger | null> {
    const open = this.d.repo.layers(s.id).filter((l) => l.state !== "merged");
    if (open.length === 0) return null;
    const lr = this.d.repo.lastRun(s.id);
    // 上次读不到 PR：退避着再读（同一条推迟会合并成一行，repeats 是连着读不到的次数）
    if (lr?.outcome === "deferred" && lr.reason === PRS_UNREADABLE) {
      const wait = Math.min(PRS_RETRY_MAX_MS, PRS_RETRY_MS * 2 ** Math.max(0, (lr.detail.repeats ?? 1) - 1));
      if (this.d.now() - (lr.finishedAt ?? lr.startedAt) < wait) return null;
    }
    // 上一次没落地（冲突、失败、要确认、回滚）、输入没变：再跑也是一样的结果，不跑（BTL-278）。trunk 或下面的层真动了才重试。
    // 等确认的那几层已经不用确认了（PR 转回 draft、冲突交回来了）：放行，按现在的状态重跑。
    const stale = (lr?.outcome === "needs_confirm" && confirmPending(lr, open).length === 0)
      // 失败（git 超时、worktree 建不起来）不一定是定论：过一阵再试
      || (lr?.outcome === "failed" && this.d.now() - (lr.finishedAt ?? lr.startedAt) >= this.failedRetryMs(s.id, lr));
    if (lr && !stale && !isSettledOutcome(lr.outcome) && lr.detail.inputs !== undefined && lr.detail.inputs === (await this.inputsOf(s, tipOf))) return null;
    // 冲突在 session 手里的层和它上面的层：session 自己动分支不算「有新提交」
    const held = await this.handedOff(s, open, tipOf);
    for (const l of open) {
      if (held && l.position >= held.position) continue;
      const tip = await tipOf(`refs/heads/${l.branch}`);
      if (tip && tip !== l.tipSha) return "layer_commits";
    }
    if (p.rebaseOnMainUpdate && (fetched || s.trunkSha === null)) {
      const trunk = await tipOf(`refs/remotes/${s.remote}/${s.trunk}`);
      if (trunk && trunk !== s.trunkSha) return "main_updated";
    }
    // 栈底合并的那次 run 推迟过或失败过：重新跑（回滚的不自动重来，等人看）
    if (lr?.trigger === "bottom_merged" && (lr.outcome === "deferred" || lr.outcome === "failed")) return "bottom_merged";
    if (p.dailyRebase && (s.lastDailyAt === null || dayOf(s.lastDailyAt) !== dayOf(this.d.now()))) return "daily";
    return null;
  }

  /** 上一次失败后要等多久再试：同样的输入、同样的原因连着失败了 n 次，等 FAILED_RETRY_MS·2^(n-1)，最多一天。 */
  private failedRetryMs(stackId: number, lr: RunRow): number {
    // 原因里带着这次 run 的编号（临时目录、临时 ref、锁的说明）：去掉再比，不然每次都像新原因
    const why = (r: RunRow): string | null => (r.reason == null ? null : reasonKey(r.reason, this.d.workRoot));
    let streak = 0;
    for (const r of this.d.repo.runs(stackId, 8)) {
      if (r.outcome !== "failed" || why(r) !== why(lr) || r.detail.inputs !== lr.detail.inputs) break;
      streak++;
    }
    return Math.min(FAILED_RETRY_MAX_MS, FAILED_RETRY_MS * 2 ** Math.max(0, streak - 1));
  }

  /** 第 5.3 节：栈是新的、某层有 fixup 提交、I 不在核对：autosquash。 */
  private async maybeAutosquash(s: StackRow): Promise<void> {
    const open = this.d.repo.layers(s.id).filter((l) => l.state !== "merged");
    const lr = this.d.repo.lastRun(s.id);
    if (lr && !isSettledOutcome(lr.outcome)) return;
    let any = false;
    for (const l of open) {
      if (!l.tipSha || !l.baseSha) continue;
      if (l.prUrl && this.d.awaitingCheck?.(l.prUrl)) return;
      if (await this.hasFixupsCached(s.repoPath, l.baseSha, l.tipSha)) any = true;
    }
    if (!any) return;
    // 同样的顶端试过一次（比如 fixup 的目标不在这一段里，结果是 noop）就不再每分钟重试
    const key = open.map((l) => l.tipSha).join(",");
    if (this.autosquashTried.get(s.id) === key) return;
    this.autosquashTried.set(s.id, key);
    await this.run(s, "autosquash", { autosquash: true });
  }

  /** 上一次因为开关关着没做完的提升 / 总览：开关打开后补做（关着时不试，免得审计里每分钟一笔 skipped）。 */
  private async retryPending(s: StackRow, p: StackPolicy): Promise<void> {
    // 这个栈正在跑（手动 rebase 停在读 PR、等锁上）：它会自己推，这里补推会和它抢（BTL-278）
    if (this.running.has(s.id)) return;
    const scope = { repoSlug: s.repoSlug };
    const lr = this.d.repo.lastRun(s.id);
    const settled = !lr || isSettledOutcome(lr.outcome);
    // 开关按层的 ticket 判断：epic 自己选了档位时（BTL-247），那一层的推送、开 PR 按它的档位。
    if (settled) await this.pushPending(s);
    const bottom = settled && p.autoOpenBottomPr ? this.needsPromotion(s) : null;
    if (bottom && this.d.external.allowed("pr_open", { ...scope, ticketKey: bottom.ticketKey })) await this.promoteBottom(s);
    if (p.overview === "issue" && this.d.external.allowed("issue_post", scope)) await this.syncOverview(s);
  }

  /**
   * 改写过、但当时 force_push 关着没推出去的层（remoteOkSha 有值）：开关打开后补推。
   * 只在远端还停在 Shipherd 替换掉的那个提交、本地还是 Shipherd 记下的顶端时推；别的情况留给下一次 run。
   * 补推也是强推（BTL-278）：真要推之前先读一次 PR，正在 review 的层、冲突交给了 session 的层不推，等用户点「马上 rebase」
   * （confirmed = 用户刚确认过）。
   */
  private async pushPending(s: StackRow, confirmed = false): Promise<void> {
    const due: { l: LayerRow; local: string; remote: string | null }[] = [];
    for (const l of this.d.repo.layers(s.id)) {
      if (l.state === "merged" || l.remoteOkSha === null) continue;
      if (!confirmed && (l.state === "ready" || l.conflictKey)) continue;
      if (!this.d.external.allowed("force_push", { repoSlug: s.repoSlug, ticketKey: l.ticketKey })) continue;
      const local = await revParse(s.repoPath, `refs/heads/${l.branch}`);
      const remote = await remoteTip(s.repoPath, s.remote, l.branch);
      if (remote === local) {
        this.d.repo.updateLayer(l.id, { remoteOkSha: null });
        continue;
      }
      if (!local || local !== l.tipSha || remote !== l.remoteOkSha) continue;
      due.push({ l, local, remote });
    }
    if (due.length === 0) return;
    if (!confirmed && !(await this.readPrs(s))) return;
    for (const { l: l0, local, remote } of due) {
      const l = this.d.repo.layer(l0.id) ?? l0;
      if (!confirmed && (l.state === "ready" || l.conflictKey)) continue;
      // 推之前再查一次冲突标记（BTL-278：旧版套用 rerere 留下的、还没推出去的顶端）：多出标记、或者查不了，都不推
      if (!(await this.cleanOfMarkers(s, l, local, remote))) continue;
      const ok = await this.forcePush(s, { position: l.position, branch: l.branch, oldTip: local, newTip: local, checkout: null, remoteTip: remote, remoteOkSha: l.remoteOkSha }, l).catch((e) => {
        this.d.log(`stacks: pushing ${l.branch} failed`, e);
        return false;
      });
      if (ok) this.d.repo.updateLayer(l.id, { remoteOkSha: null });
    }
  }

  /** 补推的顶端比远端那份多出冲突标记了吗：远端那份是旧顶端，层这段提交带进来的标记不算。git 出错按「不干净」算。 */
  private async cleanOfMarkers(s: StackRow, l: LayerRow, local: string, remote: string | null): Promise<boolean> {
    try {
      if (!l.baseSha || !remote) throw new Error("no base");
      const oldBase = await mergeBase(s.repoPath, remote, l.baseSha);
      if (!oldBase) throw new Error(`no merge base of ${remote} and ${l.baseSha}`);
      const bad = await markersAdded(s.repoPath, [{ branch: l.branch, oldTip: remote, oldBase, newBase: l.baseSha, newTip: local }]);
      if (bad.length === 0) return true;
      this.d.log(`stacks: not pushing ${l.branch}: conflict markers in ${bad[0]!.files.join(", ")}`);
    } catch (e) {
      this.d.log(`stacks: not pushing ${l.branch}: checking for conflict markers failed`, e);
    }
    return false;
  }

  /**
   * 旧版（BTL-278 之前）给栈所在的仓库打开过 rerere：没有任何一层配过 rerere.enabled 时写了 local 层的 rerere.enabled=true
   * （autoUpdate 只在引擎的命令行上带，没写进配置）。session 照冲突提示 rebase 时 git 会按它套用 rr-cache 里放弃过的解法。
   * 每个仓库只看一次（记在 workRoot 的 rerere-cleaned.json 里）：local 层正好是 Shipherd 写的样子（"true"、没有 local 的
   * autoUpdate、global 和 system 都没配）就删掉这一项，rr-cache 改名留作备份（不删，git 不再用它）。用户自己配的不动。
   */
  private async cleanLegacyRerere(repoPath: string): Promise<void> {
    const key = resolve(repoPath);
    if (this.rerereChecked.has(key)) return;
    this.rerereChecked.add(key);
    const file = join(this.d.workRoot, "rerere-cleaned.json");
    let done: string[] = [];
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(j)) done = j.filter((x): x is string => typeof x === "string");
    } catch {
      // 还没有
    }
    if (done.includes(key)) return;
    const get = (args: string[]) => runGit(key, ["config", ...args]).catch(() => ({ code: -1, stdout: "", stderr: "" }));
    const local = await get(["--local", "--get", "rerere.enabled"]);
    // git 出错：这次不算看过，下次再看
    if (local.code !== 0 && local.code !== 1) return void this.rerereChecked.delete(key);
    let cleaned = false;
    if (local.code === 0 && local.stdout.trim() === "true") {
      const others = [await get(["--local", "--get", "rerere.autoUpdate"]), await get(["--global", "--get", "rerere.enabled"]), await get(["--system", "--get", "rerere.enabled"])];
      if (others.some((r) => r.code !== 0 && r.code !== 1)) return void this.rerereChecked.delete(key);
      if (others.every((r) => r.code === 1)) {
        const u = await get(["--local", "--unset", "rerere.enabled"]);
        if (u.code !== 0) return void this.rerereChecked.delete(key);
        const common = await runGit(key, ["rev-parse", "--git-common-dir"]).catch(() => null);
        const rr = common?.code === 0 ? resolve(key, common.stdout.trim(), "rr-cache") : null;
        try {
          if (rr && existsSync(rr)) renameSync(rr, `${rr}.shipherd-off-${this.d.now()}`);
        } catch (e) {
          this.d.log(`stacks: moving ${rr} aside failed`, e);
        }
        cleaned = true;
        this.d.log(`stacks: turned off the rerere an older Shipherd enabled in ${key}`);
      }
    }
    try {
      mkdirSync(this.d.workRoot, { recursive: true });
      writeFileSync(file, JSON.stringify([...done, key]));
    } catch (e) {
      this.d.log(`stacks: recording the rerere cleanup failed`, e);
    }
    this.d.record?.("stack.rerere_cleanup", { cleaned });
  }

  /** 第 3.6 节：每个仓库每 5 分钟 fetch 一次（force = 现在就要）；同一个仓库串行。返回这次真的 fetch 了。 */
  private async fetch(repoPath: string, remote: string, force: boolean): Promise<boolean> {
    const now = this.d.now();
    if (!force && now - (this.lastFetch.get(repoPath) ?? 0) < FETCH_EVERY_MS) return false;
    const prev = this.fetching.get(repoPath);
    if (prev) {
      await prev;
      if (!force) return false;
    }
    const p = (async () => {
      this.lastFetch.set(repoPath, now);
      // 仓库锁（BTL-264）：fetch --prune 会和建 ticket 时 fetch 新分支起点抢 refs/remotes/<remote>/<默认分支>（cannot lock ref）。
      const r = await withRepoLock(repoPath, () => fetchRemote(repoPath, remote), `fetch ${remote} for stacks`).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
      if (r.code !== 0) this.d.log(`stacks: fetch ${remote} in ${repoPath} failed: ${r.stderr.trim()}`);
    })();
    this.fetching.set(repoPath, p);
    try {
      await p;
    } finally {
      this.fetching.delete(repoPath);
    }
    return true;
  }

  private async updateBehind(s: StackRow, tipOf: TipOf = (ref) => revParse(s.repoPath, ref)): Promise<void> {
    const bottom = this.d.repo.layers(s.id).find((l) => l.state !== "merged");
    const trunk = await tipOf(`refs/remotes/${s.remote}/${s.trunk}`);
    const tip = bottom ? await tipOf(`refs/heads/${bottom.branch}`) : null;
    if (!bottom || !trunk || !tip) {
      this.behindCache.delete(s.id);
      this.behindOf.delete(s.id);
      return;
    }
    const key = `${tip}..${trunk}`;
    if (this.behindOf.get(s.id) === key && this.behindCache.has(s.id)) return;
    this.behindOf.delete(s.id);
    this.behindCache.set(s.id, await behind(s.repoPath, tip, trunk));
    this.behindOf.set(s.id, key);
  }

  /** 栈里没合并的各层和 trunk 的顶端，一个 git 读完（BTL-275）。 */
  private async tipsOf(s: StackRow): Promise<TipOf> {
    const refs = [
      ...this.d.repo.layers(s.id).filter((l) => l.state !== "merged").map((l) => `refs/heads/${l.branch}`),
      `refs/remotes/${s.remote}/${s.trunk}`,
    ];
    const tips = await refTips(s.repoPath, refs);
    return async (ref) => (refs.includes(ref) ? (tips.get(ref) ?? null) : revParse(s.repoPath, ref));
  }

  private async hasFixupsCached(repoPath: string, base: string, tip: string): Promise<boolean> {
    const key = `${repoPath}\0${base}..${tip}`;
    const hit = this.fixupsOf.get(key);
    if (hit !== undefined) return hit;
    let v: boolean;
    try {
      v = await hasFixups(repoPath, base, tip);
    } catch {
      return false; // 出错不记，下次再试
    }
    if (this.fixupsOf.size >= 1000) this.fixupsOf.clear();
    this.fixupsOf.set(key, v);
    return v;
  }

  /** 界面（view、notices）从栈服务读到的全部状态，序列化成一串，用来判断这次 tick 有没有让它变。 */
  private visibleState(): string {
    return JSON.stringify([
      this.d.repo.list().map((s) => [s, this.d.repo.layers(s.id), this.d.repo.lastRun(s.id), this.d.repo.lastRestorable(s.id), this.behindCache.get(s.id) ?? null]),
      this.notices(),
    ]);
  }

  /** checkSchedule 每次调：今天已经跑过就什么都不做。 */
  async dailyJob(): Promise<boolean> {
    if (!this.d.jobs) return false;
    const now = this.d.now();
    const { lastRunAt, lastStatus } = this.d.jobs.get(JOB_STACKS_DAILY);
    if (lastRunAt !== null && lastStatus === "ok" && dayOf(lastRunAt) === dayOf(now)) return false;
    // 失败了 30 分钟后再试。
    if (lastRunAt !== null && lastStatus === "failed" && now - lastRunAt < DAILY_RETRY_MS) return false;
    try {
      await this.daily();
      this.d.jobs.record(JOB_STACKS_DAILY, now, "ok", null);
    } catch (e) {
      this.d.log("stacks: daily job failed", e);
      this.d.jobs.record(JOB_STACKS_DAILY, now, "failed", e instanceof Error ? e.message : String(e));
    }
    return true;
  }

  /** 每日任务：删 30 天前的备份引用，清掉残留的临时 worktree。 */
  async daily(): Promise<void> {
    for (const b of this.d.repo.backupsBefore(this.d.now() - BACKUP_KEEP_MS)) {
      const s = this.d.repo.get(b.stackId);
      if (s && existsSync(s.repoPath)) await deleteBackups(s.repoPath, b.refs).catch((e) => this.d.log(`stacks: deleting backups of run ${b.runId}`, e));
      this.d.repo.clearBackups(b.runId);
    }
    this.cleanupWork();
  }

  /** 启动时和每天：上次没清掉的临时目录（Shipherd 中途退出）。 */
  cleanupWork(): void {
    if (!existsSync(this.d.workRoot)) return;
    // tick 正要开始一次 run 时也不清（running 还没记上）
    if (this.running.size > 0 || this.ticking) return;
    for (const name of readdirSync(this.d.workRoot)) {
      try {
        rmSync(resolve(this.d.workRoot, name), { recursive: true, force: true });
      } catch {
        // 下次再清
      }
    }
    const repos = new Set(this.d.repo.list().map((s) => s.repoPath));
    for (const r of repos) {
      if (existsSync(r)) {
        // 仓库锁（BTL-264）：只锁这几条改 worktree 登记和 refs 的 git 命令。
        void withRepoLock(r, async () => {
          await runGit(r, ["worktree", "prune"]).catch(() => undefined);
          // refs/heads/butler-stack/：改名前（BTL-260）的临时分支前缀，留下的也一起清掉（TODO(5.0) 删）。
          const o = await runGit(r, ["for-each-ref", "--format=%(refname)", "refs/heads/shipherd-stack/", "refs/heads/butler-stack/"]);
          for (const ref of o.stdout.split(/\r?\n/).filter(Boolean)) await runGit(r, ["update-ref", "-d", ref]);
        }, "clean up leftover stack worktrees and branches").catch(() => undefined);
      }
    }
  }

  // ---------------------------------------------------------------- 总览 issue

  async syncOverview(s: StackRow): Promise<void> {
    if (this.policyOf(s).overview !== "issue") return;
    const all = this.d.repo.layers(s.id);
    const body = overviewBody(await this.graph(s, all));
    const hash = simpleHash(body);
    if (hash === s.overviewHash) return;
    const title = T().overviewTitle(s.name);
    const scope = { repoSlug: s.repoSlug };
    try {
      if (s.overviewNumber) {
        const n = s.overviewNumber;
        const r = await this.d.external.attempt("issue_post", { scope, target: s.overviewUrl, summary: `update stack overview`, payload: body }, () => gh.issueEdit(s.repoPath, s.repoSlug, n, title, body));
        if (r.ran) this.d.repo.updateStack(s.id, { overviewHash: hash });
      } else {
        const r = await this.d.external.attempt("issue_post", { scope, target: s.name, summary: `open stack overview`, payload: title }, () => gh.issueCreate(s.repoPath, s.repoSlug, title, body));
        if (r.ran) this.d.repo.updateStack(s.id, { overviewNumber: r.value.number, overviewUrl: r.value.url, overviewHash: hash });
      }
    } catch (e) {
      this.d.log(`stacks: overview for stack ${s.id} failed`, e);
    }
  }

  // ---------------------------------------------------------------- 给别人用的

  /** 工作流 I 的 stackNote：这个 PR 是栈的一层时，评论递送后面补的那段话。 */
  stackNote(prUrl: string, branch: string | null): string | null {
    const hits = branch ? this.d.repo.findBranchAnyRepo(branch) : [];
    const hit = hits.find((h) => h.layer.prUrl === prUrl) ?? hits[0] ?? this.findByPrUrl(prUrl);
    if (!hit) return null;
    const open = this.d.repo.layers(hit.stack.id).filter((l) => l.state !== "merged");
    const idx = open.findIndex((l) => l.id === hit.layer.id);
    if (idx === -1 || open.length < 2) return null;
    return T().note({ k: idx + 1, n: open.length, above: open.slice(idx + 1).map((l) => l.branch) });
  }

  /**
   * 「谁该动」看板（UI 重做第 1 层）：这个 PR 是没删的栈里的一层、下面还有没合的层时，最近那层的分支；
   * 栈底、下面都合了、不在栈里为 null。按分支找：先取 PR 链接对得上的层；只按分支名兜底时，这一层得还没记 PR、
   * 而且栈的仓库和 PR 的仓库一致（多仓库 ticket 在每个仓库起的分支同名，别的仓库里同名分支不在这个栈里）。
   */
  stackBelow(prUrl: string, branch: string | null): string | null {
    const key = prUrlKey(prUrl);
    const slug = prUrlParts(prUrl)?.slug ?? null;
    const hits = branch ? this.d.repo.findBranchAnyRepo(branch) : [];
    const loose = hits.filter((h) => h.layer.prUrl === null && (h.stack.repoSlug === null || (slug !== null && h.stack.repoSlug.toLowerCase() === slug)));
    const hit = hits.find((h) => h.layer.prUrl !== null && prUrlKey(h.layer.prUrl) === key) ?? (loose.length === 1 ? loose[0] : undefined);
    if (!hit) return null;
    const below = this.d.repo.layers(hit.stack.id).filter((l) => l.position < hit.layer.position && l.state !== "merged");
    return below.length === 0 ? null : below[below.length - 1]!.branch;
  }

  private findByPrUrl(url: string): { stack: StackRow; layer: LayerRow } | null {
    for (const s of this.d.repo.list()) {
      const l = this.d.repo.layers(s.id).find((x) => x.prUrl === url);
      if (l) return { stack: s, layer: l };
    }
    return null;
  }

  /** 「现在」页的提醒（第 5.2 节）。 */
  notices(): StackNoticeInfo[] {
    const now = this.d.now();
    const out: StackNoticeInfo[] = [];
    for (const s of this.d.repo.list()) {
      const p = this.policyOf(s);
      const layers = this.d.repo.layers(s.id);
      const open = layers.filter((l) => l.state !== "merged");
      if (open.length === 0) continue;
      const lr = this.d.repo.lastRun(s.id);
      if (lr?.outcome === "conflict" && lr.detail.conflict) {
        const delivered = lr.detail.delivered === true;
        if (!p.conflictToSession || (!delivered && now - lr.startedAt >= CONFLICT_NOTICE_AFTER_MS)) {
          const l = layers.find((x) => x.branch === lr.detail.conflict!.branch);
          out.push({ reason: "conflict", stackId: s.id, stackName: s.name, branch: lr.detail.conflict.branch, files: lr.detail.conflict.files, ticketKey: l?.ticketKey ?? null, prNumber: l?.prNumber ?? null });
        }
      }
      // 等确认：确认了（有了新的 run）或者那几层不用确认了（层状态变了）就不再提醒
      const pending = lr?.outcome === "needs_confirm" ? confirmPending(lr, open) : [];
      if (lr?.detail.confirm && pending.length > 0) {
        const l = layers.find((x) => x.branch === pending[0]);
        out.push({ reason: "confirm", stackId: s.id, stackName: s.name, branch: pending[0]!, branches: pending, detail: lr.detail.confirm.why, ticketKey: l?.ticketKey ?? null, prNumber: l?.prNumber ?? null });
      }
      // 刚自动改写过、还停在 Shipherd 写的顶端的层（之后有人提交了就说明有人接手了）：提醒没编译过（BTL-278）
      if (lr?.outcome === "rebased" && lr.trigger !== "manual" && now - (lr.finishedAt ?? lr.startedAt) < REWRITTEN_NOTICE_MS) {
        const rewritten = (lr.detail.layers ?? [])
          .filter((d) => d.newTip !== d.oldTip && open.some((l) => l.branch === d.branch && l.tipSha === d.newTip))
          .map((d) => d.branch);
        if (rewritten.length > 0) {
          const l = layers.find((x) => x.branch === rewritten[0]);
          out.push({ reason: "rewritten", stackId: s.id, stackName: s.name, branch: rewritten[0]!, branches: rewritten, ticketKey: l?.ticketKey ?? null, prNumber: l?.prNumber ?? null });
        }
      }
      if (lr && (lr.outcome === "deferred" || lr.outcome === "failed" || lr.outcome === "rolled_back") && now - lr.startedAt >= STUCK_AFTER_MS) {
        out.push({ reason: "stuck", stackId: s.id, stackName: s.name, branch: open[0]!.branch, detail: lr.reason, ticketKey: open[0]!.ticketKey });
      }
      for (const l of open) {
        if (l.state === "draft" && l.draftSince && now - l.draftSince >= p.draftDemoteDays * DAY_MS) {
          out.push({ reason: "draft_stale", stackId: s.id, stackName: s.name, branch: l.branch, days: Math.floor((now - l.draftSince) / DAY_MS), prNumber: l.prNumber, ticketKey: l.ticketKey });
        }
      }
      const b = this.behindCache.get(s.id);
      if (b && b.commits > 0) {
        const days = b.oldestAt ? Math.floor((now - b.oldestAt) / DAY_MS) : 0;
        if (b.commits > p.behindCommits || days >= p.behindDays) {
          out.push({ reason: "behind", stackId: s.id, stackName: s.name, branch: open[0]!.branch, commits: b.commits, days, ticketKey: open[0]!.ticketKey });
        }
      }
    }
    return out;
  }

  /** 全部工作页「更多」里的「栈」区块。 */
  async view(filter: StacksFilter): Promise<StacksView> {
    const stacks: StackView[] = [];
    for (const s of this.d.repo.list()) {
      if (filter.featureId !== null && s.featureId !== filter.featureId) continue;
      const { policy: p, by } = this.policyWhy(s);
      const lr = this.d.repo.lastRun(s.id);
      const restorable = this.d.repo.lastRestorable(s.id);
      const b = this.behindCache.get(s.id);
      const unpushed = new Set(lr?.outcome === "rebased" ? (lr.detail.unpushed ?? []) : []);
      const firstOpen = this.d.repo.layers(s.id).find((l) => l.state !== "merged");
      const layers: StackLayerView[] = this.d.repo.layers(s.id).map((l) => ({
        id: l.id, position: l.position, branch: l.branch, ticketKey: l.ticketKey, ticketTitle: this.d.owned(s.repoPath, l.branch)?.ticketTitle ?? null,
        mode: l.mode, state: l.state, prNumber: l.prNumber, prUrl: l.prUrl, behind: firstOpen?.id === l.id ? (b?.commits ?? null) : null,
        lastRebaseAt: l.lastRebaseAt, draftSince: l.draftSince, mergedAt: l.mergedAt, unpushed: unpushed.has(l.branch) || l.remoteOkSha !== null,
      }));
      stacks.push({
        id: s.id, name: s.name, repoPath: s.repoPath, repoSlug: s.repoSlug, trunk: s.trunk, featureId: s.featureId, source: s.source,
        mergeMethod: s.mergeMethod, autoRebase: p.autoRebase, autoRebaseBy: by, overviewUrl: s.overviewUrl, layers, lastRun: lr ? runView(lr) : null, restorable: restorable ? runView(restorable) : null,
      });
    }
    return { stacks, updateRefs: supportsUpdateRefs(await gitVersion()) };
  }

  // ---------------------------------------------------------------- 小工具

  policyOf(s: StackRow): StackPolicy {
    return this.policyWhy(s).policy;
  }

  /**
   * 生效的策略和 autoRebase 是谁定的（BTL-278）。epic 的档位盖在三层上；但半自动要打开时，仓库或产品层明确关着就按关：
   * 那是用户专门为这个仓库做的决定，全局层不算（全局档位写的就是全局层）。手动档照样关。
   */
  private policyWhy(s: StackRow): { policy: StackPolicy; by: StackAutoRebaseBy } {
    const base = this.d.policy.forSlug(s.repoSlug);
    if (!this.d.overlay) return { policy: base, by: "policy" };
    let p: StackPolicy;
    try {
      p = this.d.overlay(base, this.d.repo.layers(s.id).filter((l) => l.mergedAt === null).map((l) => l.ticketKey));
    } catch (e) {
      this.d.log(`stacks: automation level for stack ${s.id}`, e);
      return { policy: base, by: "policy" };
    }
    if (p.autoRebase === base.autoRebase) return { policy: p, by: "policy" };
    if (p.autoRebase && this.d.policy.autoRebaseExplicitOff(s.repoSlug)) return { policy: { ...p, autoRebase: false }, by: "explicit_off" };
    return { policy: p, by: "epic" };
  }

  /** 设置页（BTL-278）：这个范围里 autoRebase 被 epic 打开的栈，和 epic 要开、被明确关掉的栈。 */
  epicNote(scope: PolicyScope): StackEpicNote {
    const out: StackEpicNote = { on: [], ignored: [] };
    for (const s of this.d.repo.list()) {
      const inScope = scope.kind === "global"
        || (scope.kind === "repo" && s.repoSlug?.toLowerCase() === scope.slug.toLowerCase())
        || (scope.kind === "product" && this.d.policy.inProduct(s.repoSlug, scope.productId));
      if (!inScope) continue;
      const w = this.policyWhy(s);
      if (w.by === "epic" && w.policy.autoRebase) out.on.push(s.name);
      if (w.by === "explicit_off") out.ignored.push(s.name);
    }
    return out;
  }

  private epicAutoRebaseRepos(): string[] {
    try {
      return this.d.autoRebaseRepos?.() ?? [];
    } catch (e) {
      this.d.log("stacks: repos of semi epics", e);
      return [];
    }
  }

  private isManaged(repo: string, branch: string, path: string): boolean {
    const o = this.d.owned(repo, branch);
    return !!o?.worktree && resolve(o.worktree) === resolve(path);
  }

  private async trunkOf(repoPath: string): Promise<string> {
    const r = await runGit(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const v = r.code === 0 ? r.stdout.trim().replace(/^[^/]+\//, "") : "";
    if (v) return v;
    for (const b of ["main", "master"]) if (await revParse(repoPath, `refs/heads/${b}`)) return b;
    return "main";
  }

  private async graph(s: StackRow, all: LayerRow[]): Promise<GraphLayer[]> {
    return all.map((l) => ({ branch: l.branch, prNumber: l.prNumber, state: l.state, title: this.d.owned(s.repoPath, l.branch)?.ticketTitle ?? null }));
  }

  private async afterRun(stack: StackRow, trigger: StackTrigger): Promise<void> {
    const s = this.d.repo.get(stack.id)!;
    if (trigger !== "bottom_merged") await this.syncDrafts(s).catch((e) => this.d.log(`stacks: draft sync`, e));
    await this.syncOverview(s);
  }

  private changed(): void {
    try {
      this.d.onChange?.();
    } catch (e) {
      this.d.log("stacks: onChange failed", e);
    }
  }
}

function runView(r: RunRow): StackRunView {
  return {
    id: r.id, trigger: r.trigger, mode: r.mode, outcome: r.outcome, reason: r.reason, hasBackup: (r.detail.layers ?? []).some((l) => !!l.backupRef),
    conflict: r.detail.conflict ? { branch: r.detail.conflict.branch, files: r.detail.conflict.files } : null, unpushed: r.detail.unpushed ?? [],
    confirm: r.detail.confirm ?? null,
    startedAt: r.startedAt, finishedAt: r.finishedAt,
  };
}

/** 总览正文变没变（不用加密强度）。 */
function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
