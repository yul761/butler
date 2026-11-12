import { extractUserText } from "./discovery";

/** 命令文字最多保留多少个字符。 */
export const DETAIL_LIMIT = 40;

export interface RunningTool {
  id: string;
  name: string;
  command: string | null;
  file: string | null;
  startedAt: number;
  /** TaskStop / KillShell 要停的后台任务 id（tool_use 输入里的 task_id / shell_id）；别的工具没有这一项。 */
  stopsTask?: string;
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
  /** lastReply 所在那条 assistant 记录的 message.id（“需要你”按它只判断一次）；没有 id 时为 null。 */
  lastReplyId: string | null;
}

export function newTranscriptState(): TranscriptState {
  return { running: new Map(), background: new Map(), turnOpen: false, lastReply: null, lastReplyId: null };
}

/** 用户按 Esc 打断时 Claude Code 写的文字（也有 for tool use 的说法）；它后面不会再有结束这一轮的记录。 */
const INTERRUPT_PREFIX = "[Request interrupted by user";

const REBASE_RE = /\bgit\s+(?:rebase|pull\b.*--rebase)\b/;
const PUSH_RE = /\bgit\s+push\b/;
const CI_RE = /\bgh\s+run\s+watch\b|\bgh\s+pr\s+checks\b.*--watch/;
const TEST_RE = /\b(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test|vitest|jest|pytest|go\s+test|cargo\s+test|playwright\s+test|mocha)\b/;

/** 把 shell 命令归类：rebase、push、等 CI、跑测试，其余算普通命令。 */
export function classifyCommand(command: string): { kind: "rebase" | "push" | "ci" | "test" | "command"; detail: string } {
  const detail = command.trim().slice(0, DETAIL_LIMIT);
  // git pull --rebase 不是 push，rebase 要先判
  if (REBASE_RE.test(command)) return { kind: "rebase", detail };
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

/** 停后台任务的工具：TaskStop，旧名 KillShell、KillBash。它们停掉的任务不会再有 task-notification。 */
const STOP_TOOLS = new Set(["TaskStop", "KillShell", "KillBash"]);
/** 停成功时 toolUseResult.message 的开头（tool_use 不在重放的尾部里时靠它认）。 */
const STOPPED_RE = /^Successfully (?:stopped task|killed shell)/;
const NOTIFICATION_TAG = "<task-notification>";

const idOf = (o: Obj): string | null => {
  const v = typeof o.task_id === "string" ? o.task_id : typeof o.shell_id === "string" ? o.shell_id : null;
  return v?.trim() || null;
};

/** 这条 tool_result 停掉的后台任务 id：先看结果里的 task_id / shell_id，再看 tool_use 输入里的。不是停任务的工具返回 null。 */
function stoppedTask(tool: RunningTool | undefined, result: unknown): string | null {
  const r = isObj(result) ? result : null;
  if (tool) return STOP_TOOLS.has(tool.name) ? ((r && idOf(r)) ?? tool.stopsTask ?? null) : null;
  // 没看到 tool_use（在重放的 4MB 之前）：只认明确说停成功了的结果
  return r && typeof r.message === "string" && STOPPED_RE.test(r.message) ? idOf(r) : null;
}

/** 以 <task-notification> 开头的文字里所有的 task-id；只是提到它的文字（用户引用、读文件的结果）不算。 */
function notifiedTasks(text: string): string[] {
  if (!text.trimStart().startsWith(NOTIFICATION_TAG)) return [];
  return [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1].trim());
}

/** 用户条目、queued_command 附件里的文字：字符串，或者 text 块拼起来（tool_result 块不算）。 */
function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((x) => (isObj(x) && x.type === "text" && typeof x.text === "string" ? x.text : "")).join("\n");
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
    // 后台任务靠通知或 TaskStop 清，没拿到结果的前台工具（被打断）在轮次结束时清掉
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
    if (text) {
      s.lastReply = text;
      s.lastReplyId = typeof message.id === "string" && message.id ? message.id : null;
    }
    for (const block of message.content) {
      if (!isObj(block) || block.type !== "tool_use" || typeof block.id !== "string") continue;
      const input = isObj(block.input) ? block.input : {};
      const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
      const name = typeof block.name === "string" ? block.name : "";
      const tool: RunningTool = { id: block.id, name, command: typeof input.command === "string" ? input.command : null, file, startedAt: entryTime(entry) };
      const stops = STOP_TOOLS.has(name) ? idOf(input) : null;
      if (stops) tool.stopsTask = stops;
      s.running.set(block.id, tool);
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
        // TaskStop / KillShell 停掉的任务不会再有通知，只能在这里清
        const stopped = stoppedTask(tool, entry.toolUseResult);
        if (stopped) s.background.delete(stopped);
        if (taskId && tool) {
          // 真实文本里路径后面还有同一行的句子：以 .output 结尾，后面是「.」加空白、行尾的「.」或行尾。
          const m = /Output is being written to:\s*(.+?\.output)(?=\.(?:\s|$)|$)/m.exec(resultText(block.content));
          s.background.set(taskId, { taskId, toolUseId: tool.id, command: tool.command ?? "", outputFile: m ? m[1].trim() : null, startedAt: tool.startedAt });
        }
      }
    }
    // 任务结束的通知有时直接作为用户条目写进来（不经过 queue-operation）
    if (message) for (const id of notifiedTasks(plainText(message.content))) s.background.delete(id);
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

  if (entry.type === "attachment") {
    // 排队的通知（queued_command 附件，prompt 就是 <task-notification>…）
    const a = isObj(entry.attachment) ? entry.attachment : null;
    if (a?.type === "queued_command") for (const id of notifiedTasks(plainText(a.prompt))) s.background.delete(id);
    return;
  }

  if (entry.type === "queue-operation" && entry.operation === "enqueue" && typeof entry.content === "string" && entry.content.includes(NOTIFICATION_TAG)) {
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
