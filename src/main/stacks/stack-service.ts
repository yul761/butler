import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { ExternalActionKind } from "../../shared/external";
import type {
  StackActionResult, StackLayerMode, StackLayerView, StackNoticeInfo, StackPolicy, StackRunMode, StackRunView, StackTrigger,
  StackView, StacksFilter, StacksView,
} from "../../shared/stacks";
import { JOB_STACKS_DAILY, type JobsRepo } from "../db/jobs-repo";
import type { LayerRow, NewLayer, RunDetail, RunRow, StackRow, StacksRepo } from "../db/stacks-repo";
import type { AttemptResult, ExternalDetail } from "../external/actions";
import { applyTips, deferText, deleteBackups, type ApplyLayer } from "./apply";
import {
  behind, fetchRemote, gitVersion, hasFixups, isAncestor, pushBranch, remoteFor, remoteTip, revParse, runGit, subjects, supportsUpdateRefs, worktreeBranches,
} from "./git-stack";
import * as gh from "./gh-stack";
import { bottomBody, dependsLine, draftBody, draftTitle, overviewBody, stripPrefix, T, withDependsLine, withoutDependsLine, type GraphLayer } from "./pr-text";
import { runEngine, type EngineLayer, type NewTip } from "./rebase-engine";
import type { StackPolicyService } from "./stack-policy";
import { prUrlKey, prUrlParts } from "../../shared/pr-url";

/**
 * 栈式 PR（工作流 K，设计 2026-11-17-ws-k-stacks-design）：维护本地栈表，整栈自动 rebase，栈底合并后提升新栈底，
 * 管 draft 层、提醒、epic 总览。所有改本地分支的事要 autoRebase 开着；所有对外的事走 ExternalActions。
 */

/** 分支属于哪个 Butler ticket。 */
export interface OwnedBranch {
  ticketKey: string;
  ticketRepoId: number;
  ticketTitle: string | null;
  /** 这个 ticket 由 Butler 管理的 worktree（workMode = worktree、没清理、目录在）；没有为 null。 */
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
  external: {
    attempt<T>(kind: ExternalActionKind, detail: ExternalDetail, run: () => Promise<T>): Promise<AttemptResult<T>>;
    allowed(kind: ExternalActionKind, scope?: ExternalDetail["scope"]): boolean;
  };
  /** 临时 worktree 的目录（<BUTLER_HOME>/stack-work）。 */
  workRoot: string;
  /** 跑 sequence editor 的 node。 */
  execPath: string;
  now(): number;
  log(msg: string, err?: unknown): void;
  /** 分支是不是 Butler 的（ticket_repos.branch 或 branch_owners）。 */
  owned(repoPath: string, branch: string): OwnedBranch | null;
  /** 仓库 slug（gh 的 GH_REPO）。 */
  slugOf(repoPath: string): Promise<string | null>;
  /** 这个目录里的 session 在忙。 */
  sessionBusy(path: string): boolean;
  /** 这个分支有合并闸的活动占位。 */
  gateHeld(repoPath: string, branch: string): boolean;
  /** 有别的分支正占着往 trunk 合（ignore 里的分支不算）。 */
  trunkBusy(repoPath: string, trunk: string, ignore: string[]): boolean;
  /** 工作流 I：这个 PR 有送进 session、还没核对的评论。 */
  awaitingCheck?(prUrl: string): boolean;
  /** 把一段话送进这一层的 session（ticket 的这个仓库、这个分支）；true = 递进去了。 */
  deliver(to: { ticketKey: string; ticketRepoId: number | null; branch: string }, text: string): Promise<boolean>;
  /** 工作流 G 的 review 简报。 */
  briefProvider?(layer: BriefLayer): { markdown: string; posted(prUrl: string): void } | null;
  /** 度量（契约 4.7）。 */
  record?(kind: string, data: Record<string, string | number | boolean | null>, dedupeKey?: string): void;
  /** 栈或提醒变了（推给界面）。 */
  onChange?(): void;
  /** epic 名（总览标题用）。 */
  epicName?(id: number): string | null;
  /** 每日任务的记录（jobs 表）。 */
  jobs?: Pick<JobsRepo, "get" | "record">;
  /** 自动检测栈的仓库（Butler 管的仓库）。 */
  repos?(): string[];
  /** 测试用：强制逐层模式。 */
  forceMode?: StackRunMode;
}

export interface DefineInput {
  repoPath: string;
  branches: string[];
  name?: string | null;
  epicId?: number | null;
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
const DETECT_EVERY_MS = 15 * 60_000;
const CONFLICT_NOTICE_AFTER_MS = 30 * 60_000;
const STUCK_AFTER_MS = 24 * 3600_000;
export const BACKUP_KEEP_MS = 30 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
const DAILY_RETRY_MS = 30 * 60_000;

const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

const sha7 = (s: string | null) => (s ? s.slice(0, 7) : "");

/** conflictKey 是 `${branch}:${onto}:${upstream}:${trunk,各层顶端}`（分支名里不会有冒号）：取 onto。 */
export function conflictOnto(key: string | null): string | null {
  return key ? (key.split(":")[1] ?? null) : null;
}

/** conflictKey 里判断「同一个冲突」的部分：分支和这次 run 的输入。 */
function conflictInputs(key: string): string {
  const p = key.split(":");
  return `${p[0]}:${p[3] ?? ""}`;
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
  private readonly rerereOn = new Set<string>();
  /** 栈底落后 trunk 多少（tick 里算，界面和提醒用）。 */
  private readonly behindCache = new Map<number, { commits: number; oldestAt: number | null }>();
  private ticking = false;
  /** 每个栈上次试 autosquash 时各层的顶端。 */
  private readonly autosquashTried = new Map<number, string>();

  constructor(private readonly d: StackServiceDeps) {}

  // ---------------------------------------------------------------- 栈的来源

  /** stack_define：建一个栈，或者整个替换已有栈的层。 */
  async define(i: DefineInput): Promise<StackActionResult & { stackId?: number }> {
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
      this.changed();
      return { ok: true, stackId: s.id };
    }
    const slug = await this.d.slugOf(repoPath).catch(() => null);
    const trunk = await this.trunkOf(repoPath);
    const remote = await remoteFor(repoPath, trunk);
    const name = i.name?.trim() || layers.map((l) => l.ticketKey ?? l.branch).join(" → ");
    const id = this.d.repo.create(
      { repoPath, repoSlug: slug, trunk, remote, name, epicId: i.epicId ?? null, featureId: i.featureId ?? null, source: i.source },
      layers,
    );
    this.d.log(`stacks: defined stack ${id} (${name}) in ${repoPath}`);
    this.changed();
    return { ok: true, stackId: id };
  }

  /** create_ticket 的 stack_on：新分支接到 parent 分支所在栈的顶上（没有栈就新建两层的栈）。 */
  async stackOn(p: { repoPath: string; parentBranch: string; branch: string; featureId: number | null; epicId: number | null }): Promise<StackActionResult & { stackId?: number }> {
    const repoPath = resolve(p.repoPath);
    const hit = this.d.repo.findBranch(repoPath, p.parentBranch);
    if (!hit) return this.define({ repoPath, branches: [p.parentBranch, p.branch], featureId: p.featureId, epicId: p.epicId, source: "ticket" });
    const layers = this.d.repo.layers(hit.stack.id);
    const top = layers[layers.length - 1]!;
    if (top.branch !== p.parentBranch) return { ok: false, message: T().errors.notTop(p.parentBranch) };
    const o = this.d.owned(repoPath, p.branch);
    if (!o) return { ok: false, message: T().errors.notOwned(p.branch) };
    const tip = await revParse(repoPath, `refs/heads/${p.branch}`);
    this.d.repo.addLayer(hit.stack.id, { branch: p.branch, ticketKey: o.ticketKey, ticketRepoId: o.ticketRepoId, tipSha: tip, baseSha: top.tipSha });
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

  /** 自动检测：Butler 的开着的 PR 里 base 是另一个 Butler PR 的 head 的，连成链（两层以上、都不在栈里）就建栈。 */
  async detect(repoPath: string): Promise<number[]> {
    repoPath = resolve(repoPath);
    const slug = await this.d.slugOf(repoPath).catch(() => null);
    const prs = await gh.openPrs(repoPath, slug);
    if (!prs) return [];
    // 用户删掉过的栈里的分支不再自动建回来
    const mine = prs.filter((p) => this.d.owned(repoPath, p.head) && !this.d.repo.findBranch(repoPath, p.head) && !this.d.repo.inRemovedStack(repoPath, p.head));
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
      const r = await this.define({ repoPath, branches: chain.map((c) => c.head), source: "detected" });
      if (!r.ok || !r.stackId) continue;
      for (const l of this.d.repo.layers(r.stackId)) {
        const pr = chain.find((c) => c.head === l.branch)!;
        this.d.repo.updateLayer(l.id, {
          prNumber: pr.number, prUrl: pr.url, mode: pr.isDraft ? "draft" : "branch", state: pr.isDraft ? "draft" : "ready", draftSince: pr.isDraft ? this.d.now() : null,
        });
      }
      created.push(r.stackId);
    }
    return created;
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

  /** 手动（界面、stack_rebase）。 */
  async rebaseNow(stackId: number): Promise<StackActionResult> {
    const s = this.d.repo.get(stackId);
    if (!s || s.removedAt) return { ok: false, message: T().errors.notFound };
    if (!this.policyOf(s).autoRebase) return { ok: false, message: T().errors.autoRebaseOff };
    if (this.running.has(stackId)) return { ok: false, message: T().errors.busy };
    const run = await this.run(s, "manual");
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
    const policy = this.policyOf(stack0);
    await this.ensureRerere(repo);
    await this.fetch(repo, stack0.remote, true);
    const stack = this.d.repo.get(stack0.id)!;
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
      this.d.repo.finishRun(runId, { outcome: "failed", reason: res.reason });
      return this.d.repo.run(runId);
    }
    if (res.kind === "conflict") return this.onConflict(stack, open, runId, res, policy, [trunkSha, ...engineLayers.map((l) => l.tip)].join(","));

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
      this.d.repo.finishRun(runId, { outcome: "rolled_back", reason: applied.reason, detail: { layers: applied.layers } });
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
    await this.afterRun(stack, trigger);
    return this.d.repo.run(runId);
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
    }
    // 引擎没列出来的层（noop 时它只列到第一层要动的为止）：顶端照实记
    this.d.repo.updateStack(stack.id, { trunkSha });
  }

  private async forcePush(stack: StackRow, l: ApplyLayer, row: LayerRow): Promise<boolean> {
    if (!this.d.owned(stack.repoPath, l.branch)) {
      this.d.log(`stacks: not pushing ${l.branch}: not a Butler branch`);
      return false;
    }
    const r = await this.d.external.attempt(
      "force_push",
      { scope: { repoSlug: stack.repoSlug, ticketKey: row.ticketKey }, target: l.branch, summary: `stack rebase: ${l.branch} ${sha7(l.remoteTip)} → ${sha7(l.newTip)}` },
      () => pushBranch(stack.repoPath, stack.remote, l.branch, l.remoteTip),
    );
    return r.ran;
  }

  private async onConflict(
    stack: StackRow, open: LayerRow[], runId: number,
    res: { position: number; branch: string; files: string[]; commit: string | null; onto: string; upstream: string }, policy: StackPolicy,
    inputs: string,
  ): Promise<RunRow | null> {
    const detail: RunDetail = { conflict: { branch: res.branch, files: res.files, commit: res.commit, onto: res.onto, upstream: res.upstream } };
    this.d.repo.finishRun(runId, { outcome: "conflict", reason: `${res.branch}: ${res.files.join(", ")}`, detail });
    this.d.record?.("stack.conflict", { files: res.files.length });
    const layer = open.find((l) => l.branch === res.branch)!;
    // onto 是下面那层重新 rebase 出来的顶端，每次 run 都不一样（提交时间）：是不是同一个冲突按这次的输入（trunk 和各层顶端）判断
    const key = `${res.branch}:${res.onto}:${res.upstream}:${inputs}`;
    // 同一个冲突：记号不动（session 照着的是送给它的那条命令里的 onto）
    if (layer.conflictKey && conflictInputs(layer.conflictKey) === `${res.branch}:${inputs}`) return this.d.repo.run(runId);
    this.d.repo.updateLayer(layer.id, { conflictKey: key });
    if (policy.conflictToSession) await this.deliverConflict(stack, runId);
    return this.d.repo.run(runId);
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
    const text = T().conflict({ branch: c.branch, files: c.files, onto: c.onto, upstream: c.upstream, above, push });
    let ok = false;
    try {
      ok = await this.d.deliver({ ticketKey: layer.ticketKey, ticketRepoId: layer.ticketRepoId, branch: layer.branch }, text);
    } catch (e) {
      this.d.log(`stacks: delivering the conflict on ${c.branch} failed`, e);
    }
    if (ok) this.d.repo.finishRun(runId, { outcome: "conflict", reason: run.reason, detail: { ...run.detail, delivered: true } });
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

  /** draft 层的 k/n 和「依赖 #N」按现在的顺序改（只在变了时改）。 */
  async syncDrafts(stack: StackRow): Promise<void> {
    const all = this.d.repo.layers(stack.id);
    for (let i = 0; i < all.length; i++) {
      const l = all[i]!;
      if (l.state !== "draft" || !l.prNumber) continue;
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
      if (now - this.lastDetect >= DETECT_EVERY_MS && this.d.repos && this.d.policy.anyAutoRebase()) {
        this.lastDetect = now;
        // 自动检测只在开了 autoRebase 的仓库里做（gh 调用不白跑）
        for (const r of this.d.repos()) {
          if (!existsSync(r)) continue;
          const slug = await this.d.slugOf(r).catch(() => null);
          if (!this.d.policy.forSlug(slug).autoRebase) continue;
          await this.detect(r).catch((e) => this.d.log(`stacks: detect in ${r}`, e));
        }
      }
      for (const [repoPath, list] of repos) {
        if (!existsSync(repoPath)) continue;
        const fetched = await this.fetch(repoPath, list[0]!.remote, false);
        for (const s0 of list) {
          const s = this.d.repo.get(s0.id)!;
          const p = this.policyOf(s);
          await this.updateBehind(s).catch((e) => this.d.log(`stacks: behind for stack ${s.id}`, e));
          if (!p.autoRebase) continue;
          const trigger = await this.dueTrigger(s, p, fetched);
          if (trigger) {
            if (trigger === "daily") this.d.repo.updateStack(s.id, { lastDailyAt: now });
            await this.run(s, trigger);
          } else if (p.autosquash) {
            await this.maybeAutosquash(s);
          }
          await this.retryPending(this.d.repo.get(s.id)!, p);
        }
      }
      this.changed();
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
        continue;
      }
      if ((await this.dueTrigger(s, p, false)) === "layer_commits") await this.run(s, "layer_commits");
    }
  }

  private async dueTrigger(s: StackRow, p: StackPolicy, fetched: boolean): Promise<StackTrigger | null> {
    const open = this.d.repo.layers(s.id).filter((l) => l.state !== "merged");
    if (open.length === 0) return null;
    for (const l of open) {
      const tip = await revParse(s.repoPath, `refs/heads/${l.branch}`);
      if (tip && tip !== l.tipSha) return "layer_commits";
    }
    if (p.rebaseOnMainUpdate && (fetched || s.trunkSha === null)) {
      const trunk = await remoteTip(s.repoPath, s.remote, s.trunk);
      if (trunk && trunk !== s.trunkSha) return "main_updated";
    }
    // 栈底合并的那次 run 推迟过或失败过：重新跑（回滚的不自动重来，等人看）
    const lr = this.d.repo.lastRun(s.id);
    if (lr?.trigger === "bottom_merged" && (lr.outcome === "deferred" || lr.outcome === "failed")) return "bottom_merged";
    if (p.dailyRebase && (s.lastDailyAt === null || dayOf(s.lastDailyAt) !== dayOf(this.d.now()))) return "daily";
    return null;
  }

  /** 第 5.3 节：栈是新的、某层有 fixup 提交、I 不在核对：autosquash。 */
  private async maybeAutosquash(s: StackRow): Promise<void> {
    const open = this.d.repo.layers(s.id).filter((l) => l.state !== "merged");
    const lr = this.d.repo.lastRun(s.id);
    if (lr && (lr.outcome === "conflict" || lr.outcome === "deferred" || lr.outcome === "failed" || lr.outcome === "rolled_back")) return;
    let any = false;
    for (const l of open) {
      if (!l.tipSha || !l.baseSha) continue;
      if (l.prUrl && this.d.awaitingCheck?.(l.prUrl)) return;
      if (await hasFixups(s.repoPath, l.baseSha, l.tipSha).catch(() => false)) any = true;
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
    const scope = { repoSlug: s.repoSlug };
    const lr = this.d.repo.lastRun(s.id);
    const settled = !lr || lr.outcome === "rebased" || lr.outcome === "noop" || lr.outcome === "restored";
    if (settled && this.d.external.allowed("force_push", scope)) await this.pushPending(s);
    if (settled && p.autoOpenBottomPr && this.needsPromotion(s) && this.d.external.allowed("pr_open", scope)) await this.promoteBottom(s);
    if (p.overview === "issue" && this.d.external.allowed("issue_post", scope)) await this.syncOverview(s);
  }

  /**
   * 改写过、但当时 force_push 关着没推出去的层（remoteOkSha 有值）：开关打开后补推。
   * 只在远端还停在 Butler 替换掉的那个提交、本地还是 Butler 记下的顶端时推；别的情况留给下一次 run。
   */
  private async pushPending(s: StackRow): Promise<void> {
    for (const l of this.d.repo.layers(s.id)) {
      if (l.state === "merged" || l.remoteOkSha === null) continue;
      const local = await revParse(s.repoPath, `refs/heads/${l.branch}`);
      const remote = await remoteTip(s.repoPath, s.remote, l.branch);
      if (remote === local) {
        this.d.repo.updateLayer(l.id, { remoteOkSha: null });
        continue;
      }
      if (!local || local !== l.tipSha || remote !== l.remoteOkSha) continue;
      const ok = await this.forcePush(s, { position: l.position, branch: l.branch, oldTip: local, newTip: local, checkout: null, remoteTip: remote, remoteOkSha: l.remoteOkSha }, l).catch((e) => {
        this.d.log(`stacks: pushing ${l.branch} failed`, e);
        return false;
      });
      if (ok) this.d.repo.updateLayer(l.id, { remoteOkSha: null });
    }
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
      const r = await fetchRemote(repoPath, remote).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
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

  /** 第 3.7 节：开了 autoRebase 的仓库第一次跑时打开 rerere（session 自己解冲突时也会记下）。 */
  private async ensureRerere(repoPath: string): Promise<void> {
    if (this.rerereOn.has(repoPath)) return;
    this.rerereOn.add(repoPath);
    const cur = await runGit(repoPath, ["config", "--get", "rerere.enabled"]);
    if (cur.code === 0 && cur.stdout.trim() !== "") return;
    const r = await runGit(repoPath, ["config", "--local", "rerere.enabled", "true"]);
    if (r.code === 0) this.d.log(`stacks: enabled rerere in ${repoPath}`);
  }

  private async updateBehind(s: StackRow): Promise<void> {
    const bottom = this.d.repo.layers(s.id).find((l) => l.state !== "merged");
    const trunk = await remoteTip(s.repoPath, s.remote, s.trunk);
    const tip = bottom ? await revParse(s.repoPath, `refs/heads/${bottom.branch}`) : null;
    if (!bottom || !trunk || !tip) {
      this.behindCache.delete(s.id);
      return;
    }
    this.behindCache.set(s.id, await behind(s.repoPath, tip, trunk));
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

  /** 启动时和每天：上次没清掉的临时目录（Butler 中途退出）。 */
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
        void runGit(r, ["worktree", "prune"]).catch(() => undefined);
        void runGit(r, ["for-each-ref", "--format=%(refname)", "refs/heads/butler-stack/"]).then(async (o) => {
          for (const ref of o.stdout.split(/\r?\n/).filter(Boolean)) await runGit(r, ["update-ref", "-d", ref]);
        }).catch(() => undefined);
      }
    }
  }

  // ---------------------------------------------------------------- epic 总览

  async syncOverview(s: StackRow): Promise<void> {
    if (this.policyOf(s).overview !== "issue") return;
    const all = this.d.repo.layers(s.id);
    const body = overviewBody(await this.graph(s, all));
    const hash = simpleHash(body);
    if (hash === s.overviewHash) return;
    const title = T().overviewTitle(s.name, s.epicId ? (this.d.epicName?.(s.epicId) ?? null) : null);
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
      if (filter.epicId !== null && s.epicId !== filter.epicId) continue;
      const p = this.policyOf(s);
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
        id: s.id, name: s.name, repoPath: s.repoPath, repoSlug: s.repoSlug, trunk: s.trunk, epicId: s.epicId, featureId: s.featureId, source: s.source,
        mergeMethod: s.mergeMethod, autoRebase: p.autoRebase, overviewUrl: s.overviewUrl, layers, lastRun: lr ? runView(lr) : null, restorable: restorable ? runView(restorable) : null,
      });
    }
    return { stacks, updateRefs: supportsUpdateRefs(await gitVersion()) };
  }

  // ---------------------------------------------------------------- 小工具

  policyOf(s: StackRow): StackPolicy {
    return this.d.policy.forSlug(s.repoSlug);
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
