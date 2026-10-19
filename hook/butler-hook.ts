import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HookEnvelope } from "../src/shared/hook-envelope";

const RAW_LIMIT = 10_000;

export function buildEnvelope(raw: string, env: NodeJS.ProcessEnv, now: number): HookEnvelope {
  const ticket = env.BUTLER_TICKET?.trim() || null;
  const butlerSession = env.BUTLER_SESSION?.trim() || null;
  try {
    return { v: 1, receivedAt: now, ticket, butlerSession, payload: JSON.parse(raw) };
  } catch (e) {
    return { v: 1, receivedAt: now, ticket, butlerSession, payload: null, parseError: (e as Error).message, raw: raw.slice(0, RAW_LIMIT) };
  }
}

export function inboxDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return join(env.BUTLER_HOME?.trim() || join(home, ".butler"), "inbox");
}

/** 先写 .tmp 再 rename，读取方永远看不到写了一半的文件。文件名以时间戳开头，按名字排序即按时间排序。 */
export function writeEnvelope(dir: string, envelope: HookEnvelope): string {
  mkdirSync(dir, { recursive: true });
  const name = `${envelope.receivedAt}-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  const tmp = join(dir, `${name}.tmp`);
  const file = join(dir, name);
  writeFileSync(tmp, JSON.stringify(envelope));
  renameSync(tmp, file);
  return file;
}

function readStdin(timeoutMs = 2000): Promise<string> {
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
