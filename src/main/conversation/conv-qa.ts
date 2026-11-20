import { z } from "zod";
import { headlessArgs } from "../claude/headless";
import { execHeadlessJson, type HeadlessExecDeps } from "../handoff/headless-exec";
import { toCliJsonSchema, validate } from "../handoff/schema";
import { currentLang } from "../i18n";

/**
 * 对话另存（UI 重做第 4 层）：一轮对话算不算问答。问答规则只有这一份。
 *
 * 先跑规则（ruleQa），判不了的交给 judgeConvQa（任务 conv_qa，低档模型，没配路由时是 Haiku）。
 * judgeConvQa 是本机 claude 的后台调用：不经过 PrivacyGateway，不进个人 LLM，不写 llm_audit；
 * sensitive_terms 和假名化只作用于网关，这里不适用（和 needs_you 判断一样）。
 * 只拿截断后的问答：问句开头 1500 字、回答结尾 1500 字。用量由 execHeadlessJson 的 onUsage 记进 session_usage，
 * 花费熔断照常生效（conv_qa 不在 EXEMPT_TASKS 里）。
 */

export const CONV_QA_QUESTION_CHARS = 1500;
export const CONV_QA_ANSWER_CHARS = 1500;
/** 不像问句、没调工具、回答不超过这么多字：不是问答（「好的」「收到」）。 */
export const CONV_QA_SHORT_REPLY = 6;

const ZH_WORDS = /吗|嘛|呢|怎么|怎样|如何|为什么|为啥|什么|是不是|能不能|可不可以|会不会|有没有|要不要|对不对|行不行|哪里|哪个|哪些|多少|区别/;
const EN_START = /^(what|why|how|when|where|which|who|is|are|does|do|can|could|should|would|will)\b/i;

/** 去掉代码块、行内代码、URL 以后：有问号、有中文疑问词，或者某个英文句子以疑问词开头。 */
export function isQuestionLike(text: string): boolean {
  const t = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ");
  if (/[?？]/.test(t)) return true;
  if (ZH_WORDS.test(t)) return true;
  return t.split(/[.!。！\n]+/).some((s) => EN_START.test(s.trim()));
}

export type RuleVerdict = "yes" | "no" | "judge";

/** 规则：改了东西的不是；没回答的不是；问了、没调别的工具就是；其余看情况。 */
export function ruleQa(t: { asked: boolean; mutated: boolean; otherTools: boolean; answerChars: number }): RuleVerdict {
  if (t.mutated) return "no";
  if (t.answerChars === 0) return "no";
  if (t.asked) return t.otherTools ? "judge" : "yes";
  if (t.otherTools) return "no";
  if (t.answerChars <= CONV_QA_SHORT_REPLY) return "no";
  return "judge";
}

/**
 * true / false：模型的结论；"paused"：一时判不了（花费熔断、限流、超时……），这一轮留着以后再判（太旧了调用方记 no / old）；
 * null：模型的答案不能用（bad_output、校验没过），调用方记 no / judge_failed。
 */
export type ConvQaVerdict = boolean | "paused" | null;

const AnswerSchema = z.object({ qa: z.boolean() });
const QA_JSON_SCHEMA = toCliJsonSchema(AnswerSchema);

const head = (s: string, n: number): string => {
  const cps = [...s];
  return cps.length <= n ? s : cps.slice(0, n).join("");
};
const tail = (s: string, n: number): string => {
  const cps = [...s];
  return cps.length <= n ? s : cps.slice(-n).join("");
};

function prompt(question: string, answer: string): string {
  if (currentLang() === "en") {
    return [
      "Below is one thing the user said to a coding agent, and the agent's reply.",
      "Was this round the user asking a question and the agent answering it (rather than the user giving a task and the agent going off to do it)?",
      "Answer as JSON only: qa (boolean).",
      "",
      "User:",
      question,
      "",
      "Agent:",
      answer,
    ].join("\n");
  }
  return [
    "下面是用户对一个写代码的 agent 说的一句话，以及 agent 的回答。",
    "这一轮是不是用户在提问、agent 在回答（而不是用户布置任务、agent 去做事）？",
    "只用 JSON 回答：qa（布尔）。",
    "",
    "用户：",
    question,
    "",
    "agent：",
    answer,
  ].join("\n");
}

/** 请低档模型判断一轮是不是问答。不给任何工具；问句取开头、回答取结尾。 */
export async function judgeConvQa(d: HeadlessExecDeps, turn: { question: string; answer: string }, cwd: string, ticketKey: string | null = null): Promise<ConvQaVerdict> {
  const args = headlessArgs({ schema: QA_JSON_SCHEMA, allowedTools: [] });
  const r = await execHeadlessJson(d, {
    task: "conv_qa",
    label: "conv qa judge",
    args,
    prompt: prompt(head(turn.question, CONV_QA_QUESTION_CHARS), tail(turn.answer, CONV_QA_ANSWER_CHARS)),
    cwd,
    ticketKey,
  });
  // 只有模型给的答案不能用才算判不了；其余失败（熔断、限流、超时、没装 claude、退出时中断……）都是一时的，留到以后再判。
  if (!r.ok) return r.reason === "bad_output" ? null : "paused";
  const v = validate(AnswerSchema, r.value);
  return v.ok ? v.value.qa : null;
}
