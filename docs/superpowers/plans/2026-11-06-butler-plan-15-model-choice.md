# 选模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 子代理默认用 Sonnet；总控开子 session 时按任务选 Opus 或 Sonnet；session 的模型记下来，恢复和 fork 时沿用，避免缓存失效；后台判断用 Haiku；给 Claude Code 的自动压缩设一个兜底长度。

**Architecture:** `sessions` 表加 `model` 列。`claudeArgs` 加 `model`，`sessionEnv` 加两个默认环境变量（用户自己设了就不覆盖）。`start_session`（ticket 总控和 feature 总控两种）加可选的 `model` 参数，一路传到 `SessionService.open`。headless 的 fork 带上被 fork 的 session 的模型。模型准则写进计划 13 建的 session 说明文件。

**Tech Stack:** TypeScript、Electron 主进程、node:sqlite、MCP server（`memory-mcp/sessions-server.ts`）、vitest。

**Spec:** `docs/superpowers/specs/2026-11-06-now-page-and-token-savings-design.md`（"选模型"两节）

**依赖:** 计划 13（`GUIDE_SECTIONS`、`claudeArgs` 的 `guidePath`）、计划 14（`headlessArgs` 的 `model`）。

## Global Constraints

- 取值只有 `"opus"`、`"sonnet"`（`start_session` 的参数）；Butler 自己的判断用 `"haiku"`。用 Claude Code 的别名，不写具体版本号。
- `CLAUDE_CODE_SUBAGENT_MODEL=sonnet`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000`：只在用户的环境里没有这两个变量时才加；对 Butler 在终端里开的所有 session（ticket、总控、修复、epic）都加；headless 不加。
- 总控自己、用户手动开的 session 不传 `--model`（用 Claude Code 自己的默认）。
- 没记模型的 session（老数据）恢复、fork 时都不传 `--model`。
- 修复 session（`openFix`）用 `sonnet`。
- 卡住判定、「需要你」判断用 `haiku`。
- 工具描述中英两套（`TOOLS`、`TOOLS_EN`）；session 说明中英两套。

## Review Focus

1. 子 session 用 Sonnet 开出来，用户关掉终端，第二天从 ticket 页点它恢复：还是 Sonnet → Task 2 的测试 `resumes with the recorded model`。
2. 子 session 里 `/clear` 之后 Butler 跑每晚 handoff，fork 的是链上最新的 id：要用同一个模型 → Task 3 的测试 `forks with the model of the session chain`。
3. 用户自己在 shell 里 `export CLAUDE_CODE_SUBAGENT_MODEL=opus` 再启动 Butler：不被覆盖 → Task 1 的测试 `keeps the user's own values`。
4. 总控传了 `model: "gpt-4"` 之类的值：返回错误，不开 session → Task 4 的测试 `rejects an unknown model`。
5. 修复 session 恢复时（它本来就是 Sonnet）不会因为没传参数变回默认 → Task 2 的测试 `resumes with the recorded model`（同一个用例覆盖修复 session）。

---

### Task 1: 启动参数和环境变量

**Files:**
- Modify: `src/main/claude/spawn.ts`
- Test: `src/main/claude/spawn.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SessionModel = "opus" | "sonnet";
  // claudeArgs 的 req 加 model?: SessionModel | null → 追加 "--model", model
  export const SUBAGENT_MODEL_DEFAULT = "sonnet";
  export const AUTO_COMPACT_WINDOW_DEFAULT = "250000";
  // sessionEnv 里：base 没有 CLAUDE_CODE_SUBAGENT_MODEL 时设成 SUBAGENT_MODEL_DEFAULT；没有 CLAUDE_CODE_AUTO_COMPACT_WINDOW 时设成 AUTO_COMPACT_WINDOW_DEFAULT
  ```

- [ ] **Step 1: 写失败的测试**

```ts
it("adds --model when given", () => { expect(claudeArgs({ mode: "new", sessionId: "s", model: "sonnet" })).toEqual(expect.arrayContaining(["--model", "sonnet"])); });
it("sets the subagent model and compact window by default", () => { const e = sessionEnv({}, { pathValue: "", sessionId: "s" }); expect(e.CLAUDE_CODE_SUBAGENT_MODEL).toBe("sonnet"); expect(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("250000"); });
it("keeps the user's own values", () => { const e = sessionEnv({ CLAUDE_CODE_SUBAGENT_MODEL: "opus", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000" }, { pathValue: "", sessionId: "s" }); expect(e.CLAUDE_CODE_SUBAGENT_MODEL).toBe("opus"); expect(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("400000"); });
it("headlessEnv does not add them", () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/main/claude/spawn.test.ts`）
- [ ] **Step 5: 真机确认这两个变量生效**

Run: `CLAUDE_CODE_SUBAGENT_MODEL=sonnet claude -p "用 Agent 工具开一个子代理，让它只回答 ok。" --output-format json | head -c 4000`
Expected: 结果的 `modelUsage` 里有 sonnet 的模型。看不到的话查 `claude --help` 和文档，确认变量名，以实际为准改常量。

- [ ] **Step 6: Commit**

```bash
git add src/main/claude/spawn.ts src/main/claude/spawn.test.ts
git commit -m "feat(model): --model for sessions, default subagent model and compact window"
```

### Task 2: 记下 session 的模型，恢复时沿用

**Files:**
- Modify: `src/main/db/migrations.ts`（`ALTER TABLE sessions ADD COLUMN model TEXT;`）
- Modify: `src/main/db/sessions-repo.ts`（`Session.model`、`NewSession.model`、`setReplacedBy` 把旧行的 `model` 复制到新行）
- Modify: `src/shared/types.ts`（`Session` 加 `model: string | null`）
- Modify: `src/main/sessions/session-service.ts`（`OpenExtra` 加 `model?: SessionModel`；新开时写进 session 行并传 `claudeArgs`；恢复时取 head 的 `model` 传进去；`openFix` 用 `"sonnet"`）
- Test: `src/main/db/repos.test.ts`（或 sessions-repo 的测试）、`src/main/sessions/session-service.test.ts`

**Interfaces:**
- Consumes: `SessionModel`、`claudeArgs({ model })`（Task 1）
- Produces: `Session.model: string | null`；`SessionService.open(req, { spawnedBy?, model? })`

- [ ] **Step 1: 写失败的测试**

```ts
it("stores the model of a new session", () => {});
it("copies the model to the session that replaces it", () => {});
it("resumes with the recorded model", async () => { /* model:"sonnet" 开出来，关掉，open({ sessionId }) → 启动参数里有 --model sonnet；修复 session 同理 */ });
it("does not pass --model for sessions without one", async () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/main/db src/main/sessions`）
- [ ] **Step 5: Commit**

```bash
git add src/main/db src/shared/types.ts src/main/sessions/session-service.ts src/main/sessions/session-service.test.ts
git commit -m "feat(model): remember each session's model and reuse it on resume"
```

### Task 3: headless 沿用模型，判断用 Haiku

**Files:**
- Modify: `src/main/handoff/runner.ts`（`full()` fork 时 `headlessArgs({ ..., model: forked?.model ?? undefined })`，`forked` 是被 fork 的那个 head）
- Modify: `src/main/handoff/feature-runner.ts`（fork 总控时同样处理）
- Modify: `src/main/sessions/stuck-judge.ts`（`model: "haiku"`）
- Modify: `src/main/handoff/runner.ts` 的 `refresh()`（tracker 刷新，不 fork）：`model: "sonnet"`
- Test: 对应的测试文件

- [ ] **Step 1: 写失败的测试**

```ts
it("forks with the model of the session chain", async () => { /* session A(model sonnet) 被 /clear 成 B（Task 2 复制了 model）；runNightly fork B → args 里有 --model sonnet */ });
it("forks without --model when the session has none", async () => {});
it("the stuck judge runs on haiku", async () => {});
it("the tracker refresh runs on sonnet", async () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/main/handoff src/main/sessions`）
- [ ] **Step 5: Commit**

```bash
git add src/main/handoff src/main/sessions/stuck-judge.ts src/main/sessions/stuck-judge.test.ts
git commit -m "feat(model): headless forks keep the session's model; judges on haiku"
```

### Task 4: start_session 的 model 参数

**Files:**
- Modify: `src/shared/control.ts`（两种 `start_session` 请求加 `model?: SessionModel`；`parseControlRequest` 校验：给了但不是 `opus`/`sonnet` 就当作坏请求）
- Modify: `memory-mcp/sessions-server.ts`（`TOOLS`、`TOOLS_EN` 里两个 `start_session` 的 `inputSchema` 加 `model`，`enum: ["opus", "sonnet"]`；描述里写准则）
- Modify: `src/main/control/control-handler.ts`（`start()` 把 `model` 传给 `sessionService.open`；结果里回显 `model`）
- Test: `src/shared/control.test.ts`、`memory-mcp/sessions-server.test.ts`、`src/main/control/control-feature.test.ts`、`control-handler.test.ts`

`model` 参数的描述（中文；英文照译）：

```
这个 session 用哪个模型。sonnet：范围小、目标明确的活，比如修 CI、处理 rebase 冲突、补测试、按已经定好的方案实现。
opus：需要判断的活，比如查原因不明的 bug、做架构设计、跨模块改动、代码审查。拿不准就用 opus。省略时用默认模型。
```

- [ ] **Step 1: 写失败的测试**

```ts
it("parses start_session with a model", () => {});
it("rejects an unknown model", () => { /* model:"gpt-4" → parse 失败，handler 返回错误，sessionService.open 没被调用 */ });
it("passes the model to the new session", async () => {});
it("lists model in both tool schemas", () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/shared memory-mcp src/main/control`）
- [ ] **Step 5: 重新打包 MCP 并确认**

Run: `pnpm build:memory-mcp && pnpm vitest run memory-mcp/bundle.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/control.ts src/shared/control.test.ts memory-mcp src/main/control
git commit -m "feat(model): coordinators pick opus or sonnet per child session"
```

### Task 5: 模型准则写进 session 说明

**Files:**
- Modify: `src/main/claude/session-guide.ts`（`GUIDE_SECTIONS` 加一段）
- Test: `src/main/claude/session-guide.test.ts`

所有 session（`ticket` 和 `coordinator`）都有这段（中文；英文照译）：

```
子代理默认用 Sonnet。派子代理做代码审查、查原因不明的问题、做架构判断时，调用 Agent 工具要传 model: "opus"；读代码、搜索、跑命令这类活用默认就行。
```

`coordinator` 额外一段：

```
用 start_session 开子 session 时按任务选 model：范围小、目标明确的用 sonnet，需要判断的用 opus，拿不准就用 opus。
```

- [ ] **Step 1: 写失败的测试**（`sessionGuide("zh","ticket")` 含 `model: "opus"`；`sessionGuide("zh","coordinator")` 含 `start_session`；`ticket` 不含 `start_session`）
- [ ] **Step 2–4: 失败 → 实现 → 通过**
- [ ] **Step 5: 全部测试和类型检查** — Run: `pnpm typecheck && pnpm test` / Expected: PASS
- [ ] **Step 6: 真机验证**

`pnpm dev`，在一个 feature 总控里说"开一个 session 去补 X 的单元测试"。
Expected: 总控调 `start_session` 时带 `model: "sonnet"`；新 session 的 `/model` 显示 Sonnet；`sqlite3 ~/.butler/app.db "select id, model from sessions order by created_at desc limit 3"` 里记着 `sonnet`。

- [ ] **Step 7: Commit**

```bash
git add src/main/claude/session-guide.ts src/main/claude/session-guide.test.ts
git commit -m "feat(model): model guidance in the Butler session guide"
```
