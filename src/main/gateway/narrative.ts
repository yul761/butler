import { z } from "zod";
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

export function narrativeMessages(payload: OutboundPayload): ChatMessage[] {
  return [
    { role: "system", content: NARRATIVE_SYSTEM_PROMPT },
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
