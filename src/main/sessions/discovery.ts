import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { Session } from "../../shared/types";
import type { SessionsRepo } from "../db/sessions-repo";
import { extractTicketKey } from "../tickets/ticket-key";

export const UNCLAIMED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_LIMIT = 200;
/** Claude Code 自己注入的标签（命令、系统提醒、hook 等），不是用户输入。 */
const CLAUDE_TAG_RE = /^<(command-|local-command-|system-reminder|user-prompt-submit-hook|bash-(input|stdout|stderr))/;

export interface DiscoveredSession {
  id: string;
  cwd: string;
  gitBranch: string | null;
  firstPrompt: string | null;
  lastActivityAt: number;
}

export interface SessionHead {
  cwd: string | null;
  gitBranch: string | null;
  firstPrompt: string | null;
}

/** 只认用户亲手输入的文本：排除 meta、子 agent、斜杠命令/系统标签和 tool_result。 */
export function extractUserText(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { type?: unknown; isSidechain?: unknown; isMeta?: unknown; message?: { role?: unknown; content?: unknown } };
  if (e.type !== "user" || e.isSidechain === true || e.isMeta === true || e.message?.role !== "user") return null;
  const c = e.message.content;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c
            .filter((x): x is { type: string; text?: unknown } => !!x && typeof x === "object" && (x as { type?: unknown }).type === "text")
            .map((x) => String(x.text ?? ""))
            .join("\n")
        : "";
  return normalizePromptText(text);
}

/** 把原始用户输入规整成 firstPrompt：去空白、排除 Claude 注入的标签、截断。 */
export function normalizePromptText(text: string): string | null {
  const t = text.trim();
  if (!t || CLAUDE_TAG_RE.test(t)) return null;
  return t.length > PROMPT_LIMIT ? `${t.slice(0, PROMPT_LIMIT)}…` : t;
}

/** 文件开头最多读多少字节：一行就是一张粘贴的大图时，也不会把整个文件读进内存。 */
export const HEAD_BYTE_LIMIT = 1024 * 1024;

/** 只读文件开头，历史文件可能有几十 MB。 */
export async function readSessionHead(file: string, maxLines = 200): Promise<SessionHead> {
  const head: SessionHead = { cwd: null, gitBranch: null, firstPrompt: null };
  const stream = createReadStream(file, { encoding: "utf8", end: HEAD_BYTE_LIMIT - 1 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  // 文件消失或无权限时 readline 不会结束，关掉它以返回已读到的部分。
  stream.once("error", () => rl.close());
  let n = 0;
  try {
    // 读取出错（文件消失、EACCES）时保留已读到的部分，不向上抛。
    for await (const line of rl) {
      if (++n > maxLines) break;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { cwd?: unknown; gitBranch?: unknown };
      if (!head.cwd && typeof e.cwd === "string") head.cwd = e.cwd;
      if (!head.gitBranch && typeof e.gitBranch === "string" && e.gitBranch && e.gitBranch !== "HEAD") head.gitBranch = e.gitBranch;
      if (!head.firstPrompt) head.firstPrompt = extractUserText(entry);
      if (head.cwd && head.gitBranch && head.firstPrompt) break;
    }
  } catch {
    // 已收集的 head 原样返回。
  } finally {
    rl.close();
    stream.destroy();
  }
  return head;
}

/** session 的对话记录文件；Claude Code 只在第一条消息之后才写入，所以刚开就退出的 session 没有它。 */
export function findTranscript(projectsDir: string, sessionId: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = join(projectsDir, d, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

export type TranscriptState = "present" | "absent" | "unknown";

/**
 * 三态的对话记录检查：projects 目录读不了（权限、类型不对等）时返回 unknown，
 * 不能和“确实没有记录”混为一谈，否则删行时可能误删真实 session。
 */
export function transcriptState(projectsDir: string, sessionId: string): TranscriptState {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
  }
  for (const d of dirs) {
    try {
      statSync(join(projectsDir, d, `${sessionId}.jsonl`));
      return "present";
    } catch (e) {
      // ENOTDIR：projects 目录里的非目录条目（如 .DS_Store），等于“这里没有”。
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return "unknown";
    }
  }
  return "absent";
}

/**
 * transcript 只会往后追加：开头的 cwd、分支和第一句话一旦齐全就不会再变。扫描时记住齐全的开头，
 * 之后每 5 分钟的扫描不再重读这些文件。
 */
export type HeadCache = Map<string, SessionHead>;
const HEAD_CACHE_LIMIT = 5000;

export async function scanClaudeProjects(projectsDir: string, sinceMs: number, cache?: HeadCache): Promise<DiscoveredSession[]> {
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return [];
  }
  const found: DiscoveredSession[] = [];
  for (const d of dirs) {
    const dir = join(projectsDir, d);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const id = basename(f, ".jsonl");
      if (!UUID_RE.test(id)) continue;
      const file = join(dir, f);
      let mtime: number;
      try {
        mtime = (await stat(file)).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < sinceMs) continue;
      let head: SessionHead;
      const cached = cache?.get(file);
      if (cached) head = cached;
      else {
        try {
          head = await readSessionHead(file);
        } catch {
          continue;
        }
        if (cache && head.cwd && head.gitBranch && head.firstPrompt) {
          if (cache.size >= HEAD_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
          cache.set(file, head);
        }
      }
      if (!head.cwd) continue;
      found.push({ id, cwd: head.cwd, gitBranch: head.gitBranch, firstPrompt: head.firstPrompt, lastActivityAt: Math.floor(mtime) });
    }
  }
  return found;
}

/** featureForCwd：在 feature 工作区里的 session 直接记成那个 feature 的总控，不进“未认领”（设计文档 2026-10-26）。 */
export function syncDiscovered(found: DiscoveredSession[], sessions: SessionsRepo, now: number, featureForCwd?: (cwd: string) => number | null): string[] {
  const inserted: string[] = [];
  for (const s of found) {
    const featureId = s.cwd ? (featureForCwd?.(s.cwd) ?? null) : null;
    const isNew = sessions.insertIfAbsent({
      id: s.id, ticketKey: null, cwd: s.cwd, origin: "discovered",
      gitBranch: s.gitBranch, firstPrompt: s.firstPrompt, lastActivityAt: s.lastActivityAt, createdAt: now,
      featureId, coordinator: featureId !== null,
    });
    if (isNew) inserted.push(s.id);
    else sessions.fillDetails(s.id, { cwd: s.cwd, gitBranch: s.gitBranch, firstPrompt: s.firstPrompt, lastActivityAt: s.lastActivityAt });
  }
  return inserted;
}

export function suggestTicket(s: { gitBranch: string | null; firstPrompt: string | null }, pattern: string): string | null {
  return (s.gitBranch && extractTicketKey(s.gitBranch, pattern)) || (s.firstPrompt && extractTicketKey(s.firstPrompt, pattern)) || null;
}

/**
 * hook 事件只带 cwd；分支和首条提示要靠扫描磁盘补全。已经齐全、已归属 ticket、已忽略，
 * 或者这次运行里已经为它扫描过的 session，都不再触发扫描。
 */
export function needsDiscovery(s: Session, requested: ReadonlySet<string>): boolean {
  if (s.ticketKey || s.dismissed || requested.has(s.id)) return false;
  return !s.cwd || !s.gitBranch || !s.firstPrompt;
}
