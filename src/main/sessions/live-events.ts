import type { ActivityEvent, ActivityEventKind } from "../../shared/activity";
import type { TranscriptEvent } from "./activity-parse";

/** 实况窗口一行字最多多少个字符（含省略号）。 */
export const LABEL_LIMIT = 80;

/** MCP 工具名：mcp__<server>__<tool>。 */
const MCP_RE = /^mcp__(.+?)__([^_].*)$/;
/** 记忆工具（StateCore 的工具名，挂在哪个记忆 server 上都一样）：remember、handoff 算写，recall、facts、why 算读。forget 两边都不算。 */
const MEMORY_WRITE = new Set(["remember", "handoff"]);
const MEMORY_READ = new Set(["recall", "facts", "why"]);

/** 工具名是 `*__remember`、`*__handoff` 算写记忆，`*__recall`、`*__facts`、`*__why` 算读记忆，别的返回 null。 */
export function memoryKind(name: string): "memory-write" | "memory-read" | null {
  const tool = MCP_RE.exec(name)?.[2];
  if (!tool) return null;
  if (MEMORY_WRITE.has(tool)) return "memory-write";
  if (MEMORY_READ.has(tool)) return "memory-read";
  return null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 路径的最后一段（Windows 路径也按反斜杠切）。 */
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

/** 压成一行、去掉首尾空白，超出 LABEL_LIMIT 的截断加省略号。 */
function oneLine(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const chars = [...t];
  return chars.length <= LABEL_LIMIT ? t : `${chars.slice(0, LABEL_LIMIT - 1).join("")}…`;
}

/** 一般工具的主要参数：命令的第一行、文件名、搜索的模式、子 agent 的说明、网址。没有就是空串。 */
function mainArg(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") return str(input.command).split("\n")[0];
  const file = str(input.file_path) || str(input.notebook_path);
  if (file) return baseName(file);
  return str(input.pattern) || str(input.description) || str(input.url) || str(input.query);
}

/**
 * 实况窗口里一行的字：记忆工具写的是记下了什么（remember 的 text、handoff 的 summary）或者查了什么（recall 的 query、why 的 factId），
 * 没有参数时写工具名；MCP 工具写成「工具 (server)」；其余是工具名加主要参数。
 */
export function toolLabel(name: string, input: Record<string, unknown>): string {
  const mcp = MCP_RE.exec(name);
  if (mcp && memoryKind(name)) {
    const tool = mcp[2];
    const said = str(input.text) || str(input.summary) || str(input.query) || str(input.factId);
    return oneLine(said || tool);
  }
  if (mcp) return oneLine(`${mcp[2]} (${mcp[1]})`);
  return oneLine([name, mainArg(name, input)].filter(Boolean).join(" "));
}

/** transcript 里的一件事换成推给界面的 activity:event。 */
export function liveEvent(sessionId: string, e: TranscriptEvent): ActivityEvent {
  if (e.type !== "tool") return { sessionId, at: e.at, kind: e.type, label: "" };
  const kind: ActivityEventKind = memoryKind(e.name) ?? "tool";
  return { sessionId, at: e.at, kind, label: toolLabel(e.name, e.input) };
}
