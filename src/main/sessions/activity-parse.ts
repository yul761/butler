import { extractUserText } from "./discovery";

/** 命令文字最多保留多少个字符。 */
export const DETAIL_LIMIT = 40;

export interface RunningTool {
  id: string;
  name: string;
  command: string | null;
  file: string | null;
  startedAt: number;
}

export interface BackgroundTask {
  taskId: string;
  toolUseId: string;
  command: string;
  outputFile: string | null;
  startedAt: number;
}

export interface TranscriptState {
  running: Map<string, RunningTool>;
  background: Map<string, BackgroundTask>;
  /** 当前轮次是否还没结束。 */
  turnOpen: boolean;
  /** 最后一条带文字的 assistant 回复（总控结束 session 前看它是不是在问用户）；还没有时为 null。 */
  lastReply: string | null;
}

export function newTranscriptState(): TranscriptState {
  return { running: new Map(), background: new Map(), turnOpen: false, lastReply: null };
}

/** 用户按 Esc 打断时 Claude Code 写的文字（也有 for tool use 的说法）；它后面不会再有结束这一轮的记录。 */
const INTERRUPT_PREFIX = "[Request interrupted by user";

const PUSH_RE = /\bgit\s+push\b/;
const CI_RE = /\bgh\s+run\s+watch\b|\bgh\s+pr\s+checks\b.*--watch/;
const TEST_RE = /\b(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test|vitest|jest|pytest|go\s+test|cargo\s+test|playwright\s+test|mocha)\b/;

/** 把 shell 命令归类：push、等 CI、跑测试，其余算普通命令。 */
export function classifyCommand(command: string): { kind: "push" | "ci" | "test" | "command"; detail: string } {
  const detail = command.trim().slice(0, DETAIL_LIMIT);
  if (PUSH_RE.test(command)) return { kind: "push", detail };
  if (CI_RE.test(command)) return { kind: "ci", detail };
  if (TEST_RE.test(command)) return { kind: "test", detail };
  return { kind: "command", detail };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object";

function entryTime(e: Obj): number {
  const t = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((x) => (isObj(x) && typeof x.text === "string" ? x.text : "")).join("\n");
}

/** 把一条 transcript 记录折进状态；任何形状不对的记录都忽略，不抛错。 */
export function applyEntry(s: TranscriptState, entry: unknown): void {
  if (!isObj(entry) || entry.isSidechain === true) return;
  const message = isObj(entry.message) ? entry.message : null;

  if (entry.type === "assistant" && message) {
    // 后台任务靠 notification 清，没拿到结果的前台工具（被打断）在轮次结束时清掉
    if (message.stop_reason === "end_turn") {
      s.turnOpen = false;
      s.running.clear();
    } else {
      // 后台任务完成会让 Claude 在没有用户消息的情况下重新开始一轮
      s.turnOpen = true;
    }
    if (!Array.isArray(message.content)) return;
    const text = message.content
      .flatMap((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" && b.text.trim() ? [b.text.trim()] : []))
      .join("\n");
    if (text) s.lastReply = text;
    for (const block of message.content) {
      if (!isObj(block) || block.type !== "tool_use" || typeof block.id !== "string") continue;
      const input = isObj(block.input) ? block.input : {};
      const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
      s.running.set(block.id, {
        id: block.id,
        name: typeof block.name === "string" ? block.name : "",
        command: typeof input.command === "string" ? input.command : null,
        file,
        startedAt: entryTime(entry),
      });
    }
    return;
  }

  if (entry.type === "user") {
    // tool_result 在任何路径下都要处理，文字和结果可能在同一条记录里
    if (message && Array.isArray(message.content)) {
      const taskId = isObj(entry.toolUseResult) && typeof entry.toolUseResult.backgroundTaskId === "string" ? entry.toolUseResult.backgroundTaskId : null;
      for (const block of message.content) {
        if (!isObj(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const tool = s.running.get(block.tool_use_id);
        s.running.delete(block.tool_use_id);
        if (taskId && tool) {
          // 真实文本里路径后面还有同一行的句子：以 .output 结尾，后面是「.」加空白、行尾的「.」或行尾。
          const m = /Output is being written to:\s*(.+?\.output)(?=\.(?:\s|$)|$)/m.exec(resultText(block.content));
          s.background.set(taskId, { taskId, toolUseId: tool.id, command: tool.command ?? "", outputFile: m ? m[1].trim() : null, startedAt: tool.startedAt });
        }
      }
    }
    const text = extractUserText(entry);
    if (text !== null) {
      // 新的用户消息或者打断：上一轮没拿到结果的前台工具不会再有结果了
      s.running.clear();
      s.turnOpen = !text.startsWith(INTERRUPT_PREFIX);
    }
    return;
  }

  if (entry.type === "system") {
    if (entry.subtype === "turn_duration" || entry.subtype === "stop_hook_summary") {
      s.turnOpen = false;
      s.running.clear();
    }
    return;
  }

  if (entry.type === "queue-operation" && entry.operation === "enqueue" && typeof entry.content === "string" && entry.content.includes("<task-notification>")) {
    const m = /<task-id>([^<]+)<\/task-id>/.exec(entry.content);
    if (m) s.background.delete(m[1].trim());
  }
}

/** 正在跑的前台工具里最新的那个。 */
export function currentTool(s: TranscriptState): RunningTool | null {
  let last: RunningTool | null = null;
  for (const t of s.running.values()) last = t;
  return last;
}

export function backgroundTasks(s: TranscriptState): BackgroundTask[] {
  return [...s.background.values()];
}
