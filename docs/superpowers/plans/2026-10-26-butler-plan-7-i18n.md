# 中英文切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Butler 的界面、主进程文案和发给 claude 的提示词都支持中文 / 英文，默认跟系统语言，设置里可以改。

**Architecture:** 一个共享的语言解析函数；主进程和渲染进程各自一套按语言分开的文案表（同一个类型，键必须一致）；主进程持有当前语言，保存设置后通知渲染进程重新加载。提示词默认值随语言走。

**Tech Stack:** Electron + TypeScript，React，vitest，Playwright。

**Spec:** `docs/superpowers/specs/2026-10-26-i18n-design.md`

## Global Constraints

- 语言值：`Lang = "zh" | "en"`；设置 `language` 取 `auto | zh | en`，默认 `auto`。
- 环境变量 `BUTLER_LANG`（`zh` / `en`）优先于设置。
- `auto`：系统首选语言以 `zh` 开头 → `zh`，否则 `en`。
- 迁移只追加（迁移 7）。
- 文案两套必须键一致：英文表的类型是中文表的类型（`typeof zh`）。
- 现有测试断言的中文文案保持不变（测试默认中文）。
- 每个 task 结束：`pnpm test`、`pnpm typecheck`、`npx eslint . --ignore-pattern '.claude/**'` 全过再提交；提交信息结尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

- 升级的老用户第一次启动 1.2.1：必须仍是中文（迁移 7）。→ Task 1 的迁移测试。
- 用户保存过（没改动的）默认提示词：切换语言后应当跟着变成另一种语言的默认值。→ Task 4 的测试。
- 英文下主进程抛给界面的错误（建 ticket、清理原因、设置校验）是英文。→ Task 3 的测试。
- 切换语言后，Butler 自己的 `/handoff` 命令显示需要更新，而不是“冲突”。→ Task 4 的测试。
- E2E 在英文系统的机器上照样能跑（`BUTLER_LANG=zh`）。→ Task 5。

---

### Task 1: 语言解析、设置、迁移、主进程当前语言

**Files:** Create `src/shared/i18n.ts`、`src/main/i18n.ts`；Modify `src/main/db/migrations.ts`、`src/main/db/settings-repo.ts`、`src/shared/settings.ts`、`src/main/settings/settings-values.ts`、`src/main/ipc/settings-handlers.ts`、`src/shared/ipc.ts`、`src/main/ipc/register.ts`、`src/renderer/src/api.ts`、`src/main/index.ts`；Test `src/shared/i18n.test.ts`、`src/main/db/repos.test.ts`、`src/main/settings/settings-values.test.ts`

**Interfaces — Produces:**
- `src/shared/i18n.ts`：`type Lang = "zh" | "en"`；`LANG_SETTINGS = ["auto", "zh", "en"] as const`；`resolveLang(setting: string, systemLocales: readonly string[], override?: string): Lang`。
- `src/main/i18n.ts`：`currentLang(): Lang`、`setLang(l: Lang): void`、`onLangChange(cb: (l: Lang) => void): () => void`。默认 `zh`。
- 设置键 `language`（默认 `auto`，可编辑；`normalizeSetting` 只接受 `LANG_SETTINGS`）。
- 迁移 7：已有 `onboardingDone = 1` 或有 ticket 时 `INSERT OR IGNORE` `language = zh`。
- IPC `app:language` → 当前 `Lang`；`api.language()`。
- `index.ts`：启动时 `setLang(resolveLang(settings.get("language"), app.getPreferredSystemLanguages(), process.env.BUTLER_LANG))`；保存 / 重置 `language` 后重新解析、`setLang`、`notify()`。

- [ ] Step 1: 测试：`resolveLang("auto", ["zh-Hans-CN"])` → zh；`("auto", ["zh-TW"])` → zh；`("auto", ["en-US","zh-CN"])` → en；`("auto", [])` → en；`("zh", ["en-US"])` → zh；`("auto", ["zh-CN"], "en")` → en；override 不是 zh/en 时忽略。迁移 7：版本 6 的库里有 ticket → `language` 读出 zh；全新库 → auto。`normalizeSetting("language", "fr")` 抛错。
- [ ] Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过 → Step 5: 提交 `feat(i18n): language setting, resolution and migration 7`

### Task 2: 渲染进程文案中英两套，语言选择

**Files:** Modify `src/renderer/src/strings.ts`、`src/renderer/src/main.tsx`、`src/renderer/src/components/GeneralSettings.tsx`、`src/renderer/src/components/Wizard.tsx`；Test `src/renderer/src/strings.test.ts`（新建）

**Interfaces:** `strings.ts` 导出 `let S`、`let STATUS_LABEL`（可重新赋值的 live binding）、`STATUS_ORDER`（不变）、`setUiLang(l: Lang): void`、`STRINGS: Record<Lang, typeof zhS>`（测试用）。`main.tsx` 渲染前 `setUiLang(await api.language())`（失败时用 zh）。常规设置页和向导第一步各有一个 `select`（`S.languageLabel`：自动 / 中文 / English），保存后 `location.reload()`。

- [ ] Step 1: 测试：`STRINGS.en` 和 `STRINGS.zh` 递归键集合相同；函数项两边都是函数且参数个数相同；`setUiLang("en")` 后 `S.newTicket === "New ticket"`、`STATUS_LABEL.done === "Done"`，`setUiLang("zh")` 复原。
- [ ] Step 2–5: 失败 → 翻译全部文案（英文语气和 README 一致，UI 标签简短）→ 通过 → 提交 `feat(i18n): English UI strings and a language picker`

### Task 3: 主进程给人看的文案

**Files:** Modify `src/main/strings.ts` 和所有抛给用户的消息所在的文件（`ticket-service.ts`、`feature-service.ts`、`worktree-cleanup.ts`、`settings-values.ts`、`ipc/validate.ts` 里面向用户的、`ipc/register.ts`、`index.ts` 托盘 / 对话框 / 错误、`hooks/installer.ts`、`gateway/*` 里面向用户的、`sessions/session-service.ts`、`handoff/runner.ts`、`claude/*` 里面向用户的、`memory/memory-service.ts`、`db/database.ts`、`brief/brief-service.ts`）；Test `src/main/strings.test.ts`（新建）

**Interfaces:** `src/main/strings.ts` 导出 `M()`：返回当前语言的表（`M().ticketNotFound(key)` 这样用），以及 `MAIN_STRINGS: Record<Lang, MainStrings>`。通知相关的 `N` 并入 `M()`。托盘菜单在 `onLangChange` 时重建。

- [ ] Step 1: 测试：两套键一致；`setLang("en")` 后 `TicketService.create` 用非法 ticket 号抛出的消息是英文、`code` 不变；`cleanupTicketWorktrees` 的 blocked 原因是英文；`normalizeBranchTemplate("x")` 的错误是英文。测试结束复原 `zh`。
- [ ] Step 2–5: 失败 → 把每处消息换成 `M().xxx` 并翻译 → 通过（现有中文断言不变）→ 提交 `feat(i18n): main-process messages in both languages`

### Task 4: 提示词和给 claude 看的内容

**Files:** Modify `src/main/handoff/templates.ts`、`src/main/db/settings-repo.ts`、`src/main/handoff/command.ts`、`src/main/gateway/narrative.ts`、`src/main/memory/notes.ts`、`src/shared/control.ts`（`taskMessage`）、`src/main/control/control-handler.ts`、`memory-mcp/sessions-server.ts`、`memory-mcp/sessions-entry.ts`、`src/main/memory/mcp-config.ts`；Test 对应的 `*.test.ts`

**Interfaces:**
- `templates.ts`：`defaultHandoffPrompt(l)`、`defaultRefreshPrompt(l)`、`handoffSchemaDoc(l)`、`handoffExample(l)`（例子的字段值翻译，结构不变）、`handoffCommandMd(l)` / `handoffCommandBody(l)`。保留原导出名作为中文版本的别名（测试和旧调用不变）。
- `SettingsRepo.get("handoffPrompt" | "refreshPrompt")`：没有存值、或存的值等于任一语言的默认值 → 当前语言的默认值。
- `handoffCommandStatus`：正文等于当前语言版本 → installed；等于另一语言版本或旧版本 → stale。
- `taskMessage(task, l)`：en 前缀 `Task from the coordinator session:\n`。
- `sessionsServer` 的 env 加 `BUTLER_LANG`；`SessionsServer` 选项 `lang`，工具描述按语言。
- `narrative.ts` 系统提示按语言（en：写 2–4 句英文）；`notes.ts` 标签按语言。

- [ ] Step 1: 测试：en 下 `settings.get("handoffPrompt")` 是英文默认；存过中文默认值的在 en 下也变成英文；存过自定义的不变。en 下 `/handoff` 中文版本的状态是 stale、安装后是 installed。`taskMessage("x","en")` 前缀英文。sessions server en 模式 `tools/list` 描述是英文。
- [ ] Step 2–5: 失败 → 实现、翻译 → 通过 → 提交 `feat(i18n): prompts and model-facing text follow the language`

### Task 5: E2E、文档、版本

**Files:** Modify `e2e/fixtures.ts`（沙盒环境加 `BUTLER_LANG=zh`，`launch` 可传覆盖）；Create `e2e/language.spec.ts`；Modify `README.md`、`docs/configuration.md`、`package.json`（1.2.1）

- [ ] Step 1: E2E：`BUTLER_LANG` 不设、设置 `language=en`……用 `BUTLER_LANG=en` 启动 → 向导标题是英文 → 设置页常规的语言选中文 → 重新加载后 `S` 中文标题可见。（`BUTLER_LANG` 优先于设置，所以切换测试用不设 `BUTLER_LANG`、先在向导里选 English 的方式。）
- [ ] Step 2: 全部 E2E 通过；README 里“UI is in Chinese”改成两种语言，configuration.md 常规表加 `language` 一行。
- [ ] Step 3: 提交 `test(e2e): language switch; docs; release 1.2.1`（版本号单独一个 commit `release: 1.2.1`）。
