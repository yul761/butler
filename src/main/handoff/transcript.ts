import { open } from "node:fs/promises";
import { extractHandoffBlock } from "./schema";

export interface AssistantText {
  uuid: string | null;
  text: string;
}

interface Entry {
  type?: unknown;
  uuid?: unknown;
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

const MAX_WINDOW = 16 * 1024 * 1024;

/**
 * 读 transcript 末尾（默认 1 MiB），返回最后一轮对话里 assistant 的文本（按时间顺序）。
 * “一轮”从最后一条不是 tool_result 的 user 消息之后开始（/handoff 展开后的说明是一条 isMeta 的 user 消息，也算边界）。
 * 窗口里一条 assistant 文本都没找到时，扩大窗口再读一次。
 */
export async function readLastTurn(file: string, maxBytes = 1024 * 1024): Promise<AssistantText[]> {
  const fh = await open(file, "r");
  let text: string;
  let fromStart: boolean;
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    text = buf.toString("utf8");
    fromStart = start === 0;
  } finally {
    await fh.close();
  }
  const lines = text.split("\n");
  if (!fromStart) lines.shift(); // 第一行可能被截断。

  const out: AssistantText[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: Entry | null;
    try {
      e = JSON.parse(lines[i]) as Entry | null;
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    if (e.type === "user") {
      if (isToolResultOnly(e.message?.content)) continue;
      break;
    }
    if (e.type === "assistant") {
      const t = textOf(e.message?.content);
      if (t) out.unshift({ uuid: typeof e.uuid === "string" ? e.uuid : null, text: t });
    }
  }
  if (out.length === 0 && !fromStart && maxBytes * 8 <= MAX_WINDOW) return readLastTurn(file, maxBytes * 8);
  return out;
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
