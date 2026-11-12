import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isHandoffInvocation, isToolResultOnly, textOf } from "../handoff/transcript";
import { MAIN_STRINGS, M } from "../strings";

/**
 * 换新前的对话尾巴（BTL-190 第 6 点）：/clear 之前 Butler 自己读旧 transcript，摘出 handoff 之前最近的几轮对话写成文件，
 * 换新后的 session 读它接着做。不调用模型。
 */

/** 最多几轮（一轮从一条用户说的话开始）。 */
export const TAIL_TURNS = 8;
/** 正文最多多少字（不算开头的说明）；超出时去掉最旧的轮。 */
export const TAIL_CHARS = 12_000;
/** 一次工具调用的参数摘要最多多少字。 */
export const TOOL_SUMMARY_CHARS = 120;
/** 先读末尾 1 MiB；不够（没找到 handoff 那条命令、不够 8 轮）就扩大到 8 倍再读，最多 16 MiB。 */
const FIRST_WINDOW = 1024 * 1024;
const MAX_WINDOW = 16 * 1024 * 1024;

export interface TailTurn {
  /** 这一轮开头用户说的话；读的窗口从一轮中间开始时为 null。 */
  user: string | null;
  /** 按时间顺序：助手的文字，或者一行工具调用（tool 为工具名）。 */
  items: Array<{ text: string } | { tool: string; summary: string }>;
}

export interface TailExtract {
  turns: TailTurn[];
  /** 找到了 Butler 输入的 handoff 请求（ticket / feature 的 /handoff，epic 的那句话）。没找到时 turns 为空。 */
  commandFound: boolean;
}

interface Entry {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  message?: { content?: unknown };
}

/** 这条 user 消息是不是 Butler 为这次换新输入的 handoff 请求。epic 的那句话按两种语言的开头认（换新途中切了语言也认得）。 */
export function refreshCommandMatcher(kind: "ticket" | "feature" | "epic"): (content: unknown) => boolean {
  if (kind !== "epic") return isHandoffInvocation;
  const heads = Object.values(MAIN_STRINGS).map((s) => s.refreshEpicHandoff.slice(0, 24));
  return (content) => {
    const t = textOf(content).trim();
    return heads.some((h) => t.startsWith(h));
  };
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 工具参数里最能说明它在做什么的那一项；都没有就是整个参数的 JSON。 */
const SUMMARY_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "query", "url", "skill", "title", "subject", "description", "prompt"];

export function toolSummary(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    for (const k of SUMMARY_KEYS) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return clip(oneLine(v), TOOL_SUMMARY_CHARS);
    }
  }
  let json: string;
  try {
    json = JSON.stringify(input) ?? "";
  } catch {
    json = "";
  }
  return clip(oneLine(json === "{}" ? "" : json), TOOL_SUMMARY_CHARS);
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const LOCAL_OUTPUT = /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/;
const COMMAND_NAME = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** 用户说的话：去掉 system-reminder；斜杠命令写成「/命令 参数」；本地命令的输出不算用户说的话（返回空）。 */
function userText(content: unknown): string {
  const t = textOf(content).replace(REMINDER, "").trim();
  if (!t || LOCAL_OUTPUT.test(t)) return "";
  const name = COMMAND_NAME.exec(t);
  if (name) return oneLine(`${name[1]} ${COMMAND_ARGS.exec(t)?.[1] ?? ""}`);
  return t;
}

/**
 * 从 transcript 的若干行（按时间顺序）里摘出最后一次 handoff 请求之前的最近 TAIL_TURNS 轮。那条请求和它之后的都不要。
 * 跳过 sidechain、isMeta、压缩摘要、只有 tool_result 的条目和本地命令的输出；助手的思考不要。读不懂的行跳过。
 */
export function extractRefreshTail(lines: string[], isCommand: (content: unknown) => boolean): TailExtract {
  const entries: Entry[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l) as unknown;
      if (e && typeof e === "object") entries.push(e as Entry);
    } catch {
      // 截断的行、坏行
    }
  }
  let end = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "user" && e.isSidechain !== true && isCommand(e.message?.content)) {
      end = i;
      break;
    }
  }
  if (end < 0) return { turns: [], commandFound: false };

  const turns: TailTurn[] = [];
  let cur: TailTurn | null = null;
  for (const e of entries.slice(0, end)) {
    if (e.isSidechain === true || e.isMeta === true || e.isCompactSummary === true) continue;
    const content = e.message?.content;
    if (e.type === "user") {
      if (isToolResultOnly(content)) continue;
      const said = userText(content);
      if (!said) continue;
      cur = { user: said, items: [] };
      turns.push(cur);
    } else if (e.type === "assistant") {
      const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        const block = b as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
        let item: TailTurn["items"][number] | null = null;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) item = { text: block.text.trim() };
        else if (block.type === "tool_use") item = { tool: typeof block.name === "string" && block.name ? block.name : "?", summary: toolSummary(block.input) };
        if (!item) continue;
        if (!cur) {
          cur = { user: null, items: [] };
          turns.push(cur);
        }
        cur.items.push(item);
      }
    }
  }
  return { turns: turns.slice(-TAIL_TURNS), commandFound: true };
}

function renderTurn(t: TailTurn): string {
  const s = M().refreshTail;
  const out: string[] = [];
  if (t.user !== null) out.push(`## ${s.user}`, "", t.user, "");
  let inAssistant = false;
  let lastWasTool = false;
  for (const item of t.items) {
    if (!inAssistant) {
      out.push(`## ${s.assistant}`, "");
      inAssistant = true;
    }
    if ("tool" in item) {
      out.push(`- ${s.tool} ${item.tool}: ${item.summary}`);
      lastWasTool = true;
    } else {
      if (lastWasTool) out.push("");
      out.push(item.text, "");
      lastWasTool = false;
    }
  }
  return out.join("\n").trim();
}

/**
 * 写进文件的内容：开头一段说明，然后按时间顺序的各轮。正文超过 TAIL_CHARS 时去掉最旧的轮；只剩一轮还超出就截掉它的前面。
 * 没有可写的轮时返回 null。
 */
export function renderRefreshTail(turns: TailTurn[], sessionId: string): string | null {
  const blocks = turns.map(renderTurn).filter((b) => b.length > 0);
  const sep = "\n\n";
  let total = blocks.reduce((n, b) => n + b.length, 0) + sep.length * Math.max(0, blocks.length - 1);
  while (blocks.length > 1 && total > TAIL_CHARS) total -= blocks.shift()!.length + sep.length;
  if (blocks.length === 0) return null;
  const s = M().refreshTail;
  if (blocks[0].length > TAIL_CHARS) blocks[0] = `${s.cut}\n\n…${blocks[0].slice(blocks[0].length - (TAIL_CHARS - s.cut.length - 3))}`;
  return `# ${s.title}\n\n${s.intro(sessionId, blocks.length)}\n\n${blocks.join(sep)}\n`;
}

/** 读文件末尾 maxBytes 字节，按行拆开（不是从头读时去掉可能被截断的第一行）。 */
async function readTailLines(file: string, maxBytes: number): Promise<{ lines: string[]; fromStart: boolean }> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8", 0, bytesRead).split("\n");
    if (start > 0) lines.shift();
    return { lines, fromStart: start === 0 };
  } finally {
    await fh.close();
  }
}

/** 读 transcript 摘尾巴；窗口里没找到 handoff 请求、或者不够 TAIL_TURNS 轮时扩大窗口再读。 */
export async function readRefreshTail(file: string, isCommand: (content: unknown) => boolean): Promise<TailExtract> {
  for (let window = FIRST_WINDOW; ; window *= 8) {
    const { lines, fromStart } = await readTailLines(file, window);
    const r = extractRefreshTail(lines, isCommand);
    if ((r.commandFound && r.turns.length >= TAIL_TURNS) || fromStart || window * 8 > MAX_WINDOW) return r;
  }
}

/**
 * 摘尾巴并写进 out（覆盖上一次换新写的）：成功返回 out；没有 transcript、没找到 handoff 请求、没有可写的对话时返回 null，不写。
 * 读写失败会 reject（调用方记日志，当作没写成）。
 */
export async function writeRefreshTail(o: {
  transcript: string | null;
  out: string;
  sessionId: string;
  kind: "ticket" | "feature" | "epic";
}): Promise<string | null> {
  if (!o.transcript) return null;
  const { turns } = await readRefreshTail(o.transcript, refreshCommandMatcher(o.kind));
  const body = renderRefreshTail(turns, o.sessionId);
  if (body === null) return null;
  await mkdir(dirname(o.out), { recursive: true });
  await writeFile(o.out, body, "utf8");
  return o.out;
}
