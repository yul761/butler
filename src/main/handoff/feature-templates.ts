import type { FeatureHandoff, Handoff, Pr } from "../../shared/handoff";
import type { Lang } from "../../shared/i18n";
import type { TicketStatus } from "../../shared/types";

/** feature 汇总 prompt 里一个 ticket 的情况（设计文档 2026-10-28）。 */
export interface FeatureTicketContext {
  key: string;
  title: string | null;
  status: TicketStatus;
  prs: Pr[];
  /** 最新一条完整的 ticket handoff；还没有就是 null。 */
  latest: Handoff | null;
}

/** 给 claude 看的字段说明，和 src/shared/handoff.ts 的 FeatureHandoffSchema 一一对应。 */
const SCHEMA_DOC = `{
  summary: string,                // 一段话：整体到哪了
  blockers: string[],             // 卡在哪；提到 ticket 时写 ticket 号；没有就是 []
  next_steps: {                   // 接下来要做的事，第一条最先做
    ticket: string | null,        // 这一步属于哪个 ticket（ticket 号）；不属于某个 ticket 时为 null
    text: string
  }[],
  decisions: { key: string, statement: string }[],   // 跨 ticket 的约定（接口、错误码等），key 用简短的英文标识
  open_questions: string[]
}`;

const SCHEMA_DOC_EN = `{
  summary: string,                // one paragraph: where the feature stands overall
  blockers: string[],             // what is in the way; mention tickets by id; [] if nothing
  next_steps: {                   // what comes next; the first item comes first
    ticket: string | null,        // the ticket id this step belongs to; null if it belongs to no single ticket
    text: string
  }[],
  decisions: { key: string, statement: string }[],   // agreements across tickets (APIs, error codes...); key is a short English identifier
  open_questions: string[]
}`;

const EXAMPLE_VALUE: FeatureHandoff = {
  summary: "登录页前端（PROJ-123）已提 PR 等 review；后端 token 接口（PROJ-124）还差刷新失败的处理，两边还没联调。",
  blockers: ["PROJ-124 等运维开 staging 的 Redis 权限"],
  next_steps: [
    { ticket: "PROJ-124", text: "补上 refresh 失败时的错误码" },
    { ticket: null, text: "两边都合并后在 staging 联调登录流程" },
  ],
  decisions: [{ key: "auth-error-codes", statement: "token 过期统一返回 401 + code=token_expired" }],
  open_questions: ["移动端是否也走新的刷新逻辑？"],
};

const EXAMPLE_VALUE_EN: FeatureHandoff = {
  summary: "The login page frontend (PROJ-123) has a PR waiting for review; the backend token API (PROJ-124) still lacks the failed-refresh handling, and the two haven't been wired up yet.",
  blockers: ["PROJ-124 is waiting for ops to grant Redis access on staging"],
  next_steps: [
    { ticket: "PROJ-124", text: "Add the error code for a failed refresh" },
    { ticket: null, text: "Once both are merged, test the login flow end to end on staging" },
  ],
  decisions: [{ key: "auth-error-codes", statement: "An expired token always returns 401 with code=token_expired" }],
  open_questions: ["Should the mobile app use the new refresh logic too?"],
};

export const featureHandoffSchemaDoc = (l: Lang): string => (l === "en" ? SCHEMA_DOC_EN : SCHEMA_DOC);
export const featureHandoffExample = (l: Lang): string => JSON.stringify(l === "en" ? EXAMPLE_VALUE_EN : EXAMPLE_VALUE, null, 2);

/** 晚间批量和"立即更新"用的 prompt。占位符 {{feature}}、{{previous}}、{{tickets}} 由 FeatureSummaryRunner 填充。 */
const PROMPT = `你在为 Butler 写 feature「{{feature}}」的汇总，显示在 feature 页的"整体进度"里，让人明天早上一打开就知道整体到哪了。

要求：
1. 依据这个 session 的对话（如果有）和下面列出的每个 ticket 的最新 handoff 来写；可以用 \`gh pr view\` 确认 PR 状态。
2. 只写跨 ticket 的整体情况：整体进展、卡在哪、接下来先做什么、ticket 之间的约定（接口、错误码等）。单个 ticket 的细节在它自己的 handoff 里，不要重复。
3. 提到 ticket 时只写 ticket 号（例如 PROJ-123），不要写标题或链接。next_steps 的 ticket 填这一步属于的 ticket 号，不属于某个 ticket 时填 null。
4. 不要写完成百分比，也不要估算进度数字。
5. 只读：不要修改任何文件，不要提交或推送。

上一次汇总：
{{previous}}

这个 feature 下的 ticket：
{{tickets}}

输出一个 JSON 对象，字段如下：
${SCHEMA_DOC}

示例：
${featureHandoffExample("zh")}
`;

const PROMPT_EN = `You are writing Butler's summary of the feature "{{feature}}". It is shown as the overall progress on the feature page, so that tomorrow morning one look tells where the feature stands.

Requirements:
1. Base it on this session's conversation (if there is one) and on the latest handoff of each ticket listed below; you may confirm PR states with \`gh pr view\`.
2. Only write about the picture across tickets: overall progress, what is in the way, what to do first, and agreements between tickets (APIs, error codes and so on). Each ticket's own details are in its own handoff; don't repeat them.
3. Refer to a ticket only by its id (for example PROJ-123), never by title or link. In next_steps, set ticket to the id of the ticket the step belongs to, or null if it belongs to no single ticket.
4. Don't write a completion percentage or estimate progress as a number.
5. Read only: don't change any file, don't commit or push.
6. Write every text field in English.

Previous summary:
{{previous}}

Tickets of this feature:
{{tickets}}

Output one JSON object with these fields:
${SCHEMA_DOC_EN}

Example:
${featureHandoffExample("en")}
`;

export const defaultFeatureHandoffPrompt = (l: Lang): string => (l === "en" ? PROMPT_EN : PROMPT);

/** 填进 prompt 的几段固定文字。 */
const FILL = {
  zh: {
    noTickets: "（这个 feature 下还没有 ticket）",
    firstSummary: "（这是第一次汇总）",
    untitled: "无标题",
    status: (s: string) => `（状态：${s}）`,
    prs: "  PR：",
    noPrs: "还没有",
    done: "  最近完成：",
    next: "  下一步：",
    blockers: "  卡住：",
    none: "无",
    noHandoff: "  （还没有 handoff）",
    sep: "；",
  },
  en: {
    noTickets: "(this feature has no tickets yet)",
    firstSummary: "(this is the first summary)",
    untitled: "untitled",
    status: (s: string) => ` (status: ${s})`,
    prs: "  PRs: ",
    noPrs: "none yet",
    done: "  Recently done: ",
    next: "  Next: ",
    blockers: "  Blocked by: ",
    none: "nothing",
    noHandoff: "  (no handoff yet)",
    sep: "; ",
  },
};

/** PR 写成“仓库名#号 状态 (review)”，例如 web#455 open (pending)。 */
function prLabel(p: Pr): string {
  const repo = /github\.com\/[^/]+\/([^/]+)\/pull\//.exec(p.url)?.[1] ?? "";
  return `${repo}#${p.number} ${p.state}${p.review ? ` (${p.review})` : ""}`;
}

/** {{tickets}}：每个 ticket 的号、标题、状态、PR 和最新 handoff 里的完成、下一步、卡住。 */
export function renderFeatureTickets(rows: FeatureTicketContext[], l: Lang): string {
  const f = FILL[l];
  if (rows.length === 0) return f.noTickets;
  const list = (items: string[]) => (items.length > 0 ? items.join(f.sep) : f.none);
  return rows
    .flatMap((r) => [
      `- ${r.key} ${r.title ?? f.untitled}${f.status(r.status)}`,
      `${f.prs}${r.prs.length > 0 ? r.prs.map(prLabel).join(", ") : f.noPrs}`,
      ...(r.latest
        ? [`${f.done}${list(r.latest.done_today)}`, `${f.next}${list(r.latest.next_steps)}`, `${f.blockers}${list(r.latest.blockers)}`]
        : [f.noHandoff]),
    ])
    .join("\n");
}

/** {{previous}}：上一次的有效汇总。 */
export function renderPreviousSummary(previous: FeatureHandoff | null, l: Lang): string {
  return previous ? JSON.stringify(previous, null, 2) : FILL[l].firstSummary;
}
