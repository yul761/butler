import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExternalActionKind } from "../../shared/external";
import type { PolicyScope } from "../../shared/admission-policy";
import {
  isSettledOutcome,
  type ConflictLease, type StackActionResult, type StackActor, type StackAutoRebaseBy, type StackConfirmWhy, type StackEpicNote, type StackLayerMode, type StackLayerView, type StackMarkersWhere, type StackNoticeInfo,
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
import { effectiveStatus, type Ticket } from "../../shared/types";

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
  deliver(to: StackMailTo, text: string, topic?: "verify"): Promise<boolean>;
  /** 撤回还排在信箱里没送的那条冲突（BTL-278：层收回来了、冲突没了，旧的 rebase 指令不能再送进去）。 */
  withdraw?(to: StackMailTo, topic?: "verify"): void;
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
/** 认不出层推到哪个 remote 的推迟原因开头（rebaseNow 认它，回本地化的提示）。 */
const PUSH_REMOTE_AMBIGUOUS = "can't tell which remote";
const FAILED_RETRY_MS = 60 * 60_000;
/** 同样的输入、同样的原因连着失败：每多一次等的时间翻倍，最多等一天（确定性的失败不用每小时重跑一遍）。 */
const FAILED_RETRY_MAX_MS = 24 * 3600_000;
/** 读不到开着的 PR（gh 没登录、网络断了）推迟的：等 5 分钟再读，每次翻倍，最多一小时（BTL-278：原来每个 tick 都起一次 gh）。 */
const PRS_UNREADABLE = "can't read the open PRs";
/** 栈里有层的 ticket 关掉或归档了（BTL-278 复核）：整个栈不改写，推迟的原因以它开头（后面是那几层）。 */
const NOT_LIVE = "ticket closed or archived:";
const PRS_RETRY_MS = 5 * 60_000;
const PRS_RETRY_MAX_MS = 60 * 60_000;
/** pushTarget 的结果留多久（同一轮里的几次 git 调用合成一次）。 */
const PUSH_TARGET_MEMO_MS = 30_000;
/** 查冲突标记出错（git 超时之类）以后多久再查：MARKERS_RETRY_MS·2^(n-1)，最多 MARKERS_RETRY_MAX_MS。 */
const MARKERS_RETRY_MS = 5 * 60_000;
const MARKERS_RETRY_MAX_MS = 60 * 60_000;
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
 * handoff 只在还有层的冲突在 session 手里时算数；remote_ahead 一直算到下一次 run。空的就是不用再确认了（提醒消掉、自动 run 放行）。
 */
function confirmPending(r: RunRow, open: LayerRow[]): string[] {
  const c = r.detail.confirm;
  if (!c) return [];
  const live = c.branches.filter((b) => open.some((l) => l.branch === b));
  if (c.why === "ready_pr") return live.filter((b) => open.find((l) => l.branch === b)!.state === "ready");
  // remote_ahead：等人点，下一次自动 run 再核对远端
  if (c.why === "remote_ahead") return live;
  return open.some((l) => l.conflictKey !== null) ? live : [];
}

/** ref（完整名字）现在指向的提交，没有为 null。 */
type TipOf = (ref: string) => Promise<string | null>;

type RemoteKind = "none" | "github" | "other" | "unknown";

/** 层的分支推到哪个 remote（pushTarget）。 */
interface PushTarget {
  remote: string | null;
  /** 分支在某个 remote 上有，却认不出该推哪个。 */
  ambiguous: boolean;
}

/** 确定不是 GitHub 的托管（这些仓库没有 GitHub PR）。别的认不出的主机（SSH 别名之类）按 unknown 算。 */
const OTHER_HOSTS = /(^|\.)(gitlab|bitbucket|codeberg|gitea|gitee|sr\.ht|sourceforge|dev\.azure|visualstudio)(\.|$)|^gitlab[.-]|^bitbucket[.-]/i;

/** host/owner/name（GitLab 的子组还会更长）形式、host 确定不是 GitHub 的 slug。github.com 上的是 owner/name 两段。 */
function otherHostSlug(slug: string): boolean {
  const p = slug.split("/");
  return p.length >= 3 && OTHER_HOSTS.test(p[0]!);
}

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

/**
 * 栈发给某一层 session 的信的收件层：ticket、仓库（同一个 ticket 跨仓库时分支常常同名，BTL-278）、分支。
 * ticketRepoId 没记上时由收件方按仓库路径和分支去找。
 */
export interface StackMailTo {
  ticketKey: string;
  ticketRepoId: number | null;
  repoPath: string;
  branch: string;
}

/** 信箱里这一层这一类信的 ref：同一个 ref 新的换掉还没送的旧的，撤回也按它。仓库对不上就不是同一封。 */
export function stackMailRef(to: { ticketKey: string; branch: string }, repoId: number, topic?: "verify"): string {
  return `stack:${to.ticketKey}:${repoId}:${to.branch}${topic ? `:${topic}` : ""}`;
}

/**
 * 栈服务还替不替这个 ticket 的分支干活（认作 Shipherd 的分支：rebase、强推、开 PR、做栈检测）：归档的、关掉的（BTL-270）都不算。
 * 关掉的 ticket 再被改写、推送、开 PR，正是关 ticket 要防的事（BTL-278 复核）。
 */
export function stackTicketLive(t: Pick<Ticket, "archivedAt" | "status" | "statusManual"> | null): boolean {
  return t !== null && t.archivedAt === null && effectiveStatus(t) !== "closed";
}

/** 收件层在 ticket 的哪个仓库：记着的 ticketRepoId，没有就按仓库路径和分支找（路径对不上的不算；same 是比较路径的函数）。 */
export function stackMailRepoIdOf(
  to: StackMailTo, repos: { id: number; repoPath: string; branch: string }[], same: (a: string, b: string) => boolean,
): number | null {
  if (to.ticketRepoId !== null) return to.ticketRepoId;
  return repos.find((r) => r.branch === to.branch && same(r.repoPath, to.repoPath))?.id ?? null;
}

function mailTo(stack: Pick<StackRow, "repoPath">, l: Pick<LayerRow, "ticketRepoId" | "branch"> & { ticketKey: string }): StackMailTo {
  return { ticketKey: l.ticketKey, ticketRepoId: l.ticketRepoId, repoPath: stack.repoPath, branch: l.branch };
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
  /**
   * 强推前查冲突标记的结果，按「层 id:要推的顶端:远端顶端」记（BTL-278）：两头都没变就不再每分钟重查。
   * files 非空 = 多出了标记，「现在」页提醒；null = 查不了（at、n：查的时间、连着查不了几次，退避着重查）。
   * 只在内存里：重启后第一次推重查一次，查的过程没有别的副作用。每层只留最新的一条（local、remote：查的是哪两个顶端，「现在」页按 local 认）。
   */
  private readonly markersOf = new Map<string, { layerId: number; local: string; remote: string | null; files: string[] | null; at: number; n: number }>();
  /** 被下面带标记的层拦住、这次没推的层（「现在」页点名拦它的那一层，BTL-278）：层 → 拦它的层（id）、它当时要推的顶端。 */
  private readonly heldOf = new Map<number, { byId: number; byBranch: string; tip: string }>();
  /** pushTarget 的结果（这一轮里）。 */
  private readonly pushTargetMemo = new Map<string, { at: number; p: Promise<PushTarget> }>();
  /** 要开 PR 的新栈底认不出该推到哪个 remote（「现在」页提醒，BTL-278）：栈 → 那一层。 */
  private readonly noPushRemote = new Map<number, { layerId: number }>();
  /** reconcilePrs 对上的 PR 的 head 仓库（owner/name，小写），按「栈 id\0分支」：pushTarget 先按它认 remote。 */
  private readonly prHeadRepo = new Map<string, string>();
  /** 补推时读 PR 读不到：按栈退避着再读，免得 gh 认不出的主机每分钟调一次 gh（BTL-278）。 */
  private readonly pushPrsRetry = new Map<number, { at: number; n: number }>();
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

  constructor(private readonly d: StackServiceDeps) {
    // rerere 清理的候选在这一版第一次启动时就定下来：那时 stacks 表里的栈是旧版留下的；之后新建的栈不算（BTL-278）
    this.rerereMemo();
  }

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
      if (pr.headRepo) this.prHeadRepo.set(`${stack.id}\0${l.branch}`, pr.headRepo.toLowerCase());
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
   * 读不到 PR 的原因，带上主机和怎么办（BTL-278）：GitHub Enterprise 这类主机多半是 gh 没登录那台，24 小时后「卡住」的提醒里照着做。
   * 主机从 host/owner/name 形式的 slug 里取（带点的才算主机名，SSH 别名不算）；只有 owner/name 的就是 github.com。
   */
  private async prsUnreadable(stack: StackRow): Promise<string> {
    const extra = (await this.d.remoteSlugs?.(stack.repoPath).catch(() => [] as string[])) ?? [];
    const host = [stack.repoSlug, ...extra].map((x) => (x ? x.split("/") : [])).find((p) => p.length >= 3 && p[0]!.includes("."))?.[0] ?? null;
    return `${PRS_UNREADABLE}${host ? ` on ${host}` : ""}; is gh signed in there? (gh auth login${host ? ` --hostname ${host}` : ""})`;
  }

  /**
   * 仓库的 origin 和 upstream 上开着的 PR（fork 工作流里层的 PR 开在 upstream 上，BTL-278），按 url 去重。
   * 有一个读不到就返回 null。给了 heads 时，读满一页的再逐层查（查不全也是 null）。
   */
  private async openPrsOf(repoPath: string, known: string[], heads: string[] | null): Promise<{ prs: gh.PrSnapshot[] | null; anySlug: boolean }> {
    const extra = (await this.d.remoteSlugs?.(repoPath).catch(() => [] as string[])) ?? [];
    // GitLab、Bitbucket 之类主机上的 slug（slugOf 给的是 host/owner/name）不交给 gh：GH_HOST=gitlab.com 必然读不到，栈就永远推迟（BTL-278）
    const slugs: (string | null)[] = [...new Set([...known, ...extra].filter((x) => !!x && !otherHostSlug(x)))];
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
  /**
   * 一个 remote 的地址：get-url（套用过 insteadOf 的）和配置里原样写的，都要（insteadOf 把 GitHub 地址改写成镜像时，
   * 仓库名只在原样的那个里）。missing：没有这个 remote（get-url 报 2、config 报 1）。
   */
  private async remoteUrls(repo: string, remote: string): Promise<{ urls: (string | null)[]; missing: boolean }> {
    const run = (args: string[]) => runGit(repo, args).catch(() => null);
    const url = await run(["remote", "get-url", remote]);
    const raw = await run(["config", "--get", `remote.${remote}.url`]);
    return { urls: [url, raw].map((r) => (r?.code === 0 ? r.stdout.trim() : null)), missing: !!url && url.code === 2 && raw?.code === 1 };
  }

  /** 一个 remote 指向的 GitHub 仓库（owner/name，小写），两种地址里认得出的都算。 */
  private async remoteRepos(repo: string, remote: string): Promise<string[]> {
    const own = new Set<string>();
    for (const u of (await this.remoteUrls(repo, remote)).urls) {
      const sl = u ? parseRemoteSlug(u) : null;
      if (sl && sl.split("/").length === 2) own.add(sl.toLowerCase());
    }
    return [...own];
  }

  private async remoteInfo(stack: Pick<StackRow, "repoPath" | "remote" | "repoSlug">): Promise<{ kind: RemoteKind; own: string[] }> {
    const { urls, missing } = await this.remoteUrls(stack.repoPath, stack.remote);
    if (missing) return { kind: "none", own: [] };
    const kinds = urls.map((u) => (u === null ? "unknown" : remoteKind(u)));
    // 保守地取：有一个是 GitHub 就是 GitHub，有一个认不出就是认不出（按读不到处理），都确定不是才当没有 PR
    const kind: RemoteKind = kinds.includes("github") ? "github" : kinds.includes("unknown") ? "unknown" : kinds.includes("other") ? "other" : "none";
    // 层的分支在哪个仓库：栈的 remote，再加上 origin（fork 工作流里 trunk 常常跟着 upstream，ticket 分支却推在自己的 fork 上）
    const own = new Set([...(await this.remoteRepos(stack.repoPath, stack.remote)), ...(stack.remote === "origin" ? [] : await this.remoteRepos(stack.repoPath, "origin"))]);
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
    this.pushTargetMemo.clear();
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
    // 认不出推到哪个 remote，手动也推迟了（改写了也推不出去）：不算成功，说清楚怎么指定
    if (run?.outcome === "deferred" && run.reason?.startsWith(`${PUSH_REMOTE_AMBIGUOUS} `)) {
      return { ok: false, message: T().errors.pushRemoteAmbiguous(run.reason.slice(PUSH_REMOTE_AMBIGUOUS.length + 1).split(" ")[0]!) };
    }
    if (run?.outcome === "deferred" && run.reason?.startsWith(`${NOT_LIVE} `)) return { ok: false, message: T().errors.notLive(run.reason.slice(NOT_LIVE.length + 1)) };
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
    // 改写前先把层的 PR 状态读对（BTL-278）；读不到时自动的不动。手动的照常跑（用户点了就是确认，层的状态按上次读到的算，
    // 强推照常按 lease 推）：gh 读不到的主机（自建 GitLab 之类）上的栈只能这样 rebase
    if (!(await this.readPrs(stack)) && auto) return this.defer(stack, trigger, await this.prsUnreadable(stack), "deferred");
    const trunkSha = (await remoteTip(repo, stack.remote, stack.trunk)) ?? (await revParse(repo, `refs/heads/${stack.trunk}`));
    if (!trunkSha) return this.defer(stack, trigger, `no ${stack.trunk}`, "failed");
    const all = this.d.repo.layers(stack.id);
    const open = all.filter((l) => l.state !== "merged");
    if (open.length === 0) {
      this.d.repo.updateStack(stack.id, { trunkSha });
      return null;
    }
    // 有一层的 ticket 关掉或归档了（PR 刚读过：合并了的不算）：整个栈这次不改写任何分支（BTL-278 复核：关 ticket 承诺它的分支
    // 不改写、不推、不开 PR；只改别的层的话，上面的层就接不到它上面了）。「现在」页点名那一层，要人把它移出栈
    const dead = open.filter((l) => !this.live(repo, l)).map((l) => l.branch);
    if (dead.length > 0) return this.defer(stack, trigger, `${NOT_LIVE} ${dead.join(", ")}`, "deferred", { inputs: await this.inputsOf(stack) });
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
      // 强推命令锁的远端 sha 现在就定下来、记进 run（BTL-278）：远端有本地没有的提交（reviewer 推的）时，
      // 照着 lease 推就会冲掉它们：自动跑时先问人，确认以后交出去也不给推送命令
      const lease = await this.conflictLease(stack, open.find((l) => l.branch === res.branch)!);
      if (auto && lease.ahead) return this.needsConfirm(stack, runId, "remote_ahead", [res.branch], o);
      return this.onConflict(stack, open, runId, res, policy, lease);
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
    const external = this.externalDefer(stack, open, changed);
    const ambiguous = external ? null : await this.ambiguousPushRemote(stack, changed);
    if (external || ambiguous) {
      this.d.repo.deleteRun(runId);
      // 认不出 remote 的推迟要等人改配置（或者分支、trunk 变了）：记下输入，同样的输入不再每次 fetch 都重跑（dueTrigger）
      return this.defer(stack, trigger, (external ?? ambiguous)!, "deferred", ambiguous ? { inputs: await this.inputsOf(stack) } : undefined);
    }
    const checkouts = await worktreeBranches(repo);
    const applyLayers: ApplyLayer[] = [];
    for (const t of res.tips) {
      const l = open.find((x) => x.branch === t.branch)!;
      const path = checkouts.get(t.branch) ?? null;
      const managed = path !== null && this.isManaged(repo, t.branch, path);
      applyLayers.push({
        position: t.position, branch: t.branch, oldTip: t.oldTip, newTip: t.newTip, checkout: path ? { path, managed } : null,
        remoteTip: await this.layerRemoteTip(stack, t.branch), remoteOkSha: l.remoteOkSha,
      });
    }
    const applied = await applyTips({
      repo, stackId: stack.id, runId, layers: applyLayers, sessionBusy: (p) => this.d.sessionBusy(p),
      push: this.pusher((l, done) => this.forcePush(stack, l, open.find((x) => x.branch === l.branch)!, res.tips.find((t) => t.branch === l.branch)?.newBase ?? null, done)),
      log: (m) => this.d.log(m),
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
    const asked = await this.askToVerify(stack, open, changed, applied, applyLayers);
    if (asked.length > 0) this.patchRun(runId, { verifyAsked: asked });
    await this.afterRun(stack, trigger);
    return this.d.repo.run(runId);
  }

  /**
   * 改写过的层没人编译、跑过测试（BTL-278）：请每一层的 session 核对一次。和冲突分开排（topic verify），
   * 同一层新的一条换掉还没送的旧的。没有 session 的层由「刚自动改写」的提醒告诉用户。
   */
  private async askToVerify(
    stack: StackRow, open: LayerRow[], changed: NewTip[], applied: { pushed: string[]; pushFailed: { branch: string }[] }, layers: ApplyLayer[],
  ): Promise<string[]> {
    const asked: string[] = [];
    for (const t of changed) {
      const l = open.find((x) => x.branch === t.branch);
      if (!l?.ticketKey) continue;
      const pushed = applied.pushed.includes(t.branch);
      const unpushed = pushed ? undefined
        : applied.pushFailed.some((f) => f.branch === t.branch) ? "blocked" as const
        : !layers.find((x) => x.branch === t.branch)?.remoteTip ? "local" as const
        : "off" as const;
      const text = T().verify({ branch: t.branch, onto: t.newBase, tip: t.newTip, pushed, unpushed });
      const ok = await this.d.deliver(mailTo(stack, { ...l, ticketKey: l.ticketKey }), text, "verify")
        .catch((e) => (this.d.log(`stacks: asking ${l.branch}'s session to verify failed`, e), false));
      if (ok) asked.push(t.branch);
    }
    return asked;
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
    const layers = this.d.repo.layers(stack.id);
    const push = branches.some((b) => this.d.external.allowed("force_push", { repoSlug: stack.repoSlug, ticketKey: layers.find((l) => l.branch === b)?.ticketKey ?? null }));
    this.d.repo.finishRun(runId, { outcome: "needs_confirm", reason, detail: { confirm: { why, branches, push, toSession: this.policyOf(stack).conflictToSession }, inputs, autosquash: o.autosquash || undefined } });
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

  /**
   * 要改写的层在某个 remote 上有、却认不出该推到哪个（BTL-278，fork 工作流）：不改写，免得改了本地、PR 所在的那个分支却再也跟不上。
   * 哪个 remote 上都还没有的层（只在本地）不算：本来就不推，照常改写（原来整栈因此永远推迟、每次 fetch 都空跑一次引擎）。
   * 「强推」开关关着也要看：开关关着时会记下远端的旧顶端等以后补推，认不出 remote 就记不下，以后也补推不了。
   */
  private async ambiguousPushRemote(stack: StackRow, changed: NewTip[]): Promise<string | null> {
    for (const t of changed) {
      if ((await this.pushTarget(stack, t.branch)).ambiguous) return `${PUSH_REMOTE_AMBIGUOUS} ${t.branch} is pushed to (it is on another remote, and no config says where it goes); say which with git config branch.${t.branch}.pushRemote <remote>`;
    }
    return null;
  }

  /**
   * 交给 session 的强推命令锁哪个 sha（BTL-278）：层要推的 remote 上现在的顶端。ahead = 它不是本地分支的祖先
   * （也不是 Shipherd 自己改写前、还没推掉的那个旧顶端）：远端有本地没有的提交，不能给推送命令。git 出错按 ahead 算。
   */
  private async conflictLease(stack: StackRow, l: LayerRow): Promise<ConflictLease> {
    const remote = await this.pushRemote(stack, l.branch);
    if (!remote) return { remote: null, sha: null, ahead: false };
    const sha = await remoteTip(stack.repoPath, remote, l.branch);
    if (!sha || sha === l.remoteOkSha) return { remote, sha, ahead: false };
    const local = await revParse(stack.repoPath, `refs/heads/${l.branch}`);
    const ahead = !local || !(await isAncestor(stack.repoPath, sha, local).catch(() => false));
    return { remote, sha, ahead };
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

  private defer(stack: StackRow, trigger: StackTrigger, reason: string, outcome: "deferred" | "failed", detail?: RunDetail): RunRow | null {
    const fresh = this.d.repo.recordRepeatable(stack.id, trigger, outcome, reason, detail);
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
      if (l.conflictKey && l.ticketKey) this.d.withdraw?.(mailTo(stack, { ...l, ticketKey: l.ticketKey }));
    }
    // 引擎没列出来的层（noop 时它只列到第一层要动的为止）：顶端照实记
    this.d.repo.updateStack(stack.id, { trunkSha });
  }

  /**
   * 层的分支推到哪个 remote（BTL-278）。fork 工作流里栈的 remote（trunk 跟着的那个）常是 upstream，ticket 分支却推在 origin（自己的 fork）上，
   * PR 的 head 也在那里：推到栈的 remote 会在 upstream 上新建一个同名分支，PR 却没更新。反过来（origin 是主仓库、分支在 fork 的 remote 上）也一样。
   * 按顺序认：
   * 1. 层的 PR 的 head 仓库（reconcilePrs 记下的）是哪个 remote 的地址，就推那个；
   * 2. 配置写明的：branch.<b>.pushRemote、remote.pushDefault，或者跟踪的就是同名分支的 branch.<b>.remote
   *    （从 upstream/main 开出来的分支 branch.<b>.remote 是 upstream、merge 是 main：那不算）；
   * 3. 有跟踪分支的：origin 先于栈的 remote；
   * 4. 哪边都还没有：只有栈的 remote 就是 origin（或者根本没有 origin）才新建。
   * 认不出就是 null：不推、不给推送命令、不新建分支。ambiguous = 分支在某个 remote 上有、却认不出该推哪个
   * （只在第三个 remote 上，或者配置的 remote 上没有、别的 remote 上有）。结果按轮记下（tick、手动操作开头清空，最多留 30 秒）。
   */
  private pushTarget(stack: Pick<StackRow, "id" | "repoPath" | "remote">, branch: string): Promise<PushTarget> {
    const head = this.prHeadRepo.get(`${stack.id}\0${branch}`) ?? "";
    const key = `${stack.repoPath}\0${stack.remote}\0${branch}\0${head}`;
    const hit = this.pushTargetMemo.get(key);
    if (hit && this.d.now() - hit.at < PUSH_TARGET_MEMO_MS) return hit.p;
    const siblings = this.d.repo.layers(stack.id).filter((l) => l.state !== "merged" && l.branch !== branch).map((l) => l.branch);
    const p = this.pushTargetNow(stack.repoPath, stack.remote, branch, head || null, siblings);
    this.pushTargetMemo.set(key, { at: this.d.now(), p });
    p.catch(() => this.pushTargetMemo.delete(key));
    return p;
  }

  private async pushRemote(stack: Pick<StackRow, "id" | "repoPath" | "remote">, branch: string): Promise<string | null> {
    return (await this.pushTarget(stack, branch)).remote;
  }

  private async pushTargetNow(repo: string, stackRemote: string, branch: string, headRepo: string | null, siblings: string[] = []): Promise<PushTarget> {
    const run = (args: string[]) => runGit(repo, args).catch(() => null);
    const list = await run(["remote"]);
    const remotes = list?.code === 0 ? list.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
    if (headRepo) {
      // 和认 PR 是不是这个栈的（remoteInfo 的 own）用同一个判断
      for (const r of remotes) if ((await this.remoteRepos(repo, r)).includes(headRepo)) return { remote: r, ambiguous: false };
      // 哪个 remote 的地址都不是它（仓库改过名、地址写法认不出）：按下面的规则认
    }
    const refs = await run(["for-each-ref", "--format=%(refname)", "refs/remotes/"]);
    const all = new Set(refs?.code === 0 ? refs.stdout.split(/\r?\n/).map((x) => x.trim()) : []);
    const has = new Set(remotes.filter((r) => all.has(`refs/remotes/${r}/${branch}`)));
    const cfgOut = await run(["config", "-z", "--get-regexp", "^(branch\\..*\\.(pushremote|remote|merge)|remote\\.pushdefault)$"]);
    const cfg = new Map<string, string>();
    if (cfgOut?.code === 0) {
      for (const e of cfgOut.stdout.split("\0")) {
        const nl = e.indexOf("\n");
        if (nl > 0) cfg.set(e.slice(0, nl), e.slice(nl + 1));
      }
    }
    // 键名里 section 和变量名 git 给的是小写，分支名（subsection）照原样
    const tracked = cfg.get(`branch.${branch}.merge`) === `refs/heads/${branch}` ? cfg.get(`branch.${branch}.remote`) : undefined;
    const named = cfg.get(`branch.${branch}.pushremote`) ?? cfg.get("remote.pushdefault") ?? tracked;
    if (named && remotes.includes(named)) {
      if (has.has(named) || has.size === 0) return { remote: named, ambiguous: false };
      return { remote: null, ambiguous: true };
    }
    if (has.has("origin")) return { remote: "origin", ambiguous: false };
    if (has.has(stackRemote)) return { remote: stackRemote, ambiguous: false };
    if (has.size > 0) return { remote: null, ambiguous: true };
    if (stackRemote !== "origin") return { remote: remotes.includes("origin") ? null : stackRemote, ambiguous: false };
    // 栈跟着 origin，可是同一个栈里已经有层推在别的 remote 上（反向 fork：origin 是主仓库，分支在自己的 fork 上）：
    // 没配置的新层也多半该推到那边，不在 origin（主仓库）上新建（BTL-278）。只有一个 remote 的普通仓库照旧推 origin
    const elsewhere = (b: string): boolean => {
      const t = cfg.get(`branch.${b}.merge`) === `refs/heads/${b}` ? cfg.get(`branch.${b}.remote`) : undefined;
      const n = cfg.get(`branch.${b}.pushremote`) ?? t;
      if (n && n !== "origin" && remotes.includes(n)) return true;
      return !all.has(`refs/remotes/origin/${b}`) && remotes.some((r) => r !== "origin" && all.has(`refs/remotes/${r}/${b}`));
    };
    // remotes.length > 1 其实是多余的（只有 origin 时 elsewhere 不会成立）：写给人看的，说明这条只管有好几个 remote 的仓库
    if (remotes.length > 1 && siblings.some(elsewhere)) return { remote: null, ambiguous: false };
    return { remote: stackRemote, ambiguous: false };
  }

  /** 层在它要推的那个 remote 上的顶端；认不出推到哪里时为 null。 */
  private async layerRemoteTip(stack: Pick<StackRow, "id" | "repoPath" | "remote">, branch: string): Promise<string | null> {
    const rm = await this.pushRemote(stack, branch);
    return rm ? remoteTip(stack.repoPath, rm, branch) : null;
  }

  /** applyTips 的 push：记下这次已经推上去的层，给 heldBelow 用（从下往上推）。 */
  private pusher(push: (l: ApplyLayer, done: ReadonlySet<string>) => Promise<boolean>): (l: ApplyLayer) => Promise<boolean> {
    const done = new Set<string>();
    return async (l) => {
      const ok = await push(l, done);
      if (ok) done.add(l.branch);
      return ok;
    };
  }

  /**
   * 强推一层（自动 run、手动 rebase、恢复备份、补推都走这里）。newBase：这一层新的起点（不知道时按父层现在的顶端算）。
   * 推之前查一次冲突标记（BTL-278）：按远端那份比（旧顶端 = 远端顶端，旧起点 = 它和新起点的 merge-base），远端没有、这次要推上去的
   * 标记就不推，抛错（调用方记成推送失败，「现在」页提醒）。引擎自己的护栏按改写前的本地顶端比：本地顶端里已经有的标记
   * （旧版套用 rerere 留下的、没推出去的）它当成层自己的放过去了，这里不放。
   */
  private async forcePush(stack: StackRow, l: ApplyLayer, row: LayerRow, newBase: string | null, pushedNow?: ReadonlySet<string>): Promise<boolean> {
    if (!this.live(stack.repoPath, row)) {
      this.d.log(`stacks: not pushing ${l.branch}: its ticket is closed or archived, or the branch isn't its any more`);
      return false;
    }
    const remote = await this.pushRemote(stack, l.branch);
    if (!remote) {
      this.d.log(`stacks: not pushing ${l.branch}: can't tell which remote its PR is on`);
      return false;
    }
    const scope = { repoSlug: stack.repoSlug, ticketKey: row.ticketKey };
    if (this.d.external.allowed("force_push", scope)) {
      const files = await this.markersVsRemote(stack, row, l.newTip, l.remoteTip, newBase);
      if (files === null) throw new Error(`not pushing ${l.branch}: checking for conflict markers failed`);
      if (files.length > 0) throw new Error(`not pushing ${l.branch}: conflict markers in ${files.join(", ")}`);
      const below = await this.heldBelowNoted(stack, row, l.newTip, pushedNow);
      if (below) throw new Error(`not pushing ${l.branch}: ${below.branch} below it has conflict markers that weren't pushed`);
    }
    // 推查过的那个提交（l.newTip），不推分支现在指着的：查的过程中、推下面的层时 session 可能又提交了（BTL-278）
    const r = await this.d.external.attempt(
      "force_push",
      { scope, target: l.branch, summary: `stack rebase: ${l.branch} ${sha7(l.remoteTip)} → ${sha7(l.newTip)}` },
      () => pushBranch(stack.repoPath, remote, l.branch, l.remoteTip, l.newTip),
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
    lease: ConflictLease,
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
      // 还没交出去的：补送时用这次的 lease（远端可能又变了）
      const conflict = prev.detail.delivered ? pc : { ...pc, lease };
      this.patchRun(prev.id, { inputs: await this.inputsOf(stack), repeats: (prev.detail.repeats ?? 1) + 1, conflict });
      return this.d.repo.run(prev.id);
    }
    const detail: RunDetail = {
      conflict: { branch: res.branch, files: res.files, commit: res.commit, onto: res.onto, upstream: res.upstream, ident, key: handed ? layer.conflictKey! : key, lease },
      ...(handed ? { delivered: true } : {}),
    };
    this.d.repo.finishRun(runId, { outcome: "conflict", reason: `${res.branch}: ${res.files.join(", ")}`, detail });
    if (!handed) {
      this.d.record?.("stack.conflict", { files: res.files.length });
      // 上一次改写后的核对请求说的是旧顶端：不管冲突交不交给 session，都先撤掉（BTL-278）
      if (layer.ticketKey) this.d.withdraw?.(mailTo(stack, { ...layer, ticketKey: layer.ticketKey }), "verify");
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
    // 强推命令锁的是 run 时记下的远端完整 sha（BTL-278）：补送时不重读跟踪 ref（那时它可能已经是 reviewer 推的提交）。
    // 旧版记的 run 没有 lease：现在算一次，同样核对是不是本地的祖先。远端有本地没有的提交、认不出推到哪里，都不给推送命令。
    const lease = c.lease ?? (await this.conflictLease(stack, layer));
    const push = lease.remote !== null && !lease.ahead && this.d.external.allowed("force_push", { repoSlug: stack.repoSlug, ticketKey: layer.ticketKey });
    const text = T().conflict({
      branch: c.branch, files: c.files, onto: c.onto, upstream: c.upstream, above, push, remote: lease.remote ?? stack.remote, remoteSha: lease.sha, remoteAhead: lease.ahead,
      noRemote: lease.remote === null,
    });
    // 这次 run 已经不是最近一次（之后又跑过）：它的冲突过时了，不送
    if (this.d.repo.lastRun(stack.id)?.id !== runId) return;
    const to = mailTo(stack, { ...layer, ticketKey: layer.ticketKey });
    // 还没送进去的「改写后核对」说的是上一次改写的顶端：这一层又要交冲突了，先撤掉（BTL-278）
    this.d.withdraw?.(to, "verify");
    const ref = `${stack.repoPath}\0${to.ticketKey}\0${to.branch}`;
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

  /**
   * 栈底下面有合并掉的层、自己还不是 ready：要提升。栈底的 ticket 关掉、归档了（或分支不归它了）不提升：不推、不开 PR、
   * 不改 base、不标 ready（BTL-278 复核 P1）。promoteBottom、retryPending 都经过这里。
   */
  private needsPromotion(stack: StackRow): LayerRow | null {
    const all = this.d.repo.layers(stack.id);
    const bottom = all.find((l) => l.state !== "merged");
    if (!bottom || bottom.state === "ready") return null;
    if (!this.live(stack.repoPath, bottom)) return null;
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
    const pushTo = await this.pushRemote(stack, layer.branch);
    if (pushTo) this.noPushRemote.delete(stack.id);
    const remote = pushTo ? await remoteTip(repo, pushTo, layer.branch) : null;
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
        // 认不出该推到哪个 remote（分支只在别的 remote 上、fork 工作流里哪儿都还没有）：不在 trunk 的 remote 上新建分支（BTL-278）
        if (!pushTo) {
          this.noPushRemote.set(stack.id, { layerId: layer.id });
          const k = `${layer.id}:no-remote`;
          if (!this.notPromotedLogged.has(k)) {
            this.notPromotedLogged.add(k);
            this.d.log(`stacks: not opening the PR of ${layer.branch}: can't tell which remote it is pushed to`);
          }
          return;
        }
        // 推之前查冲突标记（BTL-278）：远端还没有它，按起点比。有标记或查不了就不推、不开 PR（「现在」页提醒），和补推一样
        if (!tip) return;
        const files = await this.markersVsRemote(stack, layer, tip, null, null);
        if (files === null || files.length > 0) return;
        // 查的时候分支又动了：这轮不推，下一轮按新的顶端再查（PR 的描述、提交列表也是按 tip 写的）
        if ((await revParse(repo, `refs/heads/${layer.branch}`)) !== tip) return;
        // 推查过的那个提交：复查之后到真推之间分支还可能再动
        const r = await this.d.external.attempt("branch_push", { scope, target: layer.branch, summary: `push ${layer.branch} before opening its PR` }, () =>
          pushBranch(repo, pushTo, layer.branch, null, tip));
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
    this.pushTargetMemo.clear();
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
      // 这一层或者要先推的父层的 ticket 关掉或归档了：不推、不开（BTL-278 复核）。父层不会是合并了的：那样这一层就是栈底，上面已经返回了
      for (const b of [parent, layer]) if (!this.live(repo, b)) return { ok: false, message: t.notLive(b.branch) };
      // 远端还没有的父层和这一层先推上去。第一次推也是把内容交出去（BTL-278）：推之前和别的推送一样查冲突标记，
      // 下面有带标记、没推出去的层也不推（叠在它上面，推上去远端就带着那些标记），推的是查过的那个提交
      for (const b of [parent, layer]) {
        if (b.state === "merged") continue;
        const rm = await this.pushRemote(stack, b.branch);
        if (!rm) return { ok: false, message: t.noPushRemote(b.branch) };
        if (await remoteTip(repo, rm, b.branch)) continue;
        const tip = await revParse(repo, `refs/heads/${b.branch}`);
        if (!tip) return { ok: false, message: t.markersUnchecked(b.branch) };
        const files = await this.markersVsRemote(stack, b, tip, null, null);
        if (files === null) return { ok: false, message: t.markersUnchecked(b.branch) };
        if (files.length > 0) return { ok: false, message: t.markers(b.branch, files.join(", ")) };
        // 刚推上去的父层：heldBelow 按本地 = 远端跟踪分支认出它已经推了，不再拦这一层
        const below = await this.heldBelow(stack, b, tip);
        if (below) return { ok: false, message: t.heldBelow(b.branch, below.branch) };
        const r = await this.d.external.attempt("branch_push", { scope: { repoSlug: slug, ticketKey: b.ticketKey }, target: b.branch, summary: `push ${b.branch} before opening a draft` }, () =>
          pushBranch(repo, rm, b.branch, null, tip));
        if (!r.ran) return { ok: false, message: t.switchOff("branch_push") };
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
    this.pushTargetMemo.clear();
    this.running.add(stackId);
    try {
      const repo = stack.repoPath;
      await this.fetch(repo, stack.remote, true);
      const checkouts = await worktreeBranches(repo);
      const layers: ApplyLayer[] = [];
      const rows = this.d.repo.layers(stackId);
      // 那次 run 改写过、现在已经不在栈里的层：不恢复（栈服务不再管它），说一声跳过了哪些（BTL-278 复核 P2）
      const gone: string[] = [];
      for (const l of from.detail.layers ?? []) {
        if (!l.backupRef) continue;
        const row = rows.find((r) => r.branch === l.branch);
        if (!row) {
          gone.push(l.branch);
          continue;
        }
        // 关掉或归档的 ticket 的分支不改写（BTL-278 复核），恢复备份也是改写。只看还在栈里、没合并的层
        if (row.state !== "merged" && !this.live(repo, row)) return { ok: false, message: t.notLive(l.branch) };
        const backup = await revParse(repo, l.backupRef);
        const cur = await revParse(repo, `refs/heads/${l.branch}`);
        if (!backup || cur !== l.newTip) return { ok: false, message: t.restoreMoved(l.branch) };
        const path = checkouts.get(l.branch) ?? null;
        layers.push({
          position: l.position, branch: l.branch, oldTip: cur, newTip: backup, checkout: path ? { path, managed: this.isManaged(repo, l.branch, path) } : null,
          remoteTip: await this.layerRemoteTip(stack, l.branch), remoteOkSha: rows.find((r) => r.branch === l.branch)?.remoteOkSha ?? null,
        });
      }
      // 改写过的层都不在栈里了：没有能恢复的
      if (layers.length === 0 && gone.length > 0) return { ok: false, message: t.restoreSkipped(gone.join(", ")) };
      const runId = this.d.repo.startRun(stackId, "restore", null);
      const res = await applyTips({
        repo, stackId, runId, layers, backup: false, sessionBusy: (p) => this.d.sessionBusy(p),
        // layers 里只有还在栈里的层（上面跳过了别的），rows 里一定找得到
        push: this.pusher((l, done) => this.forcePush(stack, l, rows.find((r) => r.branch === l.branch)!, null, done)), log: (m) => this.d.log(m),
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
        if (row?.ticketKey) this.d.withdraw?.(mailTo(stack, { ...row, ticketKey: row.ticketKey }), "verify");
      }
      this.d.repo.finishRun(runId, { outcome: "restored", detail: { layers: res.layers, pushed: res.pushed, unpushed: res.unpushed, restoredFrom: from.id } });
      return gone.length > 0 ? { ok: true, message: t.restoreSkipped(gone.join(", ")) } : { ok: true };
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
      this.pushTargetMemo.clear();
      // 旧版跑过 rebase 的仓库，栈都删了（不再有活的栈）也要清（BTL-278）：每轮看一遍还没清的候选，清过的不再起 git
      const memo = this.rerereMemo();
      for (const c of memo.candidates) if (!memo.done.includes(c) && existsSync(join(c, ".git"))) await this.cleanLegacyRerere(c);
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
          // 「现在」页的标记、被拦提醒：session 自己推上去了就撤（只碰提醒）。每个栈都看：autoRebase 关着、上一次没落定的栈
          // 不会走补推，原来提醒就一直挂着（BTL-278 复核）。正在跑的栈跳过：它推完自己会改
          if (!this.running.has(s.id)) await this.releasePushed(s).catch((e) => this.d.log(`stacks: releasing notices for stack ${s.id}`, e));
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
    // 因为 ticket 关掉推迟的：每层都又 live 了（ticket 重新打开、关掉的层移出了栈），马上按那次的触发重跑，不等退避，也不等新的触发
    // （BTL-278 复核 P7：daily、手动那次推迟以后没有别的触发，lr 一直停在 deferred，补推、提升都不做）。手动的那次按自动的重跑：
    // 没人在点，要改写正在 review 的 PR 时照样先问
    if (lr?.outcome === "deferred" && lr.reason?.startsWith(NOT_LIVE) === true && open.every((l) => this.live(s.repoPath, l))) {
      return lr.trigger === "manual" || lr.trigger === "restore" ? "layer_commits" : lr.trigger;
    }
    // 上次读不到 PR：退避着再读（同一条推迟会合并成一行，repeats 是连着读不到的次数）
    if (lr?.outcome === "deferred" && lr.reason?.startsWith(PRS_UNREADABLE)) {
      const wait = Math.min(PRS_RETRY_MAX_MS, PRS_RETRY_MS * 2 ** Math.max(0, (lr.detail.repeats ?? 1) - 1));
      if (this.d.now() - (lr.finishedAt ?? lr.startedAt) < wait) return null;
    }
    // 上一次没落地（冲突、失败、要确认、回滚）、输入没变：再跑也是一样的结果，不跑（BTL-278）。trunk 或下面的层真动了才重试。
    // 等确认的那几层已经不用确认了（PR 转回 draft、冲突交回来了）：放行，按现在的状态重跑。
    const stale = (lr?.outcome === "needs_confirm" && confirmPending(lr, open).length === 0)
      // 失败（git 超时、worktree 建不起来）不一定是定论：过一阵再试
      || (lr?.outcome === "failed" && this.d.now() - (lr.finishedAt ?? lr.startedAt) >= this.failedRetryMs(s.id, lr))
      // 认不出推到哪个 remote 的推迟（记了输入的那种）：等人改配置，过一阵再看（同样连着推迟，间隔翻倍）
      || (lr?.outcome === "deferred" && this.d.now() - (lr.finishedAt ?? lr.startedAt) >= Math.min(FAILED_RETRY_MAX_MS, FAILED_RETRY_MS * 2 ** Math.max(0, (lr.detail.repeats ?? 1) - 1)));
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
    // 不再要提升（autoOpenBottomPr 关了、栈底已经 ready、换了栈底）：「认不出推到哪个 remote」的提醒也不用了（BTL-278）
    if (settled && !bottom) this.noPushRemote.delete(s.id);
    if (bottom && this.d.external.allowed("pr_open", { ...scope, ticketKey: bottom.ticketKey })) await this.promoteBottom(s);
    // pr_open 关着、promoteBottom 不来：人已经指定了推到哪个 remote 的话，提醒也该撤（不然一直说「认不出」）
    else if (bottom && this.noPushRemote.get(s.id)?.layerId === bottom.id && (await this.pushRemote(s, bottom.branch))) this.noPushRemote.delete(s.id);
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
      const remote = await this.layerRemoteTip(s, l.branch);
      if (remote === local) {
        // 提醒（它自己被拦、它拦着别的层）由 tick 里的 releasePushed 撤
        this.d.repo.updateLayer(l.id, { remoteOkSha: null });
        continue;
      }
      if (!local || local !== l.tipSha || remote !== l.remoteOkSha) continue;
      // 先查冲突标记（不用读 PR、不碰网络）：多出标记、或者查不了，都不推（BTL-278：旧版套用 rerere 留下的、还没推出去的顶端）。
      // forcePush 自己还会查一次（结果记着，不重跑 git）
      const files = await this.markersVsRemote(s, l, local, remote, l.baseSha);
      if (files === null || files.length > 0) continue;
      // 下面那层带着标记、没推出去：这一层叠在它上面，也先不推（它修好推出去以后再补；「现在」页点名拦它的那层）
      if (await this.heldBelowNoted(s, l, local)) continue;
      due.push({ l, local, remote });
    }
    if (due.length === 0) return;
    if (!confirmed) {
      const wait = this.pushPrsRetry.get(s.id);
      if (wait && this.d.now() < wait.at) return;
      if (!(await this.readPrs(s))) {
        const n = (wait?.n ?? 0) + 1;
        this.pushPrsRetry.set(s.id, { at: this.d.now() + Math.min(PRS_RETRY_MAX_MS, PRS_RETRY_MS * 2 ** (n - 1)), n });
        return;
      }
      this.pushPrsRetry.delete(s.id);
    }
    for (const { l: l0, local, remote } of due) {
      const l = this.d.repo.layer(l0.id) ?? l0;
      if (!confirmed && (l.state === "ready" || l.conflictKey)) continue;
      // 读 PR、推下面的层的时候 session 又提交了：查过的已经不是它现在的样子，这轮不推（下一次 run 按新的顶端来）。
      // 推的照样是查过的 local（forcePush 推 newTip）：复查之后到真推之间分支还可能再动
      if ((await revParse(s.repoPath, `refs/heads/${l.branch}`)) !== local) continue;
      const ok = await this.forcePush(s, { position: l.position, branch: l.branch, oldTip: local, newTip: local, checkout: null, remoteTip: remote, remoteOkSha: l.remoteOkSha }, l, l.baseSha).catch((e) => {
        this.d.log(`stacks: pushing ${l.branch} failed`, e);
        return false;
      });
      if (ok) this.d.repo.updateLayer(l.id, { remoteOkSha: null });
    }
  }

  /**
   * 下面有一层（改写后没推出去的、或者从没推过的）带着冲突标记，而要推的顶端就叠在它现在的顶端上：这一层也不推（BTL-278）。
   * 这一层自己那段（起点..顶端）里看不到那些标记（它们在起点里），只按自己那段查放得过去，推上去远端就带着下面那层的标记。
   * pushedNow：这次 run 里已经推上去的层（不用再读 ref）。返回拦住它的那一层。
   */
  private async heldBelow(stack: StackRow, row: LayerRow, tip: string, pushedNow?: ReadonlySet<string>): Promise<LayerRow | null> {
    const lower = this.d.repo.layers(stack.id).filter((x) => x.state !== "merged" && x.position < row.position && !pushedNow?.has(x.branch));
    if (lower.length === 0) return null;
    const remotes = new Map<string, string | null>();
    for (const x of lower) remotes.set(x.branch, await this.pushRemote(stack, x.branch));
    const refs = lower.flatMap((x) => [`refs/heads/${x.branch}`, ...(remotes.get(x.branch) ? [`refs/remotes/${remotes.get(x.branch)}/${x.branch}`] : [])]);
    const tips = await refTips(stack.repoPath, refs);
    for (const x of lower) {
      const local = tips.get(`refs/heads/${x.branch}`) ?? null;
      const rm = remotes.get(x.branch);
      const remote = rm ? (tips.get(`refs/remotes/${rm}/${x.branch}`) ?? null) : null;
      // 已经推上去了（session 自己推的、补推推的）：不再拦任何层（「现在」页的提醒由 releasePushed 撤）
      if (!local || local === remote) continue;
      if (!(await isAncestor(stack.repoPath, local, tip))) continue;
      const files = await this.markersVsRemote(stack, x, local, remote, null);
      if (files === null || files.length > 0) return x;
    }
    return null;
  }

  /** heldBelow，并记下（或清掉）这一层被谁拦住：自动 run 和补推用，「现在」页点名拦它的那层（BTL-278）。 */
  private async heldBelowNoted(stack: StackRow, row: LayerRow, tip: string, pushedNow?: ReadonlySet<string>): Promise<LayerRow | null> {
    const below = await this.heldBelow(stack, row, tip, pushedNow);
    // 不拦了就清掉（推没推成都清：推失败不是被下面那层拦的）。这一层推上去以后不另外清，靠这里
    if (below) this.heldOf.set(row.id, { byId: below.id, byBranch: below.branch, tip });
    else this.heldOf.delete(row.id);
    return below;
  }

  /**
   * 这一层已经推上去了（本地 = 远端）：它以前查出的标记作废，它不再算被拦，被它拦住的层也不再算被拦（BTL-278 复核 V6：
   * 上面那层的 force_push 关着、不会再走 heldBelowNoted 的话，「现在」页会一直说它被这层拦住）。按层 id 认，不按分支名（别的栈可能同名）。
   */
  private pushedOut(layerId: number): void {
    this.dropMarkers(layerId);
    this.heldOf.delete(layerId);
    for (const [k, h] of this.heldOf) if (h.byId === layerId) this.heldOf.delete(k);
  }

  /**
   * 「现在」页上有提醒的层（带着冲突标记或查不了、拦着上面的层、被下面拦住）已经被 session 自己推上去了（本地 = 远端）：
   * 撤掉这些提醒（BTL-278 复核 V6）。补推前跑（每轮、手动 rebase 之后都来）。不靠 heldBelow 碰巧路过：上面的层 force_push
   * 关着、它自己又没有 remoteOkSha 时，没有别的路径会再看它。只看有提醒的层（一次 git 读全部 ref），没有就不起 git。
   */
  private async releasePushed(s: StackRow): Promise<void> {
    const layers = this.d.repo.layers(s.id);
    const ids = new Set<number>();
    for (const m of this.markersOf.values()) if (m.files === null || m.files.length > 0) ids.add(m.layerId);
    for (const [id, h] of this.heldOf) ids.add(id).add(h.byId);
    const ls = layers.filter((l) => l.state !== "merged" && ids.has(l.id));
    if (ls.length === 0) return;
    const remotes = new Map<string, string | null>();
    for (const l of ls) remotes.set(l.branch, await this.pushRemote(s, l.branch));
    const tips = await refTips(s.repoPath, ls.flatMap((l) => [`refs/heads/${l.branch}`, ...(remotes.get(l.branch) ? [`refs/remotes/${remotes.get(l.branch)}/${l.branch}`] : [])]));
    for (const l of ls) {
      const local = tips.get(`refs/heads/${l.branch}`) ?? null;
      const rm = remotes.get(l.branch);
      if (!local || !rm || tips.get(`refs/remotes/${rm}/${l.branch}`) !== local) continue;
      // 推上去的正是查出带标记的那个提交：标记跟着到了远端，记一笔（提醒照样撤：远端现在就是这样，再拦也拦不回来）
      const m = [...this.markersOf.values()].find((x) => x.layerId === l.id && x.local === local && x.files !== null && x.files.length > 0);
      if (m) this.d.log(`stacks: ${l.branch} was pushed at ${sha7(local)} with the conflict markers Shipherd found in ${m.files!.join(", ")}`);
      this.pushedOut(l.id);
    }
  }

  /**
   * 这一层记着的「被谁拦住」还作数的话，拦它的那层（BTL-278 复核）：同一个栈里、id 和分支名都对得上（层 id 会被新加的层复用）、
   * 没合并、在它下面、现在确实还被标记拦着（markerBlocked），而且这一层还停在当时要推的顶端。
   * 不作数的记录当场删掉（BTL-278 复核 P3）：留着的话，拦它的层移出栈修好再加回来、或者新层复用了它的 id，旧记录会复活。
   * 栈正在跑时只认不删：改写到一半，层的 tipSha 还没写回，这时删了，force_push 关着的层就没人再记回来。
   */
  private heldBy(s: StackRow, layers: LayerRow[], l: LayerRow): LayerRow | null {
    const h = this.heldOf.get(l.id);
    if (!h) return null;
    const by = layers.find((x) => x.id === h.byId && x.branch === h.byBranch);
    if (h.tip === l.tipSha && by && by.state !== "merged" && by.position < l.position && this.markerBlocked(by) !== null) return by;
    if (!this.running.has(s.id)) this.heldOf.delete(l.id);
    return null;
  }

  /** 层的分支现在还归它的 ticket 管：ticket 没关、没归档，分支还在 ticket 的仓库里，而且认出的 ticket 就是这一层的（分支名没被别的 ticket 拿去用）。 */
  private live(repoPath: string, l: { branch: string; ticketKey: string | null }): boolean {
    const o = this.d.owned(repoPath, l.branch);
    return o !== null && (l.ticketKey === null || o.ticketKey === l.ticketKey);
  }

  private dropMarkers(layerId: number): void {
    for (const [k, v] of this.markersOf) if (v.layerId === layerId) this.markersOf.delete(k);
  }

  /**
   * 要推的顶端比远端那份多出了哪些文件的冲突标记（BTL-278）：远端那份是旧顶端（旧起点 = 它和新起点的 merge-base），
   * 层这段提交本来就带着、远端也有的标记不算。远端还没有这个分支：按新起点比。newBase 不知道时按父层（栈底是 trunk）现在的顶端算。
   * 返回 null = 查不了（git 出错、找不到起点）：按「不干净」处理。
   * 结果按（层、要推的顶端、远端顶端）记下：两头没变就不重查、不重复记日志；查不了的退避着重查（MARKERS_RETRY_MS 起，翻倍）。
   */
  private async markersVsRemote(s: StackRow, l: LayerRow, local: string, remote: string | null, newBase: string | null): Promise<string[] | null> {
    const key = `${l.id}:${local}:${remote}`;
    const prev = this.markersOf.get(key);
    const now = this.d.now();
    if (prev && (prev.files !== null || now - prev.at < Math.min(MARKERS_RETRY_MAX_MS, MARKERS_RETRY_MS * 2 ** (prev.n - 1)))) return prev.files;
    let files: string[] | null = null;
    try {
      const base = newBase ?? (await this.parentBase(s, l, local));
      if (!base) throw new Error("no base");
      const oldBase = remote ? await mergeBase(s.repoPath, remote, base) : base;
      if (!oldBase) throw new Error(`no merge base of ${remote} and ${base}`);
      const bad = await markersAdded(s.repoPath, [{ branch: l.branch, oldTip: remote ?? base, oldBase, newBase: base, newTip: local }]);
      files = bad.flatMap((b) => b.files);
      if (files.length > 0) this.d.log(`stacks: not pushing ${l.branch}: conflict markers in ${files.join(", ")}`);
    } catch (e) {
      this.d.log(`stacks: not pushing ${l.branch}: checking for conflict markers failed`, e);
    }
    // 同一层旧的结果作废
    this.dropMarkers(l.id);
    this.markersOf.set(key, { layerId: l.id, local, remote, files, at: now, n: files === null ? (prev?.files === null ? prev.n + 1 : 1) : 0 });
    return files;
  }

  /** 层的起点不知道时（恢复备份）：它和父层（栈底是 trunk）现在的顶端的 merge-base。 */
  private async parentBase(s: StackRow, l: LayerRow, tip: string): Promise<string | null> {
    const below = this.d.repo.layers(s.id).filter((x) => x.state !== "merged" && x.position < l.position).at(-1);
    const parent = below
      ? await revParse(s.repoPath, `refs/heads/${below.branch}`)
      : ((await remoteTip(s.repoPath, s.remote, s.trunk)) ?? (await revParse(s.repoPath, `refs/heads/${s.trunk}`)));
    return parent ? mergeBase(s.repoPath, tip, parent) : null;
  }

  /**
   * 因为冲突标记（或者查不了）没推、现在还停在查过的那个顶端的层（「现在」页提醒用）：按这一层最新的那次查认，
   * 不按 remoteOkSha 拼：Shipherd 没改写过的层（session 自己提交了带标记的解法、没推）也会拦住上面的层（BTL-278）。
   * remote：查的时候远端那份（null = 远端还没有它）。
   */
  private markerBlocked(l: LayerRow): { files: string[]; remote: string | null } | null {
    if (l.state === "merged" || l.tipSha === null) return null;
    // 同一个本地顶端可能按不同的远端顶端查过几次（远端动了）：看最近查的那次
    let v: { files: string[] | null; remote: string | null; at: number } | null = null;
    for (const x of this.markersOf.values()) if (x.layerId === l.id && x.local === l.tipSha && (!v || x.at >= v.at)) v = x;
    if (!v) return null;
    return v.files === null || v.files.length > 0 ? { files: v.files ?? [], remote: v.remote } : null;
  }

  /**
   * 旧版（BTL-278 之前）给栈所在的仓库打开过 rerere：没有任何一层配过 rerere.enabled 时写了 local 层的 rerere.enabled=true
   * （autoUpdate 只在引擎的命令行上带，没写进配置）。session 照冲突提示 rebase 时 git 会按它套用 rr-cache 里放弃过的解法。
   * 每个仓库只看一次（记在 workRoot 旁边的 stack-rerere-cleaned.json 里）：local 层正好是 Shipherd 写的样子（"true"、没有 local 的
   * autoUpdate、global 和 system 都没配）就删掉这一项，rr-cache 改名留作备份（不删，git 不再用它）。用户自己配的不动。
   */
  /**
   * stack-rerere-cleaned.json：candidates = 这一版第一次启动（建这个文件）时建过栈的仓库（删掉的栈也算；旧版在那里可能跑过
   * rebase、打开过 rerere；只跑过没变化的 run 不留行，所以不按 stack_runs 算），done = 已经处理过的仓库。只清候选；
   * 别的仓库、以及升级以后才建栈的仓库里的 local rerere 是用户自己开的，不动（BTL-278）。
   * 读出来改完再原子地写回（同一个进程里串行），不会并发丢记录。
   */
  /** 读过、写过的 stack-rerere-cleaned.json（写不进去时这次运行期间照用这份：不按那时的 stacks 表重算候选）。 */
  private rerereMemoCache: { candidates: string[]; done: string[] } | null = null;

  /**
   * 记录放在 workRoot 外面（它旁边）：cleanupWork 每次启动和每天都清空 workRoot，放在里面的话重启后就按那时的 stacks 表
   * 重算候选，把用户后来自己开的 rerere 也关掉（BTL-278）。
   */
  private rerereMemoFile(): string {
    return join(dirname(this.d.workRoot), "stack-rerere-cleaned.json");
  }

  private rerereMemo(): { candidates: string[]; done: string[] } {
    if (this.rerereMemoCache) return this.rerereMemoCache;
    const read = (file: string): { candidates: string[]; done: string[] } | null => {
      try {
        const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
        const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
        if (j && typeof j === "object" && !Array.isArray(j)) {
          const o = j as { candidates?: unknown; done?: unknown };
          return { candidates: strs(o.candidates), done: strs(o.done) };
        }
      } catch {
        // 还没有
      }
      return null;
    };
    const memo = read(this.rerereMemoFile());
    if (memo) return (this.rerereMemoCache = memo);
    // 上一版放在 workRoot 里（还没被清掉的话）：搬过来，不按现在的 stacks 表重算
    const legacy = join(this.d.workRoot, "rerere-cleaned.json");
    const old = read(legacy);
    const next = old ?? { candidates: [...new Set(this.d.repo.repoPathsOfStacks().map((p) => resolve(p)))], done: [] as string[] };
    // 旧文件不用删：启动时 cleanupWork 清空 workRoot，它跟着没了。写不进去时只剩内存里这份（这次运行期间照用，
    // 重启后旧文件已经没了，会按那时的 stacks 表重算候选）
    this.writeRerereMemo(next);
    return next;
  }

  /** 写下记录（原子地换掉旧的）；写不进去时内存里留着这份。返回写没写成。 */
  private writeRerereMemo(memo: { candidates: string[]; done: string[] }): boolean {
    this.rerereMemoCache = memo;
    const file = this.rerereMemoFile();
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(memo));
      renameSync(tmp, file);
      return true;
    } catch (e) {
      this.d.log(`stacks: recording the rerere cleanup failed`, e);
      return false;
    }
  }

  private markRerereDone(key: string): void {
    const memo = this.rerereMemo();
    if (!memo.done.includes(key)) this.writeRerereMemo({ ...memo, done: [...memo.done, key] });
  }

  private rerereQueue: Promise<void> = Promise.resolve();

  private cleanLegacyRerere(repoPath: string): Promise<void> {
    const next = this.rerereQueue.then(() => this.cleanLegacyRerereNow(repoPath));
    this.rerereQueue = next.catch(() => undefined);
    return next;
  }

  private async cleanLegacyRerereNow(repoPath: string): Promise<void> {
    const key = resolve(repoPath);
    if (this.rerereChecked.has(key)) return;
    this.rerereChecked.add(key);
    const memo = this.rerereMemo();
    if (memo.done.includes(key)) return;
    // 旧版没在这里跑过：local 层的 rerere 是用户自己开的
    if (!memo.candidates.includes(key)) return this.markRerereDone(key);
    const get = (args: string[]) => runGit(key, ["config", ...args]).catch(() => ({ code: -1, stdout: "", stderr: "" }));
    const local = await get(["--local", "--get", "rerere.enabled"]);
    // git 出错：这次不算看过，下次再看
    if (local.code !== 0 && local.code !== 1) return void this.rerereChecked.delete(key);
    let cleaned = false;
    let failed = false;
    if (local.code === 0 && local.stdout.trim() === "true") {
      const others = [await get(["--local", "--get", "rerere.autoUpdate"]), await get(["--global", "--get", "rerere.enabled"]), await get(["--system", "--get", "rerere.enabled"])];
      if (others.some((r) => r.code !== 0 && r.code !== 1)) return void this.rerereChecked.delete(key);
      if (others.every((r) => r.code === 1)) {
        const u = await get(["--local", "--unset", "rerere.enabled"]);
        if (u.code !== 0) {
          // 同一个键有多个值（退出码 5）之类：不是旧版那一行，记下来不再每轮重试
          failed = true;
          this.d.log(`stacks: leaving rerere on in ${key}: git config --unset exited ${u.code} ${u.stderr.trim()}`);
        } else {
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
    }
    this.markRerereDone(key);
    this.d.record?.("stack.rerere_cleanup", { cleaned, failed });
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
      // fork 工作流（BTL-278）：trunk 跟着 upstream，层的分支却在 origin 上；origin 也 fetch，推送前才认得出远端现在的样子
      const remotes = [remote];
      if (remote !== "origin" && (await runGit(repoPath, ["config", "--get", "remote.origin.url"]).catch(() => null))?.code === 0) remotes.push("origin");
      for (const rm of remotes) {
        const r = await withRepoLock(repoPath, () => fetchRemote(repoPath, rm), `fetch ${rm} for stacks`).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
        if (r.code !== 0) this.d.log(`stacks: fetch ${rm} in ${repoPath} failed: ${r.stderr.trim()}`);
      }
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
      // ticket 关掉、归档了（或分支不归它了）的层：栈服务不再管它，只出 ticket_closed 那一条。它自己的标记、被拦、刚改写过的提醒
      // 都不出（BTL-278 复核 P5：那些提醒承诺下一轮补推，和「不再推」对不上）
      const dead = open.filter((l) => !this.live(s.repoPath, l));
      const deadIds = new Set(dead.map((l) => l.id));
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
        out.push({ reason: "confirm", stackId: s.id, stackName: s.name, branch: pending[0]!, branches: pending, detail: lr.detail.confirm.why, push: lr.detail.confirm.push ?? true, toSession: lr.detail.confirm.toSession ?? true, ticketKey: l?.ticketKey ?? null, prNumber: l?.prNumber ?? null });
      }
      // 刚自动改写过、还停在 Shipherd 写的顶端的层（之后有人提交了就说明有人接手了）：提醒没编译过（BTL-278）
      if (lr?.outcome === "rebased" && lr.trigger !== "manual" && now - (lr.finishedAt ?? lr.startedAt) < REWRITTEN_NOTICE_MS) {
        const rewritten = (lr.detail.layers ?? [])
          .filter((d) => d.newTip !== d.oldTip && open.some((l) => l.branch === d.branch && l.tipSha === d.newTip && !deadIds.has(l.id)))
          .map((d) => d.branch);
        if (rewritten.length > 0) {
          const l = layers.find((x) => x.branch === rewritten[0]);
          const asked = rewritten.filter((b) => lr.detail.verifyAsked?.includes(b));
          out.push({ reason: "rewritten", stackId: s.id, stackName: s.name, branch: rewritten[0]!, branches: rewritten, asked, ticketKey: l?.ticketKey ?? null, prNumber: l?.prNumber ?? null });
        }
      }
      if (lr && (lr.outcome === "deferred" || lr.outcome === "failed" || lr.outcome === "rolled_back") && now - lr.startedAt >= STUCK_AFTER_MS) {
        // 读不到 PR（GitHub Enterprise 之类 gh 没登录的主机）：说清楚为什么、怎么办（BTL-278）
        const prs = lr.outcome === "deferred" && lr.reason?.startsWith(PRS_UNREADABLE) ? /^can't read the open PRs on (\S+);/.exec(lr.reason) : null;
        if (lr.outcome === "deferred" && lr.reason?.startsWith(NOT_LIVE)) {
          // 下面 ticket_closed 那条说了
        } else if (lr.outcome === "deferred" && lr.reason?.startsWith(PRS_UNREADABLE)) {
          out.push({ reason: "prs_unreadable", stackId: s.id, stackName: s.name, branch: open[0]!.branch, host: prs?.[1] ?? null, ticketKey: open[0]!.ticketKey });
        } else {
          out.push({ reason: "stuck", stackId: s.id, stackName: s.name, branch: open[0]!.branch, detail: lr.reason, ticketKey: open[0]!.ticketKey });
        }
      }
      // 因为冲突标记没推的层（BTL-278）：不提醒的话它就一直不推，没人知道。按它是哪种层说：
      // 从没推过的新栈底（也没开 PR）、从没推过的中间层、改写过没推出去的、本地有没推的提交（session 自己提交的）
      for (const l of open) {
        if (deadIds.has(l.id)) continue;
        const m = this.markerBlocked(l);
        if (!m) continue;
        const where: StackMarkersWhere = m.remote === null ? (l.id === open[0]!.id ? "new_bottom" : "new_layer") : l.remoteOkSha !== null ? "rewritten" : "local";
        out.push({ reason: "markers", stackId: s.id, stackName: s.name, branch: l.branch, files: m.files, where, ticketKey: l.ticketKey, prNumber: l.prNumber });
      }
      // 被下面带标记的层拦住、没推的层：点名拦它的那层（那层自己有一条 markers 提醒）。同一层拦住的几层并成一条
      const held = new Map<string, LayerRow[]>();
      for (const l of open) {
        if (deadIds.has(l.id)) continue;
        const by = this.heldBy(s, layers, l);
        if (by && !deadIds.has(by.id)) held.set(by.branch, [...(held.get(by.branch) ?? []), l]);
      }
      for (const [by, ls] of held) {
        out.push({ reason: "held_below", stackId: s.id, stackName: s.name, branch: ls[0]!.branch, branches: ls.map((l) => l.branch), by, ticketKey: ls[0]!.ticketKey, prNumber: ls[0]!.prNumber });
      }
      // 有层的 ticket 关掉或归档了：栈服务不再改写、推这个栈，也不给这一层开 PR，要人把它移出栈（BTL-278 复核）。
      // 按现在的 ticket 状态算（不靠 run 记录）：ticket 重新打开、层移出栈，提醒就没了。autoRebase 关着时本来就不自动改写，
      // 不提醒（BTL-278 复核 P4）：手动操作被拒时，拒绝的提示里说原因
      if (p.autoRebase && dead.length > 0) {
        out.push({ reason: "ticket_closed", stackId: s.id, stackName: s.name, branch: dead[0]!.branch, branches: dead.map((l) => l.branch), ticketKey: dead[0]!.ticketKey, prNumber: dead[0]!.prNumber });
      }
      // 新栈底认不出推到哪个 remote：不推、不开 PR，要人指定（BTL-278）
      const np = this.noPushRemote.get(s.id);
      const npl = np ? open.find((l) => l.id === np.layerId) : undefined;
      if (npl && npl.id === open[0]!.id && !npl.prNumber) {
        out.push({ reason: "no_push_remote", stackId: s.id, stackName: s.name, branch: npl.branch, ticketKey: npl.ticketKey, prNumber: null });
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
