import type { WorkflowCoordinatorOp } from "../../shared/workflow-control";
import { basename } from "node:path";
import { type ShipherdControlRequest, type ControlResult, type InboxControlOp, sanitizeTask, SUMMARY_LIMIT } from "../../shared/control";
import type { ProgressFilter, ProgressView } from "../../shared/progress";
import type { Turn } from "../../shared/turn";
import { effectiveStatus, type Block, type Feature, type FeatureStatusRow, type OpenSessionResult, type Session, type Ticket, type WatchedPr } from "../../shared/types";
import { roleOf, type InboxService } from "../inbox/inbox-service";
import { progressOverview } from "../progress/progress-view";
import type { MetricsOverview } from "../../shared/metrics";
import type { PrAssessmentView, Readiness, RiskLevel } from "../../shared/prereview";
import { M } from "../strings";
import { admitOrRefuse } from "./admission";
import type { ControlHandlerDeps } from "./control-handler";

/** Shipherd 总控（BTL-190 第 5 点）要的数据：index.ts 从 SessionService、PrWatcher、「需要你」和收件箱拿。 */
export interface ShipherdControlDeps {
  /** 所有未归档 feature 的一行情况。 */
  featureRows: () => FeatureStatusRow[];
  /** Shipherd 在盯的所有 PR（PrWatcher.statusOf）。 */
  prs: () => WatchedPr[];
  /** 每个 PR 轮到谁，按链接查（TurnService.prTurns，和看板同一套算法）；没有为 null。 */
  prTurns: () => (url: string, ticketKey?: string) => Turn | null;
  /** 开着终端的 Shipherd session 的 head。 */
  openHeads: () => Session[];
  /** 「需要你」的理由；不需要为 null。 */
  needsYou: (sessionId: string) => string | null;
  inbox: Pick<InboxService, "view">;
  /** 进度聚合（buildProgress，ws-b）。 */
  progress?: (filter: ProgressFilter) => ProgressView;
  /** 效果总览（ws-h，和「效果」页同一份）。 */
  metrics?: (days: number | undefined) => MetricsOverview;
  /** feature 汇总的新鲜度和后台重新生成（ws-b）。 */
  summaries?: {
    running(featureId: number): boolean;
    /** 汇总之后有新活动（含 PR 状态变化）。 */
    stale(featureId: number): boolean;
    /** 最新汇总读 PR 状态的时间；没有为 null。 */
    prStatusAt(featureId: number): number | null;
    /** 后台跑 runManual，不等。 */
    refresh(featureId: number): void;
  };
  /** 就绪、风险（ws-g）：list_prs 带上 risk / ready / missing，pr_assessment 给一个 PR 的全部评估。 */
  assessment?: {
    summaries(prIds: number[]): Map<number, { risk: RiskLevel | null; ready: boolean | null; missing: Readiness["missing"] }>;
    /** ticket_prs 的 id 或 PR 链接；找不到为 null。 */
    view(ref: string): PrAssessmentView | null;
  };
  /** list_inbox 的 messages：Shipherd 总控发出、收到的信箱消息（BTL-245）。 */
  shipherdSessions?: () => string[];
}

const iso = (t: number | null | undefined): string | null => (t ? new Date(t).toISOString() : null);

/** controlHandler 里几种作用域共用的处理，Shipherd 总控也用。 */
export interface ShipherdControlHelpers {
  sessionActivity: (wanted: string, belongs: (s: Session) => boolean) => Promise<ControlResult>;
  refreshSession: (req: { from: string | null; session: string }, belongs: (s: Session) => boolean) => ControlResult;
  listedActivity: (id: string) => object | null;
  lastReply: (id: string) => string | null;
}

type Named = { id: number; name: string } | null;

const ok = (value: unknown): ControlResult => ({ v: 1, ok: true, value });
const fail = (error: string): ControlResult => ({ v: 1, ok: false, error });

/**
 * Shipherd 总控的请求（BTL-190 第 5 点）：全部只读，加上 send_message 和 refresh_session。不建、不删、不结束。
 * 只有 send_message 会开 session：目标 feature 总控的终端关着（比如闲置时自动关掉了）时，接着它最近的那个再把消息交进去。
 * 请求文件谁都能写：往终端里写东西的 send_message 和换新别人的 refresh_session 要求 from 是开着终端的 Shipherd 总控自己。
 */
export function shipherdControl(d: ControlHandlerDeps, h: ShipherdControlHelpers): (req: Exclude<ShipherdControlRequest, { op: InboxControlOp["op"] | WorkflowCoordinatorOp["op"] }>) => Promise<ControlResult> {
  const name = (r: { repoPath: string }) => basename(r.repoPath);

  /** 名字或 id（数字先按 id 找，再按名字，不分大小写）。 */
  const pick = <T extends { id: number; name: string }>(list: T[], wanted: string): T | undefined => {
    const w = wanted.trim();
    const byId = /^\d+$/.test(w) ? list.find((x) => x.id === Number(w)) : undefined;
    return byId ?? list.find((x) => x.name.trim().toLowerCase() === w.toLowerCase());
  };

  /** 正在给这个 epic 开 session（send_message 打开关着的终端）：同时来的第二条不再开第二个，等它开好排进同一个信箱。值是开好的 head，没开成为 null。 */
  const opening = new Map<string, Promise<string | null>>();

  return async (req) => {
    const b = d.shipherd;
    if (!b) return fail(M().ctlShipherdOff);
    const features = d.features?.list() ?? [];
    const featureById = new Map(features.map((f) => [f.id, f]));
    const named = (x: { id: number; name: string } | undefined | null): Named => (x ? { id: x.id, name: x.name } : null);
    const featureOf = (id: number | null): Feature | undefined => (id === null ? undefined : featureById.get(id));
    const live = features.filter((f) => f.archivedAt === null);
    /** 名字或 id 找一个未归档的 epic（内部是 feature）；找不到时是给总控看的错误。 */
    const pickEpic = (wanted: string): Feature | { error: string } =>
      pick(live, wanted) ?? { error: M().ctlNoSuchEpic(wanted, live.map((x) => x.name).join(", ") || M().ctlNoEpics) };
    /** epic 里的 feature（内部是 block，BTL-246），按 epic 取一次。 */
    const blocksOf = new Map<number, Block[]>();
    const blocksIn = (epicId: number): Block[] => {
      let list = blocksOf.get(epicId);
      if (!list) blocksOf.set(epicId, (list = d.blocks?.list(epicId) ?? []));
      return list;
    };
    const blockOf = (t: Ticket): Named => (t.featureId === null || t.blockId == null ? null : named(blocksIn(t.featureId).find((x) => x.id === t.blockId)));
    const ticketOwners = (t: Ticket) => ({ epic: named(featureOf(t.featureId)), feature: blockOf(t) });
    /** 一个 session 属于哪个 ticket、epic。 */
    const owners = (s: Session) => {
      if (s.ticketKey !== null) {
        const t = d.tickets.get(s.ticketKey);
        return { ticket: s.ticketKey, ...(t ? ticketOwners(t) : { epic: null, feature: null }), repo: t?.repos.find((r) => r.id === s.repoId) ?? null };
      }
      return { ticket: null, epic: named(featureOf(s.featureId)), feature: null, repo: null };
    };
    /** 一个 epic 里每个 feature 的进度（顺序同 position）。 */
    const blockProgress = (epicId: number) => {
      const own = d.tickets.listByFeature(epicId);
      return blocksIn(epicId).map((x, i) => {
        const mine = own.filter((t) => t.blockId === x.id);
        return { id: x.id, name: x.name, position: i + 1, merged: mine.filter((t) => effectiveStatus(t) === "done").length, total: mine.length, mine };
      });
    };
    const self = req.from ? (d.sessions.head(req.from) ?? null) : null;
    /** 往别的 session 里写东西、换新别的 session 的请求：from 必须是开着终端的 Shipherd 总控（请求文件谁都能写）。 */
    const fromOpenShipherd = !!self?.shipherd && !!d.sessionService.termIdOf(self.id);

    type Target = { feature: Feature; session: Session | null };
    /** send_message 的目标：给的 session 换成它的 epic（ticket 和修复 session 不行）；epic 按名字或 id 找，已归档的不算。 */
    const resolveTarget = (r: { session?: string; epic?: string }): Target | { error: string } => {
      if (r.epic !== undefined) {
        const f = pickEpic(r.epic);
        return "error" in f ? f : { feature: f, session: null };
      }
      const wanted = r.session ?? "";
      const t = d.sessions.head(wanted);
      if (!t || t.id === self?.id || t.dismissed) return { error: M().ctlNoSuchSession(wanted) };
      const f = roleOf(t) === "feature_coordinator" && t.featureId !== null ? featureById.get(t.featureId) : undefined;
      if (f && f.archivedAt === null) return { feature: f, session: t };
      return { error: M().ctlSendWrongTarget(t.id) };
    };
    const mailbox = d.mailbox;
    /** 排进目标的信箱（BTL-245）：在忙的下一次工具调用时读到，停着的直接输入；从不因为它在忙而拒绝。 */
    const enqueue = (sessionId: string, text: string, featureId: number | null, interrupt: boolean, hold = false) =>
      mailbox!.send({ kind: "shipherd", from: self?.id ?? null, to: sessionId, featureId, body: text, interrupt, hold });
    const queued = (r: { id: string; state: "busy" | "idle" | "closed" }, sessionId: string, extra: object = {}): ControlResult =>
      ok({ queued: true, sessionId: d.sessions.head(sessionId)?.id ?? sessionId, requestId: r.id, state: r.state, ...extra, note: `${M().mailboxSendNote(r.state)}${M().mailboxReplyNote}` });
    /**
     * 终端关着（闲置时自动关掉了、Shipherd 重启过）：和用户点开一样接着最近的那个（给的 session 没隐藏就接着它），
     * 排着的消息当作它的第一条输入（submit 等输入框就绪）。epic 从没开过总控时新开一个。
     * 正在打开（同时来的第二条）、打开失败：消息照样排在接着的那个 session 的信箱里，下次打开时送；没有可接着的才报错。
     */
    const openAndSend = async (target: Target, text: string, featureId: number | null, interrupt: boolean): Promise<ControlResult> => {
      const svc = d.sessionService;
      const f = target.feature;
      const key = `f${f.id}`;
      if (!svc.openFeature) return fail(M().ctlStartUnavailable);
      const given = target.session && target.session.coordinator && target.session.replacedBy === null ? target.session : undefined;
      const resume = given ?? d.sessions.listFeatureCoordinators(f.id).find((x) => x.coordinator && x.replacedBy === null && !x.dismissed);
      // 用户点 × 结束的（BTL-256）：不替用户再打开，消息排着，用户打开时送到。
      if (resume && resume.userEndedAt != null) {
        const r = enqueue(resume.id, text, featureId, false);
        return ok({ queued: true, sessionId: resume.id, requestId: r.id, state: r.state, wake: "ended_by_user", note: `${M().mailboxWakeNote("ended_by_user")}${M().mailboxReplyNote}` });
      }
      const openFeature = svc.openFeature.bind(svc);
      const open = (): Promise<OpenSessionResult> => openFeature({ featureId: f.id, ...(resume && { sessionId: resume.id }) });
      // 先排进接着的那个的信箱：打开时一起送；打不开也不丢。
      // hold：马上就要打开它（或交给 opened），不让信箱再去唤醒一次，免得两边同时 --resume 同一个 session。
      const early = resume ? enqueue(resume.id, text, featureId, false, true) : null;
      const pending = opening.get(key);
      if (pending) {
        if (early) return queued(early, resume!.id);
        const head = await pending;
        return head === null ? fail(M().ctlOpenFailed("open_failed")) : queued(enqueue(head, text, featureId, interrupt), head);
      }
      let settle: (head: string | null) => void = () => {};
      opening.set(key, new Promise((res) => (settle = res)));
      let r: OpenSessionResult | undefined;
      let room: Awaited<ReturnType<typeof admitOrRefuse>> | null = null;
      const failed = (message: string): ControlResult => (early ? queued(early, resume!.id, { openError: message }) : fail(message));
      try {
        // 要新开一个终端：和 start_session 一样先按内存放行（工作流 W）。
        room = await admitOrRefuse(d.admission, `send_message ${key}`);
        if (!room.ok) {
          // 内存不够（BTL-256）：消息排着，内存腾出来以后信箱叫后台恢复时再送。
          if (early) return queued(early, resume!.id, { openError: room.error, wake: "waiting_memory", wakeError: room.error });
          return fail(room.error);
        }
        r = await open();
      } catch (err) {
        if (room?.ok) room.release();
        d.log?.(`control: shipherd message: opening ${key} failed`, err);
        return failed((err as Error).message);
      } finally {
        opening.delete(key);
        // 等着的那几条：开成了拿到 head（排进它的信箱），抛了、没开成拿到 null。
        settle(r?.ok ? (d.sessions.head(r.termId)?.id ?? r.termId) : null);
      }
      if (!r.ok || r.alreadyOpen) room.release();
      if (!r.ok) return failed(r.reason === "claude_missing" ? M().ctlClaudeMissing : M().ctlOpenFailed(r.reason));
      d.notify();
      const headId = d.sessions.head(r.termId)?.id ?? r.termId;
      // 查过没在跑、打开时却已经开着（和用户同时点开）：信箱照常送（在忙走 hook，停着直接输入）；还没排过的照样能叫停。
      const sent = early ?? enqueue(headId, text, featureId, r.alreadyOpen && interrupt, !r.alreadyOpen);
      if (r.alreadyOpen) return queued(sent, headId);
      void mailbox!.opened(headId, r.termId, d.submit).catch((err: unknown) => d.log?.(`control: shipherd message for ${headId} failed`, err));
      return queued({ ...sent, state: "closed" }, headId, { opened: resume ? "resumed" : "opened" });
    };

    switch (req.op) {
      case "list_epics":
        return ok(b.featureRows().map((r) => ({
          id: r.id, name: r.name, status: r.status, jiraEpic: featureById.get(r.id)?.jiraEpicKey ?? null,
          // epic 里的 feature 和各自合了几个（BTL-246），顺序就是推进的顺序。
          features: blockProgress(r.id).map((x) => ({ id: x.id, name: x.name, position: x.position, merged: x.merged, total: x.total })),
          coordinatorRunning: !!d.sessionService.runningCoordinator?.(r.id), coordinatorSession: d.sessionService.runningCoordinator?.(r.id)?.id ?? null,
          summary: r.summary === null ? null : r.summary.slice(0, SUMMARY_LIMIT), summaryAt: r.summaryAt === null ? null : new Date(r.summaryAt).toISOString(),
          // 汇总读 PR 状态的时间（总控 /handoff 交上来的汇总没有，按 summaryAt 算）；stale：之后有新活动，含 PR 状态变化（ws-b）。
          prStatusAt: iso(b.summaries?.prStatusAt(r.id) ?? r.summaryAt), stale: b.summaries?.stale(r.id) ?? null,
          blockers: r.blockers,
        })));
      case "list_features": {
        let epics = live;
        if (req.epic !== undefined) {
          const f = pickEpic(req.epic);
          if ("error" in f) return fail(f.error);
          epics = [f];
        }
        return ok(epics.flatMap((f) => {
          const desc = new Map(blocksIn(f.id).map((x) => [x.id, x.description]));
          return blockProgress(f.id).map(({ mine, ...x }) => ({
            epic: named(f), ...x, description: desc.get(x.id) ?? null,
            tickets: mine.map((t) => ({ key: t.key, title: t.title, status: effectiveStatus(t) })),
          }));
        }));
      }
      case "list_tickets": {
        let list = d.tickets.list();
        if (req.epic !== undefined) {
          const f = pick(features, req.epic);
          if (!f) return fail(M().ctlNoSuchEpic(req.epic, features.map((x) => x.name).join(", ") || M().ctlNoEpics));
          list = list.filter((t) => t.featureId === f.id);
        }
        return ok(list.map((t) => ({
          key: t.key, title: t.title, status: effectiveStatus(t), ...ticketOwners(t),
          repos: t.repos.map((r) => ({ name: name(r), dir: d.ticketService.workDir(r), branch: r.branch })),
          ...(d.workflow && { workflow: d.workflow.summary(t.key) }),
        })));
      }
      case "list_prs": {
        const prs = b.prs();
        const turnOf = b.prTurns();
        const assessed = b.assessment?.summaries(prs.flatMap((p) => (p.prId !== null ? [p.prId] : []))) ?? new Map();
        return ok(prs.map((p) => {
          const t = d.tickets.get(p.ticketKey);
          const x = p.detail;
          const a = p.prId !== null ? assessed.get(p.prId) : undefined;
          return {
            prId: p.prId,
            ticket: p.ticketKey, repo: p.repoPath === null ? null : basename(p.repoPath), branch: p.branch, number: p.number, url: p.url, state: p.state, review: p.review, ci: p.ci,
            checkedAt: p.checkedAt ? new Date(p.checkedAt).toISOString() : null, ...(t ? ticketOwners(t) : { epic: null, feature: null }),
            // ws-b：叠放、轮到谁要的字段。分支行（还没有 PR）没有。
            ...(x && p.checkedAt > 0 && {
              title: x.title, headBranch: p.branch || null, baseBranch: x.baseBranch, draft: x.isDraft, author: x.author, labels: x.labels,
              reviewRequests: x.reviewRequests, reviewers: x.reviewers.map((r) => ({ ...r, at: iso(r.at) })), mergeable: x.mergeable, mergeState: x.mergeState,
              statusChangedAt: iso(x.statusChangedAt), turn: p.url ? turnOf(p.url, p.ticketKey) : null,
            }),
            // ws-g：只是读表（还没评估过为 null）。
            ...(b.assessment && p.prId !== null && { risk: a?.risk ?? null, ready: a?.ready ?? null, missing: (a?.missing ?? []).map((m: Readiness["missing"][number]) => m.detail) }),
          };
        }));
      }
      case "pr_assessment": {
        if (!b.assessment) return fail(M().ctlPreReviewUnavailable);
        const v = b.assessment.view(req.pr);
        return v ? ok(v) : fail(M().ctlNoSuchPr(req.pr));
      }
      case "list_sessions": {
        const decisions = new Map<string, number>();
        for (const x of b.inbox.view({ all: true }).decisions) decisions.set(x.sessionId, (decisions.get(x.sessionId) ?? 0) + 1);
        return ok(b.openHeads().filter((s) => !s.shipherd).map((s) => {
          const { repo, ...own } = owners(s);
          return {
            id: s.id, role: roleOf(s), ...own, repo: repo ? name(repo) : null, firstPrompt: s.firstPrompt,
            waitingForInput: s.waitingForInput, lastActivityAt: s.lastActivityAt ? new Date(s.lastActivityAt).toISOString() : null,
            activity: h.listedActivity(s.id), needs_you: b.needsYou(s.id), decisions: decisions.get(s.id) ?? 0, last_reply: h.lastReply(s.id),
          };
        }));
      }
      case "session_activity":
        return h.sessionActivity(req.session, () => true);
      case "list_inbox":
        return ok({ ...b.inbox.view({ all: true }), messages: mailbox?.views({ shipherd: true }, b.shipherdSessions?.() ?? (self ? [self.id] : [])) ?? [] });
      case "refresh_session":
        if (!fromOpenShipherd) return fail(M().ctlInboxNotYours);
        return h.refreshSession(req, () => true);
      case "send_message": {
        // 只有开着的 Shipherd 总控自己能往别的终端里写。
        if (!fromOpenShipherd) return fail(M().ctlInboxNotYours);
        const target = resolveTarget(req);
        if ("error" in target) return fail(target.error);
        if (!mailbox) return fail(M().ctlStartUnavailable);
        const text = sanitizeTask(`${M().shipherdMessagePrefix}\n${req.text}`);
        const running = d.sessionService.runningCoordinator?.(target.feature.id) ?? null;
        const featureId = target.feature.id;
        if (running) return queued(enqueue(running.id, text, featureId, req.interrupt === true), running.id);
        return openAndSend(target, text, featureId, req.interrupt === true);
      }
      case "progress_overview": {
        if (!b.progress) return fail(M().ctlProgressUnavailable);
        let featureId: number | null = null;
        if (req.epic !== undefined) {
          const f = pickEpic(req.epic);
          if ("error" in f) return fail(f.error);
          featureId = f.id;
        }
        return ok(progressOverview(b.progress({ featureId })));
      }
      case "metrics_overview": {
        if (!b.metrics) return fail(M().ctlMetricsUnavailable);
        return ok(b.metrics(req.days));
      }
      case "list_stacks":
        return d.stacks ? d.stacks.handle({ kind: "shipherd" }, req) : fail(M().ctlStacksOff);
      case "stack_define":
      case "stack_rebase":
      case "stack_layer_mode":
        // 改本地分支、可能推送：和 refresh_session 一样只接受开着的 Shipherd 总控自己发的。
        if (!fromOpenShipherd) return fail(M().ctlInboxNotYours);
        return d.stacks ? d.stacks.handle({ kind: "shipherd" }, req) : fail(M().ctlStacksOff);
      case "refresh_epic_summary": {
        // 会花额度：和 refresh_session 一样只接受开着的 Shipherd 总控自己发的。
        if (!fromOpenShipherd) return fail(M().ctlInboxNotYours);
        const s = b.summaries;
        if (!s) return fail(M().ctlSummaryUnavailable);
        const f = pickEpic(req.epic);
        if ("error" in f) return fail(f.error);
        const epic = { id: f.id, name: f.name };
        if (s.running(f.id)) return ok({ started: false, running: true, epic, note: M().ctlSummaryRunning });
        const row = b.featureRows().find((r) => r.id === f.id);
        const stale = s.stale(f.id);
        s.refresh(f.id);
        return ok({ started: true, epic, lastSummaryAt: iso(row?.summaryAt), stale, note: M().ctlSummaryStarted });
      }
    }
  };
}
