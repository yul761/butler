import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyPrState, classifyShip } from "../src/shared/gate-command";
import type { HookEnvelope } from "../src/shared/hook-envelope";
import { homeFromEnv } from "../src/main/paths";
import { envValue } from "../src/shared/legacy-env";
import { renameWithRetrySync } from "../src/main/util/fs-retry";

const RAW_LIMIT = 10_000;

const DESCRIPTION_LIMIT = 200;

/** Agent / Task 的 PostToolUse 带着整个 prompt 和 tool_response（可能很大）：只留判断是不是 review 要用的几个字段。 */
function trimAgentPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  if (p.hook_event_name !== "PostToolUse" || (p.tool_name !== "Agent" && p.tool_name !== "Task")) return payload;
  const input = p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
  return {
    hook_event_name: p.hook_event_name,
    session_id: p.session_id,
    tool_name: p.tool_name,
    tool_use_id: p.tool_use_id,
    cwd: p.cwd,
    tool_input: {
      description: typeof input.description === "string" ? input.description.slice(0, DESCRIPTION_LIMIT) : null,
      subagent_type: typeof input.subagent_type === "string" ? input.subagent_type : null,
    },
  };
}

const REMEMBER_LIMIT = 4000;

/** feature 记忆的 remember（约定广播，BTL-245）：只留存进去的那段话和 consolidate，tool_response 不带。 */
function trimRememberPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  if (p.hook_event_name !== "PostToolUse" || p.tool_name !== "mcp__shipherd-feature__remember") return payload;
  const input = p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
  return {
    hook_event_name: p.hook_event_name,
    session_id: p.session_id,
    tool_name: p.tool_name,
    tool_input: { text: typeof input.text === "string" ? input.text.slice(0, REMEMBER_LIMIT) : null, consolidate: input.consolidate === true },
  };
}

const COMMAND_LIMIT = 2000;
const PR_URLS_MAX = 5;

/** Bash 跑完（成功是 PostToolUse，失败是 PostToolUseFailure：`git push && gh pr create` 里 gh 失败了，推送还是成功的）。 */
const isBashPost = (p: unknown): p is Record<string, unknown> => {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (o.hook_event_name === "PostToolUse" || o.hook_event_name === "PostToolUseFailure") && o.tool_name === "Bash";
};

const bashCommand = (p: Record<string, unknown>): string | null => {
  const input = p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
  return typeof input.command === "string" ? input.command : null;
};

/**
 * Bash 跑完（工作流 W：记下分支是谁的）：在截断之前对整条命令跑 classifyShip（提交信息很长的 `git commit … && git push` 截断后就认不出了），
 * 只留解析出来的 ship、截断的命令（日志用）、目录，和 gh pr create 打出来的 PR 链接。输出可能很大、可能有敏感内容，不带。
 */
function trimBashPayload(payload: unknown): unknown {
  if (!isBashPost(payload)) return payload;
  const p = payload;
  const command = bashCommand(p) ?? "";
  const ship = classifyShip(command);
  // gh pr merge / close / reopen（BTL-270）：主进程马上重读这个 PR，界面不等下一轮轮询。
  const prState = classifyPrState(command);
  const response = p.tool_response && typeof p.tool_response === "object" ? (p.tool_response as Record<string, unknown>) : {};
  // 失败的没有 tool_response，输出在 error 里。
  const out = [response.stdout, response.stderr, p.error].filter((v): v is string => typeof v === "string").join("\n");
  const urls = ship.some((c) => c.kind === "pr_create") ? [...new Set(out.match(/https?:\/\/[^\s"'<>()]+\/pull\/\d+/g) ?? [])].slice(-PR_URLS_MAX) : [];
  return {
    hook_event_name: p.hook_event_name,
    session_id: p.session_id,
    tool_name: p.tool_name,
    tool_use_id: p.tool_use_id,
    cwd: p.cwd,
    tool_input: { command: command.slice(0, COMMAND_LIMIT) },
    ship,
    pr_urls: urls,
    ...(prState.length > 0 && { pr_state: prState }),
  };
}

/** 要不要写进收件箱：Bash 跑完的只有推送分支、开 PR、改 PR 状态的才写（别的 Bash 调用每次都来，主进程用不上）。在 trimBashPayload 之后调用。 */
export function wanted(envelope: HookEnvelope): boolean {
  if (!isBashPost(envelope.payload)) return true;
  const { ship, pr_state } = envelope.payload;
  return (Array.isArray(ship) && ship.length > 0) || (Array.isArray(pr_state) && pr_state.length > 0);
}

export function buildEnvelope(raw: string, env: NodeJS.ProcessEnv, now: number): HookEnvelope {
  const ticket = envValue(env, "TICKET")?.trim() || null;
  const shipherdSession = envValue(env, "SESSION")?.trim() || null;
  try {
    return { v: 1, receivedAt: now, ticket, shipherdSession, payload: trimRememberPayload(trimBashPayload(trimAgentPayload(JSON.parse(raw)))) };
  } catch (e) {
    return { v: 1, receivedAt: now, ticket, shipherdSession, payload: null, parseError: (e as Error).message, raw: raw.slice(0, RAW_LIMIT) };
  }
}

export function inboxDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return join(homeFromEnv(env, home), "inbox");
}

/** 先写 .tmp 再 rename，读取方永远看不到写了一半的文件。文件名以时间戳开头，按名字排序即按时间排序。rename 失败时删掉 .tmp。 */
export function writeEnvelope(dir: string, envelope: HookEnvelope, rename: (from: string, to: string) => void = renameWithRetrySync): string {
  mkdirSync(dir, { recursive: true });
  const name = `${envelope.receivedAt}-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  const tmp = join(dir, `${name}.tmp`);
  const file = join(dir, name);
  writeFileSync(tmp, JSON.stringify(envelope));
  try {
    rename(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 已经不在了。
    }
    throw e;
  }
  return file;
}

export function readStdin(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

export async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    const envelope = buildEnvelope(raw, process.env, Date.now());
    if (wanted(envelope)) writeEnvelope(inboxDir(process.env), envelope);
  } catch {
    // 绝不阻塞 Claude Code：任何错误都静默吞掉。
  }
}
