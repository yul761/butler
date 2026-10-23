import { basename } from "node:path";
import { MAX_RUNNING_PER_TICKET, sanitizeTask, type ControlRequest, type ControlResult } from "../../shared/control";
import type { OpenSessionResult, Ticket, TicketRepo } from "../../shared/types";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { SessionService } from "../sessions/session-service";
import { samePath, type TicketService } from "../tickets/ticket-service";

export interface ControlHandlerDeps {
  tickets: TicketsRepo;
  sessions: SessionsRepo;
  ticketService: Pick<TicketService, "workDir">;
  sessionService: Pick<SessionService, "open" | "openTerminalCount" | "isRunning">;
  /** 把任务作为第一条消息交给新 session（等输入框就绪、粘贴、回车）。 */
  submit: (termId: string, task: string) => Promise<boolean>;
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

  return async (req) => {
    const t = d.tickets.get(req.ticketKey);
    if (!t || t.archivedAt !== null) return fail(`找不到 ticket ${req.ticketKey}（可能已经归档）`);

    if (req.op === "list_repos") {
      return ok(t.repos.map((r) => ({ name: name(r), dir: d.ticketService.workDir(r), workMode: r.workMode, branch: r.branch })));
    }

    if (req.op === "list_sessions") {
      return ok(
        d.sessions.listByTicket(t.key).filter((s) => !s.replacedBy && !s.dismissed).map((s) => ({
          id: s.id,
          repo: s.coordinator ? "总控" : repoNameOf(t, s.repoId),
          firstPrompt: s.firstPrompt,
          running: d.sessionService.isRunning(s.id),
          waitingForInput: s.waitingForInput,
          lastActivityAt: s.lastActivityAt ? new Date(s.lastActivityAt).toISOString() : null,
          startedByCoordinator: s.spawnedBy !== null,
        })),
      );
    }

    const repo = findRepo(t, req.repo);
    if (typeof repo === "string") return fail(repo);
    const task = sanitizeTask(req.task);
    if (!task) return fail("task 是空的");
    if (d.sessionService.openTerminalCount(t.key) >= MAX_RUNNING_PER_TICKET) {
      return fail(`这个 ticket 已经有 ${MAX_RUNNING_PER_TICKET} 个终端在运行，先等其中一些结束`);
    }
    const r = await d.sessionService.open({ ticketKey: t.key, repoId: repo.id }, { spawnedBy: spawner(t, req.from) ?? undefined });
    if (!r.ok) return fail(openError(r, repo));
    d.notify();
    // 不等任务写完：等输入框就绪可能要十几秒，总控先拿到 session id。
    d.submit(r.termId, task).then(
      (done) => done || d.log?.(`control: task for ${r.termId} not delivered (terminal exited or never got ready)`),
      (e: unknown) => d.log?.(`control: task for ${r.termId} failed`, e),
    );
    return ok({ sessionId: r.termId, repo: name(repo), dir: d.ticketService.workDir(repo) });
  };
}
