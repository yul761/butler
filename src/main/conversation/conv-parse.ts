import { createHash } from "node:crypto";
import { isHandoffInvocation, isToolResultOnly } from "../handoff/transcript";
import { deliveryText } from "../prereview/delivery";
import { classifyCommand } from "../sessions/activity-parse";
import { MAIN_STRINGS } from "../strings";

/**
 * 对话另存（UI 重做第 4 层）：把 Claude Code transcript 的一行变成「说的话」。纯函数，不读文件、不碰数据库。
 * 「哪些 user 文本不算话」的规则只在这里一份（refresh-tail.ts 有自己的过滤，服务的是另一件事，不共用）。
 *
 * 规则：
 *  1. 整行跳过（返回 []）：JSON 解析失败；type 不是 user 也不是 assistant；isSidechain（子 agent 的对话）。
 *  2. noise（不是话、也不开新轮，只用来接上 parentUuid）：isMeta、isCompactSummary、isApiErrorMessage、model 是 <synthetic>、
 *     user 的 content 只有 tool_result、清洗后文本为空、第 4 条。
 *  3. user 文本清洗：去掉 <system-reminder>、<ide_selection>、<ide_opened_file>、<ide_diagnostics> 块，再 trim；
 *     content 是数组时 text 块用 \n\n 连起来，每个 image 块记成 [image]。
 *  4. 清洗后以 <local-command-stdout|stderr|caveat>、<bash-input|stdout|stderr>、<task-notification> 开头，
 *     或者以 [Request interrupted by user 开头：noise。
 *  5. handoff（不存，这一轮 agent 的话也不存）：/handoff 调用；Butler 的 epic handoff 请求（refreshEpicHandoff、
 *     idleCloseEpicHandoff，中英各取前 24 个字符）。
 *  6. relay（存成 user 消息，但这一轮不判问答）：以 inboxAnswersIntro 开头，Butler 转给 agent 的用户回答。
 *  7. silent（不存，开一轮 qa=no；agent 的话照存）：其他斜杠命令（含 <command-name>）；Butler：/Butler: 开头的通知；
 *     换新的恢复提示（refreshResume）、转来的汇报（inboxReportsIntro）、每日巡检（butlerPatrolMessage），中英各取前 16 个字符；
 *     总控发来的消息、花费上限后的「接着做」取整段固定开头（SILENT_HEADS）；别的 session 的回复、预审结果、进件缺信息时
 *     让总控去问，开头和占位符之间的固定段都要对上（SILENT_SHAPES）。
 *  8. 其余都是 user。
 *  9. assistant：只取 text 块（不要 thinking），用 \n\n 连起来，放在第一个 text 块的位置；每个 tool_use 一个 tool entry；
 *     stop = stop_reason === "end_turn"，只挂在这一行的最后一个 entry 上。
 * 10. key：uuid；没有 uuid 时用 h: 加整行的 sha1。同一行第二个 entry 起加 #1、#2……
 * 11. at：Date.parse(timestamp)，不是字符串或解析失败为 null。
 * 12. 工具效果：见 toolEffect。
 * 13. 长度上限：见 capText。
 */

export const CONV_TEXT_MAX = 20_000;
/** capText 保留的结尾长度。 */
const CAP_TAIL = 4000;

export type ToolEffect = "read" | "mutate" | "other";
/** user 文本怎么处理：user 存且开一轮；relay 存但开的是不判问答的一轮；silent 不存只开一轮；handoff 不存、这一轮 agent 的话也不存。 */
export type UserOpen = "user" | "relay" | "silent" | "handoff";
export type ConvEntry =
  | { kind: "user"; key: string; parent: string | null; at: number | null; open: UserOpen; text: string | null }
  | { kind: "assistant"; key: string; parent: string | null; at: number | null; text: string; stop: boolean }
  | { kind: "tool"; key: string; parent: string | null; at: number | null; name: string; effect: ToolEffect; stop: boolean }
  /** 不是话、也不开新轮（工具结果、本地命令输出、isMeta、compact 摘要、API 错误……）：只用来接上 parentUuid。 */
  | { kind: "noise"; key: string; parent: string | null; at: number | null };

interface Line {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  isApiErrorMessage?: unknown;
  message?: { content?: unknown; model?: unknown; stop_reason?: unknown } | null;
}

type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? content.filter((b): b is Block => !!b && typeof b === "object") : []);

const STRIP = /<(system-reminder|ide_selection|ide_opened_file|ide_diagnostics)>[\s\S]*?<\/\1>/g;
const NOISE_HEAD = /^(<(local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)>|\[Request interrupted by user)/;
const COMMAND_NAME = /<command-name>/;
const BUTLER_NOTICE = /^Butler(：|: )/;

const heads = (pick: (s: (typeof MAIN_STRINGS)["zh"]) => string, n: number): string[] => Object.values(MAIN_STRINGS).map((s) => pick(s).slice(0, n));
const HANDOFF_HEADS = [...heads((s) => s.refreshEpicHandoff, 24), ...heads((s) => s.idleCloseEpicHandoff, 24)];
const RELAY_HEADS = heads((s) => s.inboxAnswersIntro, Number.MAX_SAFE_INTEGER);
/** 只转一条回答时没有 intro，整条就是 inboxAnswer(问题, 回答)：认开头和中间「用户的回答」那一段。 */
const RELAY_SINGLE = Object.values(MAIN_STRINGS).map((s) => {
  const [pre, rest = ""] = s.inboxAnswer("\u0000", "\u0001").split("\u0000");
  return { pre, mid: rest.split("\u0001")[0] };
});
const isSingleRelay = (t: string): boolean => RELAY_SINGLE.some(({ pre, mid }) => t.startsWith(pre) && t.indexOf(mid, pre.length) > 0);
/** 模板里第一个占位符之前的那段（占位符用 \u0000 代入）。 */
const before0 = (t: string): string => t.split("\u0000")[0];
/**
 * 模板（占位符代入 \u0000、\u0001）第一行的固定段：文本要以第一段开头，后面各段按顺序出现才算。
 * 只认开头太容易误伤用户自己的话（「Butler 对 CI 的判断对吗？」「【回复】一下 amy 的评论」）。
 */
type Shape = string[];
const shapeOf = (template: string): Shape => template.split("\n")[0].split("\u0000").flatMap((p) => p.split("\u0001"));
const fits = (shape: Shape, text: string): boolean => {
  if (!text.startsWith(shape[0])) return false;
  let at = shape[0].length;
  for (const piece of shape.slice(1)) {
    if (!piece) continue;
    const i = text.indexOf(piece, at);
    if (i < 0) return false;
    at = i + piece.length;
  }
  return true;
};
const shapes = (pick: (s: (typeof MAIN_STRINGS)["zh"]) => string): Shape[] => Object.values(MAIN_STRINGS).map((s) => shapeOf(pick(s)));
/**
 * Butler 往终端里打的其它固定格式（「Butler：」开头的通知另由 BUTLER_NOTICE 认）：别的 session 的回复、预审结果、
 * 进件缺信息时让总控去问。开头加上占位符之间的固定段一起认。
 */
const SILENT_SHAPES: Shape[] = [
  ...shapes((s) => s.butlerReplyLine("\u0000", ["\u0001"], "")),
  ...shapes((s) => s.intakeClarify("\u0000", "\u0001", "", false)),
  ...shapes((s) => s.intakeClarify("\u0000", "\u0001", "", true)),
  ...(["zh", "en"] as const).flatMap((lang) =>
    (["error", "clean", "violations"] as const).map((verdict) => shapeOf(deliveryText({ shortSha: "\u0000", verdict, violations: [], gaps: [], error: "\u0001", lang }))),
  ),
];
/** 总控发来的消息、每日巡检、花费上限后的「接着做」：固定开头本身就够长。 */
const SILENT_HEADS = [
  ...heads((s) => s.refreshResume("ticket", "X-1", null), 16),
  ...heads((s) => s.inboxReportsIntro, 16),
  ...heads((s) => s.butlerMessagePrefix, Number.MAX_SAFE_INTEGER),
  ...heads((s) => s.butlerPatrolMessage, 16),
  ...heads((s) => before0(s.cost.continueAfterDowngrade("\u0000")), Number.MAX_SAFE_INTEGER),
  ...heads((s) => before0(s.cost.continueAfterRaise("\u0000")), Number.MAX_SAFE_INTEGER),
];

/** 去掉提醒和 IDE 上下文块，再 trim。 */
export function cleanUserText(raw: string): string {
  return raw.replace(STRIP, "").trim();
}

/** user content 的原文：字符串，或者 text 块用 \n\n 连起来，image 块记成 [image]。 */
function rawUserText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .map((b) => (b.type === "text" ? String(b.text ?? "") : b.type === "image" ? "[image]" : null))
    .filter((t): t is string => t !== null)
    .join("\n\n");
}

/** 一条 user 消息怎么处理（规则 4 到 8）。cleaned 是 cleanUserText 之后的文本。 */
export function userOpenOf(content: unknown, cleaned: string): UserOpen | "noise" {
  if (!cleaned || NOISE_HEAD.test(cleaned)) return "noise";
  if (isHandoffInvocation(content) || HANDOFF_HEADS.some((h) => cleaned.startsWith(h))) return "handoff";
  if (RELAY_HEADS.some((h) => cleaned.startsWith(h)) || isSingleRelay(cleaned)) return "relay";
  if (COMMAND_NAME.test(cleaned) || BUTLER_NOTICE.test(cleaned) || SILENT_HEADS.some((h) => cleaned.startsWith(h)) || SILENT_SHAPES.some((sh) => fits(sh, cleaned))) {
    return "silent";
  }
  return "user";
}

const MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "TodoWrite", "BashOutput", "ToolSearch", "AskUserQuestion"]);
const MCP_MUTATE = /create|push|merge|update|delete|write|commit|remember|forget|handoff|set_/;
const MCP_READ = /get|list|search|read|view|recall|facts|why|status|activity/;

const BASH_MUTATE = [
  /\bgit\s+(commit|push|merge|rebase|reset|cherry-pick|am|revert|tag|stash)\b/,
  /\bgh\s+pr\s+(create|merge|edit|comment|close|ready)\b/,
  /\bsed\s+-i\b/,
  /(^|[;&|]\s*)(rm|mv|cp|mkdir|touch|chmod)\s/,
];
/** 去掉写到 /dev/null 和 2>&1 这类转向以后，还有 > 或 >> 就算写文件。 */
const harmlessRedirect = /\d*>>?\s*\/dev\/null\b|\d*>&\d+/g;
const fileRedirect = /(^|[^-=<>])>>?(?!=)/;

const READ_SEGMENTS: RegExp[] = [
  /^git\s+(status|log|diff|show|blame|branch)\b/,
  /^(ls|cat|grep|rg|find|head|tail|wc|pwd|echo)(\s|$)/,
  /^gh\s+pr\s+(view|checks|list|diff)\b/,
  /^gh\s+run\s+(view|list)\b/,
];

function bashEffect(command: string): ToolEffect {
  if (!command.trim()) return "other";
  if (BASH_MUTATE.some((r) => r.test(command))) return "mutate";
  if (fileRedirect.test(command.replace(harmlessRedirect, ""))) return "mutate";
  const kind = classifyCommand(command).kind;
  if (kind === "push" || kind === "rebase") return "mutate";
  const segments = command.replace(harmlessRedirect, "").split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every((s) => READ_SEGMENTS.some((r) => r.test(s))) ? "read" : "other";
}

/** 工具调用改没改东西（只用来判断问答，不存）。mcp 工具按工具名那一段（最后一个 __ 后面）判断，避开服务名里的词。 */
export function toolEffect(name: string, input: unknown): ToolEffect {
  if (MUTATING_TOOLS.has(name)) return "mutate";
  if (READ_TOOLS.has(name)) return "read";
  if (name === "Bash") {
    const command = input && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
    return typeof command === "string" ? bashEffect(command) : "other";
  }
  if (name.startsWith("mcp__")) {
    const tool = name.slice(name.lastIndexOf("__") + 2);
    if (MCP_MUTATE.test(tool)) return "mutate";
    if (MCP_READ.test(tool)) return "read";
  }
  return "other";
}

/** 超过 max 时保留开头 max-4000 个字符和结尾 4000 个，中间写明省略了多少。按码点切，不切坏代理对。 */
export function capText(text: string, max = CONV_TEXT_MAX): string {
  if (text.length <= max) return text;
  const cps = [...text];
  if (cps.length <= max) return text;
  const tail = Math.min(CAP_TAIL, Math.floor(max / 2));
  const head = max - tail;
  const omitted = cps.length - head - tail;
  return `${cps.slice(0, head).join("")}\n\n[… ${omitted} chars omitted …]\n\n${cps.slice(cps.length - tail).join("")}`;
}

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

type Draft =
  | { kind: "user"; open: UserOpen; text: string | null }
  | { kind: "assistant"; text: string; stop: boolean }
  | { kind: "tool"; name: string; effect: ToolEffect; stop: boolean }
  | { kind: "noise" };

function draftsOf(e: Line): Draft[] {
  const content = e.message?.content;
  if (e.isMeta === true || e.isCompactSummary === true || e.isApiErrorMessage === true || e.message?.model === "<synthetic>") return [{ kind: "noise" }];
  if (e.type === "user") {
    if (isToolResultOnly(content)) return [{ kind: "noise" }];
    const cleaned = cleanUserText(rawUserText(content));
    const open = userOpenOf(content, cleaned);
    if (open === "noise") return [{ kind: "noise" }];
    return [{ kind: "user", open, text: open === "user" || open === "relay" ? cleaned : null }];
  }
  const out: Draft[] = [];
  const texts: string[] = [];
  let textAt = -1;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : blocksOf(content);
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      if (textAt < 0) {
        textAt = out.length;
        out.push({ kind: "assistant", text: "", stop: false });
      }
      texts.push(b.text.trim());
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      out.push({ kind: "tool", name: b.name, effect: toolEffect(b.name, b.input), stop: false });
    }
  }
  if (textAt >= 0) out[textAt] = { kind: "assistant", text: texts.join("\n\n"), stop: false };
  if (out.length === 0) return [{ kind: "noise" }];
  const last = out[out.length - 1] as { stop?: boolean };
  last.stop = e.message?.stop_reason === "end_turn";
  return out;
}

/** transcript 的一行 → entries（规则见文件头）。永不抛错。 */
export function convEntriesOf(line: string): ConvEntry[] {
  let e: Line;
  try {
    const v = JSON.parse(line) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return [];
    e = v as Line;
  } catch {
    return [];
  }
  if (e.type !== "user" && e.type !== "assistant") return [];
  if (e.isSidechain === true) return [];
  const base = typeof e.uuid === "string" && e.uuid ? e.uuid : `h:${sha1(line)}`;
  const parent = typeof e.parentUuid === "string" ? e.parentUuid : null;
  const parsed = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  const at = Number.isFinite(parsed) ? parsed : null;
  return draftsOf(e).map((d, i) => ({ ...d, key: i === 0 ? base : `${base}#${i}`, parent, at }) as ConvEntry);
}
