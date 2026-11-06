---
description: 生成 Butler handoff（当前 ticket 的进度摘要；在 feature 总控里是 feature 汇总）
---
<!-- butler:handoff-command v1 sha256:b1f595f85e044f9f794e47f10ac55636f96a984ec3d072ec8382fcfb21fe12e9 -->
先看你能不能调用 butler-sessions 的 `list_tickets` 工具（mcp__butler-sessions__list_tickets）。能调用的话，这个 session 是 feature 总控，不属于某个 ticket，要写的是 feature 汇总：
- 先用 `list_tickets` 看这个 feature 下各 ticket 的情况，再结合这个 session 的完整对话来写。
- 只写跨 ticket 的整体情况：整体进展、卡在哪、接下来先做什么、ticket 之间的约定（接口、错误码等）。提到 ticket 时只写 ticket 号；不要写完成百分比。
- 只读：不要修改文件，不要提交或推送。
- 最后输出一个 ```butler-feature-handoff 代码块，里面只有一个 JSON 对象；代码块之后不要再写任何内容。不要输出 butler-handoff 代码块，后面 ticket handoff 的说明也不用管。

feature 汇总的字段如下：
{
  summary: string,                // 一段话：整体到哪了
  blockers: string[],             // 卡在哪；提到 ticket 时写 ticket 号；没有就是 []
  next_steps: {                   // 接下来要做的事，第一条最先做
    ticket: string | null,        // 这一步属于哪个 ticket（ticket 号）；不属于某个 ticket 时为 null
    text: string
  }[],
  decisions: { key: string, statement: string }[],   // 跨 ticket 的约定（接口、错误码等），key 用简短的英文标识
  open_questions: string[]
}

示例：
```butler-feature-handoff
{
  "summary": "登录页前端（PROJ-123）已提 PR 等 review；后端 token 接口（PROJ-124）还差刷新失败的处理，两边还没联调。",
  "blockers": [
    "PROJ-124 等运维开 staging 的 Redis 权限"
  ],
  "next_steps": [
    {
      "ticket": "PROJ-124",
      "text": "补上 refresh 失败时的错误码"
    },
    {
      "ticket": null,
      "text": "两边都合并后在 staging 联调登录流程"
    }
  ],
  "decisions": [
    {
      "key": "auth-error-codes",
      "statement": "token 过期统一返回 401 + code=token_expired"
    }
  ],
  "open_questions": [
    "移动端是否也走新的刷新逻辑？"
  ]
}
```

不能调用 `list_tickets` 时，照下面的说明写 ticket 的 handoff。

请为当前 session 对应的 ticket 生成一份 handoff，供 Butler 的早间简报使用。

- 依据这个 session 的完整对话；如果可以，再用 tracker MCP 工具和 `gh pr view` 确认 ticket 与 PR 的最新状态。
- 只读：不要修改文件，不要提交或推送。
- ticket 填当前的 ticket 号（通常在分支名里，例如 PROJ-123）。
- 已有的 followup 如果知道 id 就填 id，否则 id 填 null。
- 最后输出一个 ```butler-handoff 代码块，里面只有一个 JSON 对象；代码块之后不要再写任何内容。

字段如下：
{
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
}

示例：
```butler-handoff
{
  "ticket": "PROJ-123",
  "status": "in_review",
  "done_today": [
    "登录页改用新的 token 刷新逻辑",
    "补了 refresh 失败的单元测试"
  ],
  "next_steps": [
    "根据 review 意见拆分 AuthService",
    "合并后改 staging 的 token TTL 配置"
  ],
  "blockers": [],
  "prs": [
    {
      "number": 456,
      "url": "https://github.com/acme/web/pull/456",
      "state": "open",
      "review": "pending"
    }
  ],
  "jira": {
    "status": "In Review",
    "subtasks": [
      {
        "key": "PROJ-124",
        "status": "Done"
      }
    ]
  },
  "followups": [
    {
      "id": "f_1a2b3c4d",
      "kind": "config",
      "description": "改 staging 的 token TTL 为 15 分钟",
      "trigger": "after_merge",
      "due_date": null,
      "done": false
    },
    {
      "id": null,
      "kind": "flag",
      "description": "全量打开 new_login 开关",
      "trigger": "on_date",
      "due_date": "2026-10-30",
      "done": false
    }
  ],
  "decisions": [
    {
      "key": "token-storage",
      "statement": "refresh token 只放 httpOnly cookie"
    }
  ],
  "learnings": [
    "本仓库的 e2e 需要先跑 pnpm seed"
  ],
  "open_questions": [
    "TTL 是否需要和移动端一致？"
  ]
}
```

$ARGUMENTS
