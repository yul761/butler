import type { Handoff } from "../../shared/handoff";

const FENCE = "```";

/** 给 claude 看的字段说明，和 src/shared/handoff.ts 的 zod schema 一一对应。 */
export const HANDOFF_SCHEMA_DOC = `{
  ticket: string,                 // ticket 号，例如 "PROJ-123"
  status: "active" | "in_review" | "blocked" | "merged_pending_followup" | "done",
  done_today: string[],           // 今天实际完成的事
  next_steps: string[],           // 接下来要做的事，第一条是明天最先做的一步
  blockers: string[],             // 卡住的原因，没有就是 []
  pr: null | {                    // 没有 PR 就是 null
    number: number, url: string,
    state: "open" | "merged" | "closed",
    review: "pending" | "changes_requested" | "approved" | null
  },
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
  pr: { number: 456, url: "https://github.com/acme/web/pull/456", state: "open", review: "pending" },
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

/** 晚间批量和“立即 handoff”用的默认 prompt（设置里可改）。占位符由 src/main/handoff/prompt.ts 填充。 */
export const DEFAULT_HANDOFF_PROMPT = `你在为 Butler 生成 ticket {{ticket}}（{{title}}，分支 {{branch}}）的 handoff：总结这个 session 到目前为止的进度，供明天早上的简报使用。

要求：
1. 用 tracker MCP 工具读取 ticket {{ticket}} 的描述、评论和子任务。可用的工具：{{tracker_tools}}。工具不可用或读取失败时 jira 填 null，不要编造。
2. 用 \`gh pr view {{branch}}\` 和 \`gh pr checks {{branch}}\` 读取 PR 状态；没有 PR 时 pr 填 null。
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

1. 用 \`gh pr view {{branch}}\` 查询 PR 的 state 和 review 状态；没有 PR 时 pr 填 null。
2. 用 tracker MCP 工具查询 ticket {{ticket}} 的状态和子任务。可用的工具：{{tracker_tools}}。不可用时 jira 填 null。
3. status：PR 已合并填 merged_pending_followup；PR 打开中填 in_review；其他情况沿用当前状态 {{current_status}}。

只输出一个 JSON 对象，包含 status、pr、jira 三个字段，含义同下：
{{schema}}
`;

/** handoff.md 里的标记行：有它才说明文件是 Butler 写的，可以更新或卸载。 */
export const HANDOFF_COMMAND_MARKER = "<!-- butler:handoff-command v1 -->";

/** 写入 Claude Code 用户级 commands 目录的 /handoff 命令。 */
export const HANDOFF_COMMAND_MD = `---
description: 生成 Butler handoff（当前 ticket 的进度摘要）
---
${HANDOFF_COMMAND_MARKER}
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
