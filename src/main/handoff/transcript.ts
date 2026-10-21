import { open } from "node:fs/promises";
import { extractHandoffBlock } from "./schema";

export interface AssistantText {
  uuid: string | null;
  text: string;
}

interface Entry {
  type?: unknown;
  uuid?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
}

const isToolResultOnly = (content: unknown): boolean =>
  Array.isArray(content) &&
  content.length > 0 &&
  content.every((b) => !!b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
    .map((b) => String((b as { text?: unknown }).text ?? ""))
    .join("\n");
}

const COMMAND_NAME = /<command-name>\s*\/handoff\s*<\/command-name>/;
const TYPED_COMMAND = /^\s*\/handoff(\s|$)/;

/** 这条 user 消息是不是 /handoff 的调用（命令消息，或直接键入的 /handoff）。 */
const isHandoffInvocation = (content: unknown): boolean => {
  const t = textOf(content);
  return COMMAND_NAME.test(t) || TYPED_COMMAND.test(t);
};

export interface LastTurn {
  turn: AssistantText[];
  /** 这一轮的起点是不是 /handoff 调用（包括 isMeta 的命令展开，V4）。 */
  isHandoffCommand: boolean;
}

const MAX_WINDOW = 16 * 1024 * 1024;

/**
 * 读 transcript 末尾（默认 1 MiB），返回最后一轮对话里 assistant 的文本（按时间顺序）。
 * “一轮”从最后一条不是 tool_result 的 user 消息之后开始（/handoff 展开后的说明是一条 isMeta 的 user 消息，也算边界，
 * 此时再往前看一条 user 消息是不是 /handoff 的命令消息）。isSidechain 条目整个跳过。
 * 窗口里没找到 assistant 文本或没找到边界时，扩大窗口再读。
 */
export async function readLastTurnInfo(file: string, maxBytes = 1024 * 1024): Promise<LastTurn> {
  const fh = await open(file, "r");
  let text: string;
  let fromStart: boolean;
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    text = buf.toString("utf8", 0, bytesRead);
    fromStart = start === 0;
  } finally {
    await fh.close();
  }
  const lines = text.split("\n");
  if (!fromStart) lines.shift(); // 第一行可能被截断。

  const turn: AssistantText[] = [];
  let isHandoffCommand = false;
  let boundaryFound = false;
  let pendingMeta = false; // 已遇到 isMeta 边界，还在找它前面的命令消息。
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: Entry | null;
    try {
      e = JSON.parse(lines[i]) as Entry | null;
    } catch {
      continue;
    }
    if (!e || typeof e !== "object" || e.isSidechain === true) continue;
    if (e.type === "user") {
      const content = e.message?.content;
      if (isToolResultOnly(content)) continue;
      if (!pendingMeta) {
        boundaryFound = true;
        if (isHandoffInvocation(content)) {
          isHandoffCommand = true;
          break;
        }
        if (e.isMeta !== true) break;
        pendingMeta = true;
        continue;
      }
      isHandoffCommand = isHandoffInvocation(content);
      break;
    }
    if (e.type === "assistant" && !pendingMeta) {
      const t = textOf(e.message?.content);
      if (t) turn.unshift({ uuid: typeof e.uuid === "string" ? e.uuid : null, text: t });
    }
  }
  if ((turn.length === 0 || !boundaryFound || pendingMeta) && !fromStart && maxBytes * 8 <= MAX_WINDOW) {
    return readLastTurnInfo(file, maxBytes * 8);
  }
  return { turn, isHandoffCommand };
}

export async function readLastTurn(file: string, maxBytes = 1024 * 1024): Promise<AssistantText[]> {
  return (await readLastTurnInfo(file, maxBytes)).turn;
}

export interface FoundHandoff {
  /** 所在 assistant 条目的 uuid（入库去重用）。 */
  uuid: string | null;
  block: string;
}

/** 这一轮里最后一个 butler-handoff 代码块。 */
export function findHandoffBlock(turn: AssistantText[]): FoundHandoff | null {
  for (let i = turn.length - 1; i >= 0; i--) {
    const block = extractHandoffBlock(turn[i].text);
    if (block !== null) return { uuid: turn[i].uuid, block };
  }
  return null;
}
