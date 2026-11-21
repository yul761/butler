// butler-hook mailbox <dir>：工具调用的间隙把信箱里排队的消息作为 additionalContext 送进 session（BTL-245）。
// 只在 PostToolUse / PostToolUseFailure 上跑，而且 settings 里的命令先看过目录在不在：到这里时多半真有消息。
import { readdirSync, readFileSync, renameSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  DONE_SUFFIX, MAILBOX_CONTEXT_LIMIT, MAILBOX_EVENT, MSG_SUFFIX, TAKEN_SUFFIX, type MailboxFile,
} from "../src/shared/mailbox";
import type { HookEnvelope } from "../src/shared/hook-envelope";

export interface MailboxDeps {
  readdir(dir: string): string[];
  read(file: string): string;
  rename(from: string, to: string): void;
  /** 把文件的 mtime 改成现在：主进程按它算认领了多久、什么时候送到的。 */
  touch(file: string): void;
  pid: number;
}

export const realMailboxDeps: MailboxDeps = {
  readdir: (d) => readdirSync(d),
  read: (f) => readFileSync(f, "utf8"),
  rename: (a, b) => renameSync(a, b),
  touch: (f) => {
    const now = new Date();
    utimesSync(f, now, now);
  },
  pid: process.pid,
};

/** 这两个工具之后的 additionalContext 有报告说会被丢掉：不送，留给下一次工具调用。 */
const SKIP_TOOLS = new Set(["Agent", "Task"]);

export interface MailboxRun {
  /** 写到 stdout 的内容；没什么可送为空串。 */
  out: string;
  /** stdout 写完以后调：认领的文件改成 .done。 */
  commit(): void;
  /** 没写成：认领的文件放回去。 */
  rollback(): void;
}

const NOTHING: MailboxRun = { out: "", commit: () => {}, rollback: () => {} };

function parse(text: string): MailboxFile | null {
  try {
    const v = JSON.parse(text) as Partial<MailboxFile>;
    return typeof v.id === "string" && typeof v.text === "string" ? { id: v.id, text: v.text, intro: typeof v.intro === "string" ? v.intro : "" } : null;
  } catch {
    return null;
  }
}

/** 认领、拼正文。任何一步出错都只少送，不抛。 */
export function runMailbox(stdin: string, env: NodeJS.ProcessEnv, root: string, d: MailboxDeps = realMailboxDeps): MailboxRun {
  const sid = env.BUTLER_SESSION?.trim();
  if (!sid || !root) return NOTHING;
  let event = "PostToolUse";
  try {
    const p = JSON.parse(stdin) as { tool_name?: unknown; hook_event_name?: unknown; agent_id?: unknown };
    if (typeof p.tool_name === "string" && SKIP_TOOLS.has(p.tool_name)) return NOTHING;
    // 子 agent 的工具调用：additionalContext 进的是子 agent，主 session 看不到。留给主线程的下一次工具调用或停下来以后的直接输入。
    if (typeof p.agent_id === "string" && p.agent_id) return NOTHING;
    if (p.hook_event_name === "PostToolUseFailure") event = "PostToolUseFailure";
  } catch {
    // 读不出 stdin 也照样送：消息和这次工具调用是什么无关。
  }
  const dir = join(root, sid);
  let names: string[];
  try {
    names = d.readdir(dir).filter((n) => n.endsWith(MSG_SUFFIX)).sort();
  } catch {
    return NOTHING;
  }
  const taken: string[] = [];
  const parts: string[] = [];
  let intro = "";
  let size = 0;
  const touch = (file: string) => {
    try {
      d.touch(file);
    } catch {
      // 改不了 mtime：最多被早一点放回去，再送一次。
    }
  };
  const putBack = (claimed: string, name: string) => {
    try {
      d.rename(join(dir, claimed), join(dir, name));
    } catch {
      // 主进程过 60 秒会把留下的 .taken 放回去。
    }
  };
  for (const name of names) {
    const claimed = `${name}${TAKEN_SUFFIX}${d.pid}`;
    try {
      d.rename(join(dir, name), join(dir, claimed));
    } catch {
      continue; // 被主进程（直接输入）或者并行的另一个 hook 拿走了。
    }
    touch(join(dir, claimed));
    let file: MailboxFile | null;
    try {
      file = parse(d.read(join(dir, claimed)));
    } catch {
      file = null;
    }
    // 第一条总要送（主进程排队时已经把单条截到上限以内）；后面的放不下就留到下一次。
    if (!file || (parts.length > 0 && size + file.text.length + 8 > MAILBOX_CONTEXT_LIMIT)) {
      putBack(claimed, name);
      if (file) break;
      continue;
    }
    if (!intro) intro = file.intro;
    parts.push(file.text.slice(0, MAILBOX_CONTEXT_LIMIT));
    taken.push(name);
    size += file.text.length + 8;
  }
  if (parts.length === 0) return NOTHING;
  const head = intro.replace("{n}", String(parts.length));
  const context = [head, ...parts].filter(Boolean).join("\n\n---\n\n");
  return {
    out: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }),
    commit: () => {
      for (const name of taken) {
        try {
          touch(join(dir, `${name}${TAKEN_SUFFIX}${d.pid}`));
          d.rename(join(dir, `${name}${TAKEN_SUFFIX}${d.pid}`), join(dir, `${name}${DONE_SUFFIX}`));
        } catch {
          // 留着 .taken：主进程 60 秒后放回去，可能再送一次，但不会丢。
        }
      }
    },
    rollback: () => {
      for (const name of taken) putBack(`${name}${TAKEN_SUFFIX}${d.pid}`, name);
    },
  };
}

/** 送完以后给主进程的信封：让它马上清扫这个终端的 .done（不等定时清扫）。 */
export function mailboxEnvelope(env: NodeJS.ProcessEnv, now: number): HookEnvelope {
  const sid = env.BUTLER_SESSION?.trim() || null;
  return { v: 1, receivedAt: now, ticket: env.BUTLER_TICKET?.trim() || null, butlerSession: sid, payload: { hook_event_name: MAILBOX_EVENT, session_id: sid } };
}
