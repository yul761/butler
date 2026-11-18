import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { classifyShip, type ShipCommand } from "../../shared/gate-command";
import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";
import type { Ticket } from "../../shared/types";
import type { BranchOwner, BranchOwnersRepo } from "../db/branch-owners-repo";
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
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/** hook 在截断前解析好的 ship（新版 hook）；格式不对为 null。 */
function parsedShip(v: unknown): ShipCommand[] | null {
  if (!Array.isArray(v)) return null;
  const out: ShipCommand[] = [];
  for (const c of v) {
    if (!c || typeof c !== "object") return null;
    const o = c as Record<string, unknown>;
    if (!strOrNull(o.dir)) return null;
    if (o.kind === "push" && strOrNull(o.branch)) out.push({ kind: "push", dir: o.dir, branch: o.branch });
    else if (o.kind === "pr_create" && strOrNull(o.head)) out.push({ kind: "pr_create", dir: o.dir, head: o.head });
    else return null;
  }
  return out;
}

/** Bash 跑完（成功或失败）的推送和开 PR；别的信封为 null。 */
export function shipFromEnvelope(env: HookEnvelope): Shipped | null {
  const p = env.payload;
  if (isHeadlessEnvelope(env) || !p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if ((o.hook_event_name !== "PostToolUse" && o.hook_event_name !== "PostToolUseFailure") || o.tool_name !== "Bash") return null;
  const input = o.tool_input && typeof o.tool_input === "object" ? (o.tool_input as Record<string, unknown>) : {};
  const command = str(input.command);
  const sessionId = env.butlerSession ?? str(o.session_id);
  const cwd = str(o.cwd);
  if (!sessionId || !cwd) return null;
  // 新版 hook 对整条命令解析过（命令本身截断到 2000 字）；旧版的只有命令。
  const commands = parsedShip(o.ship) ?? (command ? classifyShip(command) : []);
  if (commands.length === 0) return null;
  const prUrls = Array.isArray(o.pr_urls) ? o.pr_urls.filter((u): u is string => typeof u === "string") : [];
  return { sessionId, ticket: env.ticket, cwd, commands, prUrls };
}

/**
 * 命令里的目录（`cd` / `git -C`）按 hook 的 cwd 解析成绝对路径。`~`、`$HOME` 展开成 home；
 * Windows 上 Git Bash 的 `/c/Users/...` 换成 `C:\Users\...`（不换的话 resolve 会得到 `C:\c\Users\...`）。
 */
export function resolveShipDir(cwd: string, dir: string | null, o: { home: string; win: boolean }): string {
  const path = o.win ? win32 : posix;
  if (dir === null) return path.resolve(cwd);
  let d = dir.replace(/^(?:~|\$HOME|\$\{HOME\})(?=$|[/\\])/, o.home);
  if (o.win) d = d.replace(/^\/([A-Za-z])(?=$|\/)/, (_m, letter: string) => `${letter.toUpperCase()}:\\`);
  return path.resolve(cwd, d);
}

/** 看起来像版本 tag 的名字（`git push origin v2.1.0` 推的是 tag，不是分支）。 */
const TAG_LIKE = /^v?\d+(?:\.\d+)+(?:[-+.][0-9A-Za-z.-]*)?$/;

export interface BranchOwnershipDeps {
  tickets: { get(key: string): Pick<Ticket, "key" | "repos"> | null };
  /** 没有 BUTLER_TICKET 时用 session 记着的 ticket。 */
  sessionTicket(sessionId: string): string | null;
  currentBranch(dir: string): Promise<string>;
  /** worktree 所属的主仓库（git rev-parse --git-common-dir 的上一级）。 */
  mainRepoRoot(dir: string): Promise<string>;
  owners: Pick<BranchOwnersRepo, "record" | "get">;
  linker: Pick<PrLinker, "linkCreatedPr">;
  /** 这个 session（/clear 之后的 head）是不是总控、终端开没开着：总控替子 session 推的分支不抢它的归属。 */
  isCoordinator(sessionId: string): boolean;
  isOpen(sessionId: string): boolean;
  /** 让 PR watcher 马上查这个仓库（列新分支上的 PR、读刚链接的）。 */
  soon(repoId: number): void;
  /** 目录在不在（hook 的 cwd 可能已经是命令跑完以后的目录）。 */
  exists(dir: string): boolean;
  home: string;
  win: boolean;
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

const same = (a: string, b: string): boolean => samePath(a, b) || samePath(real(a), real(b));

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

  /** 目录在 ticket 的哪个仓库里：主仓库根对上 ticket 仓库的路径，或者对上 ticket 仓库（本身可能是个 worktree）的主仓库根。 */
  private async repoOf(t: Pick<Ticket, "repos">, root: string): Promise<Ticket["repos"][number] | null> {
    const direct = t.repos.find((r) => same(r.repoPath, root));
    if (direct) return direct;
    for (const r of t.repos) {
      try {
        if (same(await this.d.mainRepoRoot(r.repoPath), root)) return r;
      } catch {
        // 仓库目录没了：不是它。
      }
    }
    return null;
  }

  /** 总控（rebase 后替子 session force-push）不抢开着的别的 session 的分支。 */
  private keepsOwner(prev: BranchOwner | null, sessionId: string): boolean {
    return prev !== null && prev.sessionId !== sessionId && this.d.isCoordinator(sessionId) && !this.d.isCoordinator(prev.sessionId) && this.d.isOpen(prev.sessionId);
  }

  async record(s: Shipped): Promise<void> {
    const what = `${s.sessionId} in ${s.cwd}`;
    const ticketKey = s.ticket ?? this.d.sessionTicket(s.sessionId);
    if (!ticketKey) return this.d.log(`branch owner: ${what}: no ticket`);
    const t = this.d.tickets.get(ticketKey);
    if (!t) return this.d.log(`branch owner: ${what}: ticket ${ticketKey} not found`);
    const touched = new Set<number>();
    // 一条命令里开了几个 PR 的不多见：链接只认最后打出来的那一个（同一条命令里 gh pr list 之类打出来的不算）。
    const prUrl = s.prUrls.at(-1) ?? null;
    for (const c of s.commands) {
      let dir = resolveShipDir(s.cwd, c.dir, { home: this.d.home, win: this.d.win });
      // hook 的 cwd 如果已经是命令跑完以后的目录，`cd sub && git push` 解析出来是 sub/sub：不存在就用 cwd 本身。
      if (c.dir !== null && !this.d.exists(dir)) dir = resolveShipDir(s.cwd, null, { home: this.d.home, win: this.d.win });
      let root: string;
      try {
        root = await this.d.mainRepoRoot(dir);
      } catch {
        this.d.log(`branch owner: ${what}: ${dir} is not in a git repository`);
        continue;
      }
      const repo = await this.repoOf(t, root);
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
      if (c.kind === "push" && c.branch !== null && TAG_LIKE.test(branch)) {
        this.d.log(`branch owner: ${what}: ${branch} looks like a tag`);
        continue;
      }
      const prev = this.d.owners.get(ticketKey, repo.id, branch);
      if (this.keepsOwner(prev, s.sessionId)) {
        this.d.log(`branch owner: ${ticketKey} ${branch} stays with ${prev!.sessionId} (pushed by the coordinator ${s.sessionId})`);
      } else {
        this.d.owners.record({ ticketKey, repoId: repo.id, branch, sessionId: s.sessionId, dir, at: this.d.now() });
        this.d.log(`branch owner: ${ticketKey} ${branch} -> ${s.sessionId} (${c.kind})`);
      }
      if (c.kind === "pr_create" && prUrl && !this.d.linker.linkCreatedPr(ticketKey, prUrl, branch, repo.id)) {
        this.d.log(`branch owner: ${what}: ${prUrl} not linked (already linked, or not a PR of ${repo.repoPath})`);
      }
      touched.add(repo.id);
    }
    for (const id of touched) this.d.soon(id);
  }
}
