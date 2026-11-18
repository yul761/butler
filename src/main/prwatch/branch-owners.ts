import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { classifyShip, type ShipCommand } from "../../shared/gate-command";
import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";
import type { Ticket } from "../../shared/types";
import type { BranchOwnersRepo } from "../db/branch-owners-repo";
import { samePath } from "../tickets/ticket-service";
import type { PrLinker } from "./pr-links";

/** hook 报上来的一次推送或开 PR（butler-hook 只为这两种 Bash 调用写信封）。 */
export interface Shipped {
  /** BUTLER_SESSION（/clear 之后不变）；不是 Butler 开的终端用 Claude 的 session id。 */
  sessionId: string;
  ticket: string | null;
  cwd: string;
  commands: ShipCommand[];
  /** gh pr create 打出来的 PR 链接。 */
  prUrls: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Bash 的 PostToolUse 里的推送和开 PR；别的信封为 null。 */
export function shipFromEnvelope(env: HookEnvelope): Shipped | null {
  const p = env.payload;
  if (isHeadlessEnvelope(env) || !p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if (o.hook_event_name !== "PostToolUse" || o.tool_name !== "Bash") return null;
  const input = o.tool_input && typeof o.tool_input === "object" ? (o.tool_input as Record<string, unknown>) : {};
  const command = str(input.command);
  const sessionId = env.butlerSession ?? str(o.session_id);
  const cwd = str(o.cwd);
  if (!command || !sessionId || !cwd) return null;
  const commands = classifyShip(command);
  if (commands.length === 0) return null;
  const prUrls = Array.isArray(o.pr_urls) ? o.pr_urls.filter((u): u is string => typeof u === "string") : [];
  return { sessionId, ticket: env.ticket, cwd, commands, prUrls };
}

export interface BranchOwnershipDeps {
  tickets: { get(key: string): Pick<Ticket, "key" | "repos"> | null };
  /** 没有 BUTLER_TICKET 时用 session 记着的 ticket。 */
  sessionTicket(sessionId: string): string | null;
  currentBranch(dir: string): Promise<string>;
  /** worktree 所属的主仓库（git rev-parse --git-common-dir 的上一级）。 */
  mainRepoRoot(dir: string): Promise<string>;
  owners: Pick<BranchOwnersRepo, "record">;
  linker: Pick<PrLinker, "linkCreatedPr">;
  /** 让 PR watcher 马上查这个仓库（列新分支上的 PR、读刚链接的）。 */
  soon(repoId: number): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/**
 * 记下分支是谁的（工作流 W）：CI 的结论递给推这个分支、在上面开 PR 的 session，不看共享检出现在在哪个分支上。
 * 目录按 hook 的 cwd 解析（`cd` / `git -C`），仓库按目录所属的主仓库（worktree 也算）对上 ticket 的仓库。认不出的都记日志，不记归属。
 */
export class BranchOwnership {
  constructor(private readonly d: BranchOwnershipDeps) {}

  async handle(env: HookEnvelope): Promise<void> {
    const s = shipFromEnvelope(env);
    if (s) await this.record(s);
  }

  async record(s: Shipped): Promise<void> {
    const what = `${s.sessionId} in ${s.cwd}`;
    const ticketKey = s.ticket ?? this.d.sessionTicket(s.sessionId);
    if (!ticketKey) return this.d.log(`branch owner: ${what}: no ticket`);
    const t = this.d.tickets.get(ticketKey);
    if (!t) return this.d.log(`branch owner: ${what}: ticket ${ticketKey} not found`);
    const touched = new Set<number>();
    for (const c of s.commands) {
      const dir = resolve(s.cwd, c.dir ?? ".");
      let root: string;
      try {
        root = await this.d.mainRepoRoot(dir);
      } catch {
        this.d.log(`branch owner: ${what}: ${dir} is not in a git repository`);
        continue;
      }
      const repo = t.repos.find((r) => samePath(r.repoPath, root) || samePath(real(r.repoPath), real(root)));
      if (!repo) {
        this.d.log(`branch owner: ${what}: ${dir} is not one of ${ticketKey}'s repos`);
        continue;
      }
      let branch = c.kind === "push" ? c.branch : c.head;
      if (branch === null) {
        try {
          branch = await this.d.currentBranch(dir);
        } catch (e) {
          this.d.log(`branch owner: ${what}: reading the branch of ${dir} failed`, e);
          continue;
        }
      }
      if (!branch || branch === "HEAD") {
        this.d.log(`branch owner: ${what}: ${dir} is not on a branch`);
        continue;
      }
      this.d.owners.record({ ticketKey, repoId: repo.id, branch, sessionId: s.sessionId, dir, at: this.d.now() });
      this.d.log(`branch owner: ${ticketKey} ${branch} -> ${s.sessionId} (${c.kind})`);
      if (c.kind === "pr_create") for (const url of s.prUrls) this.d.linker.linkCreatedPr(ticketKey, url, branch);
      touched.add(repo.id);
    }
    for (const id of touched) this.d.soon(id);
  }
}
