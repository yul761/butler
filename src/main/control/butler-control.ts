import { basename } from "node:path";
import { type ButlerControlRequest, type ControlResult, type InboxControlOp, sanitizeTask, SUMMARY_LIMIT } from "../../shared/control";
import { effectiveStatus, type EpicFeatureRow, type EpicView, type Feature, type Session, type Ticket, type WatchedPr } from "../../shared/types";
import { roleOf, type InboxService } from "../inbox/inbox-service";
import { M } from "../strings";
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
}

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
 * Butler 总控的请求（BTL-190 第 5 点）：全部只读，加上 send_message 和 refresh_session。不建、不删、不结束，也不开 session。
 * 请求文件谁都能写：往终端里写东西的 send_message 要求 from 是 Butler 总控自己。
 */
export function butlerControl(d: ControlHandlerDeps, h: ButlerControlHelpers): (req: Exclude<ButlerControlRequest, { op: InboxControlOp["op"] }>) => Promise<ControlResult> {
  const name = (r: { repoPath: string }) => basename(r.repoPath);

  /** 名字或 id（数字先按 id 找，再按名字，不分大小写）。 */
  const pick = <T extends { id: number; name: string }>(list: T[], wanted: string): T | undefined => {
    const w = wanted.trim();
    const byId = /^\d+$/.test(w) ? list.find((x) => x.id === Number(w)) : undefined;
    return byId ?? list.find((x) => x.name.trim().toLowerCase() === w.toLowerCase());
  };

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

    switch (req.op) {
      case "list_epics":
        return ok(b.epicViews().map((e) => ({
          id: e.id, name: e.name, features: e.features.filter((r) => r.archivedAt === null).length,
          sessionRunning: e.sessions.some((s) => s.termId !== null), waiting: e.waiting, stuck: e.stuck,
        })));
      case "list_features":
        return ok(b.featureRows().map((r) => ({
          id: r.id, name: r.name, epic: epicOf(r.epicId), status: r.status,
          coordinatorRunning: !!d.sessionService.runningCoordinator?.(r.id),
          summary: r.summary === null ? null : r.summary.slice(0, SUMMARY_LIMIT), summaryAt: r.summaryAt === null ? null : new Date(r.summaryAt).toISOString(),
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
      case "list_prs":
        return ok(b.prs().map((p) => {
          const t = d.tickets.get(p.ticketKey);
          return {
            ticket: p.ticketKey, repo: name(p), branch: p.branch, number: p.number, url: p.url, state: p.state, review: p.review, ci: p.ci,
            checkedAt: p.checkedAt ? new Date(p.checkedAt).toISOString() : null, ...(t ? ticketOwners(t) : { feature: null, epic: null }),
          };
        }));
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
        return ok(b.inbox.view({ all: true }));
      case "refresh_session":
        return h.refreshSession(req, () => true);
      case "send_message": {
        // 只有 Butler 总控自己能往别的终端里写。
        if (!self?.butler) return fail(M().ctlInboxNotYours);
        const target = d.sessions.head(req.session);
        if (!target || target.id === self.id) return fail(M().ctlNoSuchSession(req.session));
        const role = roleOf(target);
        const live = role === "epic" ? target.epicId !== null && epicById.has(target.epicId) : role === "feature_coordinator" && featureById.has(target.featureId ?? -1);
        if (!live) return fail(M().ctlSendWrongTarget(target.id));
        if (!d.sessionService.termIdOf(target.id)) return fail(M().ctlSessionNotRunning(target.id));
        if (!d.guard || !d.deliver) return fail(M().ctlSendBlocked(target.id, M().ctlStartBlock.closed));
        const g = d.guard.check(target.id);
        if (!g.ok) return fail(M().ctlSendBlocked(target.id, M().ctlStartBlock[g.block]));
        const text = sanitizeTask(`${M().butlerMessagePrefix}\n${req.text}`);
        // 不等它送到：deliver 要等输入框就绪，最多一分钟。
        d.deliver(g.termId, text, d.guard.recheckAfter(target.id, g)).then(
          (res) => res === "sent" || d.log?.(`control: butler message for ${target.id} not delivered (${res})`),
          (err: unknown) => d.log?.(`control: butler message for ${target.id} failed`, err),
        );
        return ok({ sent: true, sessionId: target.id, note: M().ctlSendNote });
      }
    }
  };
}
