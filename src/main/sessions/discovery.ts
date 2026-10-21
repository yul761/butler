import { createReadStream, existsSync, readdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
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

/** 只读文件开头，历史文件可能有几十 MB。 */
export async function readSessionHead(file: string, maxLines = 200): Promise<SessionHead> {
  const head: SessionHead = { cwd: null, gitBranch: null, firstPrompt: null };
  const stream = createReadStream(file, { encoding: "utf8" });
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

export async function scanClaudeProjects(projectsDir: string, sinceMs: number): Promise<DiscoveredSession[]> {
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
      try {
        head = await readSessionHead(file);
      } catch {
        continue;
      }
      if (!head.cwd) continue;
      found.push({ id, cwd: head.cwd, gitBranch: head.gitBranch, firstPrompt: head.firstPrompt, lastActivityAt: Math.floor(mtime) });
    }
  }
  return found;
}

export function syncDiscovered(found: DiscoveredSession[], sessions: SessionsRepo, now: number): string[] {
  const inserted: string[] = [];
  for (const s of found) {
    const isNew = sessions.insertIfAbsent({
      id: s.id, ticketKey: null, cwd: s.cwd, origin: "discovered",
      gitBranch: s.gitBranch, firstPrompt: s.firstPrompt, lastActivityAt: s.lastActivityAt, createdAt: now,
    });
    if (isNew) inserted.push(s.id);
    else sessions.fillDetails(s.id, { cwd: s.cwd, gitBranch: s.gitBranch, firstPrompt: s.firstPrompt, lastActivityAt: s.lastActivityAt });
  }
  return inserted;
}

export function suggestTicket(s: { gitBranch: string | null; firstPrompt: string | null }, pattern: string): string | null {
  return (s.gitBranch && extractTicketKey(s.gitBranch, pattern)) || (s.firstPrompt && extractTicketKey(s.firstPrompt, pattern)) || null;
}
