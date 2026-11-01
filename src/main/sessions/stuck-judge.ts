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
  /** 上次检查以来子进程几乎没用 CPU；读不到为 null。不代表有没有子进程：常驻的 MCP server 也是子进程。 */
  childCpuQuiet: boolean | null;
}

function cpuLine(quiet: boolean | null, en: boolean): string {
  if (quiet === null) return en ? "Child process CPU usage is unknown." : "子进程的 CPU 使用情况未知。";
  if (quiet) return en ? "Child processes barely used CPU in the last few minutes." : "子进程最近几分钟几乎没有用 CPU。";
  return en ? "Child processes used CPU in the last few minutes." : "子进程最近几分钟用过 CPU。";
}

function prompt(i: StuckInput): string {
  if (currentLang() === "en") {
    return [
      "You are judging whether a Claude Code session is stuck.",
      "The session has shown no new transcript entries or command output for a while. Decide whether it is really stuck, or just doing something slow and legitimate (a long build, a long test run, waiting on the network).",
      `Current activity: ${i.activity}`,
      `Quiet for: ${i.minutes} minutes`,
      cpuLine(i.childCpuQuiet, true),
      `Last output:\n${i.lastOutput}`,
      `Terminal tail:\n${i.terminalTail}`,
      'Answer as JSON: stuck (boolean), reason (one short sentence), action (one short sentence on what the user should do; empty if not stuck). Write reason and action in English.',
    ].join("\n\n");
  }
  return [
    "你在判断一个 Claude Code session 是不是卡住了。",
    "这个 session 已经有一阵没有新的对话记录和命令输出。请判断它是真的卡住了，还是在做一件合理但很慢的事（长时间构建、跑测试、等网络）。",
    `当前活动：${i.activity}`,
    `已安静：${i.minutes} 分钟`,
    cpuLine(i.childCpuQuiet, false),
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
