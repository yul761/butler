import { z } from "zod";
import { headlessArgs } from "../claude/headless";
import { execHeadlessJson, type HeadlessExecDeps } from "../handoff/headless-exec";
import { toCliJsonSchema, validate } from "../handoff/schema";
import { currentLang } from "../i18n";
import { sanitizeJudgeReason } from "../util/judge-text";

const AnswerSchema = z.object({ category: z.enum(["env", "code"]), reason: z.string() });
const JSON_SCHEMA = toCliJsonSchema(AnswerSchema);

/** 日志最多给模型这么多字符（从尾部截）。 */
export const CI_MODEL_LOG_CHARS = 3000;

export interface CiModelInput {
  cwd: string;
  checks: string[];
  step: string | null;
  log: string;
}

export function ciPrompt(i: CiModelInput, lang: "zh" | "en" = currentLang()): string {
  const log = i.log.length > CI_MODEL_LOG_CHARS ? i.log.slice(-CI_MODEL_LOG_CHARS) : i.log;
  if (lang === "en") {
    return [
      "A CI run failed. Decide whether this looks like a problem in the code (a real test failure, a type error, a lint error, a build error caused by the change) or a problem in the environment (network, timeouts, the runner going away, a package registry or service being down, disk full, rate limits).",
      "If you are not sure, answer code: an environment answer makes Butler rerun CI instead of telling the developer.",
      `Failed checks: ${i.checks.join(", ")}`,
      `Failed step: ${i.step ?? "unknown"}`,
      `Log tail:\n${log}`,
      "Answer as JSON: category (\"env\" or \"code\"), reason (one short sentence in English).",
    ].join("\n\n");
  }
  return [
    "一次 CI 失败了。请判断它像是代码的问题（真的测试失败、类型错误、lint 错误、改动导致的构建失败），还是环境的问题（网络、超时、runner 掉线、包仓库或外部服务挂了、磁盘满、限流）。",
    "拿不准就答 code：答 env 会让 Butler 重跑 CI，而不是告诉开发者。",
    `失败的检查：${i.checks.join("、")}`,
    `失败的步骤：${i.step ?? "未知"}`,
    `日志末尾：\n${log}`,
    "用 JSON 回答：category（\"env\" 或 \"code\"）、reason（一句话理由，用中文）。",
  ].join("\n\n");
}

/** 后台模型判断一次 CI 失败（任务 ci_classify，经路由）。不给任何工具；失败返回 null。 */
export async function classifyCiByModel(d: HeadlessExecDeps, input: CiModelInput): Promise<{ category: "env" | "code"; reason: string } | null> {
  const args = headlessArgs({ schema: JSON_SCHEMA, allowedTools: [] });
  const r = await execHeadlessJson(d, { task: "ci_classify", label: "ci classify", args, prompt: ciPrompt(input), cwd: input.cwd });
  if (!r.ok) return null;
  const v = validate(AnswerSchema, r.value);
  return v.ok ? { category: v.value.category, reason: sanitizeJudgeReason(v.value.reason) } : null;
}
