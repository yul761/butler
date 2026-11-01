import { z } from "zod";
import { headlessArgs } from "../claude/headless";
import { execHeadlessJson, type HeadlessExecDeps } from "../handoff/headless-exec";
import { toCliJsonSchema, validate } from "../handoff/schema";
import { currentLang } from "../i18n";
import type { StuckVerdict } from "./stuck-tracker";

const VerdictSchema = z.object({ stuck: z.boolean(), reason: z.string(), action: z.string() });
const STUCK_JSON_SCHEMA = toCliJsonSchema(VerdictSchema);

export interface StuckInput {
  cwd: string;
  /** 现在在做什么（“运行 pnpm test”之类）。 */
  activity: string;
  minutes: number;
  lastOutput: string;
  terminalTail: string;
  /** 有没有子进程在跑；读不到为 null。 */
  children: boolean | null;
}

function prompt(i: StuckInput): string {
  const kids = (zh: boolean) => (i.children === null ? (zh ? "未知" : "unknown") : i.children ? (zh ? "有" : "yes") : zh ? "没有" : "no");
  if (currentLang() === "en") {
    return [
      "You are judging whether a Claude Code session is stuck.",
      "The session has shown no new transcript entries, terminal output or child-process CPU activity for a while. Decide whether it is really stuck, or just doing something slow and legitimate (a long build, a long test run, waiting on the network).",
      `Current activity: ${i.activity}`,
      `Quiet for: ${i.minutes} minutes`,
      `Child processes running: ${kids(false)}`,
      `Last output:\n${i.lastOutput}`,
      `Terminal tail:\n${i.terminalTail}`,
      'Answer as JSON: stuck (boolean), reason (one short sentence), action (one short sentence on what the user should do; empty if not stuck). Write reason and action in English.',
    ].join("\n\n");
  }
  return [
    "你在判断一个 Claude Code session 是不是卡住了。",
    "这个 session 已经有一阵没有新的对话记录、终端输出和子进程 CPU 活动。请判断它是真的卡住了，还是在做一件合理但很慢的事（长时间构建、跑测试、等网络）。",
    `当前活动：${i.activity}`,
    `已安静：${i.minutes} 分钟`,
    `是否有子进程在跑：${kids(true)}`,
    `最后输出：\n${i.lastOutput}`,
    `终端末尾：\n${i.terminalTail}`,
    "用 JSON 回答：stuck（布尔）、reason（一句话原因）、action（一句话建议用户怎么做；没卡住就留空）。reason 和 action 用中文。",
  ].join("\n\n");
}

/** 请 headless Claude 判断一个可疑的 session 是否卡住。不给任何工具；失败返回 null。 */
export async function judgeStuck(d: HeadlessExecDeps, input: StuckInput): Promise<StuckVerdict | null> {
  const args = headlessArgs({ schema: STUCK_JSON_SCHEMA, allowedTools: [] });
  const r = await execHeadlessJson(d, { label: "stuck judge", args, prompt: prompt(input), cwd: input.cwd });
  if (!r.ok) return null;
  const v = validate(VerdictSchema, r.value);
  return v.ok ? v.value : null;
}
