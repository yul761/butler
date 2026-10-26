import { z } from "zod";
import { currentLang } from "../i18n";
import type { ChatMessage } from "./provider";
import type { OutboundPayload } from "./types";

/** 输出上限：2–4 句话用不了这么多；推理模型也留一点余量。预算检查按这个数估算输出费用。 */
export const NARRATIVE_MAX_TOKENS = 800;

/** 固定的系统提示：不含任何用户数据（隐私不变量测试只检查用户消息）。 */
export const NARRATIVE_SYSTEM_PROMPT = [
  "你是用户的工作助理。用户会给你今天早上的工作简报数据（JSON），请据此写“今日重点”：2 到 4 句中文，每句说一件事，最该先做的放最前面。",
  "规则：",
  "1. 数据里形如 [[T_ab12]] 的是占位符（T 是 ticket，R 是仓库，B 是分支，P 是人名，S 是其他名词）。提到它们时原样照抄，不要改写、翻译、拆开，也不要编造新的占位符。",
  "2. 只根据数据说话，不要猜测数据里没有的事，不要输出网址、路径或代码。",
  "3. 字段含义：section 为 first 是先做、today 是今天、watch 是留意；rule 为 pr_approved 是 PR 已批准待合并，pr_changes_requested 是 PR 被要求修改，followup_after_merge 是合并后的收尾任务，followup_due 是到期的待办，next_step 是下一步，blocked_long 是阻塞多天，review_waiting 是等 review 多天，stale 是多天没有活动，unclaimed 是未认领的会话；days 是天数，count 是数量。",
  '4. 只输出一个 JSON 对象，不要输出任何别的文字，格式：{"focus": ["第一句", "第二句"]}',
].join("\n");

/** 英文用户的系统提示（设计文档 2026-10-26）：规则一样，“今日重点”写英文。 */
export const NARRATIVE_SYSTEM_PROMPT_EN = [
  "You are the user's work assistant. The user gives you this morning's work brief as JSON. From it, write “Today's focus”: 2 to 4 sentences in English, one thing per sentence, the most urgent first.",
  "Rules:",
  "1. Values like [[T_ab12]] in the data are placeholders (T is a ticket, R a repo, B a branch, P a person, S another name). When you mention them, copy them exactly: don't rewrite, translate or split them, and never invent new placeholders.",
  "2. Say only what the data says. Don't guess at anything the data doesn't contain, and don't output URLs, paths or code.",
  "3. Field meanings: section first means do first, today means today, watch means keep an eye on; rule pr_approved is a PR approved and ready to merge, pr_changes_requested a PR with requested changes, followup_after_merge a follow-up after a merge, followup_due a due to-do, next_step the next step, blocked_long blocked for days, review_waiting waiting for review for days, stale no activity for days, unclaimed unclaimed sessions; days is a number of days, count a count.",
  '4. Output only one JSON object and nothing else, in this format: {"focus": ["first sentence", "second sentence"]}',
].join("\n");

export function narrativeMessages(payload: OutboundPayload): ChatMessage[] {
  return [
    { role: "system", content: currentLang() === "en" ? NARRATIVE_SYSTEM_PROMPT_EN : NARRATIVE_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

const NarrativeSchema = z.object({ focus: z.array(z.string().trim().min(1).max(400)).min(1).max(6) });

/** 宽松解析：去掉代码围栏和 JSON 前后的闲话，再按 schema 校验。不符合时返回 null。 */
export function parseNarrative(content: string): string[] | null {
  const t = content.trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const r = NarrativeSchema.safeParse(JSON.parse(t.slice(start, end + 1)));
    return r.success ? r.data.focus : null;
  } catch {
    return null;
  }
}
