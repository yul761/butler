import { createHash } from "node:crypto";
import type { Handoff } from "../../shared/handoff";
import type { Lang } from "../../shared/i18n";

const FENCE = "```";

/** 给 claude 看的字段说明，和 src/shared/handoff.ts 的 zod schema 一一对应。 */
export const HANDOFF_SCHEMA_DOC = `{
  ticket: string,                 // ticket 号，例如 "PROJ-123"
  status: "active" | "in_review" | "blocked" | "merged_pending_followup" | "done",
  done_today: string[],           // 今天实际完成的事
  next_steps: string[],           // 接下来要做的事，第一条是明天最先做的一步
  blockers: string[],             // 卡住的原因，没有就是 []
  prs: {                          // 这个 ticket 的所有 PR（多个仓库就有多个）；没有 PR 就是 []
    number: number, url: string,
    state: "open" | "merged" | "closed",
    review: "pending" | "changes_requested" | "approved" | null
  }[],
  jira: null | {                  // tracker 读不到就是 null，不要编造
    status: string,
    subtasks: { key: string, status: string }[]
  },
  followups: {                    // 合并或部署之后还要做的事
    id: string | null,            // 已有的项填原来的 id；新项填 null
    kind: "config" | "flag" | "deploy" | "doc" | "other",
    description: string,
    trigger: "after_merge" | "after_deploy" | "on_date" | "none",
    due_date: string | null,      // YYYY-MM-DD，只有 trigger 是 on_date 时填写
    done: boolean
  }[],
  decisions: { key: string, statement: string }[],   // 做出的决定，key 用简短的英文标识
  learnings: string[],            // 以后别的 ticket 也用得上的经验
  open_questions: string[]
}`;

export const HANDOFF_EXAMPLE_VALUE: Handoff = {
  ticket: "PROJ-123",
  status: "in_review",
  done_today: ["登录页改用新的 token 刷新逻辑", "补了 refresh 失败的单元测试"],
  next_steps: ["根据 review 意见拆分 AuthService", "合并后改 staging 的 token TTL 配置"],
  blockers: [],
  prs: [{ number: 456, url: "https://github.com/acme/web/pull/456", state: "open", review: "pending" }],
  jira: { status: "In Review", subtasks: [{ key: "PROJ-124", status: "Done" }] },
  followups: [
    { id: "f_1a2b3c4d", kind: "config", description: "改 staging 的 token TTL 为 15 分钟", trigger: "after_merge", due_date: null, done: false },
    { id: null, kind: "flag", description: "全量打开 new_login 开关", trigger: "on_date", due_date: "2026-10-30", done: false },
  ],
  decisions: [{ key: "token-storage", statement: "refresh token 只放 httpOnly cookie" }],
  learnings: ["本仓库的 e2e 需要先跑 pnpm seed"],
  open_questions: ["TTL 是否需要和移动端一致？"],
};

export const HANDOFF_EXAMPLE = JSON.stringify(HANDOFF_EXAMPLE_VALUE, null, 2);

/** 英文版的字段说明和例子（设计文档 2026-10-26 中英文切换）：结构和中文版一样，只有说明和例子的文字不同。 */
export const HANDOFF_SCHEMA_DOC_EN = `{
  ticket: string,                 // the ticket id, for example "PROJ-123"
  status: "active" | "in_review" | "blocked" | "merged_pending_followup" | "done",
  done_today: string[],           // what was actually finished today
  next_steps: string[],           // what comes next; the first item is the first step tomorrow
  blockers: string[],             // what is in the way; [] if nothing
  prs: {                          // every PR of this ticket (several repos means several PRs); [] if there is none
    number: number, url: string,
    state: "open" | "merged" | "closed",
    review: "pending" | "changes_requested" | "approved" | null
  }[],
  jira: null | {                  // null if the tracker can't be read; never make it up
    status: string,
    subtasks: { key: string, status: string }[]
  },
  followups: {                    // what still has to happen after the merge or deploy
    id: string | null,            // keep the id of an existing item; null for a new one
    kind: "config" | "flag" | "deploy" | "doc" | "other",
    description: string,
    trigger: "after_merge" | "after_deploy" | "on_date" | "none",
    due_date: string | null,      // YYYY-MM-DD, only when trigger is on_date
    done: boolean
  }[],
  decisions: { key: string, statement: string }[],   // decisions made; key is a short English identifier
  learnings: string[],            // lessons other tickets can use later
  open_questions: string[]
}`;

export const HANDOFF_EXAMPLE_VALUE_EN: Handoff = {
  ...HANDOFF_EXAMPLE_VALUE,
  done_today: ["Moved the login page to the new token refresh logic", "Added unit tests for a failed refresh"],
  next_steps: ["Split AuthService as the review asked", "After the merge, change the token TTL config on staging"],
  followups: [
    { id: "f_1a2b3c4d", kind: "config", description: "Set the token TTL on staging to 15 minutes", trigger: "after_merge", due_date: null, done: false },
    { id: null, kind: "flag", description: "Turn the new_login flag on for everyone", trigger: "on_date", due_date: "2026-10-30", done: false },
  ],
  decisions: [{ key: "token-storage", statement: "The refresh token lives only in an httpOnly cookie" }],
  learnings: ["This repo's e2e tests need pnpm seed first"],
  open_questions: ["Should the TTL match the mobile app?"],
};

export const HANDOFF_EXAMPLE_EN = JSON.stringify(HANDOFF_EXAMPLE_VALUE_EN, null, 2);

export const handoffSchemaDoc = (l: Lang): string => (l === "en" ? HANDOFF_SCHEMA_DOC_EN : HANDOFF_SCHEMA_DOC);
export const handoffExample = (l: Lang): string => (l === "en" ? HANDOFF_EXAMPLE_EN : HANDOFF_EXAMPLE);

/** 晚间批量和“立即 handoff”用的默认 prompt（设置里可改）。占位符由 src/main/handoff/prompt.ts 填充。 */
export const DEFAULT_HANDOFF_PROMPT = `你在为 Butler 生成 ticket {{ticket}}（{{title}}，分支 {{branch}}）的 handoff：总结这个 session 到目前为止的进度，供明天早上的简报使用。

要求：
1. 用 tracker MCP 工具读取 ticket {{ticket}} 的描述、评论和子任务。可用的工具：{{tracker_tools}}。工具不可用或读取失败时 jira 填 null，不要编造。
2. 用 \`gh pr view <分支>\` 和 \`gh pr checks <分支>\` 读取 PR 状态（分支：{{branch}}）。ticket 涉及几个仓库就在每个仓库的目录里各查一次，把找到的 PR 都放进 prs；一个都没有时 prs 填 []。
3. 只读：不要修改任何文件，不要提交或推送。
4. followups 是“合并或部署之后还要做的事”（改配置、开关 feature flag、部署、写文档等）。下面列出了已有的 followups：已有的项保留原来的 id；已经做完的 done 填 true；新发现的项 id 填 null。
5. done_today 只写今天实际完成的事；next_steps 的第一条写明天最先要做的一步。

上一次 handoff：
{{previous_handoff}}

已有的 followups：
{{open_followups}}

输出一个 JSON 对象，字段如下：
{{schema}}

示例：
{{example}}
`;

/** 早间快速刷新用的默认 prompt（不 resume，只查 PR 和 tracker 状态）。 */
export const DEFAULT_REFRESH_PROMPT = `只查询 ticket {{ticket}}（分支 {{branch}}）的最新状态，不要总结对话，也不要修改任何文件。

1. 用 \`gh pr view <分支>\` 查询 PR 的 state 和 review 状态（分支：{{branch}}）。几个仓库就在每个仓库的目录里各查一次，PR 都放进 prs；没有 PR 时 prs 填 []。
2. 用 tracker MCP 工具查询 ticket {{ticket}} 的状态和子任务。可用的工具：{{tracker_tools}}。不可用时 jira 填 null。
3. status：PR 都已合并填 merged_pending_followup；还有 PR 打开中填 in_review；其他情况沿用当前状态 {{current_status}}。

只输出一个 JSON 对象，包含 status、prs、jira 三个字段，含义同下：
{{schema}}
`;

export const DEFAULT_HANDOFF_PROMPT_EN = `You are writing Butler's handoff for ticket {{ticket}} ({{title}}, branch {{branch}}): summarize this session's progress so far for tomorrow morning's brief.

Requirements:
1. Read ticket {{ticket}}'s description, comments and subtasks with the tracker MCP tools. Available tools: {{tracker_tools}}. If the tools are unavailable or fail, set jira to null; never make it up.
2. Read the PR state with \`gh pr view <branch>\` and \`gh pr checks <branch>\` (branch: {{branch}}). If the ticket spans several repos, check in each repo's folder and put every PR you find into prs; if there is none, set prs to [].
3. Read only: don't change any file, don't commit or push.
4. followups are "what still has to happen after the merge or deploy" (config changes, feature flags, deploys, docs and so on). The existing followups are listed below: keep their ids; set done to true for the ones that are finished; use null as the id of a new item.
5. done_today lists only what was actually finished today; the first item of next_steps is the first step tomorrow.
6. Write every text field in English.

Previous handoff:
{{previous_handoff}}

Existing followups:
{{open_followups}}

Output one JSON object with these fields:
{{schema}}

Example:
{{example}}
`;

export const DEFAULT_REFRESH_PROMPT_EN = `Only look up the latest state of ticket {{ticket}} (branch {{branch}}). Don't summarize the conversation and don't change any file.

1. Look up the PR state and review state with \`gh pr view <branch>\` (branch: {{branch}}). With several repos, check in each repo's folder and put every PR into prs; if there is none, set prs to [].
2. Look up ticket {{ticket}}'s status and subtasks with the tracker MCP tools. Available tools: {{tracker_tools}}. If they are unavailable, set jira to null.
3. status: merged_pending_followup if all PRs are merged; in_review if a PR is still open; otherwise keep the current status {{current_status}}.

Output only one JSON object with the three fields status, prs and jira, meaning the same as below:
{{schema}}
`;

export const defaultHandoffPrompt = (l: Lang): string => (l === "en" ? DEFAULT_HANDOFF_PROMPT_EN : DEFAULT_HANDOFF_PROMPT);
export const defaultRefreshPrompt = (l: Lang): string => (l === "en" ? DEFAULT_REFRESH_PROMPT_EN : DEFAULT_REFRESH_PROMPT);

/**
 * handoff.md 里的标记行紧跟在 front matter 之后：`<!-- butler:handoff-command v1 sha256:<hex> -->`。
 * hex 是“去掉标记行之后的全文”的 sha256；用户改过内容 hash 就对不上，Butler 不再认它是自己的文件。
 */
export const HANDOFF_COMMAND_MARKER = "<!-- butler:handoff-command v1";

export function commandBodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** 在 front matter（以 `---\n...\n---\n` 开头）之后插入带 hash 的标记行。 */
export function renderHandoffCommand(body: string): string {
  const m = /^---\n[\s\S]*?\n---\n/.exec(body);
  const at = m ? m[0].length : 0;
  return `${body.slice(0, at)}${HANDOFF_COMMAND_MARKER} sha256:${commandBodyHash(body)} -->\n${body.slice(at)}`;
}

const MARKER_RE = /^(---\n[\s\S]*?\n---\n)<!-- butler:handoff-command v1 sha256:([0-9a-f]{64}) -->\n/;

/** 解析 Butler 写的文件：标记行必须紧跟 front matter、hash 必须和其余内容一致，否则返回 null（不是 Butler 的，或被用户改过）。 */
export function parseHandoffCommand(text: string): { body: string } | null {
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  const body = m[1] + text.slice(m[0].length);
  return commandBodyHash(body) === m[2] ? { body } : null;
}

/** 当前版本的命令正文（不含标记行）。 */
export const HANDOFF_COMMAND_BODY = `---
description: 生成 Butler handoff（当前 ticket 的进度摘要）
---
请为当前 session 对应的 ticket 生成一份 handoff，供 Butler 的早间简报使用。

- 依据这个 session 的完整对话；如果可以，再用 tracker MCP 工具和 \`gh pr view\` 确认 ticket 与 PR 的最新状态。
- 只读：不要修改文件，不要提交或推送。
- ticket 填当前的 ticket 号（通常在分支名里，例如 PROJ-123）。
- 已有的 followup 如果知道 id 就填 id，否则 id 填 null。
- 最后输出一个 ${FENCE}butler-handoff 代码块，里面只有一个 JSON 对象；代码块之后不要再写任何内容。

字段如下：
${HANDOFF_SCHEMA_DOC}

示例：
${FENCE}butler-handoff
${HANDOFF_EXAMPLE}
${FENCE}

$ARGUMENTS
`;

/** 写入 Claude Code 用户级 commands 目录的 /handoff 命令。 */
export const HANDOFF_COMMAND_MD = renderHandoffCommand(HANDOFF_COMMAND_BODY);

export const HANDOFF_COMMAND_BODY_EN = `---
description: Write a Butler handoff (a progress summary of the current ticket)
---
Write a handoff for the ticket of this session, for Butler's morning brief.

- Base it on this session's whole conversation; if you can, confirm the latest state of the ticket and its PRs with the tracker MCP tools and \`gh pr view\`.
- Read only: don't change files, don't commit or push.
- Set ticket to the current ticket id (usually in the branch name, for example PROJ-123).
- For an existing followup, use its id if you know it; otherwise use null.
- Write every text field in English.
- Finish with one ${FENCE}butler-handoff code block that contains a single JSON object; write nothing after the code block.

Fields:
${HANDOFF_SCHEMA_DOC_EN}

Example:
${FENCE}butler-handoff
${HANDOFF_EXAMPLE_EN}
${FENCE}

$ARGUMENTS
`;

export const handoffCommandBody = (l: Lang): string => (l === "en" ? HANDOFF_COMMAND_BODY_EN : HANDOFF_COMMAND_BODY);
export const handoffCommandMd = (l: Lang): string => renderHandoffCommand(handoffCommandBody(l));
