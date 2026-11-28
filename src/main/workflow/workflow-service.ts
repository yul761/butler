import type { AutomationLevel } from "../../shared/automation";
import type { PreReviewVerdict, ReviewTarget } from "../../shared/prereview";
import { ticketFinished, type Session, type Ticket, type TicketRepo } from "../../shared/types";
import {
  botOf, hasStep, maxRoundsOf, mergeByOf, parseWorkflow, pendingBefore, preReviewGatesPr, presetOf, progressOf, scopeKey, stepOf,
  type MergeBy, type ReviewBot, type TicketWorkflowView, type Workflow, type WorkflowLayerView, type WorkflowProblem, type WorkflowScope, type WorkflowStep,
  type WorkflowStepId,
  WORKFLOW_SCOPE_KINDS,
} from "../../shared/workflow";
import type { StageEvent } from "../db/pr-stage-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import type { BotRequest, WorkflowRepo } from "../db/workflow-repo";
import { LayeredResolver, type ScopeRef } from "../scope/layered";
import { aiReviewerOf } from "../tickets/gh";
import { samePath } from "../tickets/ticket-service";
import { botReviewCommands, type BotReviewResult } from "./bot-review";
import { WF } from "./strings";

/**
 * 工作流程（BTL-273）：分层取一个 ticket 的流程，按实际情况（预审、PR、CI、bot review、合并）和 session 的标记算每一步，
 * 用信箱提醒 session 下一步，走到 bot review 时请 Copilot / Codex，走到合并时告诉总控；闸门问它能不能开 PR、能不能合。
 *
 * 和自动化档位的关系（写在 epic 记忆里）：流程决定这个 ticket 走哪些步骤（有流程时预审开不开、评论转不转按流程）；
 * 档位只是总开关，决定对外动作谁做：半自动由 Shipherd 自己请 bot review，手动让 session 跑命令。
 */

/** 没有 CI 的仓库：PR 开了这么久还读不到 check，就当 CI 这一步不用等。 */
export const NO_CI_GRACE_MS = 10 * 60_000;
/** bot 的 review 比请求早一点也算这一轮的（请求的时间是 gh 返回的时间）。 */
const RESPONSE_SLACK_MS = 60_000;
/** 请求行的 error 写这个：对外动作开关关着，交给 session 请的（提醒里说开关在哪）。 */
const OFF_SWITCH = "external_off";
/** session 自己标的步骤；其余的按实际情况判断，session 标不了。 */
export const SESSION_STEPS: readonly WorkflowStepId[] = ["implement", "self_review", "address_comments", "re_review"];
/** 只看现在、不记进库的步骤。 */
const LIVE_ONLY: readonly WorkflowStepId[] = ["ci_green", "human_review"];
/** session 标步骤时的说明最多几个字（control 请求那边也按这个拒）。 */
export const STEP_NOTE_MAX = 500;

const NOTICE_REF = (key: string) => `workflow:${key}`;
const MERGE_REF = (key: string) => `workflow-merge:${key}`;
/** workflow_notices 里给总控的那一条用的键。 */
const MERGE_NOTICE = (key: string) => `${key}#merge`;

type WorkflowHolder = { workflow: Workflow | null };

export interface WorkflowServiceDeps {
  repo: WorkflowRepo;
  tickets: { get(key: string): Ticket | null; list(): Ticket[] };
  featureName(id: number): string | null;
  /** 名字或 id → feature id（MCP 的 epic:<名字>）。 */
  findFeature?(ref: string): number | null;
  productsOf(slug: string): { id: number; name: string }[];
  productName(id: number): string | null;
  findProduct?(ref: string): number | null;
  slugOf(path: string): string | null;
  prs: { byTicket(key: string): TicketPr[] };
  stages: { forTicket(key: string): StageEvent[] };
  preReviews: {
    latestFor(t: ReviewTarget): { verdict: PreReviewVerdict | null; id: number } | null;
    latestForBranch(slug: string, branch: string): { verdict: PreReviewVerdict | null; id: number; target: ReviewTarget } | null;
  };
  /** 分支现在的提交（本地 ref）；读不到 null。 */
  headSha(dir: string, branch: string): Promise<string | null>;
  level(ticketKey: string): AutomationLevel;
  mailbox: { send(i: { kind: "shipherd"; from: null; to: string; featureId: number | null; body: string; ref: string }): unknown; withdraw(ref: string): void };
  /** 这个 ticket 的开发 session（开着、休眠着都行）；没有 null。 */
  recipient(ticketKey: string): string | null;
  /** epic 的总控 session；没有 null。 */
  coordinator(featureId: number): string | null;
  session(id: string): Session | null;
  requestBotReview(pr: TicketPr, cwd: string, bot: ReviewBot): Promise<BotReviewResult>;
  /** 这几次 bot review 一共几条行内评论；没拉到为 null（不是 0）。 */
  reviewCommentCount(pr: TicketPr, cwd: string, reviewIds: string[]): Promise<number | null>;
  /** gh 在哪个目录跑（ticket 仓库的 worktree / 主 checkout）。 */
  ghCwd(pr: TicketPr): string | null;
  now(): number;
  log(msg: string, err?: unknown): void;
  onChange(): void;
}

export interface EffectiveWorkflow {
  workflow: Workflow;
  scope: WorkflowScope;
  label: string;
}

export type SetWorkflowResult = { ok: true; changed: boolean; workflow: Workflow | null } | { ok: false; problem: WorkflowProblem; message: string };

const isCoordinator = (s: Session | null): boolean => s !== null && s.ticketKey === null && (s.shipherd || (s.featureId !== null && s.fixesSession === null));

export class WorkflowService {
  private readonly resolver: LayeredResolver<WorkflowHolder>;
  /** 每个 ticket 的 evaluate 串起来跑：两次并发的判断不能各请一次 bot、各送一次提醒。 */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly d: WorkflowServiceDeps) {
    this.resolver = new LayeredResolver<WorkflowHolder>({
      defaults: { workflow: null },
      read: (ref) => {
        const l = this.d.repo.layer(this.fromRef(ref));
        return l ? { workflow: l.workflow } : null;
      },
      productsOf: d.productsOf,
      productName: d.productName,
    });
  }

  private fromRef(ref: ScopeRef): WorkflowScope {
    return ref.kind === "global" ? { kind: "global" } : ref.kind === "product" ? { kind: "product", productId: ref.productId } : { kind: "repo", slug: ref.slug };
  }

  // ---------------------------------------------------------------- 分层

  /** 有没有设过流程。PR 轮询、hook 这些热路径每次都问，所以只查一行（BTL-273 review 第 10 点）。 */
  anyWorkflow(): boolean {
    return this.d.repo.hasLayers();
  }

  /**
   * 这个 ticket 生效的流程（只要流程本身）；没设过任何流程就直接 null，不去读 ticket 和分层。
   * 读坏了也是 null：按原来的开关走。
   */
  workflowFor(ticketKey: string | null | undefined): Workflow | null {
    if (!ticketKey) return null;
    try {
      if (!this.anyWorkflow()) return null;
      return this.effective(ticketKey)?.workflow ?? null;
    } catch (e) {
      this.d.log(`workflow: reading the workflow of ${ticketKey} failed`, e);
      return null;
    }
  }

  label(scope: WorkflowScope): string {
    switch (scope.kind) {
      case "global":
        return "";
      case "product":
        return this.d.productName(scope.productId) ?? `#${scope.productId}`;
      case "repo":
        return scope.slug;
      case "feature":
        return this.d.featureName(scope.featureId) ?? `#${scope.featureId}`;
      case "ticket":
        return scope.ticketKey;
    }
  }

  /** 给人看的「来自哪里」。 */
  sourceText(scope: WorkflowScope): string {
    const s = WF().source;
    const l = this.label(scope);
    switch (scope.kind) {
      case "global":
        return s.global;
      case "product":
        return s.product(l);
      case "repo":
        return s.repo(l);
      case "feature":
        return s.feature(l);
      case "ticket":
        return s.ticket(l);
    }
  }

  /** ticket 的 product/repo 层按第一个有 slug 的仓库算（多仓库的 ticket 只认一份流程）。 */
  private slugOfTicket(t: Ticket): string | null {
    for (const r of [...t.repos].sort((a, b) => a.id - b.id)) {
      const s = this.d.slugOf(r.repoPath);
      if (s) return s;
    }
    return null;
  }

  /** 从上往下的每一层（全局 → 产品 → 仓库 → epic → ticket），只列设过的。 */
  chain(ticketKey: string): WorkflowLayerView[] {
    const t = this.d.tickets.get(ticketKey);
    const out: WorkflowLayerView[] = [];
    const slug = t ? this.slugOfTicket(t) : null;
    const refs = this.resolver.layersFor(slug ? { kind: "repo", slug } : { kind: "global" });
    for (const l of refs) {
      const scope = this.fromRef(l.ref);
      const stored = this.d.repo.layer(scope);
      if (stored) out.push({ scope, label: this.label(scope), workflow: stored.workflow, updatedAt: stored.updatedAt });
    }
    const extra: WorkflowScope[] = [];
    if (t?.featureId != null) extra.push({ kind: "feature", featureId: t.featureId });
    extra.push({ kind: "ticket", ticketKey });
    for (const scope of extra) {
      const stored = this.d.repo.layer(scope);
      if (stored) out.push({ scope, label: this.label(scope), workflow: stored.workflow, updatedAt: stored.updatedAt });
    }
    return out;
  }

  /** 生效的流程：最深的那一层整份生效；都没设是 null（照旧）。 */
  effective(ticketKey: string): EffectiveWorkflow | null {
    const c = this.chain(ticketKey);
    const last = c[c.length - 1];
    return last ? { workflow: last.workflow, scope: last.scope, label: last.label } : null;
  }

  /** 某一层自己（不往上找）。 */
  layer(scope: WorkflowScope): WorkflowLayerView | null {
    const l = this.d.repo.layer(scope);
    return l ? { scope, label: this.label(scope), workflow: l.workflow, updatedAt: l.updatedAt } : null;
  }

  /** 编辑器上列的所有层。 */
  layers(): WorkflowLayerView[] {
    const order = (s: WorkflowScope) => WORKFLOW_SCOPE_KINDS.indexOf(s.kind);
    return this.d.repo
      .layers()
      .map((l) => ({ scope: l.scope, label: this.label(l.scope), workflow: l.workflow, updatedAt: l.updatedAt }))
      .sort((a, b) => order(a.scope) - order(b.scope) || a.label.localeCompare(b.label));
  }

  /** 设一层（raw 是不可信输入）；null 清掉。改了以后受影响的 ticket 重新判断一遍。 */
  setLayer(scope: WorkflowScope, raw: unknown | null): SetWorkflowResult {
    let workflow: Workflow | null = null;
    if (raw !== null) {
      const r = parseWorkflow(raw);
      if (!r.ok) return { ok: false, problem: r.problem, message: WF().problem(r.problem) };
      workflow = r.workflow;
    }
    const norm: WorkflowScope = scope.kind === "repo" ? { kind: "repo", slug: scope.slug.toLowerCase() } : scope;
    const changed = this.d.repo.setLayer(norm, workflow, this.d.now());
    if (changed) {
      this.d.log(`workflow: ${scopeKey(norm)} ${workflow ? `set to ${workflow.steps.map((s) => s.id).join(",")}` : "cleared"}`);
      this.d.onChange();
      for (const t of this.affected(norm)) void this.evaluate(t);
    }
    return { ok: true, changed, workflow };
  }

  /** 改了这一层会影响哪些进行中的 ticket。 */
  private affected(scope: WorkflowScope): string[] {
    const open = this.d.tickets.list().filter((t) => !ticketFinished(t));
    if (scope.kind === "ticket") return open.some((t) => t.key === scope.ticketKey) ? [scope.ticketKey] : [];
    if (scope.kind === "feature") return open.filter((t) => t.featureId === scope.featureId).map((t) => t.key);
    return open.map((t) => t.key);
  }

  // ---------------------------------------------------------------- 进度

  private prsOf(ticketKey: string): TicketPr[] {
    // slug 对不上 ticket 仓库的 PR（repoId null）不算：同名分支在别的仓库开的 PR 不是这个 ticket 的。
    return this.d.prs.byTicket(ticketKey).filter((p) => p.repoId !== null && p.state !== "closed");
  }

  /** 每一轮各自的 bot 回复（按 PR 分组、按轮次排好），key 是请求的 id。见 splitBotRounds。 */
  private botEventsByRound(reqs: BotRequest[], events: StageEvent[]): Map<number, StageEvent[]> {
    const byPr = new Map<number, BotRequest[]>();
    for (const r of reqs) (byPr.get(r.prId) ?? byPr.set(r.prId, []).get(r.prId)!).push(r);
    const out = new Map<number, StageEvent[]>();
    for (const [prId, list] of byPr) {
      list.sort((a, b) => a.round - b.round);
      const split = splitBotRounds(list.map((r) => ({ requestedAt: r.requestedAt, bot: r.bot })), events.filter((e) => e.prId === prId));
      list.forEach((r, i) => out.set(r.id, split[i]));
    }
    return out;
  }

  /**
   * 这一轮 bot 回来了没有：回来了填 reviewedAt 和意见条数（行内评论）。
   * 只有 review、还没看到它的行内评论时不定：PR 监视拉行内评论可能失败了，这时当成 0 条会把「处理意见」误判成做完，
   * 要等 confirmBots 用 gh 数过（数不到就一直不定）。已经定了的，后来又看到更多行内评论（晚到的）就把条数往上改。
   */
  private settleBot(req: BotRequest, ev: StageEvent[]): BotRequest {
    if (req.status === "requesting") return req;
    const inline = ev.filter((e) => e.kind === "comment" && e.data.reviewId != null).length;
    if (req.reviewedAt !== null) {
      if (inline > (req.reviewComments ?? 0) && this.d.repo.raiseBotComments(req.id, inline)) return { ...req, reviewComments: inline };
      return req;
    }
    if (ev.length === 0) return req;
    // 有 review 却没有行内评论：等 gh 数过再定。只有普通评论（Codex 回一句）没有行内评论可拉，直接定。
    if (inline === 0 && ev.some((e) => e.kind === "review")) return req;
    const at = Math.min(...ev.map((e) => e.at));
    this.d.repo.markBotReviewed(req.id, at, inline);
    return { ...req, reviewedAt: at, reviewComments: inline };
  }

  /** bot 交了 review 但没看到行内评论的那几轮：用 gh 数一下（数到 0 才算没有意见；数不到留着下次再数）。 */
  private async confirmBots(t: Ticket): Promise<void> {
    const open = this.prsOf(t.key).filter((p) => p.state === "open");
    if (open.length === 0) return;
    const reqs = this.d.repo.botRequests(t.key);
    const byRound = this.botEventsByRound(reqs, this.d.stages.forTicket(t.key));
    for (const req of reqs) {
      const pr = open.find((p) => p.id === req.prId);
      if (!pr || req.reviewedAt !== null || req.status === "requesting") continue;
      const ev = byRound.get(req.id) ?? [];
      const reviews = ev.filter((e) => e.kind === "review" && e.data.id != null);
      if (reviews.length === 0 || ev.some((e) => e.kind === "comment" && e.data.reviewId != null)) continue;
      const cwd = this.d.ghCwd(pr);
      if (cwd === null) continue;
      let n: number | null;
      try {
        n = await this.d.reviewCommentCount(pr, cwd, reviews.map((e) => String(e.data.id)));
      } catch (e) {
        this.d.log(`workflow: counting the bot's inline comments on ${t.key} PR #${pr.number} failed`, e);
        n = null;
      }
      if (n === null) {
        this.d.log(`workflow: couldn't count the bot's inline comments on ${t.key} PR #${pr.number}; will try again`);
        continue;
      }
      // 只填还空着的（等 gh 的时候别的路径可能已经定了）。
      this.d.repo.markBotReviewed(req.id, Math.min(...ev.map((e) => e.at)), n);
    }
  }

  /** 每个开着的 PR 的各轮请求（第 1 轮是 bot_review，后面是 re_review），已经对过回来没有。 */
  private rounds(ticketKey: string, prs: TicketPr[], events: StageEvent[]): Map<number, BotRequest[]> {
    const reqs = this.d.repo.botRequests(ticketKey).filter((r) => prs.some((p) => p.id === r.prId));
    const byRound = this.botEventsByRound(reqs, events);
    const byPr = new Map<number, BotRequest[]>();
    for (const r of reqs) (byPr.get(r.prId) ?? byPr.set(r.prId, []).get(r.prId)!).push(this.settleBot(r, byRound.get(r.id) ?? []));
    for (const list of byPr.values()) list.sort((a, b) => a.round - b.round);
    return byPr;
  }

  /** 预审：每个有 PR 的仓库，PR 现在的 head 预审 clean；还没有 PR 的，分支最近一次预审 clean。至少要有一个。 */
  private preReviewDone(t: Ticket, prs: TicketPr[]): { done: boolean; detail: string | null } {
    let seen = 0;
    const ids: number[] = [];
    for (const r of t.repos) {
      const slug = this.d.slugOf(r.repoPath);
      if (!slug) continue;
      const pr = prs.find((p) => p.repoId === r.id);
      const branch = pr?.headBranch ?? r.branch;
      const row = pr?.headSha ? this.d.preReviews.latestFor({ repoSlug: slug, branch, headSha: pr.headSha }) : this.d.preReviews.latestForBranch(slug, branch);
      if (!row) {
        if (pr) return { done: false, detail: null };
        continue;
      }
      seen++;
      if (row.verdict !== "clean") return { done: false, detail: null };
      ids.push(row.id);
    }
    return { done: seen > 0, detail: ids.length ? ids.map((i) => `#${i}`).join(",") : null };
  }

  /**
   * 按实际情况现在算得上做完的步骤（live）。ci_green、human_review、merge 只看现在（闸门用它）；其余的一旦成立就记下来。
   */
  private facts(t: Ticket, w: Workflow, done: ReadonlySet<WorkflowStepId>): Map<WorkflowStepId, string | null> {
    const out = new Map<WorkflowStepId, string | null>();
    const prs = this.prsOf(t.key);
    const open = prs.filter((p) => p.state === "open");
    const events = this.d.stages.forTicket(t.key);
    const now = this.d.now();
    const prList = prs.map((p) => `#${p.number}`).join(",");
    if (prs.length > 0) {
      out.set("open_pr", prList);
      out.set("implement", prList);
    }
    if (hasStep(w, "self_review")) {
      const e = events.find((x) => x.kind === "skill" && x.data.category === "review");
      if (e) out.set("self_review", String(e.data.name ?? ""));
    }
    if (hasStep(w, "pre_review")) {
      const p = this.preReviewDone(t, prs);
      if (p.done) out.set("pre_review", p.detail);
    }
    if (prs.length > 0) {
      const ciOk = (p: TicketPr) =>
        p.state === "merged" || p.ci === "passing" || (p.ci === "none" && p.checkedAt > 0 && now - (p.openedAt ?? p.linkedAt) >= NO_CI_GRACE_MS);
      if (prs.every(ciOk)) out.set("ci_green", prList);
      if (prs.every((p) => p.state === "merged" || p.review === "approved")) out.set("human_review", prList);
      if (open.length === 0) out.set("merge", prList);
    }
    const rounds = this.rounds(t.key, open, events);
    if (open.length > 0 || prs.length > 0) {
      const firstBack = open.every((p) => rounds.get(p.id)?.[0]?.reviewedAt != null);
      if (hasStep(w, "bot_review") && (open.length === 0 ? prs.length > 0 : firstBack)) out.set("bot_review", null);
      // 第一轮一条意见都没有：没什么要处理的。
      if (hasStep(w, "address_comments") && open.length > 0 && firstBack && open.every((p) => rounds.get(p.id)![0].reviewComments === 0)) out.set("address_comments", null);
      // 流程里没有「处理评论」：复审不用等它（open_pr → bot_review → re_review → merge 这种流程合法）。
      const addressed = !hasStep(w, "address_comments") || done.has("address_comments") || out.has("address_comments");
      if (hasStep(w, "re_review") && open.length > 0 && addressed) {
        const max = maxRoundsOf(stepOf(w, "re_review"));
        const settled = open.every((p) => {
          const rs = rounds.get(p.id) ?? [];
          const last = rs[rs.length - 1];
          if (!last || last.reviewedAt === null) return false;
          return last.reviewComments === 0 || rs.length - 1 >= max;
        });
        if (settled) out.set("re_review", null);
      }
    }
    return out;
  }

  /**
   * 记下的 + 现在成立的，按步骤。CI 通过、人工 review 只认现在成立的（不记进库：push 以后 CI 又红了，界面和提醒都要跟着退回去），
   * 放进 done 时时间用现在。
   */
  private doneSet(t: Ticket, w: Workflow): { done: Map<WorkflowStepId, { at: number; detail: string | null }>; live: Map<WorkflowStepId, string | null> } {
    const done = new Map<WorkflowStepId, { at: number; detail: string | null }>();
    for (const d of this.d.repo.done(t.key)) if (!LIVE_ONLY.includes(d.step)) done.set(d.step, { at: d.doneAt, detail: d.detail });
    const live = this.facts(t, w, new Set(done.keys()));
    const now = this.d.now();
    for (const [step, detail] of live) if (LIVE_ONLY.includes(step)) done.set(step, { at: now, detail });
    // PR 都合了：流程算走完（不记进库：之后再开 PR 的话按实际情况重新算），别卡在处理评论、再请 review 上一直提醒。
    const prs = this.prsOf(t.key);
    if (prs.length > 0 && prs.every((p) => p.state === "merged")) {
      const detail = prs.map((p) => `#${p.number}`).join(",");
      for (const st of w.steps) if (!done.has(st.id)) done.set(st.id, { at: now, detail });
    }
    return { done, live };
  }

  view(ticketKey: string): TicketWorkflowView {
    const eff = this.effective(ticketKey);
    const t = this.d.tickets.get(ticketKey);
    if (!eff || !t) return { ticketKey, workflow: null, source: null, preset: null, steps: [], current: null };
    const { done } = this.doneSet(t, eff.workflow);
    const rounds: Partial<Record<WorkflowStepId, number>> = {};
    const reqs = this.d.repo.botRequests(ticketKey);
    if (reqs.length > 0) {
      const perPr = new Map<number, number>();
      for (const r of reqs) perPr.set(r.prId, Math.max(perPr.get(r.prId) ?? 0, r.round));
      const max = Math.max(...perPr.values());
      if (hasStep(eff.workflow, "bot_review")) rounds.bot_review = Math.min(max, 1);
      if (hasStep(eff.workflow, "re_review")) rounds.re_review = Math.max(0, max - 1);
    }
    const p = progressOf(eff.workflow, done, rounds);
    return { ticketKey, workflow: eff.workflow, source: { scope: eff.scope, label: eff.label }, preset: presetOf(eff.workflow), steps: p.steps, current: p.current };
  }

  /** list_tickets 里的一项：用的哪份流程、现在在哪一步、做完几步。 */
  summary(ticketKey: string): { source: string; preset: string | null; current: WorkflowStepId | null; done: number; total: number } | null {
    const v = this.view(ticketKey);
    if (!v.workflow || !v.source) return null;
    return { source: scopeKey(v.source.scope), preset: v.preset, current: v.current, done: v.steps.filter((s) => s.state === "done").length, total: v.steps.length };
  }

  // ---------------------------------------------------------------- session 标步骤

  /** session 调 workflow_step_done。只有 SESSION_STEPS 能标；其余的按实际情况算。 */
  markStep(ticketKey: string, step: WorkflowStepId, note: string | null): { ok: true; message: string } | { ok: false; message: string } {
    const eff = this.effective(ticketKey);
    if (!eff) return { ok: false, message: WF().noWorkflow };
    if (!hasStep(eff.workflow, step)) return { ok: false, message: WF().stepNotInWorkflow(step) };
    if (!SESSION_STEPS.includes(step)) return { ok: false, message: WF().stepAuto(step) };
    const text = note?.trim() || null;
    if (text !== null && text.length > STEP_NOTE_MAX) return { ok: false, message: WF().stepNoteTooLong(STEP_NOTE_MAX) };
    // 前面还有 Shipherd 按实际情况判断的步骤没做完（例如 bot 还没 review 就标「处理意见」）：不收，不然那一轮的意见会被跳过。
    const t = this.d.tickets.get(ticketKey);
    if (t) {
      const { done, live } = this.doneSet(t, eff.workflow);
      const ids = eff.workflow.steps.map((s) => s.id);
      const blocking = ids.slice(0, ids.indexOf(step)).find((s) => !SESSION_STEPS.includes(s) && !done.has(s) && !live.has(s));
      if (blocking) return { ok: false, message: WF().stepTooEarly(step, blocking) };
    }
    if (this.d.repo.markDone(ticketKey, step, this.d.now(), "session", text)) this.d.onChange();
    void this.evaluate(ticketKey);
    return { ok: true, message: WF().stepDone(step, this.view(ticketKey).current) };
  }

  // ---------------------------------------------------------------- 判断、提醒、请 bot

  /** 重新判断一个 ticket（PR 读到了、预审出结果了、session 标了一步、流程改了、session 开了）。同一个 ticket 串行。 */
  evaluate(ticketKey: string): Promise<void> {
    const prev = this.chains.get(ticketKey) ?? Promise.resolve();
    const next = prev.then(() => this.evaluateNow(ticketKey)).catch((e: unknown) => this.d.log(`workflow: evaluating ${ticketKey} failed`, e));
    this.chains.set(ticketKey, next);
    void next.finally(() => {
      if (this.chains.get(ticketKey) === next) this.chains.delete(ticketKey);
    });
    return next;
  }

  /**
   * 启动时先调：上次关掉时正在调 gh 的那几轮（还是 requesting）没有人会再写回了，删掉让它们重新请；
   * 不删的话这一轮永远占着，bot_review 一直做不完，合并也一直被拦。
   */
  recoverInterrupted(): void {
    const n = this.d.repo.dropInterruptedBotRequests();
    if (n > 0) this.d.log(`workflow: ${n} bot review request(s) were cut off by the last quit; asking again`);
  }

  /** 启动时：有流程的进行中 ticket 都过一遍（提醒按库里记的那条判断，不重复送）。 */
  async evaluateAll(): Promise<void> {
    if (!this.anyWorkflow()) return;
    for (const t of this.d.tickets.list()) if (!ticketFinished(t)) await this.evaluate(t.key);
  }

  private async evaluateNow(ticketKey: string): Promise<void> {
    const t = this.d.tickets.get(ticketKey);
    const eff = t ? this.effective(ticketKey) : null;
    if (!t || !eff || ticketFinished(t)) {
      // 流程被清掉了、ticket 已经完成（手动标 done、归档）：排着的提醒先撤回，不再往下判断。
      this.withdrawNotice(ticketKey);
      return;
    }
    const w = eff.workflow;
    if (hasStep(w, "bot_review") || hasStep(w, "re_review")) await this.confirmBots(t);
    const now = this.d.now();
    const { done, live } = this.doneSet(t, w);
    let changed = false;
    for (const [step, detail] of live) {
      if (!hasStep(w, step) || done.has(step) || LIVE_ONLY.includes(step)) continue;
      if (this.d.repo.markDone(ticketKey, step, now, "shipherd", detail)) {
        done.set(step, { at: now, detail });
        changed = true;
      }
    }
    const { current } = progressOf(w, done);
    const asked = current === "bot_review" || current === "re_review" ? await this.askBot(t, w, current) : false;
    if (changed || asked) this.d.onChange();
    this.notify(t, w, current);
  }

  /**
   * 走到 bot_review / re_review：每个开着的 PR 该请的这一轮先占住（UNIQUE 行），再看档位：半自动 Shipherd 自己请，手动交给 session。
   * 返回有没有新请求。
   */
  private async askBot(t: Ticket, w: Workflow, current: "bot_review" | "re_review"): Promise<boolean> {
    const step = stepOf(w, current);
    const bot = botOf(step);
    const open = this.prsOf(t.key).filter((p) => p.state === "open");
    const events = this.d.stages.forTicket(t.key);
    const rounds = this.rounds(t.key, open, events);
    const max = maxRoundsOf(stepOf(w, "re_review"));
    let any = false;
    for (const pr of open) {
      const rs = rounds.get(pr.id) ?? [];
      const last = rs[rs.length - 1];
      let round: number | null = null;
      if (current === "bot_review" && rs.length === 0) round = 1;
      // 再请：上一轮回来了、还有意见、没到上限，而且之后 push 过（head 变了）。
      if (current === "re_review" && last && last.reviewedAt !== null && (last.reviewComments ?? 0) > 0 && rs.length - 1 < max && pr.headSha && pr.headSha !== last.sha) round = rs.length + 1;
      if (round === null) continue;
      const claim = this.d.repo.claimBotRequest(t.key, pr.id, round, bot, pr.headSha, this.d.now());
      if (!claim) continue;
      any = true;
      if (this.d.level(t.key) !== "semi") {
        this.d.repo.finishBotRequest(claim.id, "asked_session", null, this.d.now());
        continue;
      }
      const cwd = this.d.ghCwd(pr);
      let r: BotReviewResult;
      if (cwd === null) r = { ok: false, error: "no checkout of the repository" };
      else {
        try {
          r = await this.d.requestBotReview(pr, cwd, bot);
        } catch (e) {
          r = { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
        }
      }
      // 写回时重读：别的路径（session 说请过了、行被删了）已经动过就不覆盖。
      // 对外动作「请 bot review」的开关关着：Shipherd 没请，和手动档一样交给 session（提醒里说开关在哪）。
      if (!r.ok && r.off) {
        this.d.repo.finishBotRequest(claim.id, "asked_session", OFF_SWITCH, this.d.now());
        this.d.log(`workflow: ${t.key} PR #${pr.number} round ${round}: asking ${bot} is off in external actions; the session asks`);
        continue;
      }
      this.d.repo.finishBotRequest(claim.id, r.ok ? "requested" : "failed", r.ok ? null : r.error, this.d.now());
      this.d.log(`workflow: ${t.key} PR #${pr.number} round ${round} ${bot} review ${r.ok ? `requested via ${r.via}` : `failed: ${r.error}`}`);
    }
    return any;
  }

  /** 这一步要给 session 的话；一样的话不重复送（库里记着上一条，重启以后也不重送）。 */
  private notify(t: Ticket, w: Workflow, current: WorkflowStepId | null): void {
    const body = current === null ? null : this.noticeBody(t, w, current);
    const prev = this.d.repo.notice(t.key);
    // 内容变了：先撤回排着的旧提醒，再决定送不送、送给谁（找不到 session 也要先撤）。
    if (prev && prev.notice !== body) this.d.mailbox.withdraw(NOTICE_REF(t.key));
    if (body === null) {
      if (prev) this.d.repo.setNotice(t.key, null, this.d.now());
    } else if (prev?.notice !== body) {
      const to = this.d.recipient(t.key);
      if (to !== null) {
        this.d.mailbox.send({ kind: "shipherd", from: null, to, featureId: t.featureId, body, ref: NOTICE_REF(t.key) });
        this.d.repo.setNotice(t.key, body, this.d.now());
      } else if (prev) this.d.repo.setNotice(t.key, null, this.d.now());
    }
    this.notifyCoordinator(t, w, current);
  }

  private notifyCoordinator(t: Ticket, w: Workflow, current: WorkflowStepId | null): void {
    const key = MERGE_NOTICE(t.key);
    const prev = this.d.repo.notice(key);
    const want = current === "merge" && mergeByOf(w) === "coordinator" && t.featureId !== null;
    if (!want) {
      if (prev) {
        this.d.mailbox.withdraw(MERGE_REF(t.key));
        this.d.repo.setNotice(key, null, this.d.now());
      }
      return;
    }
    const prs = this.prsOf(t.key).filter((p) => p.state === "open").map((p) => p.url);
    const body = WF().coordinatorMerge(t.key, prs);
    if (prev?.notice === body) return;
    if (prev) this.d.mailbox.withdraw(MERGE_REF(t.key));
    const to = this.d.coordinator(t.featureId!);
    if (to === null) {
      if (prev) this.d.repo.setNotice(key, null, this.d.now());
      return;
    }
    this.d.mailbox.send({ kind: "shipherd", from: null, to, featureId: t.featureId, body, ref: MERGE_REF(t.key) });
    this.d.repo.setNotice(key, body, this.d.now());
  }

  private withdrawNotice(ticketKey: string): void {
    if (this.d.repo.notice(ticketKey)) {
      this.d.mailbox.withdraw(NOTICE_REF(ticketKey));
      this.d.repo.setNotice(ticketKey, null, this.d.now());
    }
    if (this.d.repo.notice(MERGE_NOTICE(ticketKey))) {
      this.d.mailbox.withdraw(MERGE_REF(ticketKey));
      this.d.repo.setNotice(MERGE_NOTICE(ticketKey), null, this.d.now());
    }
  }

  private noticeBody(t: Ticket, w: Workflow, current: WorkflowStepId): string {
    const s = WF();
    const i = w.steps.findIndex((x) => x.id === current);
    const step = w.steps[i];
    const lines = [s.noticeHead(t.key, current, i + 1, w.steps.length)];
    lines.push(this.instruction(t, w, step));
    if (step.note) lines.push(s.noticeNote(step.note));
    return lines.filter((l) => l !== "").join("\n");
  }

  private instruction(t: Ticket, w: Workflow, step: WorkflowStep): string {
    const s = WF();
    switch (step.id) {
      case "implement":
      case "self_review":
      case "pre_review":
      case "ci_green":
      case "address_comments":
      case "human_review":
        return s.doIt[step.id];
      case "open_pr":
        // 和 gh pr create 的闸门同一个判断：预审排在前面才要求这次的提交过预审。
        return s.doIt.open_pr(step.draft === true) + (preReviewGatesPr(w) ? s.openPrNeedsPreReview : "");
      case "merge":
        return s.mergeWait(mergeByOf(w));
      case "bot_review":
      case "re_review":
        return this.botInstruction(t, w, step);
    }
  }

  private botInstruction(t: Ticket, w: Workflow, step: WorkflowStep): string {
    const s = WF();
    const bot = botOf(step);
    const open = this.prsOf(t.key).filter((p) => p.state === "open");
    const reqs = this.d.repo.botRequests(t.key).filter((r) => open.some((p) => p.id === r.prId));
    const max = maxRoundsOf(stepOf(w, "re_review"));
    const lastOf = (prId: number) => reqs.filter((r) => r.prId === prId).sort((a, b) => b.round - a.round)[0];
    const out: string[] = [];
    for (const pr of open) {
      const last = lastOf(pr.id);
      const cmds = botReviewCommands(pr.slug, pr.number, bot);
      const wantRound = step.id === "bot_review" ? 1 : null;
      if (!last || (wantRound !== null && last.round < wantRound)) continue;
      if (step.id === "re_review" && last.reviewedAt !== null) {
        out.push(s.reReview(last.round, max));
        continue;
      }
      if (last.status === "failed") out.push(s.botFailed(bot, last.error ?? "", cmds));
      else if (last.status === "asked_session") out.push(last.error === OFF_SWITCH ? s.botAskSessionOff(bot, cmds) : s.botAskSession(bot, cmds));
      else if (step.id === "re_review") out.push(s.reReviewAsked(bot, last.round - 1, max));
      else out.push(s.botAsked(bot));
    }
    return [...new Set(out)].join("\n") || s.botWaiting(bot);
  }

  // ---------------------------------------------------------------- session guide

  /** 开 session 时写进 guide 的几行；没有流程是空的。 */
  guideLines(ticketKey: string): string[] {
    const eff = this.effective(ticketKey);
    if (!eff) return [];
    const s = WF();
    const w = eff.workflow;
    const lines = [s.guideHead(this.sourceText(eff.scope))];
    w.steps.forEach((st, i) => {
      let extra = "";
      if (st.id === "open_pr" && st.draft) extra += s.guideDraft;
      if (st.id === "bot_review") extra += s.guideBot(botOf(st));
      if (st.id === "re_review") extra += s.guideRounds(botOf(st), maxRoundsOf(st));
      if (st.id === "merge") extra += s.guideMergeBy(mergeByOf(w));
      if (st.note) extra += s.guideNote(st.note);
      lines.push(s.guideStep(i + 1, st.id, extra));
    });
    if (!hasStep(w, "merge")) lines.push(s.noMergeStep);
    if (w.notes) lines.push(s.guideNotes(w.notes));
    lines.push(s.guideTool);
    lines.push(s.guideCurrent(this.view(ticketKey).current));
    return lines;
  }

  // ---------------------------------------------------------------- 闸门

  /** 开 PR 之前：排在 open_pr 前面的步骤都做完（预审要对上这次的提交），draft 要带 --draft。 */
  async prCreate(i: { ticketKey: string; repoPath: string | null; dir: string | null; branch: string | null; draft: boolean }): Promise<string | null> {
    const t = this.d.tickets.get(i.ticketKey);
    const eff = t ? this.effective(i.ticketKey) : null;
    if (!t || !eff || !hasStep(eff.workflow, "open_pr")) return null;
    const w = eff.workflow;
    const { done, live } = this.doneSet(t, w);
    const have = new Set<WorkflowStepId>([...done.keys(), ...live.keys()]);
    // 写代码不用标：开 PR 本身就说明写完了。预审（排在开 PR 前面时）另外按这次的提交查；排在后面的预审是对 PR 做的，开 PR 时不查。
    const pending = pendingBefore(w, "open_pr", have).filter((s) => s !== "implement" && s !== "pre_review");
    if (pending.length > 0) return WF().prPending(pending);
    if (preReviewGatesPr(w) && !(await this.preReviewAtHead(t, i))) return WF().prPreReview;
    if (stepOf(w, "open_pr")?.draft && !i.draft) return WF().prDraft;
    return null;
  }

  /**
   * 不经 hook 开 PR 的路径（栈服务自动开栈底的 PR）用的判断：和 gh pr create 的 hook 是同一个 prCreate。
   * 能开成可以 review 的就是 open；只差「流程要先开 draft」就是 draft；别的拦着就是 blocked，带上原因。
   */
  async prOpenMode(i: { ticketKey: string; repoPath: string; branch: string }): Promise<{ mode: "open" } | { mode: "draft" } | { mode: "blocked"; reason: string }> {
    const at = { ticketKey: i.ticketKey, repoPath: i.repoPath, dir: null, branch: i.branch };
    if ((await this.prCreate({ ...at, draft: false })) === null) return { mode: "open" };
    const asDraft = await this.prCreate({ ...at, draft: true });
    return asDraft === null ? { mode: "draft" } : { mode: "blocked", reason: asDraft };
  }

  /**
   * 要开 PR 的这个提交有没有 clean 的预审。仓库认得出就只看它；认不出（比如目录是 shell 变量）时，ticket 里分支对得上的仓库
   * 每一个都要 clean：多仓库 ticket 的几个仓库可能用同名分支，不能拿一个仓库的预审放行另一个仓库开 PR。
   */
  private async preReviewAtHead(t: Ticket, i: { repoPath: string | null; dir: string | null; branch: string | null }): Promise<boolean> {
    const repoPath = i.repoPath;
    const candidates =
      repoPath !== null
        ? t.repos.filter((r) => samePath(r.repoPath, repoPath) && (i.branch === null || r.branch === i.branch)).slice(0, 1)
        : i.branch !== null
          ? t.repos.filter((r) => r.branch === i.branch)
          : t.repos.length === 1
            ? t.repos
            : [];
    if (candidates.length === 0) return false;
    // 命令给的目录只有在认得出是哪个仓库时才用；同名分支的几个仓库各自用自己的 checkout。
    const useDir = candidates.length === 1 ? i.dir : null;
    for (const repo of candidates) if (!(await this.cleanAtHead(repo, i.branch ?? repo.branch, useDir))) return false;
    return true;
  }

  private async cleanAtHead(repo: TicketRepo, branch: string, dirHint: string | null): Promise<boolean> {
    const slug = this.d.slugOf(repo.repoPath);
    if (!slug) return false;
    const dir = dirHint ?? (repo.workMode === "worktree" && repo.worktreePath ? repo.worktreePath : repo.repoPath);
    const sha = await this.d.headSha(dir, branch);
    if (!sha) return false;
    return this.d.preReviews.latestFor({ repoSlug: slug, branch, headSha: sha })?.verdict === "clean";
  }

  /** 开着的 PR 里，现在的 head 没有 clean 预审的（合并闸门用；和开 PR 一样按提交查）。返回 #号；全都过了是空。 */
  private staleForMerge(t: Ticket): string[] {
    const out: string[] = [];
    for (const pr of this.prsOf(t.key).filter((p) => p.state === "open")) {
      const repo = t.repos.find((r) => r.id === pr.repoId);
      const slug = repo ? this.d.slugOf(repo.repoPath) : null;
      const row = slug && pr.headSha ? this.d.preReviews.latestFor({ repoSlug: slug, branch: pr.headBranch ?? repo!.branch, headSha: pr.headSha }) : null;
      if (row?.verdict !== "clean") out.push(`#${pr.number}`);
    }
    return out;
  }

  /** 合并之前：谁来合对不对、合并前的步骤（PR 相关的按现在的状态）做完没有。 */
  merge(i: { ticketKey: string; sessionId: string | null }): string | null {
    const t = this.d.tickets.get(i.ticketKey);
    const eff = t ? this.effective(i.ticketKey) : null;
    if (!t || !eff) return null;
    const w = eff.workflow;
    const by: MergeBy = mergeByOf(w);
    if (by === "user") return WF().mergeByUser;
    const who = i.sessionId ? this.d.session(i.sessionId) : null;
    // 总控：全局 Shipherd 总控，或者这个 ticket 所在 epic 的总控（别的 epic 的总控不算）。
    if (!isCoordinator(who) || !(who!.shipherd || (t.featureId !== null && who!.featureId === t.featureId))) return WF().mergeNotCoordinator;
    const { done, live } = this.doneSet(t, w);
    const have = new Set<WorkflowStepId>();
    // 预审和 CI、人工 review 一样按现在算：push 了没预审过的新提交，不能凭旧记录合。
    for (const s of done.keys()) if (s !== "ci_green" && s !== "human_review" && s !== "pre_review") have.add(s);
    for (const s of live.keys()) if (s !== "pre_review") have.add(s);
    const stale = hasStep(w, "pre_review") ? this.staleForMerge(t) : [];
    if (stale.length === 0 && hasStep(w, "pre_review")) have.add("pre_review");
    const pending = pendingBefore(w, "merge", have);
    if (pending.length === 1 && pending[0] === "pre_review" && stale.length > 0) return WF().mergePreReview(stale);
    return pending.length > 0 ? WF().mergePending(pending) : null;
  }
}

/**
 * 把一个 PR 上 bot 的 review / 评论分给各轮请求（按轮次排好）。谁是 bot 按 PR 监视记下的 who，和评论闭环同一个判断 reviewerKind；
 * 每一轮只认它请的那个 bot（aiReviewerOf(author)）：同一个 PR 上 Copilot 和 Codex 都在回时，Copilot 的回复不算 Codex 那一轮的。
 * 同一个 bot 的各轮按 splitRounds 分。
 */
export function splitBotRounds(rounds: { requestedAt: number; bot: ReviewBot }[], events: StageEvent[]): StageEvent[][] {
  const out: StageEvent[][] = rounds.map(() => []);
  for (const bot of new Set(rounds.map((r) => r.bot))) {
    const idx = rounds.flatMap((r, i) => (r.bot === bot ? [i] : []));
    const mine = events.filter((e) => e.data.who === "copilot" && typeof e.data.author === "string" && aiReviewerOf(e.data.author) === bot);
    splitRounds(idx.map((i) => rounds[i].requestedAt), mine).forEach((ev, k) => (out[idx[k]] = ev));
  }
  return out;
}

/**
 * 同一个 bot 的回复分给它的各轮请求（requestedAt 按轮次排好）：
 * - 每轮从「请求前 RESPONSE_SLACK_MS」算起（请求的时间是 gh 返回的时间，bot 可能更早就回了），但不早于上一轮的终点。
 * - 上一轮的终点：它在下一轮请求前 slack 之外已经有回复，就到「下一轮请求前 slack」为止（之后的算下一轮，比如 push 后自动 review）；
 *   没有的话到下一轮请求为止（请求前 slack 内才回的，是上一轮的回复，不能算成新一轮回来了）。
 * - 行内评论跟着它的 review 走：review 分在哪轮，评论就算哪轮的（晚到的评论不会被算进后面一轮）。
 */
function splitRounds(requestedAt: number[], events: StageEvent[]): StageEvent[][] {
  const bot = events.filter((e) => e.kind === "review" || e.kind === "comment").sort((a, b) => a.at - b.at);
  const reviewOf = (e: StageEvent): string | null => (e.kind === "comment" && e.data.reviewId != null ? String(e.data.reviewId) : null);
  const ends: number[] = [];
  const starts: number[] = [];
  for (let i = 0; i < requestedAt.length; i++) {
    const start = Math.max(requestedAt[i] - RESPONSE_SLACK_MS, i > 0 ? ends[i - 1] : -Infinity);
    starts.push(start);
    if (i === requestedAt.length - 1) {
      ends.push(Infinity);
      break;
    }
    const zone = Math.max(start, requestedAt[i + 1] - RESPONSE_SLACK_MS);
    const answeredBefore = bot.some((e) => e.at >= start && e.at < zone);
    ends.push(answeredBefore ? zone : Math.max(start, requestedAt[i + 1]));
  }
  const roundOf = (at: number): number => {
    for (let i = 0; i < starts.length; i++) if (at >= starts[i] && at < ends[i]) return i;
    return -1;
  };
  const out: StageEvent[][] = requestedAt.map(() => []);
  const reviewRound = new Map<string, number>();
  for (const e of bot) {
    if (e.kind !== "review" || e.data.id == null) continue;
    const i = roundOf(e.at);
    if (i >= 0) reviewRound.set(String(e.data.id), i);
  }
  for (const e of bot) {
    const rid = reviewOf(e);
    const i = rid !== null && reviewRound.has(rid) ? reviewRound.get(rid)! : roundOf(e.at);
    if (i >= 0) out[i].push(e);
  }
  return out;
}
