import { basename } from "node:path";
import {
  MAX_RUNNING_PER_FEATURE, MAX_RUNNING_PER_TICKET, sanitizeTask, taskMessage, type ControlRequest, type ControlResult, type FeatureControlRequest,
} from "../../shared/control";
import { effectiveStatus, type OpenSessionResult, type Ticket, type TicketRepo } from "../../shared/types";
import type { FeaturesRepo } from "../db/features-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { SessionService } from "../sessions/session-service";
import { samePath, type TicketService } from "../tickets/ticket-service";

export interface ControlHandlerDeps {
  tickets: TicketsRepo;
  sessions: SessionsRepo;
  ticketService: Pick<TicketService, "workDir">;
  sessionService: Pick<SessionService, "open" | "openTerminalCount" | "isRunning"> & Partial<Pick<SessionService, "featureTerminalCount">>;
  /** feature 总控的请求（设计文档 2026-10-26）；不给就拒绝。 */
  features?: FeaturesRepo;
  /** 把任务作为第一条消息交给新 session（等启动对话框过去、输入框就绪、粘贴、回车）。 */
  submit: (termId: string, message: string) => Promise<"sent" | "exited" | "timeout">;
  notify: () => void;
  log?: (msg: string, err?: unknown) => void;
}

const ok = (value: unknown): ControlResult => ({ v: 1, ok: true, value });
const fail = (error: string): ControlResult => ({ v: 1, ok: false, error });

/** 打不开 session 时给总控看的原因。 */
function openError(r: Extract<OpenSessionResult, { ok: false }>, repo: TicketRepo): string {
  switch (r.reason) {
    case "branch_mismatch":
      return `仓库 ${basename(repo.repoPath)} 现在在 ${r.current} 上，不是这个 ticket 的分支 ${r.expected}。请用户在 Butler 里切换分支后再试`;
    case "claude_missing":
      return "Butler 找不到 claude 命令";
    case "ticket_busy":
      return "这个 ticket 正在修改仓库设置，稍后再试";
    default:
      return `打不开 session（${r.reason}）`;
  }
}

/**
 * 处理总控发来的请求（设计文档 2026-10-23 第二步）。请求文件谁都能写：ticket、仓库、开启者都在这里重新核对。
 */
export function controlHandler(d: ControlHandlerDeps): (req: ControlRequest) => Promise<ControlResult> {
  const name = (r: TicketRepo) => basename(r.repoPath);
  const repoNameOf = (t: Ticket, id: number | null) => {
    const r = t.repos.find((x) => x.id === id);
    return r ? name(r) : null;
  };

  const findRepo = (t: Ticket, wanted: string): TicketRepo | string => {
    const byPath = t.repos.find((r) => samePath(wanted, r.repoPath) || samePath(wanted, d.ticketService.workDir(r)));
    if (byPath) return byPath;
    const byName = t.repos.filter((r) => name(r).toLowerCase() === wanted.trim().toLowerCase());
    if (byName.length === 1) return byName[0];
    const names = t.repos.map(name).join(", ") || "（没有仓库）";
    return byName.length > 1 ? `有多个仓库叫 ${wanted}，请用工作目录指定：${t.repos.map((r) => d.ticketService.workDir(r)).join(", ")}` : `这个 ticket 没有仓库 ${wanted}。现有的仓库：${names}`;
  };

  /** from 必须是这个 ticket 的总控 session，才记成子 session 的开启者。 */
  const spawner = (t: Ticket, from: string | null): string | null => {
    if (!from) return null;
    const h = d.sessions.head(from);
    return h && h.ticketKey === t.key && h.coordinator ? from : null;
  };

  /** 在 ticket 的这个仓库里开子 session，把任务交给它。上限已经由调用方检查过。 */
  const start = async (t: Ticket, repo: TicketRepo, rawTask: string, spawnedBy: string | null, extra: object = {}): Promise<ControlResult> => {
    const task = sanitizeTask(rawTask);
    if (!task) return fail("task 是空的");
    if (d.sessionService.openTerminalCount(t.key) >= MAX_RUNNING_PER_TICKET) {
      return fail(`这个 ticket 已经有 ${MAX_RUNNING_PER_TICKET} 个终端在运行，先等其中一些结束`);
    }
    const r = await d.sessionService.open({ ticketKey: t.key, repoId: repo.id }, { spawnedBy: spawnedBy ?? undefined });
    if (!r.ok) return fail(openError(r, repo));
    d.notify();
    // 不等任务写完：等输入框就绪可能要十几秒（用户还要处理信任文件夹之类的对话框），总控先拿到 session id。
    d.submit(r.termId, taskMessage(task)).then(
      (res) => res === "sent" || d.log?.(`control: task for ${r.termId} not delivered (${res})`),
      (e: unknown) => d.log?.(`control: task for ${r.termId} failed`, e),
    );
    return ok({
      sessionId: r.termId, ...extra, repo: name(repo), dir: d.ticketService.workDir(repo),
      note: "任务会在新 session 的输入框就绪后提交；如果它先弹出信任文件夹之类的确认，要等用户在 Butler 里处理。",
    });
  };

  const sessionRow = (t: Ticket | null, s: { id: string; coordinator: boolean; repoId: number | null; firstPrompt: string | null; waitingForInput: boolean; lastActivityAt: number | null; spawnedBy: string | null }) => ({
    id: s.id,
    repo: s.coordinator ? "总控" : t ? repoNameOf(t, s.repoId) : null,
    firstPrompt: s.firstPrompt,
    running: d.sessionService.isRunning(s.id),
    waitingForInput: s.waitingForInput,
    lastActivityAt: s.lastActivityAt ? new Date(s.lastActivityAt).toISOString() : null,
    startedByCoordinator: s.spawnedBy !== null,
  });

  /** feature 总控（设计文档 2026-10-26）：feature 和 ticket 都在这里重新核对，ticket 必须属于这个 feature 且未归档。 */
  const featureRequest = async (req: FeatureControlRequest): Promise<ControlResult> => {
    const f = d.features?.get(req.featureId);
    if (!f || f.archivedAt !== null) return fail("找不到这个 feature（可能已经归档）");
    const own = d.tickets.listByFeature(f.id);

    if (req.op === "list_tickets") {
      return ok(own.map((t) => ({
        key: t.key, title: t.title, status: effectiveStatus(t),
        repos: t.repos.map((r) => ({ name: name(r), dir: d.ticketService.workDir(r), branch: r.branch })),
      })));
    }

    if (req.op === "list_sessions") {
      const visible = <T extends { replacedBy: string | null; dismissed: boolean }>(rows: T[]) => rows.filter((s) => !s.replacedBy && !s.dismissed);
      return ok([
        ...visible(d.sessions.listByFeature(f.id)).map((s) => ({ ...sessionRow(null, s), ticket: null })),
        ...own.flatMap((t) => visible(d.sessions.listByTicket(t.key)).map((s) => ({ ...sessionRow(t, s), ticket: t.key }))),
      ]);
    }

    const t = own.find((x) => x.key === req.ticket.trim().toUpperCase());
    if (!t) return fail(`这个 feature 下没有 ticket ${req.ticket}。现有的：${own.map((x) => x.key).join(", ") || "（没有 ticket）"}`);
    let repo: TicketRepo | string;
    if (req.repo !== undefined) repo = findRepo(t, req.repo);
    else if (t.repos.length === 1) repo = t.repos[0];
    else repo = t.repos.length === 0 ? `ticket ${t.key} 还没有仓库` : `ticket ${t.key} 有几个仓库，请用 repo 指定：${t.repos.map(name).join(", ")}`;
    if (typeof repo === "string") return fail(repo);
    if ((d.sessionService.featureTerminalCount?.(f.id) ?? 0) >= MAX_RUNNING_PER_FEATURE) {
      return fail(`这个 feature 已经有 ${MAX_RUNNING_PER_FEATURE} 个终端在运行，先等其中一些结束`);
    }
    // from 必须是这个 feature 的总控，才记成子 session 的开启者。
    const h = req.from ? d.sessions.head(req.from) : null;
    const spawnedBy = h && h.featureId === f.id && h.coordinator ? req.from : null;
    return start(t, repo, req.task, spawnedBy, { ticket: t.key });
  };

  return async (req) => {
    if ("featureId" in req) return featureRequest(req);
    const t = d.tickets.get(req.ticketKey);
    if (!t || t.archivedAt !== null) return fail(`找不到 ticket ${req.ticketKey}（可能已经归档）`);

    if (req.op === "list_repos") {
      return ok(t.repos.map((r) => ({ name: name(r), dir: d.ticketService.workDir(r), workMode: r.workMode, branch: r.branch })));
    }

    if (req.op === "list_sessions") {
      return ok(d.sessions.listByTicket(t.key).filter((s) => !s.replacedBy && !s.dismissed).map((s) => sessionRow(t, s)));
    }

    const repo = findRepo(t, req.repo);
    if (typeof repo === "string") return fail(repo);
    return start(t, repo, req.task, spawner(t, req.from));
  };
}
