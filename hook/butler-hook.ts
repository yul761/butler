import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HookEnvelope } from "../src/shared/hook-envelope";
import { dirFromEnv } from "../src/main/paths";
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

export function buildEnvelope(raw: string, env: NodeJS.ProcessEnv, now: number): HookEnvelope {
  const ticket = env.BUTLER_TICKET?.trim() || null;
  const butlerSession = env.BUTLER_SESSION?.trim() || null;
  try {
    return { v: 1, receivedAt: now, ticket, butlerSession, payload: trimAgentPayload(JSON.parse(raw)) };
  } catch (e) {
    return { v: 1, receivedAt: now, ticket, butlerSession, payload: null, parseError: (e as Error).message, raw: raw.slice(0, RAW_LIMIT) };
  }
}

export function inboxDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return join(dirFromEnv(env.BUTLER_HOME, home) ?? join(home, ".butler"), "inbox");
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
    writeEnvelope(inboxDir(process.env), buildEnvelope(raw, process.env, Date.now()));
  } catch {
    // 绝不阻塞 Claude Code：任何错误都静默吞掉。
  }
}
