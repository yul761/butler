import { basename } from "node:path";
import { type ButlerControlRequest, type ControlResult, type InboxControlOp, sanitizeTask, SUMMARY_LIMIT } from "../../shared/control";
import { waitingOnOf, type ProgressFilter, type ProgressView } from "../../shared/progress";
import { effectiveStatus, type Epic, type EpicFeatureRow, type EpicView, type Feature, type OpenSessionResult, type Session, type Ticket, type WatchedPr } from "../../shared/types";
import { roleOf, type InboxService } from "../inbox/inbox-service";
import { progressOverview } from "../progress/progress-view";
import type { MetricsOverview } from "../../shared/metrics";
import type { PrAssessmentView, Readiness, RiskLevel } from "../../shared/prereview";
import { M } from "../strings";
import type { ButlerMessages } from "./butler-messages";
import { admitOrRefuse } from "./admission";
import type { ControlHandlerDeps } from "./control-handler";

/** Butler 总控（BTL-190 第 5 点）要的数据：index.ts 从 SessionService、PrWatcher、「需要你」和收件箱拿。 */
export interface ButlerControlDeps {
  /** 未归档的 epic（SessionService.epicViews）。 */
  epicViews: () => Pick<EpicView, "id" | "name" | "sessions" | "waiting" | "stuck" | "features">[];
  /** 所有未归档 feature 的一行情况（含不属于 epic 的），带上 epicId。 */
  featureRows: () => (EpicFeatureRow & { epicId: number | null })[];
  /** Butler 在盯的所有 PR（PrWatcher.statusOf）。 */
  prs: () => WatchedPr[];
  /** 开着终端的 Butler session 的 head。 */
  openHeads: () => Session[];
  /** 「需要你」的理由；不需要为 null。 */
  needsYou: (sessionId: string) => string | null;
  inbox: Pick<InboxService, "view">;
  /** 进度聚合（buildProgress，和进度页同一份，ws-b）。 */
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
  /** send_message 的回复回流（ws-b）。 */
  messages?: Pick<ButlerMessages, "begin" | "settled" | "failed" | "ensureRunning" | "recent">;
}

const iso = (t: number | null | undefined): string | null => (t ? new Date(t).toISOString() : null);

/** controlHandler 里几种作用域共用的处理，Butler 总控也用。 */
export interface ButlerControlHelpers {
  sessionActivity: (wanted: string, belongs: (s: Session) => boolean) => Promise<ControlResult>;
  refreshSession: (req: { from: string | null; session: string }, belongs: (s: Session) => boolean) => ControlResult;
  listedActivity: (id: string) => object | null;
  lastReply: (id: string) => string | null;
}

type Named = { id: number; name: string } | null;

const ok = (value: unknown): ControlResult => ({ v: 1, ok: true, value });
const fail = (error: string): ControlResult => ({ v: 1, ok: false, error });

/**
 * Butler 总控的请求（BTL-190 第 5 点）：全部只读，加上 send_message 和 refresh_session。不建、不删、不结束。
 * 只有 send_message 会开 session：目标 feature 总控或 epic session 的终端关着（比如闲置时自动关掉了）时，接着它最近的那个再把消息交进去。
 * 请求文件谁都能写：往终端里写东西的 send_message 和换新别人的 refresh_session 要求 from 是开着终端的 Butler 总控自己。
 */
export function butlerControl(d: ControlHandlerDeps, h: ButlerControlHelpers): (req: Exclude<ButlerControlRequest, { op: InboxControlOp["op"] }>) => Promise<ControlResult> {
  const name = (r: { repoPath: string }) => basename(r.repoPath);

  /** 名字或 id（数字先按 id 找，再按名字，不分大小写）。 */
  const pick = <T extends { id: number; name: string }>(list: T[], wanted: string): T | undefined => {
    const w = wanted.trim();
    const byId = /^\d+$/.test(w) ? list.find((x) => x.id === Number(w)) : undefined;
    return byId ?? list.find((x) => x.name.trim().toLowerCase() === w.toLowerCase());
  };

  /** 正在给这个 feature、epic 开 session（send_message 打开关着的终端）：同时来的第二条不再开第二个。 */
  const opening = new Set<string>();

  return async (req) => {
    const b = d.butler;
    if (!b) return fail(M().ctlButlerOff);
    const features = d.features?.list() ?? [];
    const featureById = new Map(features.map((f) => [f.id, f]));
    // 未归档的 epic；已归档的只在给别的东西标归属时按 id 查名字。
    const epics = b.epicViews();
    const epicById = new Map(epics.map((e) => [e.id, e]));
    const named = (x: { id: number; name: string } | undefined | null): Named => (x ? { id: x.id, name: x.name } : null);
    const featureOf = (id: number | null): Feature | undefined => (id === null ? undefined : featureById.get(id));
    const epicOf = (id: number | null | undefined) => (id == null ? null : named(epicById.get(id) ?? d.epics?.get(id)));
    const ticketOwners = (t: Ticket) => {
      const f = featureOf(t.featureId);
      return { feature: named(f), epic: epicOf(f?.epicId) };
    };
    /** 一个 session 属于哪个 ticket、feature、epic。 */
    const owners = (s: Session) => {
      if (s.ticketKey !== null) {
        const t = d.tickets.get(s.ticketKey);
        return { ticket: s.ticketKey, ...(t ? ticketOwners(t) : { feature: null, epic: null }), repo: t?.repos.find((r) => r.id === s.repoId) ?? null };
      }
      const f = featureOf(s.featureId);
      return { ticket: null, feature: named(f), epic: epicOf(f ? f.epicId : s.epicId), repo: null };
    };
    const self = req.from ? (d.sessions.head(req.from) ?? null) : null;
    /** 往别的 session 里写东西、换新别的 session 的请求：from 必须是开着终端的 Butler 总控（请求文件谁都能写）。 */
    const fromOpenButler = !!self?.butler && !!d.sessionService.termIdOf(self.id);

    type Target = { kind: "feature"; feature: Feature; session: Session | null } | { kind: "epic"; epic: Epic; session: Session | null };
    /** send_message 的目标：给的 session 换成它的 feature 或 epic（ticket 和修复 session 不行）；feature、epic 按名字或 id 找，已归档的不算。 */
    const resolveTarget = (r: { session?: string; feature?: string; epic?: string }): Target | { error: string } => {
      const live = features.filter((f) => f.archivedAt === null);
      if (r.feature !== undefined) {
        const f = pick(live, r.feature);
        return f ? { kind: "feature", feature: f, session: null } : { error: M().ctlNoSuchFeatureAll(r.feature, live.map((x) => x.name).join(", ") || M().ctlNoFeatures) };
      }
      if (r.epic !== undefined) {
        const e = pick(epics, r.epic);
        const full = e ? d.epics?.get(e.id) : undefined;
        return full ? { kind: "epic", epic: full, session: null } : { error: M().ctlNoSuchEpic(r.epic, epics.map((x) => x.name).join(", ") || M().ctlNoEpics) };
      }
      const wanted = r.session ?? "";
      const t = d.sessions.head(wanted);
      if (!t || t.id === self?.id || t.dismissed) return { error: M().ctlNoSuchSession(wanted) };
      const role = roleOf(t);
      if (role === "epic" && t.epicId !== null && epicById.has(t.epicId)) {
        const full = d.epics?.get(t.epicId);
        if (full) return { kind: "epic", epic: full, session: t };
      }
      const f = role === "feature_coordinator" && t.featureId !== null ? featureById.get(t.featureId) : undefined;
      if (f && f.archivedAt === null) return { kind: "feature", feature: f, session: t };
      return { error: M().ctlSendWrongTarget(t.id) };
    };
    /** epic 正在跑的 epic session（链上最新的那个）。 */
    const runningEpicSession = (epicId: number): Session | null =>
      d.sessions.listByEpic(epicId).find((x) => x.replacedBy === null && !!d.sessionService.termIdOf(x.id)) ?? null;
    /** 终端开着：过 guard，过了交给 deliver（不等它送到：deliver 要等输入框就绪，最多一分钟）。 */
    const msgs = b.messages;
    const sendNow = (sessionId: string, text: string, requestId: string | null): ControlResult => {
      const blocked = (why: string): ControlResult => {
        if (requestId) msgs?.failed(requestId, why);
        return fail(M().ctlSendBlocked(sessionId, why));
      };
      if (!d.guard || !d.deliver) return blocked(M().ctlStartBlock.closed);
      const g = d.guard.check(sessionId);
      if (!g.ok) return blocked(M().ctlStartBlock[g.block]);
      d.deliver(g.termId, text, d.guard.recheckAfter(sessionId, g)).then(
        (res) => {
          if (requestId) msgs?.settled(requestId, g.headId, res);
          if (res !== "sent") d.log?.(`control: butler message for ${sessionId} not delivered (${res})`);
        },
        (err: unknown) => {
          if (requestId) msgs?.failed(requestId, "error");
          d.log?.(`control: butler message for ${sessionId} failed`, err);
        },
      );
      return ok({ sent: true, sessionId: g.headId, ...(requestId && { requestId }), note: M().ctlSendNote });
    };
    /**
     * 终端关着（闲置时自动关掉了、Butler 重启过）：和用户点开一样接着最近的那个（给的 session 没隐藏就接着它），
     * 消息当作它的第一条输入（submit 等输入框就绪）。feature 从没开过总控时新开一个；但属于 epic、规划还没发过的，要 epic session 用 start_feature 开工。
     */
    const openAndSend = async (target: Target, text: string, begin: (resumeId: string | null) => string | null): Promise<ControlResult> => {
      const svc = d.sessionService;
      const key = target.kind === "feature" ? `f${target.feature.id}` : `e${target.epic.id}`;
      if (opening.has(key)) return fail(M().ctlSendOpening);
      let resume: Session | undefined;
      let open: () => Promise<OpenSessionResult>;
      if (target.kind === "feature") {
        const f = target.feature;
        if (!svc.openFeature) return fail(M().ctlStartUnavailable);
        const given = target.session && target.session.coordinator && target.session.replacedBy === null ? target.session : undefined;
        resume = given ?? d.sessions.listFeatureCoordinators(f.id).find((x) => x.coordinator && x.replacedBy === null && !x.dismissed);
        if (!resume && f.epicId !== null && f.brief?.trim() && f.briefSentAt === null) {
          return fail(M().ctlSendNotStarted(f.name, epicOf(f.epicId)?.name ?? String(f.epicId)));
        }
        const openFeature = svc.openFeature.bind(svc);
        open = () => openFeature({ featureId: f.id, ...(resume && { sessionId: resume.id }) });
      } else {
        const e = target.epic;
        if (!svc.openEpic) return fail(M().ctlStartUnavailable);
        resume = target.session && target.session.replacedBy === null ? target.session : d.sessions.listByEpic(e.id).find((x) => x.replacedBy === null && !x.dismissed);
        const openEpic = svc.openEpic.bind(svc);
        open = () => openEpic({ epicId: e.id, ...(resume && { sessionId: resume.id }) });
      }
      opening.add(key);
      // 接着的那个 session 现在的最后一条回复记成"送之前的"：resume 之后读到的旧回复不算。
      const requestId = begin(resume?.id ?? null);
      const failed = (error: string, message: string): ControlResult => {
        if (requestId) msgs?.failed(requestId, error);
        return fail(message);
      };
      let r: OpenSessionResult;
      let room: Awaited<ReturnType<typeof admitOrRefuse>> | null = null;
      try {
        // 要新开一个终端：和 start_session 一样先按内存放行（工作流 W）。
        room = await admitOrRefuse(d.admission, `send_message ${key}`);
        if (!room.ok) return failed("no_memory", room.error);
        r = await open();
      } catch (err) {
        if (room?.ok) room.release();
        d.log?.(`control: butler message: opening ${key} failed`, err);
        return failed("open_failed", (err as Error).message);
      } finally {
        opening.delete(key);
      }
      if (!r.ok || r.alreadyOpen) room.release();
      if (!r.ok) return failed(r.reason, r.reason === "claude_missing" ? M().ctlClaudeMissing : M().ctlOpenFailed(r.reason));
      d.notify();
      // 查过没在跑、打开时却已经开着（和用户同时点开）：和在跑一样过 guard。
      const headId = d.sessions.head(r.termId)?.id ?? r.termId;
      if (r.alreadyOpen) return sendNow(headId, text, requestId);
      d.submit(r.termId, text).then(
        (res) => {
          if (requestId) msgs?.settled(requestId, headId, res);
          if (res !== "sent") d.log?.(`control: butler message for ${headId} not delivered (${res})`);
        },
        (err: unknown) => {
          if (requestId) msgs?.failed(requestId, "error");
          d.log?.(`control: butler message for ${headId} failed`, err);
        },
      );
      return ok({ sent: true, sessionId: headId, ...(requestId && { requestId }), opened: resume ? "resumed" : "opened", note: M().ctlSendOpenedNote });
    };

    switch (req.op) {
      case "list_epics":
        return ok(b.epicViews().map((e) => ({
          id: e.id, name: e.name, features: e.features.filter((r) => r.archivedAt === null).length,
          sessionRunning: e.sessions.some((s) => s.termId !== null), session: e.sessions.find((s) => s.termId !== null)?.id ?? null, waiting: e.waiting, stuck: e.stuck,
        })));
      case "list_features":
        return ok(b.featureRows().map((r) => ({
          id: r.id, name: r.name, epic: epicOf(r.epicId), status: r.status,
          coordinatorRunning: !!d.sessionService.runningCoordinator?.(r.id), coordinatorSession: d.sessionService.runningCoordinator?.(r.id)?.id ?? null,
          summary: r.summary === null ? null : r.summary.slice(0, SUMMARY_LIMIT), summaryAt: r.summaryAt === null ? null : new Date(r.summaryAt).toISOString(),
          // 汇总读 PR 状态的时间（总控 /handoff 交上来的汇总没有，按 summaryAt 算）；stale：之后有新活动，含 PR 状态变化（ws-b）。
          prStatusAt: iso(b.summaries?.prStatusAt(r.id) ?? r.summaryAt), stale: b.summaries?.stale(r.id) ?? null,
          blockers: r.blockers,
        })));
      case "list_tickets": {
        let list = d.tickets.list();
        if (req.feature !== undefined) {
          const f = pick(features, req.feature);
          if (!f) return fail(M().ctlNoSuchFeatureAll(req.feature, features.map((x) => x.name).join(", ") || M().ctlNoFeatures));
          list = list.filter((t) => t.featureId === f.id);
        }
        if (req.epic !== undefined) {
          const e = pick(epics, req.epic);
          if (!e) return fail(M().ctlNoSuchEpic(req.epic, epics.map((x) => x.name).join(", ") || M().ctlNoEpics));
          list = list.filter((t) => featureOf(t.featureId)?.epicId === e.id);
        }
        return ok(list.map((t) => ({
          key: t.key, title: t.title, status: effectiveStatus(t), ...ticketOwners(t),
          repos: t.repos.map((r) => ({ name: name(r), dir: d.ticketService.workDir(r), branch: r.branch })),
        })));
      }
      case "list_prs": {
        const prs = b.prs();
        const assessed = b.assessment?.summaries(prs.flatMap((p) => (p.prId !== null ? [p.prId] : []))) ?? new Map();
        return ok(prs.map((p) => {
          const t = d.tickets.get(p.ticketKey);
          const x = p.detail;
          const a = p.prId !== null ? assessed.get(p.prId) : undefined;
          return {
            prId: p.prId,
            ticket: p.ticketKey, repo: p.repoPath === null ? null : basename(p.repoPath), branch: p.branch, number: p.number, url: p.url, state: p.state, review: p.review, ci: p.ci,
            checkedAt: p.checkedAt ? new Date(p.checkedAt).toISOString() : null, ...(t ? ticketOwners(t) : { feature: null, epic: null }),
            // ws-b：叠放、卡在谁手上要的字段。分支行（还没有 PR）没有。
            ...(x && p.checkedAt > 0 && {
              title: x.title, headBranch: p.branch || null, baseBranch: x.baseBranch, draft: x.isDraft, author: x.author, labels: x.labels,
              reviewRequests: x.reviewRequests, reviewers: x.reviewers.map((r) => ({ ...r, at: iso(r.at) })), mergeable: x.mergeable, mergeState: x.mergeState,
              statusChangedAt: iso(x.statusChangedAt), waitingOn: waitingOnOf({ ...x, state: p.state, ci: p.ci, review: p.review }),
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
        return ok(b.openHeads().filter((s) => !s.butler).map((s) => {
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
        return ok({ ...b.inbox.view({ all: true }), messages: msgs?.recent() ?? [] });
      case "refresh_session":
        if (!fromOpenButler) return fail(M().ctlInboxNotYours);
        return h.refreshSession(req, () => true);
      case "send_message": {
        // 只有开着的 Butler 总控自己能往别的终端里写。
        if (!fromOpenButler) return fail(M().ctlInboxNotYours);
        const target = resolveTarget(req);
        if ("error" in target) return fail(target.error);
        const text = sanitizeTask(`${M().butlerMessagePrefix}\n${req.text}`);
        const running = target.kind === "feature" ? d.sessionService.runningCoordinator?.(target.feature.id) ?? null : runningEpicSession(target.epic.id);
        const owner = target.kind === "feature" ? { featureId: target.feature.id, epicId: null } : { featureId: null, epicId: target.epic.id };
        // 记一行，回复回来时送回这个总控（ws-b）。
        const begin = (to: string | null): string | null => (self && msgs ? msgs.begin({ from: self.id, target: to, ...owner, text: req.text }) : null);
        // ensureRunning：给 M 的钩子（唤醒休眠的 session）；默认只看终端开没开。
        if (running && (!msgs || (await msgs.ensureRunning(running.id)))) return sendNow(running.id, text, begin(running.id));
        return openAndSend(target, text, begin);
      }
      case "progress_overview": {
        if (!b.progress) return fail(M().ctlProgressUnavailable);
        let featureId: number | null = null;
        let epicId: number | null = null;
        if (req.feature !== undefined) {
          const f = pick(features.filter((x) => x.archivedAt === null), req.feature);
          if (!f) return fail(M().ctlNoSuchFeatureAll(req.feature, features.filter((x) => x.archivedAt === null).map((x) => x.name).join(", ") || M().ctlNoFeatures));
          featureId = f.id;
        }
        if (req.epic !== undefined) {
          const e = pick(epics, req.epic);
          if (!e) return fail(M().ctlNoSuchEpic(req.epic, epics.map((x) => x.name).join(", ") || M().ctlNoEpics));
          epicId = e.id;
        }
        return ok(progressOverview(b.progress({ featureId, epicId })));
      }
      case "metrics_overview": {
        if (!b.metrics) return fail(M().ctlMetricsUnavailable);
        return ok(b.metrics(req.days));
      }
      case "list_stacks":
        return d.stacks ? d.stacks.handle({ kind: "butler" }, req) : fail(M().ctlStacksOff);
      case "stack_define":
      case "stack_rebase":
      case "stack_layer_mode":
        // 改本地分支、可能推送：和 refresh_session 一样只接受开着的 Butler 总控自己发的。
        if (!fromOpenButler) return fail(M().ctlInboxNotYours);
        return d.stacks ? d.stacks.handle({ kind: "butler" }, req) : fail(M().ctlStacksOff);
      case "refresh_feature_summary": {
        // 会花额度：和 refresh_session 一样只接受开着的 Butler 总控自己发的。
        if (!fromOpenButler) return fail(M().ctlInboxNotYours);
        const s = b.summaries;
        if (!s) return fail(M().ctlSummaryUnavailable);
        const live = features.filter((x) => x.archivedAt === null);
        const f = pick(live, req.feature);
        if (!f) return fail(M().ctlNoSuchFeatureAll(req.feature, live.map((x) => x.name).join(", ") || M().ctlNoFeatures));
        const feature = { id: f.id, name: f.name };
        if (s.running(f.id)) return ok({ started: false, running: true, feature, note: M().ctlSummaryRunning });
        const row = b.featureRows().find((r) => r.id === f.id);
        const stale = s.stale(f.id);
        s.refresh(f.id);
        return ok({ started: true, feature, lastSummaryAt: iso(row?.summaryAt), stale, note: M().ctlSummaryStarted });
      }
    }
  };
}
