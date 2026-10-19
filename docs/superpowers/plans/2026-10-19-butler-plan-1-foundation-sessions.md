# Butler 计划 1：基础框架与 Session 管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出一个能日常使用的跨平台 Electron 应用：以 ticket 为中心管理多个 Claude Code session（内嵌终端、`--session-id` 新建、`--resume` 续接、worktree/branch 两种模式），通过 Butler 自己安装的 hook 实时知道哪个 session 在等你输入，并能认领在 app 外启动的 session。

**Architecture:** Electron 主进程持有所有状态：SQLite（`node:sqlite`）存 ticket/session，node-pty 跑 `claude`，`butler-hook` 单文件程序把 Claude Code hook 事件写进 `~/.butler/inbox`，主进程监听 inbox 更新状态。渲染进程是 React + xterm.js，只通过白名单 IPC 和主进程通信。业务逻辑（repo、TicketService、SessionService、hook 处理、discovery、installer）都是不依赖 Electron 的普通 TS 模块，用 vitest 在 Node 下测试。

**Tech Stack:** Electron 44.9.0、electron-vite 6.0.0、Vite 8.3.4、React 19.3.1、@xterm/xterm 6.0.0、node-pty 1.1.0、node:sqlite、vitest 5.0.5、TypeScript 5.9.3、esbuild 0.28.2（打包 hook）、Node SEA（`node --build-sea`）。

**Spec:** `docs/superpowers/specs/2026-10-19-butler-design.md`（重点：第 2、3、4、10 节和 13.1）

## 本计划在整体中的位置

设计文档覆盖 5 个子系统，拆成 4 个计划，每个计划结束时都是可用的软件：

| 计划 | 内容 | 结束时能做什么 |
|------|------|--------------|
| **1（本计划）** | 框架、数据库、ticket、内嵌终端、hook、session 发现、托盘 | 用 Butler 管理所有 ticket 的 Claude Code session |
| 2 | Handoff 采集（`claude -p --fork-session --json-schema`、`/handoff`）、followups、规则简报、调度 | 晚间总结 + 早间简报（纯规则） |
| 3 | PrivacyGateway、LLM 服务商、审计页、预算 | 简报带“今日重点”润色 |
| 4 | StateCore 记忆层、设置页完善（分支模板、ticket 正则、claude 路径）、首次启动向导、开机自启、CSP、打包签名、Playwright E2E、双平台 CI、开源文档 | 可发布的 v1.0 |

计划 2～4 在计划 1 执行完后再写，因为它们依赖本计划落地的接口和实测结果。

## Global Constraints

- 平台：Windows + macOS 功能一致；路径一律用 `node:path`，不手拼分隔符。
- Electron 内置 Node 必须能 `import "node:sqlite"`（任务 1 冒烟验证）；单元测试在系统 Node（≥22.13）下跑。
- 所有 Butler 数据放在 `~/.butler/`（Windows 为 `%USERPROFILE%\.butler\`），`BUTLER_HOME` 环境变量可覆盖。
- Claude Code 配置目录：`CLAUDE_CONFIG_DIR` 优先，否则 `~/.claude/`。
- app 不保存任何 Claude/Jira/GitHub 凭证；所有 Claude 调用都用本机已登录的 `claude` 命令。
- 本计划不发起任何网络请求。
- `butler-hook` 绝不阻塞 Claude Code：任何异常都以退出码 0 静默结束。
- 修改 Claude Code 的 `settings.json` 时只能合并，不能覆盖用户已有的 hook 或其他字段；文件不是合法 JSON 时拒绝写入。
- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，IPC 通道走白名单。
- UI 文案用中文，集中在 `src/renderer/src/strings.ts`。
- 包管理器用 pnpm；每个任务结束时 `pnpm test` 和 `pnpm typecheck` 必须通过。
- 每个 commit message 末尾加一行：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. **路径含空格或中文**（如 `C:\Users\张 三\`）：hook 命令必须正确加引号，PTY 的 cwd 必须能用。测试见任务 6。
2. **用户已有的 Claude Code hook 和配置**，以及格式损坏的 `settings.json`：安装/卸载只动 Butler 自己的条目；文件损坏时拒绝写入、原文件不变。测试见任务 6。
3. **同一个 session 被点开两次**（包括 `/clear` 之后 session id 变了的情况）：必须聚焦已有终端，绝不对同一个 session 启动第二个 `claude`。测试见任务 10。
4. **hook 事件乱序或在 app 没运行时到达**（例如 `Stop` 比 `SessionStart` 先被处理）：要能补建 session 记录，不能丢事件也不能报错。测试见任务 7。
5. **Claude Code 历史目录里有大量或损坏的 `.jsonl`**：只读文件开头、跳过损坏行、只列最近 7 天的；“未认领”列表不能被几百个历史 session 淹没。测试见任务 8。

---

## 文件结构

```
Butler/
  package.json, pnpm-lock.yaml, .gitignore
  electron.vite.config.ts, vitest.config.ts, eslint.config.mjs
  tsconfig.json, tsconfig.node.json, tsconfig.web.json
  hook/
    butler-hook.ts          hook 程序逻辑（可测试，无副作用）
    butler-hook.test.ts
    entry.ts                SEA 入口：调用 main()
  scripts/
    build-hook.mjs          esbuild 打包 + node --build-sea
  src/
    shared/                 主进程与渲染进程共用（不能 import node 模块）
      types.ts              Ticket/Session/各种 View/HealthReport
      ipc.ts                IPC 通道常量、白名单、IpcResult
      hook-envelope.ts      HookEnvelope 类型与解析
    main/
      index.ts              启动、窗口、托盘、组装依赖
      smoke.ts              --smoke 冒烟测试
      paths.ts              ~/.butler 与 Claude 配置路径
      tray-bitmap.ts        托盘图标位图（纯函数）
      test-utils.ts         测试辅助：内存数据库、临时目录、临时 git 仓库、FakePty
      util/exec.ts          execText：跑命令拿 stdout（处理 Windows .cmd）
      util/env.ts           大小写无关的 PATH 读写
      db/database.ts        打开数据库 + 迁移
      db/migrations.ts
      db/tickets-repo.ts
      db/sessions-repo.ts
      db/settings-repo.ts
      tickets/ticket-key.ts ticket 号校验/提取、分支模板
      tickets/git.ts        git 命令封装
      tickets/ticket-service.ts
      claude/locate.ts      读登录 shell 的 PATH、找 claude
      claude/capabilities.ts 版本与参数探测
      claude/spawn.ts       claude 参数、启动命令、session 环境变量
      hooks/installer.ts    合并写入/卸载 settings.json 中的 hook
      hooks/health.ts       HealthService
      hooks/hook-events.ts  把 hook 事件应用到数据库
      hooks/inbox.ts        监听 inbox 目录
      sessions/discovery.ts 扫描 Claude Code 项目目录
      sessions/pty-manager.ts
      sessions/pty-node.ts  node-pty 适配器
      sessions/session-service.ts
      ipc/result.ts         toIpcResult（纯函数）
      ipc/register.ts       注册 ipcMain 处理器
    preload/index.ts        白名单 IPC 桥
    renderer/
      index.html
      src/main.tsx, App.tsx, api.ts, strings.ts, group.ts, group.test.ts, styles.css
      src/components/Sidebar.tsx, HomePage.tsx, NewTicketDialog.tsx,
                     TicketPage.tsx, TerminalPane.tsx, UnclaimedPage.tsx, SettingsPage.tsx
```

测试文件与源文件放在一起（`*.test.ts`）。

---

### Task 1: 项目脚手架 + Electron 内 sqlite/pty 冒烟验证

**Files:**
- Create: `package.json`, `.gitignore`, `electron.vite.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`
- Create: `src/main/index.ts`, `src/main/smoke.ts`, `src/preload/index.ts`
- Create: `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`

**Interfaces:**
- Produces: `pnpm dev` / `pnpm build` / `pnpm test` / `pnpm typecheck` / `pnpm lint` 脚本；`electron out/main/index.js --smoke` 输出 `sqlite-ok 1` 和 `pty-ok`。

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "butler",
  "version": "0.1.0",
  "private": true,
  "description": "A work butler for Claude Code ticket sessions",
  "license": "MIT",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "lint": "eslint .",
    "build:hook": "node scripts/build-hook.mjs",
    "postinstall": "electron-builder install-app-deps"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["electron", "node-pty", "esbuild"]
  }
}
```

- [ ] **Step 2: 安装依赖**

```bash
pnpm add node-pty@1.1.0
pnpm add -D electron@44.9.0 electron-vite@6.0.0 vite@8.3.4 @vitejs/plugin-react@6.1.2 \
  react@19.3.1 react-dom@19.3.1 @types/react@19.3.0 @types/react-dom@19.3.0 \
  @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 \
  vitest@5.0.5 typescript@5.9.3 @types/node@24.19.2 \
  eslint@10.13.0 @eslint/js@10.0.1 typescript-eslint@8.72.0 \
  electron-builder@26.15.3 esbuild@0.28.2
```

Expected：安装成功，postinstall 输出 electron-builder 重建 node-pty 的日志（node-pty 1.x 是 N-API，可能直接用预编译包）。

- [ ] **Step 3: 写配置文件**

`.gitignore`:
```
node_modules/
out/
build/
dist/
*.log
.DS_Store
```

`electron.vite.config.ts`:
```ts
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: { rollupOptions: { external: ["node-pty"] } },
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
});
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "hook/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
  },
});
```

`eslint.config.mjs`:
```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/**", "build/**", "dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

`tsconfig.json`:
```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

`tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/main/**/*", "src/preload/**/*", "src/shared/**/*", "hook/**/*", "electron.vite.config.ts", "vitest.config.ts"]
}
```

`tsconfig.web.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  },
  "include": ["src/renderer/src/**/*", "src/shared/**/*"]
}
```

- [ ] **Step 4: 写冒烟测试和最小主进程**

`src/main/smoke.ts`:
```ts
import { DatabaseSync } from "node:sqlite";
import * as pty from "node-pty";

// 验证 Electron 内置 Node 能用 node:sqlite，且 node-pty 原生模块能加载并启动进程。
export async function runSmoke(): Promise<number> {
  const db = new DatabaseSync(":memory:");
  const row = db.prepare("SELECT 1 AS one").get() as { one: number };
  console.log(`sqlite-ok ${row.one}`);
  db.close();

  const [file, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "echo pty-ok"]] : ["/bin/echo", ["pty-ok"]];
  const output = await new Promise<string>((resolve) => {
    let buf = "";
    const p = pty.spawn(file, args, { cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
    p.onData((d) => (buf += d));
    p.onExit(() => resolve(buf));
  });
  const ok = output.includes("pty-ok");
  console.log(ok ? "pty-ok" : `pty-fail ${JSON.stringify(output)}`);
  return ok ? 0 : 1;
}
```

`src/main/index.ts`（任务 12 会重写为完整版本）:
```ts
import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { runSmoke } from "./smoke";

if (process.argv.includes("--smoke")) {
  void runSmoke().then((code) => app.exit(code));
} else {
  void app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void win.loadFile(join(__dirname, "../renderer/index.html"));
  });
}
```

`src/preload/index.ts`:
```ts
// 任务 10 会替换为白名单 IPC 桥。
export {};
```

`src/renderer/index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <!-- CSP 在计划 4 加：开发模式下 Vite 的 React 热更新需要内联脚本。 -->
    <title>Butler</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`:
```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
```

`src/renderer/src/App.tsx`（任务 11 会重写）:
```tsx
export function App() {
  return <h1>Butler</h1>;
}
```

- [ ] **Step 5: 构建并跑冒烟测试**

Run: `pnpm build && ls out/main/index.js out/preload/index.js && pnpm exec electron out/main/index.js --smoke`
Expected: 两个文件都存在（如果 preload 产物是 `index.mjs`，把 `src/main/index.ts` 里的 preload 路径改成对应文件名，任务 12 同理）；输出里包含 `sqlite-ok 1` 和 `pty-ok`，进程退出码 0。

**如果没有 `sqlite-ok`（`node:sqlite` 不可用）：停下来，向用户报告。** 整个存储层依赖它，备选方案是 better-sqlite3，要先和用户确认。如果没有 `pty-ok`：先跑 `pnpm exec electron-builder install-app-deps` 再重试；仍失败就报告。

- [ ] **Step 6: 跑其余检查**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过（vitest 显示没有测试文件，但因为 `passWithNoTests` 而通过）。

Run: `pnpm dev`
Expected: 弹出窗口，显示 “Butler”。手动关闭。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Electron app with sqlite/pty smoke test"
```

---

### Task 2: 路径、数据库与数据仓库

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/main/paths.ts`, `src/main/paths.test.ts`
- Create: `src/main/db/database.ts`, `src/main/db/migrations.ts`
- Create: `src/main/db/tickets-repo.ts`, `src/main/db/sessions-repo.ts`, `src/main/db/settings-repo.ts`, `src/main/db/repos.test.ts`
- Create: `src/main/test-utils.ts`

**Interfaces:**
- Produces:
  - `resolvePaths(env?, platform?, home?): ButlerPaths`、`ensureDirs(p: ButlerPaths): Promise<void>`
  - `ButlerPaths { home; db; inbox; inboxBad; bin; hookBin; logs; claudeConfigDir; claudeSettings; claudeProjects; claudeCommands }`
  - `openDatabase(file: string): Db`（`Db = DatabaseSync`）、`migrate(db): number`
  - `TicketsRepo`：`insert(t)`, `get(key)`, `list({includeArchived?})`, `setStatusManual(key, status|null)`, `archive(key, at)`
  - `SessionsRepo`：`insertIfAbsent(s: NewSession): boolean`, `fillDetails(id, d)`, `get(id)`, `listByTicket(key)`, `listUnclaimed(sinceMs)`, `setTicket(id, key|null)`, `setWaiting(id, waiting, at)`, `setReplacedBy(id, newId)`, `dismiss(id)`, `head(id): Session|null`
  - `SettingsRepo`：`get(key: SettingKey): string`, `set(key, value)`；`SETTING_DEFAULTS`
  - `shared/types.ts` 中的全部类型和 `effectiveStatus()`
  - `test-utils.ts`：`memDb()`, `tempDir(prefix?)`

- [ ] **Step 1: 写共享类型**

`src/shared/types.ts`:
```ts
export const TICKET_STATUSES = ["active", "in_review", "blocked", "merged_pending_followup", "done"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type WorkMode = "worktree" | "branch";

export interface Ticket {
  key: string;
  title: string | null;
  repoPath: string;
  workMode: WorkMode;
  worktreePath: string | null;
  branch: string;
  status: TicketStatus;
  statusManual: TicketStatus | null;
  createdAt: number;
  archivedAt: number | null;
}

export type SessionOrigin = "butler" | "discovered";

export interface Session {
  id: string;
  ticketKey: string | null;
  cwd: string;
  origin: SessionOrigin;
  gitBranch: string | null;
  firstPrompt: string | null;
  lastActivityAt: number | null;
  waitingForInput: boolean;
  replacedBy: string | null;
  dismissed: boolean;
  createdAt: number;
}

/** termId 非空表示这个 session 当前有一个打开的终端（termId 是该终端启动时用的 session id）。 */
export interface SessionView extends Session {
  termId: string | null;
}

export interface TicketView extends Ticket {
  effectiveStatus: TicketStatus;
  sessions: SessionView[];
  waiting: boolean;
}

export interface UnclaimedSession extends Session {
  suggestedTicket: string | null;
  suggestionExists: boolean;
}

export interface CreateTicketInput {
  key: string;
  title?: string;
  repoPath: string;
  workMode: WorkMode;
  branch?: string;
}

export interface OpenSessionRequest {
  ticketKey: string;
  /** 省略表示新建 session；给出时恢复该 session（会沿 replacedBy 链找到最新的）。 */
  sessionId?: string;
  /** 打开后预填到输入框的文本，不回车。 */
  prefill?: string;
  /** 跳过分支检查。 */
  force?: boolean;
}

export type OpenSessionResult =
  | { ok: true; termId: string; alreadyOpen: boolean }
  | { ok: false; reason: "branch_mismatch"; current: string; expected: string; dirty: boolean }
  | { ok: false; reason: "claude_missing" | "no_ticket" | "no_session" };

export type HookStatus = "installed" | "missing" | "partial" | "stale" | "settings_invalid";

export interface ClaudeHealth {
  path: string | null;
  version: string | null;
  flags: Record<string, boolean>;
  missingFlags: string[];
  error: string | null;
}

export interface HealthReport {
  claude: ClaudeHealth;
  hooks: HookStatus;
  hookBinInstalled: boolean;
  butlerHome: string;
  claudeSettingsPath: string;
}

export function effectiveStatus(t: Pick<Ticket, "status" | "statusManual">): TicketStatus {
  return t.statusManual ?? t.status;
}
```

- [ ] **Step 2: 写 paths 的失败测试**

`src/main/paths.test.ts`:
```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePaths } from "./paths";

describe("resolvePaths", () => {
  it("defaults to ~/.butler and ~/.claude", () => {
    const p = resolvePaths({}, "darwin", "/home/u");
    expect(p.home).toBe(join("/home/u", ".butler"));
    expect(p.db).toBe(join("/home/u", ".butler", "app.db"));
    expect(p.inbox).toBe(join("/home/u", ".butler", "inbox"));
    expect(p.inboxBad).toBe(join("/home/u", ".butler", "inbox", "bad"));
    expect(p.hookBin).toBe(join("/home/u", ".butler", "bin", "butler-hook"));
    expect(p.claudeSettings).toBe(join("/home/u", ".claude", "settings.json"));
    expect(p.claudeProjects).toBe(join("/home/u", ".claude", "projects"));
    expect(p.claudeCommands).toBe(join("/home/u", ".claude", "commands"));
  });

  it("honours BUTLER_HOME and CLAUDE_CONFIG_DIR", () => {
    const p = resolvePaths({ BUTLER_HOME: "/data/b", CLAUDE_CONFIG_DIR: "/data/c" }, "darwin", "/home/u");
    expect(p.home).toBe("/data/b");
    expect(p.claudeSettings).toBe(join("/data/c", "settings.json"));
  });

  it("uses .exe for the hook binary on Windows", () => {
    expect(resolvePaths({}, "win32", "/home/u").hookBin.endsWith("butler-hook.exe")).toBe(true);
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `pnpm vitest run src/main/paths.test.ts`
Expected: FAIL，找不到 `./paths`。

- [ ] **Step 4: 实现 paths.ts**

`src/main/paths.ts`:
```ts
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ButlerPaths {
  home: string;
  db: string;
  inbox: string;
  inboxBad: string;
  bin: string;
  hookBin: string;
  logs: string;
  claudeConfigDir: string;
  claudeSettings: string;
  claudeProjects: string;
  claudeCommands: string;
}

export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): ButlerPaths {
  const butlerHome = env.BUTLER_HOME?.trim() || join(home, ".butler");
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const inbox = join(butlerHome, "inbox");
  const bin = join(butlerHome, "bin");
  return {
    home: butlerHome,
    db: join(butlerHome, "app.db"),
    inbox,
    inboxBad: join(inbox, "bad"),
    bin,
    hookBin: join(bin, platform === "win32" ? "butler-hook.exe" : "butler-hook"),
    logs: join(butlerHome, "logs"),
    claudeConfigDir,
    claudeSettings: join(claudeConfigDir, "settings.json"),
    claudeProjects: join(claudeConfigDir, "projects"),
    claudeCommands: join(claudeConfigDir, "commands"),
  };
}

export async function ensureDirs(p: ButlerPaths): Promise<void> {
  for (const dir of [p.home, p.inbox, p.inboxBad, p.bin, p.logs]) await mkdir(dir, { recursive: true });
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `pnpm vitest run src/main/paths.test.ts`
Expected: PASS（3 个测试）。

- [ ] **Step 6: 写数据库和仓库的失败测试**

`src/main/test-utils.ts`:
```ts
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "./db/database";

export function memDb(): Db {
  return openDatabase(":memory:");
}

/** realpath：macOS 的 /var 实际是 /private/var，git 返回的是真实路径。 */
export function tempDir(prefix = "butler-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
```

`src/main/db/repos.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Ticket } from "../../shared/types";
import { memDb } from "../test-utils";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";
import { SessionsRepo } from "./sessions-repo";
import { SettingsRepo } from "./settings-repo";
import { TicketsRepo } from "./tickets-repo";

const ticket = (key: string, over: Partial<Ticket> = {}): Ticket => ({
  key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: `feature/${key}`,
  status: "active", statusManual: null, createdAt: 1, archivedAt: null, ...over,
});

describe("migrate", () => {
  it("is idempotent", () => {
    const db = memDb();
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(MIGRATIONS.length);
  });
});

describe("TicketsRepo", () => {
  it("inserts, reads, lists without archived, sets manual status", () => {
    const repo = new TicketsRepo(memDb());
    repo.insert(ticket("PROJ-1", { title: "登录页" }));
    repo.insert(ticket("PROJ-2"));
    expect(repo.get("PROJ-1")?.title).toBe("登录页");
    expect(repo.get("NOPE-1")).toBeNull();
    repo.archive("PROJ-2", 5);
    expect(repo.list().map((t) => t.key)).toEqual(["PROJ-1"]);
    expect(repo.list({ includeArchived: true })).toHaveLength(2);
    repo.setStatusManual("PROJ-1", "blocked");
    expect(repo.get("PROJ-1")?.statusManual).toBe("blocked");
    repo.setStatusManual("PROJ-1", null);
    expect(repo.get("PROJ-1")?.statusManual).toBeNull();
  });
});

describe("SessionsRepo", () => {
  const setup = () => {
    const db = memDb();
    new TicketsRepo(db).insert(ticket("PROJ-1"));
    return new SessionsRepo(db);
  };

  it("insertIfAbsent only inserts once", () => {
    const repo = setup();
    expect(repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/x", origin: "discovered", createdAt: 1 })).toBe(true);
    expect(repo.insertIfAbsent({ id: "a", ticketKey: "PROJ-1", cwd: "/y", origin: "butler", createdAt: 2 })).toBe(false);
    expect(repo.get("a")).toMatchObject({ ticketKey: null, cwd: "/x", origin: "discovered", waitingForInput: false, dismissed: false });
  });

  it("fillDetails keeps existing values and only moves lastActivityAt forward", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "", origin: "discovered", gitBranch: "main", lastActivityAt: 10, createdAt: 1 });
    repo.fillDetails("a", { cwd: "/x", gitBranch: "other", firstPrompt: "hi", lastActivityAt: 5 });
    expect(repo.get("a")).toMatchObject({ cwd: "/x", gitBranch: "main", firstPrompt: "hi", lastActivityAt: 10 });
    repo.fillDetails("a", { lastActivityAt: 20 });
    expect(repo.get("a")?.lastActivityAt).toBe(20);
    repo.fillDetails("a", { lastActivityAt: null });
    expect(repo.get("a")?.lastActivityAt).toBe(20);
  });

  it("head follows replacedBy and survives cycles", () => {
    const repo = setup();
    for (const id of ["a", "b", "c"]) repo.insertIfAbsent({ id, ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 1 });
    repo.setReplacedBy("a", "b");
    repo.setReplacedBy("b", "c");
    expect(repo.head("a")?.id).toBe("c");
    expect(repo.head("missing")).toBeNull();
    repo.setReplacedBy("c", "a");
    expect(repo.head("a")).not.toBeNull();
  });

  it("listUnclaimed excludes claimed, dismissed, replaced and old sessions", () => {
    const repo = setup();
    const add = (id: string, at: number, ticketKey: string | null = null) =>
      repo.insertIfAbsent({ id, ticketKey, cwd: "/x", origin: "discovered", lastActivityAt: at, createdAt: at });
    add("fresh", 100);
    add("old", 1);
    add("claimed", 100, "PROJ-1");
    add("dismissed", 100);
    repo.dismiss("dismissed");
    add("replaced", 100);
    repo.setReplacedBy("replaced", "fresh");
    expect(repo.listUnclaimed(50).map((s) => s.id)).toEqual(["fresh"]);
  });

  it("setWaiting sets the flag and bumps activity; listByTicket orders by recency", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", lastActivityAt: 1, createdAt: 1 });
    repo.insertIfAbsent({ id: "b", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", lastActivityAt: 2, createdAt: 1 });
    repo.setWaiting("a", true, 9);
    expect(repo.get("a")).toMatchObject({ waitingForInput: true, lastActivityAt: 9 });
    expect(repo.listByTicket("PROJ-1").map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("SettingsRepo", () => {
  it("returns defaults and stores overrides", () => {
    const repo = new SettingsRepo(memDb());
    expect(repo.get("branchTemplate")).toBe("feature/{key}");
    repo.set("branchTemplate", "yc/{key}");
    expect(repo.get("branchTemplate")).toBe("yc/{key}");
  });
});
```

- [ ] **Step 7: 运行，确认失败**

Run: `pnpm vitest run src/main/db`
Expected: FAIL，找不到 `./database` 等模块。

- [ ] **Step 8: 实现数据库与仓库**

`src/main/db/migrations.ts`:
```ts
/** 按顺序追加，永远不要修改已发布的条目。下标 i 对应 user_version i+1。 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE tickets (
    key TEXT PRIMARY KEY,
    title TEXT,
    repo_path TEXT NOT NULL,
    work_mode TEXT NOT NULL CHECK (work_mode IN ('worktree', 'branch')),
    worktree_path TEXT,
    branch TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'in_review', 'blocked', 'merged_pending_followup', 'done')),
    status_manual TEXT
      CHECK (status_manual IS NULL OR status_manual IN ('active', 'in_review', 'blocked', 'merged_pending_followup', 'done')),
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    ticket_key TEXT REFERENCES tickets(key),
    cwd TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('butler', 'discovered')),
    git_branch TEXT,
    first_prompt TEXT,
    last_activity_at INTEGER,
    waiting_for_input INTEGER NOT NULL DEFAULT 0,
    replaced_by TEXT,
    dismissed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_ticket ON sessions(ticket_key);
  CREATE TABLE jobs (
    name TEXT PRIMARY KEY,
    last_run_at INTEGER,
    last_status TEXT,
    last_error TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];
```

`src/main/db/database.ts`:
```ts
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations";

export type Db = DatabaseSync;

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: Db): number {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return MIGRATIONS.length;
}
```

`src/main/db/tickets-repo.ts`:
```ts
import type { Ticket, TicketStatus, WorkMode } from "../../shared/types";
import type { Db } from "./database";

interface TicketRow {
  key: string;
  title: string | null;
  repo_path: string;
  work_mode: string;
  worktree_path: string | null;
  branch: string;
  status: string;
  status_manual: string | null;
  created_at: number;
  archived_at: number | null;
}

function toTicket(r: TicketRow): Ticket {
  return {
    key: r.key,
    title: r.title,
    repoPath: r.repo_path,
    workMode: r.work_mode as WorkMode,
    worktreePath: r.worktree_path,
    branch: r.branch,
    status: r.status as TicketStatus,
    statusManual: r.status_manual as TicketStatus | null,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

export class TicketsRepo {
  constructor(private readonly db: Db) {}

  insert(t: Ticket): void {
    this.db
      .prepare(
        `INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, status, status_manual, created_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.key, t.title, t.repoPath, t.workMode, t.worktreePath, t.branch, t.status, t.statusManual, t.createdAt, t.archivedAt);
  }

  get(key: string): Ticket | null {
    const row = this.db.prepare(`SELECT * FROM tickets WHERE key = ?`).get(key) as TicketRow | undefined;
    return row ? toTicket(row) : null;
  }

  list(opts: { includeArchived?: boolean } = {}): Ticket[] {
    const where = opts.includeArchived ? "" : "WHERE archived_at IS NULL";
    const rows = this.db.prepare(`SELECT * FROM tickets ${where} ORDER BY created_at DESC, key`).all() as unknown as TicketRow[];
    return rows.map(toTicket);
  }

  setStatusManual(key: string, status: TicketStatus | null): void {
    this.db.prepare(`UPDATE tickets SET status_manual = ? WHERE key = ?`).run(status, key);
  }

  archive(key: string, at: number): void {
    this.db.prepare(`UPDATE tickets SET archived_at = ? WHERE key = ?`).run(at, key);
  }
}
```

`src/main/db/sessions-repo.ts`:
```ts
import type { Session, SessionOrigin } from "../../shared/types";
import type { Db } from "./database";

interface SessionRow {
  id: string;
  ticket_key: string | null;
  cwd: string;
  origin: string;
  git_branch: string | null;
  first_prompt: string | null;
  last_activity_at: number | null;
  waiting_for_input: number;
  replaced_by: string | null;
  dismissed: number;
  created_at: number;
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    ticketKey: r.ticket_key,
    cwd: r.cwd,
    origin: r.origin as SessionOrigin,
    gitBranch: r.git_branch,
    firstPrompt: r.first_prompt,
    lastActivityAt: r.last_activity_at,
    waitingForInput: r.waiting_for_input === 1,
    replacedBy: r.replaced_by,
    dismissed: r.dismissed === 1,
    createdAt: r.created_at,
  };
}

export interface NewSession {
  id: string;
  ticketKey: string | null;
  cwd: string;
  origin: SessionOrigin;
  gitBranch?: string | null;
  firstPrompt?: string | null;
  lastActivityAt?: number | null;
  createdAt: number;
}

export interface SessionDetails {
  cwd?: string | null;
  gitBranch?: string | null;
  firstPrompt?: string | null;
  lastActivityAt?: number | null;
}

const RECENCY = "COALESCE(last_activity_at, created_at)";

export class SessionsRepo {
  constructor(private readonly db: Db) {}

  insertIfAbsent(s: NewSession): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, ticket_key, cwd, origin, git_branch, first_prompt, last_activity_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.ticketKey, s.cwd, s.origin, s.gitBranch ?? null, s.firstPrompt ?? null, s.lastActivityAt ?? null, s.createdAt);
    return Number(r.changes) > 0;
  }

  /** 只填补空字段；lastActivityAt 只会往后移。 */
  fillDetails(id: string, d: SessionDetails): void {
    const at = d.lastActivityAt ?? null;
    this.db
      .prepare(
        `UPDATE sessions SET
           cwd = CASE WHEN cwd = '' THEN COALESCE(?, '') ELSE cwd END,
           git_branch = COALESCE(git_branch, ?),
           first_prompt = COALESCE(first_prompt, ?),
           last_activity_at = CASE WHEN ? IS NULL THEN last_activity_at ELSE MAX(COALESCE(last_activity_at, 0), ?) END
         WHERE id = ?`,
      )
      .run(d.cwd ?? null, d.gitBranch ?? null, d.firstPrompt ?? null, at, at, id);
  }

  get(id: string): Session | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  listByTicket(ticketKey: string): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE ticket_key = ? ORDER BY ${RECENCY} DESC, id`)
      .all(ticketKey) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  listUnclaimed(sinceMs: number): Session[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE ticket_key IS NULL AND dismissed = 0 AND replaced_by IS NULL AND ${RECENCY} >= ?
         ORDER BY ${RECENCY} DESC, id`,
      )
      .all(sinceMs) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  setTicket(id: string, ticketKey: string | null): void {
    this.db.prepare(`UPDATE sessions SET ticket_key = ? WHERE id = ?`).run(ticketKey, id);
  }

  setWaiting(id: string, waiting: boolean, at: number): void {
    this.db
      .prepare(`UPDATE sessions SET waiting_for_input = ?, last_activity_at = MAX(COALESCE(last_activity_at, 0), ?) WHERE id = ?`)
      .run(waiting ? 1 : 0, at, id);
  }

  setReplacedBy(id: string, newId: string): void {
    this.db.prepare(`UPDATE sessions SET replaced_by = ? WHERE id = ?`).run(newId, id);
  }

  dismiss(id: string): void {
    this.db.prepare(`UPDATE sessions SET dismissed = 1 WHERE id = ?`).run(id);
  }

  /** 沿 replaced_by 链走到最新的 session（/clear、compact 会产生新 id）。 */
  head(id: string): Session | null {
    let cur = this.get(id);
    const seen = new Set<string>();
    while (cur?.replacedBy && !seen.has(cur.id)) {
      seen.add(cur.id);
      const next = this.get(cur.replacedBy);
      if (!next) break;
      cur = next;
    }
    return cur;
  }
}
```

`src/main/db/settings-repo.ts`:
```ts
import type { Db } from "./database";

export const SETTING_DEFAULTS = {
  branchTemplate: "feature/{key}",
  ticketPattern: "[A-Z][A-Z0-9]+-\\d+",
  claudePath: "",
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(key: SettingKey): string {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? SETTING_DEFAULTS[key];
  }

  set(key: SettingKey, value: string): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }
}
```

- [ ] **Step 9: 运行，确认通过**

Run: `pnpm vitest run src/main && pnpm typecheck`
Expected: 全部 PASS。

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add paths, sqlite migrations and ticket/session/settings repos"
```

---

### Task 3: Git 封装与 TicketService

**Files:**
- Create: `src/main/tickets/ticket-key.ts`, `src/main/tickets/ticket-key.test.ts`
- Create: `src/main/tickets/git.ts`
- Create: `src/main/tickets/ticket-service.ts`, `src/main/tickets/ticket-service.test.ts`
- Modify: `src/main/test-utils.ts`（追加 `makeRepo`）

**Interfaces:**
- Consumes: `TicketsRepo`, `SettingsRepo`, `memDb`, `tempDir`
- Produces:
  - `DEFAULT_TICKET_PATTERN`, `isValidTicketKey(key, pattern?)`, `extractTicketKey(text, pattern?): string|null`, `renderBranch(template, key)`
  - `git(cwd, args): Promise<string>`, `repoRoot`, `currentBranch`, `branchExists`, `isDirty`, `addWorktree(repo, path, branch, createBranch)`, `createBranch`, `checkout`, `GitError`
  - `TicketError(code, message)`，code ∈ `"invalid_key" | "exists" | "not_git_repo" | "worktree_exists" | "dirty" | "not_found"`
  - `TicketService { create(input): Promise<Ticket>; workDir(t): string; checkBranch(t): Promise<BranchCheck>; switchBranch(t): Promise<void> }`
  - `BranchCheck = { ok: true } | { ok: false; current; expected; dirty }`
  - `makeRepo(): string`（带一次提交、默认分支 main 的临时仓库）

- [ ] **Step 1: 写 ticket-key 的失败测试**

`src/main/tickets/ticket-key.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { extractTicketKey, isValidTicketKey, renderBranch } from "./ticket-key";

describe("ticket keys", () => {
  it("validates whole keys", () => {
    expect(isValidTicketKey("PROJ-123")).toBe(true);
    expect(isValidTicketKey("AB2-1")).toBe(true);
    expect(isValidTicketKey("proj-123")).toBe(false);
    expect(isValidTicketKey("PROJ-123x")).toBe(false);
    expect(isValidTicketKey("")).toBe(false);
  });

  it("extracts keys from branches and prose, case-insensitively, upper-cased", () => {
    expect(extractTicketKey("feature/proj-42-login")).toBe("PROJ-42");
    expect(extractTicketKey("修一下 PROJ-7 的配置")).toBe("PROJ-7");
    expect(extractTicketKey("main")).toBeNull();
    expect(extractTicketKey("bump v2-api")).toBeNull();
    expect(extractTicketKey("PROJ-77")).toBe("PROJ-77");
  });

  it("supports a custom pattern", () => {
    expect(extractTicketKey("fix #123 now", "#\\d+")).toBe("#123");
  });

  it("renders branch templates", () => {
    expect(renderBranch("feature/{key}", "PROJ-1")).toBe("feature/PROJ-1");
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/tickets/ticket-key.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 ticket-key.ts**

`src/main/tickets/ticket-key.ts`:
```ts
export const DEFAULT_TICKET_PATTERN = "[A-Z][A-Z0-9]+-\\d+";

export function isValidTicketKey(key: string, pattern = DEFAULT_TICKET_PATTERN): boolean {
  return new RegExp(`^(?:${pattern})$`).test(key);
}

export function extractTicketKey(text: string, pattern = DEFAULT_TICKET_PATTERN): string | null {
  const m = new RegExp(`(?<![A-Za-z0-9])(?:${pattern})(?![0-9])`, "i").exec(text);
  return m ? m[0].toUpperCase() : null;
}

export function renderBranch(template: string, key: string): string {
  return template.replaceAll("{key}", key);
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/tickets/ticket-key.test.ts`
Expected: PASS。

- [ ] **Step 5: 写 TicketService 的失败测试**

在 `src/main/test-utils.ts` 末尾追加：
```ts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/** 一个带初始提交、当前分支为 main 的临时 git 仓库。 */
export function makeRepo(): string {
  const dir = tempDir("butler-repo-");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  g("init", "-b", "main");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  g("add", ".");
  g("commit", "-m", "init");
  return dir;
}
```
（把新的 import 合并到文件顶部的 import 区。）

`src/main/tickets/ticket-service.test.ts`:
```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { makeRepo, memDb, tempDir } from "../test-utils";
import { branchExists, currentBranch, git } from "./git";
import { TicketError, TicketService } from "./ticket-service";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const service = new TicketService({ tickets, settings: new SettingsRepo(db), now: () => 1000 });
  return { tickets, service };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no-error";
  } catch (e) {
    return e instanceof TicketError ? e.code : `other:${(e as Error).message}`;
  }
};

describe("TicketService.create", () => {
  it("branch mode creates the branch without switching the working tree", async () => {
    const { service } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "proj-1", repoPath: repo, workMode: "branch" });
    expect(t).toMatchObject({ key: "PROJ-1", branch: "feature/PROJ-1", workMode: "branch", worktreePath: null, status: "active", createdAt: 1000 });
    expect(await branchExists(repo, "feature/PROJ-1")).toBe(true);
    expect(await currentBranch(repo)).toBe("main");
    expect(service.workDir(t)).toBe(repo);
  });

  it("worktree mode creates a sibling worktree on the ticket branch", async () => {
    const { service } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "PROJ-2", repoPath: repo, workMode: "worktree" });
    const expected = join(dirname(repo), `${basename(repo)}-worktrees`, "PROJ-2");
    expect(t.worktreePath).toBe(expected);
    expect(existsSync(join(expected, "README.md"))).toBe(true);
    expect(await currentBranch(expected)).toBe("feature/PROJ-2");
    expect(service.workDir(t)).toBe(expected);
  });

  it("worktree mode reuses an existing branch", async () => {
    const { service } = setup();
    const repo = makeRepo();
    await git(repo, ["branch", "custom/PROJ-3"]);
    const t = await service.create({ key: "PROJ-3", repoPath: repo, workMode: "worktree", branch: "custom/PROJ-3" });
    expect(await currentBranch(t.worktreePath!)).toBe("custom/PROJ-3");
  });

  it("accepts a subdirectory of the repo and stores the repo root", async () => {
    const { service } = setup();
    const repo = makeRepo();
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const t = await service.create({ key: "PROJ-4", repoPath: sub, workMode: "branch" });
    expect(t.repoPath).toBe(repo);
  });

  it("rejects invalid keys, duplicates, non-repos and existing worktree dirs", async () => {
    const { service } = setup();
    const repo = makeRepo();
    expect(await code(service.create({ key: "nope", repoPath: repo, workMode: "branch" }))).toBe("invalid_key");
    await service.create({ key: "PROJ-5", repoPath: repo, workMode: "branch" });
    expect(await code(service.create({ key: "PROJ-5", repoPath: repo, workMode: "branch" }))).toBe("exists");
    expect(await code(service.create({ key: "PROJ-6", repoPath: tempDir(), workMode: "branch" }))).toBe("not_git_repo");
    mkdirSync(join(dirname(repo), `${basename(repo)}-worktrees`, "PROJ-7"), { recursive: true });
    expect(await code(service.create({ key: "PROJ-7", repoPath: repo, workMode: "worktree" }))).toBe("worktree_exists");
  });
});

describe("TicketService branch checks", () => {
  it("reports mismatch with dirty flag and refuses to switch a dirty tree", async () => {
    const { service } = setup();
    const repo = makeRepo();
    const t = await service.create({ key: "PROJ-8", repoPath: repo, workMode: "branch" });
    expect(await service.checkBranch(t)).toEqual({ ok: false, current: "main", expected: "feature/PROJ-8", dirty: false });

    writeFileSync(join(repo, "README.md"), "changed\n");
    expect(await service.checkBranch(t)).toEqual({ ok: false, current: "main", expected: "feature/PROJ-8", dirty: true });
    expect(await code(service.switchBranch(t))).toBe("dirty");

    await git(repo, ["checkout", "--", "README.md"]);
    await service.switchBranch(t);
    expect(await service.checkBranch(t)).toEqual({ ok: true });
  });

  it("worktree tickets always pass the check", async () => {
    const { service } = setup();
    const t = await service.create({ key: "PROJ-9", repoPath: makeRepo(), workMode: "worktree" });
    expect(await service.checkBranch(t)).toEqual({ ok: true });
  });
});
```

- [ ] **Step 6: 运行，确认失败**

Run: `pnpm vitest run src/main/tickets`
Expected: FAIL，找不到 `./git`、`./ticket-service`。

- [ ] **Step 7: 实现 git.ts 和 ticket-service.ts**

`src/main/tickets/git.ts`:
```ts
import { execFile } from "node:child_process";
import { resolve } from "node:path";

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new GitError(`git ${args.join(" ")} failed: ${String(stderr).trim() || err.message}`, String(stderr)));
      else done(String(stdout).trim());
    });
  });
}

/** git 在 Windows 上返回正斜杠路径，resolve 统一成本平台格式。 */
export async function repoRoot(dir: string): Promise<string> {
  return resolve(await git(dir, ["rev-parse", "--show-toplevel"]));
}

export function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ["status", "--porcelain"])).length > 0;
}

export async function addWorktree(repo: string, path: string, branch: string, createBranch: boolean): Promise<void> {
  await git(repo, createBranch ? ["worktree", "add", "-b", branch, path] : ["worktree", "add", path, branch]);
}

export async function createBranch(cwd: string, branch: string): Promise<void> {
  await git(cwd, ["branch", branch]);
}

export async function checkout(cwd: string, branch: string): Promise<void> {
  await git(cwd, ["checkout", branch]);
}
```

`src/main/tickets/ticket-service.ts`:
```ts
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CreateTicketInput, Ticket } from "../../shared/types";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { addWorktree, branchExists, checkout, createBranch, currentBranch, isDirty, repoRoot } from "./git";
import { isValidTicketKey, renderBranch } from "./ticket-key";

export type TicketErrorCode = "invalid_key" | "exists" | "not_git_repo" | "worktree_exists" | "dirty" | "not_found";

export class TicketError extends Error {
  constructor(readonly code: TicketErrorCode, message: string) {
    super(message);
  }
}

export type BranchCheck = { ok: true } | { ok: false; current: string; expected: string; dirty: boolean };

export interface TicketServiceDeps {
  tickets: TicketsRepo;
  settings: SettingsRepo;
  now: () => number;
}

export class TicketService {
  constructor(private readonly d: TicketServiceDeps) {}

  async create(input: CreateTicketInput): Promise<Ticket> {
    const key = input.key.trim().toUpperCase();
    if (!isValidTicketKey(key, this.d.settings.get("ticketPattern"))) throw new TicketError("invalid_key", `ticket 号格式不对：${input.key}`);
    if (this.d.tickets.get(key)) throw new TicketError("exists", `ticket ${key} 已经存在`);

    let root: string;
    try {
      root = await repoRoot(input.repoPath);
    } catch {
      throw new TicketError("not_git_repo", `${input.repoPath} 不是 git 仓库`);
    }

    const branch = input.branch?.trim() || renderBranch(this.d.settings.get("branchTemplate"), key);
    let worktreePath: string | null = null;
    if (input.workMode === "worktree") {
      worktreePath = join(dirname(root), `${basename(root)}-worktrees`, key);
      if (existsSync(worktreePath)) throw new TicketError("worktree_exists", `目录已存在：${worktreePath}`);
      await addWorktree(root, worktreePath, branch, !(await branchExists(root, branch)));
    } else if (!(await branchExists(root, branch))) {
      await createBranch(root, branch);
    }

    const ticket: Ticket = {
      key,
      title: input.title?.trim() || null,
      repoPath: root,
      workMode: input.workMode,
      worktreePath,
      branch,
      status: "active",
      statusManual: null,
      createdAt: this.d.now(),
      archivedAt: null,
    };
    this.d.tickets.insert(ticket);
    return ticket;
  }

  workDir(t: Ticket): string {
    return t.worktreePath ?? t.repoPath;
  }

  async checkBranch(t: Ticket): Promise<BranchCheck> {
    if (t.workMode === "worktree") return { ok: true };
    const current = await currentBranch(t.repoPath);
    if (current === t.branch) return { ok: true };
    return { ok: false, current, expected: t.branch, dirty: await isDirty(t.repoPath) };
  }

  async switchBranch(t: Ticket): Promise<void> {
    if (await isDirty(t.repoPath)) throw new TicketError("dirty", "工作区有未提交的改动，不会自动切换分支");
    await checkout(t.repoPath, t.branch);
  }
}
```

- [ ] **Step 8: 运行，确认通过**

Run: `pnpm vitest run src/main/tickets && pnpm typecheck`
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add git helpers and TicketService with worktree/branch modes"
```

---

### Task 4: 定位 claude 与能力探测

**Files:**
- Create: `src/main/util/exec.ts`, `src/main/util/env.ts`, `src/main/util/env.test.ts`
- Create: `src/main/claude/locate.ts`, `src/main/claude/locate.test.ts`
- Create: `src/main/claude/capabilities.ts`, `src/main/claude/capabilities.test.ts`

**Interfaces:**
- Consumes: `ClaudeHealth`（shared/types）
- Produces:
  - `ExecText = (file, args, opts?: { timeoutMs?; env?; cwd? }) => Promise<string>`，`execText`
  - `pathKey(env): string`、`withPath(env, value)`
  - `readLoginShellPath(platform, env, run?): Promise<string>`
  - `findOnPath(name, pathValue, platform, pathext?, exists?): string|null`
  - `locateClaude({ override, pathValue, platform, exists?, pathext? }): string|null`
  - `REQUIRED_FLAGS`、`parseVersion(out)`、`parseFlags(help)`、`probeClaude(path, env, run?): Promise<ClaudeHealth>`

- [ ] **Step 1: 写失败测试**

`src/main/util/env.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { pathKey, withPath } from "./env";

describe("PATH helpers", () => {
  it("finds the PATH key case-insensitively", () => {
    expect(pathKey({ Path: "a" })).toBe("Path");
    expect(pathKey({ PATH: "a" })).toBe("PATH");
    expect(pathKey({})).toBe("PATH");
  });

  it("replaces PATH without duplicating keys", () => {
    expect(withPath({ Path: "a", X: "1" }, "b")).toEqual({ Path: "b", X: "1" });
  });
});
```

`src/main/claude/locate.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { findOnPath, locateClaude, readLoginShellPath } from "./locate";

describe("readLoginShellPath", () => {
  it("extracts PATH between markers, ignoring shell noise", async () => {
    const run = async () => "Welcome!\n__BUTLER_PATH_START__/opt/bin:/usr/bin__BUTLER_PATH_END__\n";
    expect(await readLoginShellPath("darwin", { SHELL: "/bin/zsh", PATH: "/usr/bin" }, run)).toBe("/opt/bin:/usr/bin");
  });

  it("falls back to the process PATH when the shell fails or prints no markers", async () => {
    expect(await readLoginShellPath("darwin", { PATH: "/usr/bin" }, async () => { throw new Error("boom"); })).toBe("/usr/bin");
    expect(await readLoginShellPath("darwin", { PATH: "/usr/bin" }, async () => "nothing")).toBe("/usr/bin");
  });

  it("uses the inherited PATH on Windows", async () => {
    expect(await readLoginShellPath("win32", { Path: "C:\\bin" }, async () => "unused")).toBe("C:\\bin");
  });
});

describe("findOnPath / locateClaude", () => {
  it("finds a posix binary", () => {
    const exists = (p: string) => p === "/opt/bin/claude";
    expect(findOnPath("claude", "/usr/bin:/opt/bin", "darwin", undefined, exists)).toBe("/opt/bin/claude");
  });

  it("searches PATH in order and prefers .exe within a directory on Windows", () => {
    const exists = (p: string) => p === "C:\\npm\\claude.cmd" || p === "C:\\tools\\claude.exe";
    expect(findOnPath("claude", "C:\\npm;C:\\tools", "win32", ".EXE;.CMD", exists)).toBe("C:\\npm\\claude.cmd");
    expect(findOnPath("claude", "C:\\tools;C:\\npm", "win32", ".EXE;.CMD", exists)).toBe("C:\\tools\\claude.exe");
  });

  it("uses an existing override and rejects a missing one", () => {
    expect(locateClaude({ override: "/x/claude", pathValue: "", platform: "darwin", exists: () => true })).toBe("/x/claude");
    expect(locateClaude({ override: "/x/claude", pathValue: "/opt/bin", platform: "darwin", exists: () => false })).toBeNull();
  });
});
```

`src/main/claude/capabilities.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseFlags, parseVersion, probeClaude, REQUIRED_FLAGS } from "./capabilities";

const HELP = `
  -p, --print                           Print response and exit
  -r, --resume [value]                  Resume a conversation
  --session-id <uuid>                   Use a specific session ID
  --fork-session                        When resuming, create a new session ID
  --mcp-config <configs...>             Load MCP servers
  --output-format <format>              Output format
  --json-schema <schema>                JSON Schema for structured output
  --allowedTools, --allowed-tools <tools...>
`;

describe("capabilities", () => {
  it("parses the version", () => {
    expect(parseVersion("2.1.304 (Claude Code)\n")).toBe("2.1.304");
    expect(parseVersion("garbage")).toBeNull();
  });

  it("detects every required flag in real help text", () => {
    const flags = parseFlags(HELP);
    expect(REQUIRED_FLAGS.every((f) => flags[f])).toBe(true);
  });

  it("does not match a flag that is only a prefix of another", () => {
    expect(parseFlags("  --resume-later   nope")["--resume"]).toBe(false);
  });

  it("probe reports missing flags and errors", async () => {
    const run = async (_f: string, args: string[]) => (args[0] === "--version" ? "2.0.0" : "  -p, --print  x\n");
    const h = await probeClaude("/bin/claude", {}, run);
    expect(h.version).toBe("2.0.0");
    expect(h.missingFlags).toContain("--fork-session");
    expect(h.missingFlags).not.toContain("--print");

    const failed = await probeClaude("/bin/claude", {}, async () => { throw new Error("not executable"); });
    expect(failed.error).toContain("not executable");
    expect(await probeClaude(null, {})).toMatchObject({ path: null, error: "claude_not_found" });
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/util src/main/claude`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现**

`src/main/util/exec.ts`:
```ts
import { execFile } from "node:child_process";

export interface ExecOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type ExecText = (file: string, args: string[], opts?: ExecOptions) => Promise<string>;

/** Node 不允许不经 shell 直接执行 Windows 的 .cmd/.bat（npm 安装的 claude 就是 claude.cmd）。 */
export const execText: ExecText = (file, args, opts = {}) =>
  new Promise((done, fail) => {
    const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    execFile(
      viaShell ? `"${file}"` : file,
      args,
      { shell: viaShell, timeout: opts.timeoutMs ?? 10_000, env: opts.env, cwd: opts.cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) fail(new Error(`${file} ${args.join(" ")} failed: ${String(stderr).trim() || err.message}`));
        else done(String(stdout));
      },
    );
  });
```

`src/main/util/env.ts`:
```ts
type Env = Record<string, string | undefined>;

/** Windows 的环境变量名不区分大小写，通常是 "Path"。 */
export function pathKey(env: Env): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

export function withPath<T extends Env>(env: T, value: string): T {
  return { ...env, [pathKey(env)]: value };
}
```

`src/main/claude/locate.ts`:
```ts
import { existsSync } from "node:fs";
import path from "node:path";
import { execText, type ExecText } from "../util/exec";
import { pathKey } from "../util/env";

const START = "__BUTLER_PATH_START__";
const END = "__BUTLER_PATH_END__";

/** 从 Finder/开始菜单启动的 GUI 应用拿不到用户 shell 配置里的 PATH，所以要问登录 shell。 */
export async function readLoginShellPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, run: ExecText = execText): Promise<string> {
  const fallback = env[pathKey(env)] ?? "";
  if (platform === "win32") return fallback;
  try {
    const out = await run(env.SHELL || "/bin/zsh", ["-ilc", `printf '%s%s%s' '${START}' "$PATH" '${END}'`], { timeoutMs: 5000 });
    const s = out.indexOf(START);
    const e = out.indexOf(END, s);
    return s === -1 || e === -1 ? fallback : out.slice(s + START.length, e);
  } catch {
    return fallback;
  }
}

export function findOnPath(
  name: string,
  pathValue: string,
  platform: NodeJS.Platform,
  pathext = ".EXE;.CMD;.BAT",
  exists: (p: string) => boolean = existsSync,
): string | null {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const names = platform === "win32" ? pathext.split(";").filter(Boolean).map((ext) => name + ext.toLowerCase()) : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = p.join(dir, n);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function locateClaude(opts: {
  override: string;
  pathValue: string;
  platform: NodeJS.Platform;
  exists?: (p: string) => boolean;
  pathext?: string;
}): string | null {
  const exists = opts.exists ?? existsSync;
  const override = opts.override.trim();
  if (override) return exists(override) ? override : null;
  return findOnPath("claude", opts.pathValue, opts.platform, opts.pathext, exists);
}
```

`src/main/claude/capabilities.ts`:
```ts
import type { ClaudeHealth } from "../../shared/types";
import { execText, type ExecText } from "../util/exec";

/** Butler 依赖的 Claude Code 参数；缺任何一个都要在设置页报警。 */
export const REQUIRED_FLAGS = [
  "--print",
  "--session-id",
  "--resume",
  "--fork-session",
  "--mcp-config",
  "--output-format",
  "--json-schema",
  "--allowedTools",
] as const;

export function parseVersion(out: string): string | null {
  return /\d+\.\d+\.\d+/.exec(out)?.[0] ?? null;
}

export function parseFlags(help: string): Record<string, boolean> {
  return Object.fromEntries(REQUIRED_FLAGS.map((f) => [f, new RegExp(`(^|[\\s,])${f}(?![\\w-])`, "m").test(help)]));
}

export async function probeClaude(claudePath: string | null, env: NodeJS.ProcessEnv, run: ExecText = execText): Promise<ClaudeHealth> {
  const none = Object.fromEntries(REQUIRED_FLAGS.map((f) => [f, false]));
  if (!claudePath) return { path: null, version: null, flags: none, missingFlags: [...REQUIRED_FLAGS], error: "claude_not_found" };
  try {
    const [version, help] = await Promise.all([
      run(claudePath, ["--version"], { env, timeoutMs: 15_000 }),
      run(claudePath, ["--help"], { env, timeoutMs: 15_000 }),
    ]);
    const flags = parseFlags(help);
    return { path: claudePath, version: parseVersion(version), flags, missingFlags: REQUIRED_FLAGS.filter((f) => !flags[f]), error: null };
  } catch (e) {
    return { path: claudePath, version: null, flags: none, missingFlags: [...REQUIRED_FLAGS], error: (e as Error).message };
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/util src/main/claude && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 用真实的 claude 做一次手动核对**

Run: `CLAUDE_BIN="$(command -v claude)" pnpm dlx tsx@4 -e 'import("./src/main/claude/capabilities.ts").then(async (m) => console.log(await m.probeClaude(process.env.CLAUDE_BIN ?? null, process.env)))'`
Expected: `missingFlags: []`，`version` 是本机版本。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: locate claude via login-shell PATH and probe required flags"
```

---

### Task 5: butler-hook 程序与 SEA 打包

**Files:**
- Create: `src/shared/hook-envelope.ts`
- Create: `hook/butler-hook.ts`, `hook/butler-hook.test.ts`, `hook/entry.ts`
- Create: `scripts/build-hook.mjs`

**Interfaces:**
- Produces:
  - `HookEnvelope { v: 1; receivedAt; ticket: string|null; butlerSession: string|null; payload: unknown; parseError?; raw? }`
  - `parseEnvelope(text): HookEnvelope | null`
  - `buildEnvelope(raw, env, now)`、`inboxDir(env, home?)`、`writeEnvelope(dir, envelope): string`、`main(): Promise<void>`
  - 构建产物：`build/hook/butler-hook`（Windows 为 `butler-hook.exe`）

- [ ] **Step 1: 写失败测试**

`hook/butler-hook.test.ts`:
```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/shared/hook-envelope";
import { tempDir } from "../src/main/test-utils";
import { buildEnvelope, inboxDir, writeEnvelope } from "./butler-hook";

describe("butler-hook", () => {
  it("wraps valid JSON with ticket and session from env", () => {
    const env = buildEnvelope('{"hook_event_name":"Stop","session_id":"s1"}', { BUTLER_TICKET: "PROJ-1", BUTLER_SESSION: "s0" }, 42);
    expect(env).toEqual({ v: 1, receivedAt: 42, ticket: "PROJ-1", butlerSession: "s0", payload: { hook_event_name: "Stop", session_id: "s1" } });
  });

  it("keeps a truncated raw copy when stdin is not JSON", () => {
    const env = buildEnvelope("x".repeat(20_000), { BUTLER_TICKET: "  " }, 1);
    expect(env.payload).toBeNull();
    expect(env.ticket).toBeNull();
    expect(env.parseError).toBeTruthy();
    expect(env.raw).toHaveLength(10_000);
  });

  it("writes atomically into the inbox and round-trips through parseEnvelope", () => {
    const dir = join(tempDir(), "inbox");
    const env = buildEnvelope('{"a":1}', {}, 1234567890123);
    const file = writeEnvelope(dir, env);
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^1234567890123-\d+-[0-9a-f]+\.json$/);
    expect(parseEnvelope(readFileSync(file, "utf8"))).toEqual(env);
  });

  it("resolves the inbox from BUTLER_HOME or the home directory", () => {
    expect(inboxDir({ BUTLER_HOME: "/b" }, "/h")).toBe(join("/b", "inbox"));
    expect(inboxDir({}, "/h")).toBe(join("/h", ".butler", "inbox"));
  });

  it("parseEnvelope rejects foreign JSON", () => {
    expect(parseEnvelope('{"v":2}')).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run hook`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现**

`src/shared/hook-envelope.ts`:
```ts
export interface HookEnvelope {
  v: 1;
  receivedAt: number;
  /** Butler 启动 claude 时注入的 BUTLER_TICKET。 */
  ticket: string | null;
  /** Butler 启动 claude 时注入的 BUTLER_SESSION（启动该终端时用的 session id，/clear 后不变）。 */
  butlerSession: string | null;
  /** Claude Code 通过 stdin 传给 hook 的 JSON。 */
  payload: unknown;
  parseError?: string;
  raw?: string;
}

export function parseEnvelope(text: string): HookEnvelope | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || v.v !== 1 || typeof v.receivedAt !== "number") return null;
  return {
    v: 1,
    receivedAt: v.receivedAt,
    ticket: typeof v.ticket === "string" ? v.ticket : null,
    butlerSession: typeof v.butlerSession === "string" ? v.butlerSession : null,
    payload: v.payload ?? null,
    ...(typeof v.parseError === "string" ? { parseError: v.parseError } : {}),
    ...(typeof v.raw === "string" ? { raw: v.raw } : {}),
  };
}
```

`hook/butler-hook.ts`:
```ts
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HookEnvelope } from "../src/shared/hook-envelope";

const RAW_LIMIT = 10_000;

export function buildEnvelope(raw: string, env: NodeJS.ProcessEnv, now: number): HookEnvelope {
  const ticket = env.BUTLER_TICKET?.trim() || null;
  const butlerSession = env.BUTLER_SESSION?.trim() || null;
  try {
    return { v: 1, receivedAt: now, ticket, butlerSession, payload: JSON.parse(raw) };
  } catch (e) {
    return { v: 1, receivedAt: now, ticket, butlerSession, payload: null, parseError: (e as Error).message, raw: raw.slice(0, RAW_LIMIT) };
  }
}

export function inboxDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return join(env.BUTLER_HOME?.trim() || join(home, ".butler"), "inbox");
}

/** 先写 .tmp 再 rename，读取方永远看不到写了一半的文件。文件名以时间戳开头，按名字排序即按时间排序。 */
export function writeEnvelope(dir: string, envelope: HookEnvelope): string {
  mkdirSync(dir, { recursive: true });
  const name = `${envelope.receivedAt}-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  const tmp = join(dir, `${name}.tmp`);
  const file = join(dir, name);
  writeFileSync(tmp, JSON.stringify(envelope));
  renameSync(tmp, file);
  return file;
}

function readStdin(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

export async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    writeEnvelope(inboxDir(process.env), buildEnvelope(raw, process.env, Date.now()));
  } catch {
    // 绝不阻塞 Claude Code：任何错误都静默吞掉。
  }
}
```

`hook/entry.ts`:
```ts
import { main } from "./butler-hook";

void main().finally(() => process.exit(0));
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run hook && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 写 SEA 构建脚本**

`scripts/build-hook.mjs`:
```js
// 把 hook 打成不依赖系统 Node 的单文件可执行程序（Node SEA）。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const outDir = "build/hook";
const bundle = `${outDir}/butler-hook.cjs`;
const exe = process.platform === "win32" ? `${outDir}/butler-hook.exe` : `${outDir}/butler-hook`;
mkdirSync(outDir, { recursive: true });

await build({ entryPoints: ["hook/entry.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: bundle });

const config = `${outDir}/sea-config.json`;
writeFileSync(config, JSON.stringify({ main: bundle, output: exe, disableExperimentalSEAWarning: true, useCodeCache: false }));
execFileSync(process.execPath, ["--build-sea", config], { stdio: "inherit" });

if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", "--force", exe], { stdio: "inherit" });
console.log(`built ${exe}`);
```

- [ ] **Step 6: 构建并验证真实二进制**

Run:
```bash
pnpm build:hook
TMP_HOME="$(mktemp -d)"
echo '{"hook_event_name":"Stop","session_id":"abc"}' | BUTLER_HOME="$TMP_HOME" BUTLER_TICKET=PROJ-1 ./build/hook/butler-hook; echo "exit=$?"
cat "$TMP_HOME"/inbox/*.json
```
Expected: `exit=0`；JSON 中有 `"ticket":"PROJ-1"` 和 `"payload":{"hook_event_name":"Stop","session_id":"abc"}`。

如果 `node --build-sea` 报“不认识的配置项”或参数错误（说明本机 Node 的 SEA 接口不同），改用经典流程：把 `sea-config.json` 的 `output` 改为 `build/hook/sea-prep.blob`，执行 `node --experimental-sea-config build/hook/sea-config.json`；复制 `process.execPath` 到目标 exe；macOS 上先 `codesign --remove-signature`；然后执行 `pnpm dlx postject@1.0.0-alpha.6 <exe> NODE_SEA_BLOB build/hook/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`（macOS 再加 `--macho-segment-name NODE_SEA`），最后重新 ad-hoc 签名。按实际可行的方式更新 `build-hook.mjs`。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add butler-hook single-executable that writes hook events to the inbox"
```

---

### Task 6: Hook 安装器与 HealthService

**Files:**
- Create: `src/main/hooks/installer.ts`, `src/main/hooks/installer.test.ts`
- Create: `src/main/hooks/health.ts`, `src/main/hooks/health.test.ts`

**Interfaces:**
- Consumes: `ButlerPaths`, `SettingsRepo`, `readLoginShellPath`, `locateClaude`, `probeClaude`, `withPath`, `ExecText`, `HookStatus`, `HealthReport`
- Produces:
  - `HOOK_EVENTS`、`hookCommand(hookBin, platform)`、`isButlerHook(cmd)`、`applyInstall(settings, command)`、`applyUninstall(settings)`、`hookStatus(settings, command)`
  - `SettingsParseError`、`readSettings(file)`、`writeSettingsAtomic(file, data)`、`installHooks(settingsFile, hookBin, platform)`、`uninstallHooks(settingsFile)`、`installHookBinary(src, dest)`
  - `HealthService { refresh(): Promise<HealthReport>; claude(): { path: string|null; pathValue: string }; installHooks(): Promise<HealthReport>; uninstallHooks(): Promise<HealthReport> }`

- [ ] **Step 1: 写安装器的失败测试**

`src/main/hooks/installer.test.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import {
  applyInstall, applyUninstall, HOOK_EVENTS, hookCommand, hookStatus, installHooks, readSettings,
  SettingsParseError, uninstallHooks,
} from "./installer";

const CMD = hookCommand("/Users/张 三/.butler/bin/butler-hook", "darwin");
const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };

describe("hookCommand", () => {
  it("quotes paths with spaces and non-ASCII characters", () => {
    expect(CMD).toBe('"/Users/张 三/.butler/bin/butler-hook"');
  });

  it("uses forward slashes on Windows", () => {
    expect(hookCommand("C:\\Users\\张 三\\.butler\\bin\\butler-hook.exe", "win32")).toBe('"C:/Users/张 三/.butler/bin/butler-hook.exe"');
  });
});

describe("applyInstall / applyUninstall", () => {
  it("adds one Butler hook per event and keeps unrelated settings", () => {
    const before = { model: "opus", permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [userHook] } };
    const after = applyInstall(before, CMD);
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash(ls)"] });
    const hooks = after.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toEqual([userHook, { hooks: [{ type: "command", command: CMD, timeout: 10 }] }]);
    for (const e of HOOK_EVENTS) expect(hooks[e]).toBeDefined();
    expect(hookStatus(after, CMD)).toBe("installed");
    expect(before.hooks.Stop).toEqual([userHook]);
  });

  it("is idempotent", () => {
    const once = applyInstall({}, CMD);
    expect(applyInstall(once, CMD)).toEqual(once);
  });

  it("detects a stale command after the binary moved, and reinstall replaces it", () => {
    const old = applyInstall({}, hookCommand("/old/butler-hook", "darwin"));
    expect(hookStatus(old, CMD)).toBe("stale");
    expect(hookStatus(applyInstall(old, CMD), CMD)).toBe("installed");
  });

  it("reports partial and missing", () => {
    const full = applyInstall({}, CMD) as { hooks: Record<string, unknown> };
    delete full.hooks.Stop;
    expect(hookStatus(full, CMD)).toBe("partial");
    expect(hookStatus({ hooks: { Stop: [userHook] } }, CMD)).toBe("missing");
  });

  it("uninstall removes only Butler entries and cleans up empty containers", () => {
    const installed = applyInstall({ hooks: { Stop: [userHook] } }, CMD);
    expect(applyUninstall(installed)).toEqual({ hooks: { Stop: [userHook] } });
    expect(applyUninstall(applyInstall({}, CMD))).toEqual({});
  });
});

describe("settings file IO", () => {
  it("creates settings.json, backs up the original once, and uninstalls", async () => {
    const dir = tempDir();
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ model: "opus" }));
    await installHooks(file, "/b/butler-hook", "darwin");
    expect(JSON.parse(readFileSync(`${file}.butler-backup`, "utf8"))).toEqual({ model: "opus" });
    expect(hookStatus(await readSettings(file), hookCommand("/b/butler-hook", "darwin"))).toBe("installed");
    await installHooks(file, "/b/butler-hook", "darwin");
    expect(JSON.parse(readFileSync(`${file}.butler-backup`, "utf8"))).toEqual({ model: "opus" });
    await uninstallHooks(file);
    expect(await readSettings(file)).toEqual({ model: "opus" });
  });

  it("treats a missing file as empty", async () => {
    const file = join(tempDir(), "nested", "settings.json");
    expect(await readSettings(file)).toEqual({});
    await installHooks(file, "/b/butler-hook", "darwin");
    expect(existsSync(file)).toBe(true);
  });

  it("refuses to touch a malformed settings.json", async () => {
    const file = join(tempDir(), "settings.json");
    writeFileSync(file, "{ not json");
    await expect(installHooks(file, "/b/butler-hook", "darwin")).rejects.toBeInstanceOf(SettingsParseError);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/hooks/installer.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 installer.ts**

`src/main/hooks/installer.ts`:
```ts
import { access, chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HookStatus } from "../../shared/types";

export const HOOK_EVENTS = ["SessionStart", "Stop", "UserPromptSubmit", "SessionEnd"] as const;

type Json = Record<string, unknown>;
interface HookEntry {
  type?: string;
  command?: unknown;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}

export class SettingsParseError extends Error {}

/** 正斜杠 + 双引号：cmd、PowerShell、bash 都能执行，路径里有空格或中文也没问题。 */
export function hookCommand(hookBin: string, platform: NodeJS.Platform): string {
  const p = platform === "win32" ? hookBin.replace(/\\/g, "/") : hookBin;
  return `"${p.replace(/"/g, '\\"')}"`;
}

export function isButlerHook(command: unknown): boolean {
  return typeof command === "string" && /butler-hook(\.exe)?"?\s*$/.test(command);
}

function hookObject(settings: Json): Record<string, unknown> | null {
  const h = settings.hooks;
  return h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>) : null;
}

function butlerCommands(settings: Json, event: string): unknown[] {
  const groups = hookObject(settings)?.[event];
  if (!Array.isArray(groups)) return [];
  return (groups as HookGroup[]).flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : [])).map((h) => h.command).filter(isButlerHook);
}

export function applyUninstall(settings: Json): Json {
  const next = structuredClone(settings);
  const hooks = hookObject(next);
  if (!hooks) return next;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = (groups as HookGroup[]).flatMap((g) => {
      if (!Array.isArray(g.hooks)) return [g];
      const remaining = g.hooks.filter((h) => !isButlerHook(h.command));
      if (remaining.length === g.hooks.length) return [g];
      return remaining.length ? [{ ...g, hooks: remaining }] : [];
    });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

export function applyInstall(settings: Json, command: string): Json {
  const next = applyUninstall(settings);
  const hooks = hookObject(next) ?? {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    hooks[event] = [...groups, { hooks: [{ type: "command", command, timeout: 10 }] }];
  }
  next.hooks = hooks;
  return next;
}

export function hookStatus(settings: Json, command: string): HookStatus {
  const perEvent = HOOK_EVENTS.map((e) => butlerCommands(settings, e));
  if (perEvent.every((cmds) => cmds.length === 1 && cmds[0] === command)) return "installed";
  if (perEvent.every((cmds) => cmds.length === 0)) return "missing";
  return perEvent.some((cmds) => cmds.some((c) => c !== command)) ? "stale" : "partial";
}

export async function readSettings(file: string): Promise<Json> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Json;
  } catch {
    // 落到下面统一报错
  }
  throw new SettingsParseError(`${file} 不是合法的 JSON 对象，Butler 不会修改它`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function writeSettingsAtomic(file: string, data: Json): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const backup = `${file}.butler-backup`;
  if ((await exists(file)) && !(await exists(backup))) await copyFile(file, backup);
  const tmp = `${file}.butler-tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export async function installHooks(settingsFile: string, hookBin: string, platform: NodeJS.Platform): Promise<void> {
  const settings = await readSettings(settingsFile);
  await writeSettingsAtomic(settingsFile, applyInstall(settings, hookCommand(hookBin, platform)));
}

export async function uninstallHooks(settingsFile: string): Promise<void> {
  const settings = await readSettings(settingsFile);
  if (!settings.hooks) return;
  await writeSettingsAtomic(settingsFile, applyUninstall(settings));
}

export async function installHookBinary(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await copyFile(src, tmp);
  await chmod(tmp, 0o755);
  await rename(tmp, dest);
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/hooks/installer.test.ts`
Expected: PASS。

- [ ] **Step 5: 写 HealthService 的失败测试**

`src/main/hooks/health.test.ts`:
```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import { resolvePaths } from "../paths";
import { memDb, tempDir } from "../test-utils";
import { HealthService } from "./health";

describe("HealthService", () => {
  it("reports claude, installs hooks + binary, and detects invalid settings", async () => {
    const home = tempDir();
    const paths = resolvePaths({ BUTLER_HOME: join(home, ".butler"), CLAUDE_CONFIG_DIR: join(home, ".claude") }, "darwin", home);
    const fakeClaude = join(home, "claude");
    writeFileSync(fakeClaude, "");
    const bundled = join(home, "bundled-hook");
    writeFileSync(bundled, "#!/bin/sh\n");
    const settings = new SettingsRepo(memDb());
    settings.set("claudePath", fakeClaude);
    const run = async (_f: string, args: string[]) => (args[0] === "--version" ? "2.1.304" : "--print --session-id --resume --fork-session --mcp-config --output-format --json-schema --allowedTools");
    const health = new HealthService({ paths, platform: "darwin", env: {}, settings, bundledHookBin: bundled, readPath: async () => "/usr/bin", run });

    const first = await health.refresh();
    expect(first.claude).toMatchObject({ path: fakeClaude, version: "2.1.304", missingFlags: [] });
    expect(first.hooks).toBe("missing");
    expect(first.hookBinInstalled).toBe(false);
    expect(health.claude()).toEqual({ path: fakeClaude, pathValue: "/usr/bin" });

    const installed = await health.installHooks();
    expect(installed.hooks).toBe("installed");
    expect(installed.hookBinInstalled).toBe(true);

    expect((await health.uninstallHooks()).hooks).toBe("missing");

    writeFileSync(paths.claudeSettings, "{oops");
    expect((await health.refresh()).hooks).toBe("settings_invalid");
  });
});
```

- [ ] **Step 6: 运行，确认失败**

Run: `pnpm vitest run src/main/hooks/health.test.ts`
Expected: FAIL，找不到 `./health`。

- [ ] **Step 7: 实现 health.ts**

`src/main/hooks/health.ts`:
```ts
import { existsSync } from "node:fs";
import type { HealthReport, HookStatus } from "../../shared/types";
import { probeClaude } from "../claude/capabilities";
import { locateClaude, readLoginShellPath } from "../claude/locate";
import type { SettingsRepo } from "../db/settings-repo";
import type { ButlerPaths } from "../paths";
import type { ExecText } from "../util/exec";
import { withPath } from "../util/env";
import { hookCommand, hookStatus, installHookBinary, installHooks, readSettings, SettingsParseError, uninstallHooks } from "./installer";

export interface HealthDeps {
  paths: ButlerPaths;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  settings: SettingsRepo;
  /** 随 app 一起分发的 butler-hook，安装时复制到 paths.hookBin。 */
  bundledHookBin: string;
  readPath?: () => Promise<string>;
  run?: ExecText;
}

export class HealthService {
  private state: { path: string | null; pathValue: string } = { path: null, pathValue: "" };

  constructor(private readonly d: HealthDeps) {}

  /** 最近一次 refresh 得到的 claude 路径和登录 shell 的 PATH。 */
  claude(): { path: string | null; pathValue: string } {
    return this.state;
  }

  async refresh(): Promise<HealthReport> {
    const pathValue = await (this.d.readPath ?? (() => readLoginShellPath(this.d.platform, this.d.env)))();
    const path = locateClaude({ override: this.d.settings.get("claudePath"), pathValue, platform: this.d.platform });
    const claude = await probeClaude(path, withPath(this.d.env, pathValue), this.d.run);
    this.state = { path, pathValue };

    let hooks: HookStatus;
    try {
      hooks = hookStatus(await readSettings(this.d.paths.claudeSettings), hookCommand(this.d.paths.hookBin, this.d.platform));
    } catch (e) {
      if (!(e instanceof SettingsParseError)) throw e;
      hooks = "settings_invalid";
    }
    return {
      claude,
      hooks,
      hookBinInstalled: existsSync(this.d.paths.hookBin),
      butlerHome: this.d.paths.home,
      claudeSettingsPath: this.d.paths.claudeSettings,
    };
  }

  async installHooks(): Promise<HealthReport> {
    await installHookBinary(this.d.bundledHookBin, this.d.paths.hookBin);
    await installHooks(this.d.paths.claudeSettings, this.d.paths.hookBin, this.d.platform);
    return this.refresh();
  }

  async uninstallHooks(): Promise<HealthReport> {
    await uninstallHooks(this.d.paths.claudeSettings);
    return this.refresh();
  }
}
```

- [ ] **Step 8: 运行，确认通过**

Run: `pnpm vitest run src/main/hooks && pnpm typecheck`
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: merge-safe Claude Code hook installer and HealthService"
```

---

### Task 7: Hook 事件处理与 inbox 监听

**Files:**
- Create: `src/main/hooks/hook-events.ts`, `src/main/hooks/hook-events.test.ts`
- Create: `src/main/hooks/inbox.ts`, `src/main/hooks/inbox.test.ts`

**Interfaces:**
- Consumes: `HookEnvelope`, `parseEnvelope`, `SessionsRepo`, `TicketsRepo`
- Produces:
  - `HookEffect = { kind: "session_started"; sessionId; ticketKey; replaced: string|null } | { kind: "waiting"; sessionId; waiting: boolean } | { kind: "ended"; sessionId } | { kind: "ignored"; reason }`
  - `applyHookEnvelope(env, { sessions, tickets }): HookEffect`
  - `HookInbox { constructor({ dir, badDir, handle, intervalMs?, log? }); drain(): Promise<number>; start(); stop() }`

- [ ] **Step 1: 写失败测试**

`src/main/hooks/hook-events.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb } from "../test-utils";
import { applyHookEnvelope } from "./hook-events";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "PROJ-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const sessions = new SessionsRepo(db);
  return { sessions, tickets, deps: { sessions, tickets } };
}

const env = (event: string, sessionId: string, over: Partial<HookEnvelope> = {}, payload: Record<string, unknown> = {}): HookEnvelope => ({
  v: 1, receivedAt: 100, ticket: null, butlerSession: null,
  payload: { hook_event_name: event, session_id: sessionId, cwd: "/w", ...payload }, ...over,
});

describe("applyHookEnvelope", () => {
  it("SessionStart from a Butler terminal binds the ticket", () => {
    const { sessions, deps } = setup();
    expect(applyHookEnvelope(env("SessionStart", "s1", { ticket: "PROJ-1", butlerSession: "s1" }), deps))
      .toEqual({ kind: "session_started", sessionId: "s1", ticketKey: "PROJ-1", replaced: null });
    expect(sessions.get("s1")).toMatchObject({ ticketKey: "PROJ-1", origin: "butler", cwd: "/w", lastActivityAt: 100 });
  });

  it("/clear in a Butler terminal chains the new session and inherits the ticket", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("SessionStart", "s1", { ticket: "PROJ-1", butlerSession: "s1" }), deps);
    const eff = applyHookEnvelope(env("SessionStart", "s2", { ticket: null, butlerSession: "s1" }, { source: "clear" }), deps);
    expect(eff).toEqual({ kind: "session_started", sessionId: "s2", ticketKey: "PROJ-1", replaced: "s1" });
    expect(sessions.head("s1")?.id).toBe("s2");
    // 再 clear 一次，链继续延长
    applyHookEnvelope(env("SessionStart", "s3", { butlerSession: "s1" }, { source: "clear" }), deps);
    expect(sessions.head("s1")?.id).toBe("s3");
  });

  it("an unknown ticket in env is ignored, the session is still recorded", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("SessionStart", "s1", { ticket: "GONE-9" }), deps);
    expect(sessions.get("s1")).toMatchObject({ ticketKey: null, origin: "butler" });
  });

  it("Stop before SessionStart creates the session and marks it waiting", () => {
    const { sessions, deps } = setup();
    expect(applyHookEnvelope(env("Stop", "s9"), deps)).toEqual({ kind: "waiting", sessionId: "s9", waiting: true });
    expect(sessions.get("s9")).toMatchObject({ waitingForInput: true, origin: "discovered" });
    applyHookEnvelope(env("SessionStart", "s9"), deps);
    expect(sessions.get("s9")?.waitingForInput).toBe(true);
  });

  it("UserPromptSubmit and SessionEnd clear the waiting flag", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("Stop", "s1"), deps);
    applyHookEnvelope(env("UserPromptSubmit", "s1", { receivedAt: 200 }), deps);
    expect(sessions.get("s1")).toMatchObject({ waitingForInput: false, lastActivityAt: 200 });
    applyHookEnvelope(env("Stop", "s1"), deps);
    expect(applyHookEnvelope(env("SessionEnd", "s1"), deps)).toEqual({ kind: "ended", sessionId: "s1" });
    expect(sessions.get("s1")?.waitingForInput).toBe(false);
  });

  it("ignores payloads without event or session id", () => {
    const { deps } = setup();
    expect(applyHookEnvelope({ v: 1, receivedAt: 1, ticket: null, butlerSession: null, payload: null }, deps).kind).toBe("ignored");
    expect(applyHookEnvelope(env("Notification", "s1"), deps)).toEqual({ kind: "ignored", reason: "unhandled_event:Notification" });
  });
});
```

`src/main/hooks/inbox.test.ts`:
```ts
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import { tempDir } from "../test-utils";
import { HookInbox } from "./inbox";

const envelope = (n: number) => JSON.stringify({ v: 1, receivedAt: n, ticket: null, butlerSession: null, payload: { n } });

describe("HookInbox.drain", () => {
  it("handles files in name order, deletes them, quarantines bad ones, skips .tmp", async () => {
    const root = tempDir();
    const dir = join(root, "inbox");
    const bad = join(dir, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0002-a.json"), envelope(2));
    writeFileSync(join(dir, "0001-a.json"), envelope(1));
    writeFileSync(join(dir, "0003-a.json"), "{broken");
    writeFileSync(join(dir, "0004-a.json"), envelope(4));
    writeFileSync(join(dir, "0005-a.json.tmp"), envelope(5));

    const seen: number[] = [];
    const inbox = new HookInbox({
      dir, badDir: bad,
      handle: (e: HookEnvelope) => {
        if (e.receivedAt === 4) throw new Error("handler failed");
        seen.push(e.receivedAt);
      },
    });
    expect(await inbox.drain()).toBe(2);
    expect(seen).toEqual([1, 2]);
    expect(readdirSync(dir).sort()).toEqual(["0005-a.json.tmp", "bad"]);
    expect(readdirSync(bad).sort()).toEqual(["0003-a.json", "0004-a.json"]);
  });

  it("creates the directory if missing", async () => {
    const dir = join(tempDir(), "inbox");
    const inbox = new HookInbox({ dir, badDir: join(dir, "bad"), handle: () => undefined });
    expect(await inbox.drain()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/hooks/hook-events.test.ts src/main/hooks/inbox.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现**

`src/main/hooks/hook-events.ts`:
```ts
import type { HookEnvelope } from "../../shared/hook-envelope";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";

export type HookEffect =
  | { kind: "session_started"; sessionId: string; ticketKey: string | null; replaced: string | null }
  | { kind: "waiting"; sessionId: string; waiting: boolean }
  | { kind: "ended"; sessionId: string }
  | { kind: "ignored"; reason: string };

interface HookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function applyHookEnvelope(env: HookEnvelope, deps: { sessions: SessionsRepo; tickets: TicketsRepo }): HookEffect {
  const p = (env.payload && typeof env.payload === "object" ? env.payload : {}) as HookPayload;
  const event = str(p.hook_event_name);
  const id = str(p.session_id);
  if (!event || !id) return { kind: "ignored", reason: "missing_fields" };

  const { sessions, tickets } = deps;
  const at = env.receivedAt;
  const cwd = str(p.cwd) ?? "";
  // 这个终端当前对应的 session（/clear 之后 id 会变，BUTLER_SESSION 不变）。
  const prevHead = env.butlerSession ? sessions.head(env.butlerSession) : null;
  const envTicket = env.ticket && tickets.get(env.ticket) ? env.ticket : null;
  const ticketKey = envTicket ?? prevHead?.ticketKey ?? null;
  const fromButler = Boolean(env.butlerSession || env.ticket);

  // 事件可能乱序到达（例如 Stop 先于 SessionStart 被处理），所以每种事件都先确保 session 存在。
  const ensure = () => {
    const inserted = sessions.insertIfAbsent({ id, ticketKey, cwd, origin: fromButler ? "butler" : "discovered", lastActivityAt: at, createdAt: at });
    if (inserted) return;
    sessions.fillDetails(id, { cwd, lastActivityAt: at });
    if (ticketKey && !sessions.get(id)?.ticketKey) sessions.setTicket(id, ticketKey);
  };

  switch (event) {
    case "SessionStart": {
      ensure();
      let replaced: string | null = null;
      if (prevHead && prevHead.id !== id) {
        sessions.setReplacedBy(prevHead.id, id);
        replaced = prevHead.id;
      }
      return { kind: "session_started", sessionId: id, ticketKey, replaced };
    }
    case "Stop":
      ensure();
      sessions.setWaiting(id, true, at);
      return { kind: "waiting", sessionId: id, waiting: true };
    case "UserPromptSubmit":
      ensure();
      sessions.setWaiting(id, false, at);
      return { kind: "waiting", sessionId: id, waiting: false };
    case "SessionEnd":
      ensure();
      sessions.setWaiting(id, false, at);
      return { kind: "ended", sessionId: id };
    default:
      return { kind: "ignored", reason: `unhandled_event:${event}` };
  }
}
```

`src/main/hooks/inbox.ts`:
```ts
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseEnvelope, type HookEnvelope } from "../../shared/hook-envelope";

export interface HookInboxOptions {
  dir: string;
  badDir: string;
  handle: (env: HookEnvelope) => void;
  intervalMs?: number;
  log?: (msg: string) => void;
}

/** fs.watch 在各平台上都不完全可靠，所以同时用定时轮询兜底。 */
export class HookInbox {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private again = false;

  constructor(private readonly opts: HookInboxOptions) {}

  async drain(): Promise<number> {
    if (this.draining) {
      this.again = true;
      return 0;
    }
    this.draining = true;
    let handled = 0;
    try {
      do {
        this.again = false;
        await mkdir(this.opts.dir, { recursive: true });
        const names = (await readdir(this.opts.dir)).filter((n) => n.endsWith(".json")).sort();
        for (const name of names) {
          const file = join(this.opts.dir, name);
          try {
            const env = parseEnvelope(await readFile(file, "utf8"));
            if (!env) throw new Error("invalid envelope");
            this.opts.handle(env);
            await unlink(file);
            handled++;
          } catch (e) {
            this.opts.log?.(`inbox: ${name} -> bad (${(e as Error).message})`);
            await mkdir(this.opts.badDir, { recursive: true });
            await rename(file, join(this.opts.badDir, name)).catch(() => undefined);
          }
        }
      } while (this.again);
    } finally {
      this.draining = false;
    }
    return handled;
  }

  start(): void {
    void this.drain();
    try {
      this.watcher = watch(this.opts.dir, () => void this.drain());
    } catch {
      this.watcher = null;
    }
    this.timer = setInterval(() => void this.drain(), this.opts.intervalMs ?? 2000);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/hooks && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: apply hook events to sessions and watch the hook inbox"
```

---

### Task 8: 发现 app 外的 session

**Files:**
- Create: `src/main/sessions/discovery.ts`, `src/main/sessions/discovery.test.ts`

**Interfaces:**
- Consumes: `SessionsRepo`, `extractTicketKey`
- Produces:
  - `UNCLAIMED_WINDOW_MS`（7 天）
  - `extractUserText(entry): string|null`
  - `readSessionHead(file, maxLines?): Promise<{ cwd; gitBranch; firstPrompt }>`
  - `scanClaudeProjects(projectsDir, sinceMs): Promise<DiscoveredSession[]>`
  - `syncDiscovered(found, sessions, now): string[]`（返回新插入的 id）
  - `suggestTicket({ gitBranch, firstPrompt }, pattern): string|null`

- [ ] **Step 1: 写失败测试**

`src/main/sessions/discovery.test.ts`:
```ts
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { DEFAULT_TICKET_PATTERN } from "../tickets/ticket-key";
import { memDb, tempDir } from "../test-utils";
import { extractUserText, readSessionHead, scanClaudeProjects, suggestTicket, syncDiscovered } from "./discovery";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

const lines = (...entries: unknown[]) => entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n";
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", cwd: "/work/app", gitBranch: "feature/proj-12-login", message: { role: "user", content }, ...extra });

describe("extractUserText", () => {
  it("accepts plain and text-block prompts, rejects meta/sidechain/command/tool results", () => {
    expect(extractUserText(user("修复登录"))).toBe("修复登录");
    expect(extractUserText(user([{ type: "text", text: "hello" }]))).toBe("hello");
    expect(extractUserText(user("<command-name>/clear</command-name>"))).toBeNull();
    expect(extractUserText(user("x", { isMeta: true }))).toBeNull();
    expect(extractUserText(user("x", { isSidechain: true }))).toBeNull();
    expect(extractUserText(user([{ type: "tool_result", content: "ok" }]))).toBeNull();
    expect(extractUserText({ type: "assistant" })).toBeNull();
    expect(extractUserText(user("a".repeat(300)))).toHaveLength(201);
  });
});

describe("readSessionHead", () => {
  it("skips junk lines and finds cwd, branch and first real prompt", async () => {
    const file = join(tempDir(), `${ID1}.jsonl`);
    writeFileSync(file, lines("{not json", 42, null, { type: "summary", summary: "x" }, user("<command-name>/x</command-name>"), user("真正的问题")));
    expect(await readSessionHead(file)).toEqual({ cwd: "/work/app", gitBranch: "feature/proj-12-login", firstPrompt: "真正的问题" });
  });

  it("stops after maxLines", async () => {
    const file = join(tempDir(), `${ID1}.jsonl`);
    const filler = Array.from({ length: 50 }, () => ({ type: "summary", cwd: "/w" }));
    writeFileSync(file, lines(...filler, user("late")));
    expect((await readSessionHead(file, 10)).firstPrompt).toBeNull();
  });
});

describe("scanClaudeProjects", () => {
  it("returns recent uuid-named sessions with a cwd", async () => {
    const root = tempDir();
    const proj = join(root, "-work-app");
    mkdirSync(proj);
    writeFileSync(join(proj, `${ID1}.jsonl`), lines(user("recent")));
    writeFileSync(join(proj, `${ID2}.jsonl`), lines(user("old")));
    writeFileSync(join(proj, "not-a-uuid.jsonl"), lines(user("x")));
    writeFileSync(join(proj, "notes.txt"), "x");
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(join(proj, `${ID2}.jsonl`), old, old);

    const found = await scanClaudeProjects(root, Date.now() - 7 * 24 * 3600 * 1000);
    expect(found.map((f) => f.id)).toEqual([ID1]);
    expect(found[0]).toMatchObject({ cwd: "/work/app", firstPrompt: "recent" });
  });

  it("returns [] when the projects dir does not exist", async () => {
    expect(await scanClaudeProjects(join(tempDir(), "missing"), 0)).toEqual([]);
  });
});

describe("syncDiscovered / suggestTicket", () => {
  it("inserts new sessions without disturbing claimed ones", () => {
    const db = memDb();
    new TicketsRepo(db).insert({ key: "PROJ-12", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
    const sessions = new SessionsRepo(db);
    sessions.insertIfAbsent({ id: ID2, ticketKey: "PROJ-12", cwd: "/r", origin: "butler", lastActivityAt: 5, createdAt: 1 });
    const inserted = syncDiscovered(
      [
        { id: ID1, cwd: "/w", gitBranch: "main", firstPrompt: "hi", lastActivityAt: 10 },
        { id: ID2, cwd: "/other", gitBranch: "x", firstPrompt: "y", lastActivityAt: 20 },
      ],
      sessions, 100,
    );
    expect(inserted).toEqual([ID1]);
    expect(sessions.get(ID1)).toMatchObject({ origin: "discovered", ticketKey: null });
    expect(sessions.get(ID2)).toMatchObject({ ticketKey: "PROJ-12", cwd: "/r", origin: "butler", lastActivityAt: 20 });
  });

  it("suggests from branch first, then prompt", () => {
    expect(suggestTicket({ gitBranch: "feature/proj-12-x", firstPrompt: "PROJ-99" }, DEFAULT_TICKET_PATTERN)).toBe("PROJ-12");
    expect(suggestTicket({ gitBranch: "main", firstPrompt: "看下 PROJ-99" }, DEFAULT_TICKET_PATTERN)).toBe("PROJ-99");
    expect(suggestTicket({ gitBranch: null, firstPrompt: null }, DEFAULT_TICKET_PATTERN)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/sessions/discovery.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现**

`src/main/sessions/discovery.ts`:
```ts
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { SessionsRepo } from "../db/sessions-repo";
import { extractTicketKey } from "../tickets/ticket-key";

export const UNCLAIMED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_LIMIT = 200;

export interface DiscoveredSession {
  id: string;
  cwd: string;
  gitBranch: string | null;
  firstPrompt: string | null;
  lastActivityAt: number;
}

export interface SessionHead {
  cwd: string | null;
  gitBranch: string | null;
  firstPrompt: string | null;
}

/** 只认用户亲手输入的文本：排除 meta、子 agent、斜杠命令/系统标签和 tool_result。 */
export function extractUserText(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { type?: unknown; isSidechain?: unknown; isMeta?: unknown; message?: { role?: unknown; content?: unknown } };
  if (e.type !== "user" || e.isSidechain === true || e.isMeta === true || e.message?.role !== "user") return null;
  const c = e.message.content;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c
            .filter((x): x is { type: string; text?: unknown } => !!x && typeof x === "object" && (x as { type?: unknown }).type === "text")
            .map((x) => String(x.text ?? ""))
            .join("\n")
        : "";
  const t = text.trim();
  if (!t || t.startsWith("<")) return null;
  return t.length > PROMPT_LIMIT ? `${t.slice(0, PROMPT_LIMIT)}…` : t;
}

/** 只读文件开头，历史文件可能有几十 MB。 */
export async function readSessionHead(file: string, maxLines = 200): Promise<SessionHead> {
  const head: SessionHead = { cwd: null, gitBranch: null, firstPrompt: null };
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (++n > maxLines) break;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { cwd?: unknown; gitBranch?: unknown };
      if (!head.cwd && typeof e.cwd === "string") head.cwd = e.cwd;
      if (!head.gitBranch && typeof e.gitBranch === "string" && e.gitBranch && e.gitBranch !== "HEAD") head.gitBranch = e.gitBranch;
      if (!head.firstPrompt) head.firstPrompt = extractUserText(entry);
      if (head.cwd && head.gitBranch && head.firstPrompt) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return head;
}

export async function scanClaudeProjects(projectsDir: string, sinceMs: number): Promise<DiscoveredSession[]> {
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return [];
  }
  const found: DiscoveredSession[] = [];
  for (const d of dirs) {
    const dir = join(projectsDir, d);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const id = basename(f, ".jsonl");
      if (!UUID_RE.test(id)) continue;
      const file = join(dir, f);
      let mtime: number;
      try {
        mtime = (await stat(file)).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < sinceMs) continue;
      const head = await readSessionHead(file);
      if (!head.cwd) continue;
      found.push({ id, cwd: head.cwd, gitBranch: head.gitBranch, firstPrompt: head.firstPrompt, lastActivityAt: Math.floor(mtime) });
    }
  }
  return found;
}

export function syncDiscovered(found: DiscoveredSession[], sessions: SessionsRepo, now: number): string[] {
  const inserted: string[] = [];
  for (const s of found) {
    const isNew = sessions.insertIfAbsent({
      id: s.id, ticketKey: null, cwd: s.cwd, origin: "discovered",
      gitBranch: s.gitBranch, firstPrompt: s.firstPrompt, lastActivityAt: s.lastActivityAt, createdAt: now,
    });
    if (isNew) inserted.push(s.id);
    else sessions.fillDetails(s.id, { cwd: s.cwd, gitBranch: s.gitBranch, firstPrompt: s.firstPrompt, lastActivityAt: s.lastActivityAt });
  }
  return inserted;
}

export function suggestTicket(s: { gitBranch: string | null; firstPrompt: string | null }, pattern: string): string | null {
  return (s.gitBranch && extractTicketKey(s.gitBranch, pattern)) || (s.firstPrompt && extractTicketKey(s.firstPrompt, pattern)) || null;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/sessions && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 用本机真实数据核对一次**

Run: `pnpm dlx tsx@4 -e 'Promise.all([import("./src/main/sessions/discovery.ts"), import("node:os")]).then(async ([m, os]) => { const r = await m.scanClaudeProjects(os.homedir() + "/.claude/projects", Date.now() - m.UNCLAIMED_WINDOW_MS); console.log(r.length, r.slice(0, 3)); })'`
Expected: 列出最近 7 天的 session，`cwd`、`firstPrompt` 看起来合理（firstPrompt 是你真正输入的第一句话）。如果大量 `firstPrompt: null`，检查真实 jsonl 的 user 条目结构，调整 `extractUserText` 并补测试。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: discover Claude Code sessions started outside Butler"
```

---

### Task 9: PTY 管理与 claude 启动参数

**Files:**
- Create: `src/main/claude/spawn.ts`, `src/main/claude/spawn.test.ts`
- Create: `src/main/sessions/pty-manager.ts`, `src/main/sessions/pty-manager.test.ts`
- Create: `src/main/sessions/pty-node.ts`
- Modify: `src/main/test-utils.ts`（追加 `FakePty`、`fakePtyFactory`）

**Interfaces:**
- Consumes: `pathKey`
- Produces:
  - `SpawnSpec { file: string; args: string[] }`
  - `claudeArgs({ mode: "new" | "resume"; sessionId; mcpConfigPath? }): string[]`
  - `spawnSpec(claudePath, args, platform): SpawnSpec`
  - `sessionEnv(base, { pathValue, ticketKey, sessionId }): Record<string, string>`
  - `PtyProcess`、`PtyFactory`、`PtyEvents { data(termId, data); exit(termId, exitCode) }`
  - `PtyManager { open(termId, spec, { cwd, env, cols?, rows? }); isOpen; openIds(): string[]; write; resize; kill; killAll; snapshot(termId): string; prefill(termId, text, idleMs?, timeoutMs?): Promise<boolean> }`、`BUFFER_LIMIT`
  - `nodePtyFactory: PtyFactory`
  - 测试用：`FakePty`、`fakePtyFactory(): { factory: PtyFactory; spawned: { file; args; opts; pty: FakePty }[] }`

- [ ] **Step 1: 写失败测试**

在 `src/main/test-utils.ts` 末尾追加：
```ts
import type { PtyFactory, PtyProcess } from "./sessions/pty-manager";

export class FakePty implements PtyProcess {
  pid = 4242;
  written: string[] = [];
  resized: [number, number][] = [];
  killed = false;
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCbs.push(cb);
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(c: number, r: number): void {
    this.resized.push([c, r]);
  }
  kill(): void {
    this.killed = true;
    this.emitExit(0);
  }
  emit(d: string): void {
    this.dataCbs.forEach((cb) => cb(d));
  }
  emitExit(code: number): void {
    this.exitCbs.forEach((cb) => cb({ exitCode: code }));
  }
}

export function fakePtyFactory() {
  const spawned: { file: string; args: string[]; opts: Parameters<PtyFactory>[2]; pty: FakePty }[] = [];
  const factory: PtyFactory = (file, args, opts) => {
    const pty = new FakePty();
    spawned.push({ file, args, opts, pty });
    return pty;
  };
  return { factory, spawned };
}
```
（把新的 import 合并到文件顶部。）

`src/main/claude/spawn.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { claudeArgs, sessionEnv, spawnSpec } from "./spawn";

describe("claude spawn helpers", () => {
  it("builds new and resume args", () => {
    expect(claudeArgs({ mode: "new", sessionId: "u1" })).toEqual(["--session-id", "u1"]);
    expect(claudeArgs({ mode: "resume", sessionId: "u1", mcpConfigPath: "/m.json" })).toEqual(["--resume", "u1", "--mcp-config", "/m.json"]);
  });

  it("runs .cmd shims through cmd.exe on Windows only", () => {
    expect(spawnSpec("C:\\npm\\claude.cmd", ["--resume", "u"], "win32")).toEqual({ file: "cmd.exe", args: ["/c", "C:\\npm\\claude.cmd", "--resume", "u"] });
    expect(spawnSpec("C:\\bin\\claude.exe", ["x"], "win32")).toEqual({ file: "C:\\bin\\claude.exe", args: ["x"] });
    expect(spawnSpec("/usr/local/bin/claude", ["x"], "darwin")).toEqual({ file: "/usr/local/bin/claude", args: ["x"] });
  });

  it("builds the session env", () => {
    const env = sessionEnv(
      { Path: "C:\\old", HOME: "/h", ELECTRON_RUN_AS_NODE: "1", CLAUDECODE: "1", EMPTY: undefined },
      { pathValue: "C:\\new", ticketKey: "PROJ-1", sessionId: "u1" },
    );
    expect(env).toEqual({ Path: "C:\\new", HOME: "/h", TERM: "xterm-256color", COLORTERM: "truecolor", BUTLER_TICKET: "PROJ-1", BUTLER_SESSION: "u1" });
  });

  it("keeps the inherited PATH when the login PATH is empty", () => {
    expect(sessionEnv({ PATH: "/usr/bin" }, { pathValue: "", ticketKey: "T-1", sessionId: "u" }).PATH).toBe("/usr/bin");
  });
});
```

`src/main/sessions/pty-manager.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePtyFactory } from "../test-utils";
import { BUFFER_LIMIT, PtyManager } from "./pty-manager";

function setup() {
  const { factory, spawned } = fakePtyFactory();
  const data: [string, string][] = [];
  const exits: [string, number][] = [];
  const mgr = new PtyManager(factory, { data: (id, d) => data.push([id, d]), exit: (id, c) => exits.push([id, c]) });
  return { mgr, spawned, data, exits };
}

const spec = { file: "/bin/claude", args: ["--session-id", "t1"] };
const opts = { cwd: "/w", env: { A: "1" } };

describe("PtyManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("spawns, forwards data, buffers output and forgets exited terminals", () => {
    const { mgr, spawned, data, exits } = setup();
    mgr.open("t1", spec, opts);
    expect(spawned[0]).toMatchObject({ file: "/bin/claude", args: ["--session-id", "t1"], opts: { cwd: "/w", env: { A: "1" }, cols: 120, rows: 32 } });
    spawned[0].pty.emit("hello ");
    spawned[0].pty.emit("world");
    expect(data).toEqual([["t1", "hello "], ["t1", "world"]]);
    expect(mgr.snapshot("t1")).toBe("hello world");
    expect(mgr.openIds()).toEqual(["t1"]);
    spawned[0].pty.emitExit(3);
    expect(exits).toEqual([["t1", 3]]);
    expect(mgr.isOpen("t1")).toBe(false);
    expect(mgr.snapshot("t1")).toBe("");
  });

  it("caps the replay buffer", () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    spawned[0].pty.emit("a".repeat(BUFFER_LIMIT));
    spawned[0].pty.emit("bcd");
    const snap = mgr.snapshot("t1");
    expect(snap).toHaveLength(BUFFER_LIMIT);
    expect(snap.endsWith("bcd")).toBe(true);
  });

  it("refuses to open the same terminal twice", () => {
    const { mgr } = setup();
    mgr.open("t1", spec, opts);
    expect(() => mgr.open("t1", spec, opts)).toThrow(/already open/);
  });

  it("ignores zero-size resizes and routes writes", () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    mgr.resize("t1", 0, 10);
    mgr.resize("t1", 100, 30);
    mgr.write("t1", "x");
    mgr.write("nope", "y");
    expect(spawned[0].pty.resized).toEqual([[100, 30]]);
    expect(spawned[0].pty.written).toEqual(["x"]);
  });

  it("prefill waits for output to go quiet, then types without Enter", async () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    const p = mgr.prefill("t1", "继续 follow-up", 800, 20_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawned[0].pty.written).toEqual([]); // 还没有任何输出，不能写
    spawned[0].pty.emit("welcome");
    await vi.advanceTimersByTimeAsync(500);
    spawned[0].pty.emit("…");
    await vi.advanceTimersByTimeAsync(500);
    expect(spawned[0].pty.written).toEqual([]); // 输出还没安静 800ms
    await vi.advanceTimersByTimeAsync(400);
    expect(await p).toBe(true);
    expect(spawned[0].pty.written).toEqual(["继续 follow-up"]);
  });

  it("prefill gives up when the terminal exits or times out", async () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    const p1 = mgr.prefill("t1", "x", 800, 5000);
    spawned[0].pty.emitExit(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(await p1).toBe(false);

    mgr.open("t2", spec, opts);
    const p2 = mgr.prefill("t2", "x", 800, 1000);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await p2).toBe(false);
  });

  it("killAll kills every terminal", () => {
    const { mgr, spawned } = setup();
    mgr.open("a", spec, opts);
    mgr.open("b", spec, opts);
    mgr.killAll();
    expect(spawned.every((s) => s.pty.killed)).toBe(true);
    expect(mgr.openIds()).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/claude/spawn.test.ts src/main/sessions/pty-manager.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现**

`src/main/claude/spawn.ts`:
```ts
import { pathKey } from "../util/env";

export interface SpawnSpec {
  file: string;
  args: string[];
}

export function claudeArgs(req: { mode: "new" | "resume"; sessionId: string; mcpConfigPath?: string }): string[] {
  const args = req.mode === "new" ? ["--session-id", req.sessionId] : ["--resume", req.sessionId];
  if (req.mcpConfigPath) args.push("--mcp-config", req.mcpConfigPath);
  return args;
}

/** 直接用 PTY 跑 claude；只有 Windows 上 npm 装的 claude.cmd 需要经过 cmd.exe。 */
export function spawnSpec(claudePath: string, args: string[], platform: NodeJS.Platform): SpawnSpec {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(claudePath)) return { file: "cmd.exe", args: ["/c", claudePath, ...args] };
  return { file: claudePath, args };
}

/** 去掉 Electron 和外层 Claude Code 的标记变量，防止它们泄漏给被启动的 claude。 */
export function sessionEnv(
  base: NodeJS.ProcessEnv,
  x: { pathValue: string; ticketKey: string; sessionId: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith("ELECTRON_") || k === "CLAUDECODE") continue;
    out[k] = v;
  }
  if (x.pathValue) out[pathKey(out)] = x.pathValue;
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  out.BUTLER_TICKET = x.ticketKey;
  out.BUTLER_SESSION = x.sessionId;
  return out;
}
```

`src/main/sessions/pty-manager.ts`:
```ts
import type { SpawnSpec } from "../claude/spawn";

export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; cols: number; rows: number },
) => PtyProcess;

export interface PtyEvents {
  data(termId: string, data: string): void;
  exit(termId: string, exitCode: number): void;
}

/** 每个终端保留的回放缓冲，切回 ticket 页面时重放。 */
export const BUFFER_LIMIT = 256 * 1024;

interface Term {
  proc: PtyProcess;
  buffer: string;
  lastOutputAt: number;
  exited: boolean;
}

export class PtyManager {
  private readonly terms = new Map<string, Term>();

  constructor(
    private readonly factory: PtyFactory,
    private readonly events: PtyEvents,
    private readonly now: () => number = () => Date.now(),
  ) {}

  open(termId: string, spec: SpawnSpec, opts: { cwd: string; env: Record<string, string>; cols?: number; rows?: number }): void {
    if (this.terms.has(termId)) throw new Error(`terminal ${termId} already open`);
    const proc = this.factory(spec.file, spec.args, { cwd: opts.cwd, env: opts.env, cols: opts.cols ?? 120, rows: opts.rows ?? 32 });
    const term: Term = { proc, buffer: "", lastOutputAt: 0, exited: false };
    this.terms.set(termId, term);
    proc.onData((data) => {
      term.lastOutputAt = this.now();
      term.buffer = (term.buffer + data).slice(-BUFFER_LIMIT);
      this.events.data(termId, data);
    });
    proc.onExit(({ exitCode }) => {
      term.exited = true;
      this.terms.delete(termId);
      this.events.exit(termId, exitCode);
    });
  }

  isOpen(termId: string): boolean {
    return this.terms.has(termId);
  }

  openIds(): string[] {
    return [...this.terms.keys()];
  }

  write(termId: string, data: string): void {
    this.terms.get(termId)?.proc.write(data);
  }

  resize(termId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.terms.get(termId)?.proc.resize(cols, rows);
  }

  kill(termId: string): void {
    this.terms.get(termId)?.proc.kill();
  }

  killAll(): void {
    for (const t of [...this.terms.values()]) t.proc.kill();
  }

  snapshot(termId: string): string {
    return this.terms.get(termId)?.buffer ?? "";
  }

  /** 等 claude 的界面输出停下来（输入框就绪）后把文本写进去，不回车。 */
  async prefill(termId: string, text: string, idleMs = 800, timeoutMs = 20_000): Promise<boolean> {
    const start = this.now();
    for (;;) {
      const t = this.terms.get(termId);
      if (!t || t.exited) return false;
      const now = this.now();
      if (t.lastOutputAt > 0 && now - t.lastOutputAt >= idleMs) {
        t.proc.write(text);
        return true;
      }
      if (now - start >= timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
```

`src/main/sessions/pty-node.ts`:
```ts
import * as pty from "node-pty";
import type { PtyFactory } from "./pty-manager";

export const nodePtyFactory: PtyFactory = (file, args, opts) => {
  const p = pty.spawn(file, args, { name: "xterm-256color", cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows });
  return {
    get pid() {
      return p.pid;
    },
    onData: (cb) => {
      p.onData(cb);
    },
    onExit: (cb) => {
      p.onExit(({ exitCode }) => cb({ exitCode }));
    },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
  };
};
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: PTY manager with replay buffer and prefill, claude spawn helpers"
```

---

### Task 10: SessionService、IPC 契约与 preload

**Files:**
- Create: `src/shared/ipc.ts`
- Create: `src/main/sessions/session-service.ts`, `src/main/sessions/session-service.test.ts`
- Create: `src/main/ipc/result.ts`, `src/main/ipc/result.test.ts`
- Create: `src/main/ipc/register.ts`
- Modify: `src/preload/index.ts`（整体替换）

**Interfaces:**
- Consumes: 任务 2～9 的全部产出
- Produces:
  - `IPC`（通道名常量）、`INVOKE_CHANNELS`、`SEND_CHANNELS`、`EVENT_CHANNELS`、`IpcResult<T>`
  - `SessionService { open(req): Promise<OpenSessionResult>; ticketViews(): TicketView[]; unclaimed(): UnclaimedSession[]; claim(sessionId, ticketKey): void; dismiss(sessionId): void }`
  - `toIpcResult(fn): Promise<IpcResult<T>>`
  - `registerIpc(deps: IpcDeps): void`
  - preload 暴露 `window.butler = { invoke(ch, ...args), send(ch, ...args), on(ch, cb): () => void }`

- [ ] **Step 1: 写 IPC 契约**

`src/shared/ipc.ts`:
```ts
export const IPC = {
  ticketsList: "tickets:list",
  ticketsCreate: "tickets:create",
  ticketsSetStatus: "tickets:setStatus",
  ticketsArchive: "tickets:archive",
  ticketsSwitchBranch: "tickets:switchBranch",
  sessionsOpen: "sessions:open",
  sessionsUnclaimed: "sessions:unclaimed",
  sessionsClaim: "sessions:claim",
  sessionsDismiss: "sessions:dismiss",
  ptySnapshot: "pty:snapshot",
  ptyKill: "pty:kill",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyData: "pty:data",
  ptyExit: "pty:exit",
  stateChanged: "state:changed",
  healthGet: "health:get",
  healthInstallHooks: "health:installHooks",
  healthUninstallHooks: "health:uninstallHooks",
  dialogPickDir: "dialog:pickDir",
} as const;

/** 渲染进程 → 主进程，有返回值（ipcRenderer.invoke）。 */
export const INVOKE_CHANNELS: readonly string[] = [
  IPC.ticketsList, IPC.ticketsCreate, IPC.ticketsSetStatus, IPC.ticketsArchive, IPC.ticketsSwitchBranch,
  IPC.sessionsOpen, IPC.sessionsUnclaimed, IPC.sessionsClaim, IPC.sessionsDismiss,
  IPC.ptySnapshot, IPC.ptyKill, IPC.healthGet, IPC.healthInstallHooks, IPC.healthUninstallHooks, IPC.dialogPickDir,
];
/** 渲染进程 → 主进程，单向高频（键盘输入、尺寸变化）。 */
export const SEND_CHANNELS: readonly string[] = [IPC.ptyWrite, IPC.ptyResize];
/** 主进程 → 渲染进程。 */
export const EVENT_CHANNELS: readonly string[] = [IPC.ptyData, IPC.ptyExit, IPC.stateChanged];

export type IpcResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
```

- [ ] **Step 2: 写失败测试**

`src/main/ipc/result.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { TicketError } from "../tickets/ticket-service";
import { toIpcResult } from "./result";

describe("toIpcResult", () => {
  it("wraps values and errors", async () => {
    expect(await toIpcResult(() => 1)).toEqual({ ok: true, value: 1 });
    expect(await toIpcResult(async () => "x")).toEqual({ ok: true, value: "x" });
    expect(await toIpcResult(() => { throw new TicketError("exists", "dup"); })).toEqual({ ok: false, code: "exists", message: "dup" });
    expect(await toIpcResult(() => { throw new Error("boom"); })).toEqual({ ok: false, code: "internal", message: "boom" });
    expect(await toIpcResult(() => { throw "weird"; })).toEqual({ ok: false, code: "internal", message: "weird" });
  });
});
```

`src/main/sessions/session-service.test.ts`:
```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { TicketService } from "../tickets/ticket-service";
import { fakePtyFactory, makeRepo, memDb } from "../test-utils";
import { PtyManager } from "./pty-manager";
import { SessionService } from "./session-service";

async function setup(opts: { claudePath?: string | null; workMode?: "branch" | "worktree" } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const settings = new SettingsRepo(db);
  const ticketService = new TicketService({ tickets, settings, now: () => 1 });
  const { factory, spawned } = fakePtyFactory();
  const pty = new PtyManager(factory, { data: () => undefined, exit: () => undefined });
  let n = 0;
  const service = new SessionService({
    tickets, sessions, settings, ticketService, pty,
    claude: () => ({ path: opts.claudePath === undefined ? "/bin/claude" : opts.claudePath, pathValue: "/login/bin" }),
    newId: () => `new-${++n}`,
    now: () => 1000,
    platform: "darwin",
    baseEnv: { HOME: "/h" },
  });
  const repo = makeRepo();
  const ticket = await ticketService.create({ key: "PROJ-1", repoPath: repo, workMode: opts.workMode ?? "worktree" });
  return { service, sessions, tickets, spawned, pty, repo, ticket, ticketService };
}

describe("SessionService.open", () => {
  it("starts a new session in the ticket workdir with Butler env", async () => {
    const { service, sessions, spawned, ticket } = await setup();
    expect(await service.open({ ticketKey: "PROJ-1" })).toEqual({ ok: true, termId: "new-1", alreadyOpen: false });
    expect(spawned[0].file).toBe("/bin/claude");
    expect(spawned[0].args).toEqual(["--session-id", "new-1"]);
    expect(spawned[0].opts.cwd).toBe(ticket.worktreePath);
    expect(spawned[0].opts.env).toMatchObject({ PATH: "/login/bin", BUTLER_TICKET: "PROJ-1", BUTLER_SESSION: "new-1" });
    expect(sessions.get("new-1")).toMatchObject({ ticketKey: "PROJ-1", origin: "butler", cwd: ticket.worktreePath });
  });

  it("resumes the head of a replaced chain in the session's own cwd", async () => {
    const { service, sessions, spawned } = await setup();
    sessions.insertIfAbsent({ id: "a", ticketKey: "PROJ-1", cwd: "/elsewhere", origin: "discovered", createdAt: 1 });
    sessions.insertIfAbsent({ id: "b", ticketKey: "PROJ-1", cwd: "/elsewhere", origin: "butler", createdAt: 2 });
    sessions.setReplacedBy("a", "b");
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "a" })).toEqual({ ok: true, termId: "b", alreadyOpen: false });
    expect(spawned[0].args).toEqual(["--resume", "b"]);
    expect(spawned[0].opts.cwd).toBe("/elsewhere");
  });

  it("never spawns a second claude for a session that is already open, even after /clear", async () => {
    const { service, sessions, spawned } = await setup();
    const first = await service.open({ ticketKey: "PROJ-1" });
    expect(first).toMatchObject({ ok: true, termId: "new-1" });
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "new-1" })).toEqual({ ok: true, termId: "new-1", alreadyOpen: true });

    // 终端里执行了 /clear：hook 把 new-1 链到了 c2
    sessions.insertIfAbsent({ id: "c2", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 3 });
    sessions.setReplacedBy("new-1", "c2");
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "c2" })).toEqual({ ok: true, termId: "new-1", alreadyOpen: true });
    expect(spawned).toHaveLength(1);
  });

  it("reports missing claude, unknown ticket and unknown session", async () => {
    const { service } = await setup({ claudePath: null });
    expect(await service.open({ ticketKey: "PROJ-1" })).toEqual({ ok: false, reason: "claude_missing" });
    expect(await service.open({ ticketKey: "NOPE-1" })).toEqual({ ok: false, reason: "no_ticket" });
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "ghost" })).toEqual({ ok: false, reason: "no_session" });
  });

  it("stops on a branch mismatch unless forced", async () => {
    const { service, spawned, repo } = await setup({ workMode: "branch" });
    expect(await service.open({ ticketKey: "PROJ-1" })).toEqual({ ok: false, reason: "branch_mismatch", current: "main", expected: "feature/PROJ-1", dirty: false });
    writeFileSync(join(repo, "README.md"), "dirty\n");
    expect(await service.open({ ticketKey: "PROJ-1" })).toMatchObject({ reason: "branch_mismatch", dirty: true });
    expect(spawned).toHaveLength(0);
    expect(await service.open({ ticketKey: "PROJ-1", force: true })).toMatchObject({ ok: true });
    expect(spawned[0].opts.cwd).toBe(repo);
  });
});

describe("SessionService views", () => {
  it("ticketViews hides replaced sessions and marks open/waiting ones", async () => {
    const { service, sessions } = await setup();
    await service.open({ ticketKey: "PROJ-1" });
    sessions.insertIfAbsent({ id: "old", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 1 });
    sessions.insertIfAbsent({ id: "c2", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 1 });
    sessions.setReplacedBy("old", "c2");
    sessions.setWaiting("new-1", true, 2000);
    const [view] = service.ticketViews();
    expect(view.effectiveStatus).toBe("active");
    expect(view.waiting).toBe(true);
    expect(view.sessions.map((s) => [s.id, s.termId])).toEqual([["new-1", "new-1"], ["c2", null]]);
  });

  it("unclaimed suggests tickets and claim/dismiss work", async () => {
    const { service, sessions } = await setup();
    sessions.insertIfAbsent({ id: "u1", ticketKey: null, cwd: "/w", origin: "discovered", gitBranch: "feature/proj-1-x", lastActivityAt: 900, createdAt: 900 });
    sessions.insertIfAbsent({ id: "u2", ticketKey: null, cwd: "/w", origin: "discovered", firstPrompt: "看 PROJ-77", lastActivityAt: 900, createdAt: 900 });
    const list = service.unclaimed();
    expect(list.map((s) => [s.id, s.suggestedTicket, s.suggestionExists])).toEqual([["u1", "PROJ-1", true], ["u2", "PROJ-77", false]]);
    service.claim("u1", "PROJ-1");
    service.dismiss("u2");
    expect(service.unclaimed()).toEqual([]);
    expect(() => service.claim("u2", "NOPE-1")).toThrow();
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `pnpm vitest run src/main/ipc src/main/sessions/session-service.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 4: 实现 result.ts 和 session-service.ts**

`src/main/ipc/result.ts`:
```ts
import type { IpcResult } from "../../shared/ipc";

/** ipcMain.handle 抛出的错误到渲染进程只剩一段字符串，所以统一包装成带 code 的结果。 */
export function toIpcResult<T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> {
  return Promise.resolve()
    .then(fn)
    .then(
      (value): IpcResult<T> => ({ ok: true, value }),
      (e: unknown): IpcResult<T> => {
        const code = e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "internal";
        return { ok: false, code, message: e instanceof Error ? e.message : String(e) };
      },
    );
}
```

`src/main/sessions/session-service.ts`:
```ts
import {
  effectiveStatus,
  type OpenSessionRequest,
  type OpenSessionResult,
  type Session,
  type TicketView,
  type UnclaimedSession,
} from "../../shared/types";
import { claudeArgs, sessionEnv, spawnSpec } from "../claude/spawn";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { TicketError, type TicketService } from "../tickets/ticket-service";
import { suggestTicket, UNCLAIMED_WINDOW_MS } from "./discovery";
import type { PtyManager } from "./pty-manager";

export interface SessionServiceDeps {
  tickets: TicketsRepo;
  sessions: SessionsRepo;
  settings: SettingsRepo;
  ticketService: TicketService;
  pty: PtyManager;
  claude: () => { path: string | null; pathValue: string };
  newId: () => string;
  now: () => number;
  platform: NodeJS.Platform;
  baseEnv: NodeJS.ProcessEnv;
}

export class SessionService {
  constructor(private readonly d: SessionServiceDeps) {}

  /** 打开的终端以启动时的 session id 为 termId；/clear 后要沿链比较当前 head。 */
  private openHeads(): Map<string, string> {
    const heads = new Map<string, string>();
    for (const termId of this.d.pty.openIds()) {
      const head = this.d.sessions.head(termId);
      if (head) heads.set(head.id, termId);
    }
    return heads;
  }

  async open(req: OpenSessionRequest): Promise<OpenSessionResult> {
    const ticket = this.d.tickets.get(req.ticketKey);
    if (!ticket) return { ok: false, reason: "no_ticket" };

    let head: Session | null = null;
    if (req.sessionId) {
      head = this.d.sessions.head(req.sessionId);
      if (!head) return { ok: false, reason: "no_session" };
      const existing = this.openHeads().get(head.id);
      if (existing) {
        if (req.prefill) void this.d.pty.prefill(existing, req.prefill, 0);
        return { ok: true, termId: existing, alreadyOpen: true };
      }
    }

    const { path: claudePath, pathValue } = this.d.claude();
    if (!claudePath) return { ok: false, reason: "claude_missing" };

    if (!req.force) {
      const check = await this.d.ticketService.checkBranch(ticket);
      if (!check.ok) return { ok: false, reason: "branch_mismatch", current: check.current, expected: check.expected, dirty: check.dirty };
    }

    const workDir = this.d.ticketService.workDir(ticket);
    let termId: string;
    let cwd: string;
    let args: string[];
    if (head) {
      // claude --resume 只能在 session 当初的项目目录里找到它
      termId = head.id;
      cwd = head.cwd || workDir;
      args = claudeArgs({ mode: "resume", sessionId: head.id });
    } else {
      termId = this.d.newId();
      cwd = workDir;
      args = claudeArgs({ mode: "new", sessionId: termId });
      const now = this.d.now();
      this.d.sessions.insertIfAbsent({ id: termId, ticketKey: ticket.key, cwd, origin: "butler", lastActivityAt: now, createdAt: now });
    }

    this.d.pty.open(termId, spawnSpec(claudePath, args, this.d.platform), {
      cwd,
      env: sessionEnv(this.d.baseEnv, { pathValue, ticketKey: ticket.key, sessionId: termId }),
    });
    if (req.prefill) void this.d.pty.prefill(termId, req.prefill);
    return { ok: true, termId, alreadyOpen: false };
  }

  ticketViews(): TicketView[] {
    const heads = this.openHeads();
    return this.d.tickets.list().map((t) => {
      const sessions = this.d.sessions
        .listByTicket(t.key)
        .filter((s) => !s.replacedBy)
        .map((s) => ({ ...s, termId: heads.get(s.id) ?? null }));
      return { ...t, effectiveStatus: effectiveStatus(t), sessions, waiting: sessions.some((s) => s.waitingForInput) };
    });
  }

  unclaimed(): UnclaimedSession[] {
    const pattern = this.d.settings.get("ticketPattern");
    return this.d.sessions.listUnclaimed(this.d.now() - UNCLAIMED_WINDOW_MS).map((s) => {
      const key = suggestTicket(s, pattern);
      return { ...s, suggestedTicket: key, suggestionExists: !!key && !!this.d.tickets.get(key) };
    });
  }

  claim(sessionId: string, ticketKey: string): void {
    if (!this.d.tickets.get(ticketKey)) throw new TicketError("not_found", `找不到 ticket ${ticketKey}`);
    this.d.sessions.setTicket(sessionId, ticketKey);
  }

  dismiss(sessionId: string): void {
    this.d.sessions.dismiss(sessionId);
  }
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `pnpm vitest run src/main && pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: 写 register.ts 和 preload**

`src/main/ipc/register.ts`:
```ts
import { dialog, ipcMain, type BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc";
import type { CreateTicketInput, OpenSessionRequest, TicketStatus } from "../../shared/types";
import type { TicketsRepo } from "../db/tickets-repo";
import type { HealthService } from "../hooks/health";
import type { PtyManager } from "../sessions/pty-manager";
import type { SessionService } from "../sessions/session-service";
import { TicketError, type TicketService } from "../tickets/ticket-service";
import { toIpcResult } from "./result";

export interface IpcDeps {
  tickets: TicketsRepo;
  ticketService: TicketService;
  sessionService: SessionService;
  pty: PtyManager;
  health: HealthService;
  window: () => BrowserWindow | null;
  now: () => number;
  notify: () => void;
}

export function registerIpc(d: IpcDeps): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (_e, ...args: unknown[]) => toIpcResult(() => fn(...args)));

  handle(IPC.ticketsList, () => d.sessionService.ticketViews());
  handle(IPC.ticketsCreate, async (input: CreateTicketInput) => {
    const t = await d.ticketService.create(input);
    d.notify();
    return t;
  });
  handle(IPC.ticketsSetStatus, (key: string, status: TicketStatus | null) => {
    d.tickets.setStatusManual(key, status);
    d.notify();
  });
  handle(IPC.ticketsArchive, (key: string) => {
    d.tickets.archive(key, d.now());
    d.notify();
  });
  handle(IPC.ticketsSwitchBranch, async (key: string) => {
    const t = d.tickets.get(key);
    if (!t) throw new TicketError("not_found", `找不到 ticket ${key}`);
    await d.ticketService.switchBranch(t);
  });

  handle(IPC.sessionsOpen, async (req: OpenSessionRequest) => {
    const r = await d.sessionService.open(req);
    d.notify();
    return r;
  });
  handle(IPC.sessionsUnclaimed, () => d.sessionService.unclaimed());
  handle(IPC.sessionsClaim, (id: string, key: string) => {
    d.sessionService.claim(id, key);
    d.notify();
  });
  handle(IPC.sessionsDismiss, (id: string) => {
    d.sessionService.dismiss(id);
    d.notify();
  });

  handle(IPC.ptySnapshot, (id: string) => d.pty.snapshot(id));
  handle(IPC.ptyKill, (id: string) => d.pty.kill(id));
  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => d.pty.write(id, data));
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) => d.pty.resize(id, cols, rows));

  handle(IPC.healthGet, () => d.health.refresh());
  handle(IPC.healthInstallHooks, () => d.health.installHooks());
  handle(IPC.healthUninstallHooks, () => d.health.uninstallHooks());

  handle(IPC.dialogPickDir, async () => {
    const w = d.window();
    const options = { properties: ["openDirectory" as const] };
    const r = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
}
```

`src/preload/index.ts`（整体替换）:
```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from "../shared/ipc";

function assertAllowed(list: readonly string[], channel: string): void {
  if (!list.includes(channel)) throw new Error(`IPC channel not allowed: ${channel}`);
}

contextBridge.exposeInMainWorld("butler", {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    assertAllowed(INVOKE_CHANNELS, channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel: string, ...args: unknown[]): void {
    assertAllowed(SEND_CHANNELS, channel);
    ipcRenderer.send(channel, ...args);
  },
  on(channel: string, cb: (...args: unknown[]) => void): () => void {
    assertAllowed(EVENT_CHANNELS, channel);
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
```

- [ ] **Step 7: 类型检查与构建**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: 全部通过。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: SessionService, typed IPC contract and whitelisted preload bridge"
```

---

### Task 11: 渲染进程 UI

**Files:**
- Create: `src/renderer/src/api.ts`, `src/renderer/src/strings.ts`, `src/renderer/src/group.ts`, `src/renderer/src/group.test.ts`, `src/renderer/src/styles.css`
- Create: `src/renderer/src/components/Sidebar.tsx`, `HomePage.tsx`, `NewTicketDialog.tsx`, `TicketPage.tsx`, `TerminalPane.tsx`, `UnclaimedPage.tsx`, `SettingsPage.tsx`
- Modify: `src/renderer/src/App.tsx`（整体替换）, `src/renderer/src/main.tsx`（引入样式）

**Interfaces:**
- Consumes: `IPC`, `IpcResult`, `shared/types` 的全部类型
- Produces: `api`（渲染进程调用主进程的唯一入口）、`ButlerError(code, message)`、`groupTickets(tickets)`、`Route` 类型

- [ ] **Step 1: 写 groupTickets 的失败测试**

`src/renderer/src/group.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { TicketView } from "../../shared/types";
import { groupTickets } from "./group";

const t = (key: string, effectiveStatus: TicketView["effectiveStatus"], waiting = false): TicketView => ({
  key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b",
  status: effectiveStatus, statusManual: null, createdAt: 1, archivedAt: null, effectiveStatus, sessions: [], waiting,
});

describe("groupTickets", () => {
  it("orders groups by urgency, waiting tickets first, drops empty groups", () => {
    const groups = groupTickets([t("B-2", "active"), t("A-1", "active"), t("C-3", "active", true), t("D-4", "merged_pending_followup"), t("E-5", "done")]);
    expect(groups.map((g) => g.status)).toEqual(["merged_pending_followup", "active", "done"]);
    expect(groups[1].tickets.map((x) => x.key)).toEqual(["C-3", "A-1", "B-2"]);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/renderer`
Expected: FAIL，找不到 `./group`。

- [ ] **Step 3: 实现 strings.ts 和 group.ts**

`src/renderer/src/strings.ts`:
```ts
import type { TicketStatus } from "../../shared/types";

export const STATUS_LABEL: Record<TicketStatus, string> = {
  merged_pending_followup: "已合并·待收尾",
  active: "进行中",
  blocked: "阻塞",
  in_review: "等 review",
  done: "完成",
};

/** 侧栏分组顺序：最容易被遗忘的放最上面。 */
export const STATUS_ORDER: TicketStatus[] = ["merged_pending_followup", "active", "blocked", "in_review", "done"];

export const S = {
  home: "首页",
  newTicket: "新建 ticket",
  waiting: "等你输入",
  unclaimed: "未认领 session",
  settings: "设置",
  ticketKey: "Ticket 号",
  title: "标题（可选）",
  repo: "仓库目录",
  pick: "选择…",
  workMode: "工作方式",
  worktree: "新建 worktree",
  branch: "在原目录用分支",
  branchName: "分支名（留空用默认模板）",
  create: "创建",
  cancel: "取消",
  newSession: "新 session",
  open: "打开",
  switchTo: "切换到",
  close: "关闭",
  archive: "归档",
  statusAuto: (current: string) => `自动（当前：${current}）`,
  noSessions: "还没有 session。点“新 session”开始。",
  noTickets: "还没有 ticket。点左侧“新建 ticket”。",
  waitingList: "等你输入的 session",
  nothingWaiting: "没有 session 在等你。",
  exited: (code: number) => `claude 已退出（退出码 ${code}）`,
  branchMismatch: (current: string, expected: string) => `仓库当前在 ${current} 上，这个 ticket 的分支是 ${expected}。`,
  dirtyWarning: "工作区有未提交的改动，不会自动切换分支。",
  switchAndOpen: "切换分支并打开",
  openAnyway: "仍在当前分支打开",
  openErrors: {
    claude_missing: "找不到 claude 命令，请到设置页检查。",
    no_ticket: "ticket 不存在。",
    no_session: "session 不存在。",
  } as Record<string, string>,
  createErrors: {
    invalid_key: "ticket 号格式不对。",
    exists: "这个 ticket 已经存在。",
    not_git_repo: "所选目录不是 git 仓库。",
    worktree_exists: "worktree 目录已存在。",
  } as Record<string, string>,
  unclaimedHint: "这些是最近 7 天在 Butler 之外启动的 Claude Code session。认领后就能在对应 ticket 下恢复。",
  noUnclaimed: "没有未认领的 session。",
  claim: "认领",
  dismiss: "忽略",
  chooseTicket: "选择 ticket",
  suggestCreate: (key: string) => `建议新建 ${key}`,
  colWhere: "目录 / 分支",
  colPrompt: "第一句话",
  colActivity: "最后活动",
  health: "环境检查",
  recheck: "重新检测",
  claudePath: "claude 路径",
  claudeVersion: "版本",
  missingFlags: "缺少的参数",
  notFound: "未找到",
  hooks: "Claude Code hook",
  hookStatus: {
    installed: "已安装",
    missing: "未安装",
    partial: "部分缺失",
    stale: "路径已过期",
    settings_invalid: "settings.json 格式损坏，Butler 不会修改它",
  } as Record<string, string>,
  installHooks: "安装 / 修复",
  uninstallHooks: "卸载",
  hookExplain: "Butler 往 Claude Code 的 settings.json 里加 4 个 hook（SessionStart、Stop、UserPromptSubmit、SessionEnd），只写本地文件，不联网。你原有的 hook 不受影响。",
  butlerHome: "Butler 数据目录",
  claudeSettings: "Claude Code 设置文件",
  loading: "加载中…",
};
```

`src/renderer/src/group.ts`:
```ts
import type { TicketStatus, TicketView } from "../../shared/types";
import { STATUS_ORDER } from "./strings";

export function groupTickets(tickets: TicketView[]): { status: TicketStatus; tickets: TicketView[] }[] {
  return STATUS_ORDER.map((status) => ({
    status,
    tickets: tickets
      .filter((t) => t.effectiveStatus === status)
      .sort((a, b) => Number(b.waiting) - Number(a.waiting) || a.key.localeCompare(b.key)),
  })).filter((g) => g.tickets.length > 0);
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/renderer`
Expected: PASS。

- [ ] **Step 5: 写 api.ts**

`src/renderer/src/api.ts`:
```ts
import { IPC, type IpcResult } from "../../shared/ipc";
import type {
  CreateTicketInput, HealthReport, OpenSessionRequest, OpenSessionResult, Ticket, TicketStatus, TicketView, UnclaimedSession,
} from "../../shared/types";

declare global {
  interface Window {
    butler: {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>;
      send(channel: string, ...args: unknown[]): void;
      on(channel: string, cb: (...args: never[]) => void): () => void;
    };
  }
}

export class ButlerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await window.butler.invoke(channel, ...args)) as IpcResult<T>;
  if (!r.ok) throw new ButlerError(r.code, r.message);
  return r.value;
}

export const api = {
  listTickets: () => call<TicketView[]>(IPC.ticketsList),
  createTicket: (input: CreateTicketInput) => call<Ticket>(IPC.ticketsCreate, input),
  setStatus: (key: string, status: TicketStatus | null) => call<void>(IPC.ticketsSetStatus, key, status),
  archive: (key: string) => call<void>(IPC.ticketsArchive, key),
  switchBranch: (key: string) => call<void>(IPC.ticketsSwitchBranch, key),
  openSession: (req: OpenSessionRequest) => call<OpenSessionResult>(IPC.sessionsOpen, req),
  unclaimed: () => call<UnclaimedSession[]>(IPC.sessionsUnclaimed),
  claim: (sessionId: string, ticketKey: string) => call<void>(IPC.sessionsClaim, sessionId, ticketKey),
  dismiss: (sessionId: string) => call<void>(IPC.sessionsDismiss, sessionId),
  ptySnapshot: (termId: string) => call<string>(IPC.ptySnapshot, termId),
  ptyKill: (termId: string) => call<void>(IPC.ptyKill, termId),
  ptyWrite: (termId: string, data: string) => window.butler.send(IPC.ptyWrite, termId, data),
  ptyResize: (termId: string, cols: number, rows: number) => window.butler.send(IPC.ptyResize, termId, cols, rows),
  health: () => call<HealthReport>(IPC.healthGet),
  installHooks: () => call<HealthReport>(IPC.healthInstallHooks),
  uninstallHooks: () => call<HealthReport>(IPC.healthUninstallHooks),
  pickDirectory: () => call<string | null>(IPC.dialogPickDir),
  onPtyData: (cb: (termId: string, data: string) => void) => window.butler.on(IPC.ptyData, cb),
  onPtyExit: (cb: (termId: string, code: number) => void) => window.butler.on(IPC.ptyExit, cb),
  onStateChanged: (cb: () => void) => window.butler.on(IPC.stateChanged, cb),
};
```

- [ ] **Step 6: 写组件**

`src/renderer/src/components/Sidebar.tsx`:
```tsx
import type { TicketView } from "../../../shared/types";
import type { Route } from "../App";
import { groupTickets } from "../group";
import { S, STATUS_LABEL } from "../strings";

interface Props {
  tickets: TicketView[];
  unclaimedCount: number;
  route: Route;
  onNavigate: (r: Route) => void;
  onNew: () => void;
}

const cls = (base: string, active: boolean) => (active ? `${base} active` : base);

export function Sidebar({ tickets, unclaimedCount, route, onNavigate, onNew }: Props) {
  return (
    <nav className="sidebar">
      <button className={cls("nav", route.page === "home")} onClick={() => onNavigate({ page: "home" })}>{S.home}</button>
      <button className="new-ticket" onClick={onNew}>+ {S.newTicket}</button>
      <div className="ticket-groups">
        {groupTickets(tickets).map((g) => (
          <section key={g.status}>
            <h3>{STATUS_LABEL[g.status]}</h3>
            {g.tickets.map((t) => (
              <button
                key={t.key}
                className={cls("ticket", route.page === "ticket" && route.key === t.key)}
                onClick={() => onNavigate({ page: "ticket", key: t.key })}
              >
                <span className="key">{t.key}</span>
                {t.title && <span className="title">{t.title}</span>}
                {t.waiting && <span className="badge" title={S.waiting}>●</span>}
              </button>
            ))}
          </section>
        ))}
      </div>
      <button className={cls("nav", route.page === "unclaimed")} onClick={() => onNavigate({ page: "unclaimed" })}>
        {S.unclaimed}{unclaimedCount > 0 ? ` (${unclaimedCount})` : ""}
      </button>
      <button className={cls("nav", route.page === "settings")} onClick={() => onNavigate({ page: "settings" })}>{S.settings}</button>
    </nav>
  );
}
```

`src/renderer/src/components/HomePage.tsx`:
```tsx
import type { TicketView } from "../../../shared/types";
import { S, STATUS_LABEL } from "../strings";

export function HomePage({ tickets, onOpen }: { tickets: TicketView[]; onOpen: (key: string) => void }) {
  if (tickets.length === 0) return <p className="empty">{S.noTickets}</p>;
  const waiting = tickets.filter((t) => t.waiting);
  return (
    <div className="page">
      <h2>{S.waitingList}</h2>
      {waiting.length === 0 ? (
        <p className="empty">{S.nothingWaiting}</p>
      ) : (
        <ul className="card-list">
          {waiting.map((t) => (
            <li key={t.key}>
              <button className="card" onClick={() => onOpen(t.key)}>
                <span className="key">{t.key}</span>
                {t.title && <span className="title">{t.title}</span>}
                <span className="muted">{STATUS_LABEL[t.effectiveStatus]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`src/renderer/src/components/NewTicketDialog.tsx`:
```tsx
import { useState, type FormEvent } from "react";
import type { WorkMode } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { S } from "../strings";

export function NewTicketDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [workMode, setWorkMode] = useState<WorkMode>("worktree");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick() {
    const dir = await api.pickDirectory();
    if (dir) setRepoPath(dir);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api.createTicket({ key, title, repoPath, workMode, branch: branch || undefined });
      onCreated(t.key);
    } catch (err) {
      setError(err instanceof ButlerError ? (S.createErrors[err.code] ?? err.message) : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>{S.newTicket}</h2>
        <label>{S.ticketKey}<input value={key} onChange={(e) => setKey(e.target.value)} placeholder="PROJ-123" autoFocus required /></label>
        <label>{S.title}<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>
          {S.repo}
          <div className="row">
            <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} required />
            <button type="button" onClick={pick}>{S.pick}</button>
          </div>
        </label>
        <fieldset>
          <legend>{S.workMode}</legend>
          <label className="inline"><input type="radio" checked={workMode === "worktree"} onChange={() => setWorkMode("worktree")} />{S.worktree}</label>
          <label className="inline"><input type="radio" checked={workMode === "branch"} onChange={() => setWorkMode("branch")} />{S.branch}</label>
        </fieldset>
        <label>{S.branchName}<input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feature/PROJ-123" /></label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>{S.cancel}</button>
          <button type="submit" className="primary" disabled={busy}>{S.create}</button>
        </div>
      </form>
    </div>
  );
}
```

`src/renderer/src/components/TerminalPane.tsx`:
```tsx
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { S } from "../strings";

export function TerminalPane({ termId, visible, onClose }: { termId: string; visible: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    const term = new Terminal({ fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace', fontSize: 13, cursorBlink: true, scrollback: 10_000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    termRef.current = term;
    fitRef.current = fit;

    // 主进程按顺序发送数据事件和 invoke 的返回：快照返回之前收到的数据都已包含在快照里，直接丢弃。
    let ready = false;
    const offData = api.onPtyData((id, data) => {
      if (id === termId && ready) term.write(data);
    });
    const offExit = api.onPtyExit((id, code) => {
      if (id === termId) setExitCode(code);
    });
    void api.ptySnapshot(termId).then((snap) => {
      term.write(snap);
      ready = true;
    });

    const input = term.onData((d) => api.ptyWrite(termId, d));
    const doFit = () => {
      if (!ref.current || ref.current.offsetParent === null) return;
      fit.fit();
      api.ptyResize(termId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(ref.current!);

    return () => {
      ro.disconnect();
      offData();
      offExit();
      input.dispose();
      term.dispose();
    };
  }, [termId]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      const term = termRef.current;
      if (!term || !ref.current || ref.current.offsetParent === null) return;
      fitRef.current?.fit();
      api.ptyResize(termId, term.cols, term.rows);
      term.focus();
    });
  }, [visible, termId]);

  return (
    <div className="terminal-wrap" style={{ display: visible ? "flex" : "none" }}>
      {exitCode !== null && (
        <div className="exited">
          {S.exited(exitCode)} <button onClick={onClose}>{S.close}</button>
        </div>
      )}
      <div className="terminal" ref={ref} />
    </div>
  );
}
```

`src/renderer/src/components/TicketPage.tsx`:
```tsx
import { useEffect, useState } from "react";
import { TICKET_STATUSES, type OpenSessionRequest, type TicketStatus, type TicketView } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { S, STATUS_LABEL } from "../strings";
import { TerminalPane } from "./TerminalPane";

interface Mismatch {
  req: OpenSessionRequest;
  current: string;
  expected: string;
  dirty: boolean;
}

export function TicketPage({ ticket }: { ticket: TicketView }) {
  const openTerms = ticket.sessions.flatMap((s) => (s.termId ? [s.termId] : []));
  // panes 里保留已退出但还没关闭的终端，方便看到 claude 的报错输出。
  const [panes, setPanes] = useState<string[]>(openTerms);
  const [active, setActive] = useState<string | null>(openTerms[0] ?? null);
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openKey = openTerms.join(",");
  useEffect(() => {
    const ids = openKey ? openKey.split(",") : [];
    setPanes((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
  }, [openKey]);

  async function open(req: OpenSessionRequest) {
    setError(null);
    setMismatch(null);
    try {
      const r = await api.openSession(req);
      if (r.ok) {
        setPanes((prev) => (prev.includes(r.termId) ? prev : [...prev, r.termId]));
        setActive(r.termId);
      } else if (r.reason === "branch_mismatch") {
        setMismatch({ req, current: r.current, expected: r.expected, dirty: r.dirty });
      } else {
        setError(S.openErrors[r.reason]);
      }
    } catch (e) {
      setError(e instanceof ButlerError ? e.message : (e as Error).message);
    }
  }

  async function switchAndOpen(m: Mismatch) {
    try {
      await api.switchBranch(ticket.key);
      await open(m.req);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function closePane(id: string) {
    setPanes((prev) => prev.filter((p) => p !== id));
    if (active === id) setActive(panes.find((p) => p !== id) ?? null);
  }

  const statusValue = ticket.statusManual ?? "auto";

  return (
    <div className="ticket-page">
      <header className="ticket-header">
        <h2>{ticket.key}{ticket.title && <span className="title"> · {ticket.title}</span>}</h2>
        <span className="muted">{ticket.workMode === "worktree" ? ticket.worktreePath : `${ticket.repoPath} @ ${ticket.branch}`}</span>
        <select
          value={statusValue}
          onChange={(e) => void api.setStatus(ticket.key, e.target.value === "auto" ? null : (e.target.value as TicketStatus))}
        >
          <option value="auto">{S.statusAuto(STATUS_LABEL[ticket.status])}</option>
          {TICKET_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <button onClick={() => void api.archive(ticket.key)}>{S.archive}</button>
      </header>

      <div className="sessions-bar">
        {ticket.sessions.length === 0 && <span className="muted">{S.noSessions}</span>}
        {ticket.sessions.map((s) => (
          <button
            key={s.id}
            className={s.termId && s.termId === active ? "session active" : "session"}
            title={s.firstPrompt ?? s.id}
            onClick={() => (s.termId ? setActive(s.termId) : void open({ ticketKey: ticket.key, sessionId: s.id }))}
          >
            {s.waitingForInput && <span className="badge">●</span>}
            {s.id.slice(0, 8)}
            <span className="muted">{s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : ""}</span>
            <span className="action">{s.termId ? S.switchTo : S.open}</span>
          </button>
        ))}
        <button className="primary" onClick={() => void open({ ticketKey: ticket.key })}>+ {S.newSession}</button>
      </div>

      {error && <p className="error">{error}</p>}
      {mismatch && (
        <div className="notice">
          <p>{S.branchMismatch(mismatch.current, mismatch.expected)}</p>
          {mismatch.dirty && <p className="error">{S.dirtyWarning}</p>}
          <div className="actions">
            <button disabled={mismatch.dirty} onClick={() => void switchAndOpen(mismatch)}>{S.switchAndOpen}</button>
            <button onClick={() => void open({ ...mismatch.req, force: true })}>{S.openAnyway}</button>
            <button onClick={() => setMismatch(null)}>{S.cancel}</button>
          </div>
        </div>
      )}

      <div className="terminals">
        {panes.map((id) => <TerminalPane key={id} termId={id} visible={id === active} onClose={() => closePane(id)} />)}
      </div>
    </div>
  );
}
```

`src/renderer/src/components/UnclaimedPage.tsx`:
```tsx
import { useCallback, useEffect, useState } from "react";
import type { TicketView, UnclaimedSession } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";

export function UnclaimedPage({ tickets }: { tickets: TicketView[] }) {
  const [items, setItems] = useState<UnclaimedSession[] | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const load = useCallback(async () => setItems(await api.unclaimed()), []);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  if (!items) return <p className="empty">{S.loading}</p>;
  if (items.length === 0) return <p className="empty">{S.noUnclaimed}</p>;

  return (
    <div className="page">
      <h2>{S.unclaimed}</h2>
      <p className="muted">{S.unclaimedHint}</p>
      <table className="table">
        <thead>
          <tr><th>{S.colWhere}</th><th>{S.colPrompt}</th><th>{S.colActivity}</th><th /></tr>
        </thead>
        <tbody>
          {items.map((s) => {
            const selected = choice[s.id] ?? (s.suggestionExists ? s.suggestedTicket! : "");
            return (
              <tr key={s.id}>
                <td><div>{s.cwd}</div><div className="muted">{s.gitBranch ?? ""}</div></td>
                <td>{s.firstPrompt ?? ""}</td>
                <td className="muted">{s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : ""}</td>
                <td className="actions">
                  <select value={selected} onChange={(e) => setChoice({ ...choice, [s.id]: e.target.value })}>
                    <option value="">{S.chooseTicket}</option>
                    {tickets.map((t) => <option key={t.key} value={t.key}>{t.key}</option>)}
                  </select>
                  <button disabled={!selected} onClick={() => void api.claim(s.id, selected)}>{S.claim}</button>
                  <button onClick={() => void api.dismiss(s.id)}>{S.dismiss}</button>
                  {s.suggestedTicket && !s.suggestionExists && <span className="muted">{S.suggestCreate(s.suggestedTicket)}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

`src/renderer/src/components/SettingsPage.tsx`:
```tsx
import { useEffect, useState } from "react";
import type { HealthReport } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";

export function SettingsPage() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<HealthReport>) {
    setBusy(true);
    setError(null);
    try {
      setReport(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run(api.health);
  }, []);

  if (!report) return <p className="empty">{error ?? S.loading}</p>;
  const { claude } = report;

  return (
    <div className="page">
      <h2>{S.health}</h2>
      <dl className="kv">
        <dt>{S.claudePath}</dt><dd>{claude.path ?? <span className="error">{S.notFound}</span>}</dd>
        <dt>{S.claudeVersion}</dt><dd>{claude.version ?? "—"}</dd>
        {claude.missingFlags.length > 0 && (<><dt>{S.missingFlags}</dt><dd className="error">{claude.missingFlags.join(" ")}</dd></>)}
        {claude.error && claude.error !== "claude_not_found" && (<><dt /><dd className="error">{claude.error}</dd></>)}
        <dt>{S.hooks}</dt><dd className={report.hooks === "installed" ? "ok" : "error"}>{S.hookStatus[report.hooks]}</dd>
        <dt>{S.butlerHome}</dt><dd>{report.butlerHome}</dd>
        <dt>{S.claudeSettings}</dt><dd>{report.claudeSettingsPath}</dd>
      </dl>
      <p className="muted">{S.hookExplain}</p>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button disabled={busy} onClick={() => void run(api.health)}>{S.recheck}</button>
        <button className="primary" disabled={busy || report.hooks === "settings_invalid"} onClick={() => void run(api.installHooks)}>{S.installHooks}</button>
        <button disabled={busy || report.hooks === "missing"} onClick={() => void run(api.uninstallHooks)}>{S.uninstallHooks}</button>
      </div>
    </div>
  );
}
```

`src/renderer/src/App.tsx`（整体替换）:
```tsx
import { useCallback, useEffect, useState } from "react";
import type { TicketView } from "../../shared/types";
import { api } from "./api";
import { HomePage } from "./components/HomePage";
import { NewTicketDialog } from "./components/NewTicketDialog";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { TicketPage } from "./components/TicketPage";
import { UnclaimedPage } from "./components/UnclaimedPage";

export type Route = { page: "home" } | { page: "ticket"; key: string } | { page: "unclaimed" } | { page: "settings" };

export function App() {
  const [route, setRoute] = useState<Route>({ page: "home" });
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const [showNew, setShowNew] = useState(false);

  const refresh = useCallback(async () => {
    const [t, u] = await Promise.all([api.listTickets(), api.unclaimed()]);
    setTickets(t);
    setUnclaimedCount(u.length);
  }, []);

  useEffect(() => {
    void refresh();
    return api.onStateChanged(() => void refresh());
  }, [refresh]);

  const current = route.page === "ticket" ? (tickets.find((t) => t.key === route.key) ?? null) : null;

  return (
    <div className="app">
      <Sidebar tickets={tickets} unclaimedCount={unclaimedCount} route={route} onNavigate={setRoute} onNew={() => setShowNew(true)} />
      <main className="main">
        {route.page === "home" && <HomePage tickets={tickets} onOpen={(key) => setRoute({ page: "ticket", key })} />}
        {route.page === "ticket" && current && <TicketPage key={current.key} ticket={current} />}
        {route.page === "unclaimed" && <UnclaimedPage tickets={tickets} />}
        {route.page === "settings" && <SettingsPage />}
      </main>
      {showNew && (
        <NewTicketDialog
          onClose={() => setShowNew(false)}
          onCreated={(key) => {
            setShowNew(false);
            setRoute({ page: "ticket", key });
            void refresh();
          }}
        />
      )}
    </div>
  );
}
```

`src/renderer/src/main.tsx`（整体替换）:
```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
```

`src/renderer/src/styles.css`:
```css
:root {
  --bg: #ffffff;
  --panel: #f5f5f4;
  --border: #e2e2df;
  --text: #1c1c1a;
  --muted: #74746f;
  --accent: #2f6fdf;
  --danger: #c2410c;
  --ok: #15803d;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1b1a;
    --panel: #242422;
    --border: #3a3a37;
    --text: #ececea;
    --muted: #9b9b96;
    --accent: #6b9cf0;
    --danger: #f08a5d;
    --ok: #4ade80;
  }
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 13px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
button, input, select { font: inherit; color: inherit; }
button { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
input, select { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
.muted { color: var(--muted); }
.error { color: var(--danger); }
.ok { color: var(--ok); }
.badge { color: var(--accent); margin: 0 4px; }

.app { display: flex; height: 100%; }
.sidebar { width: 240px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; padding: 10px; background: var(--panel); border-right: 1px solid var(--border); }
.sidebar .nav, .sidebar .ticket, .sidebar .new-ticket { text-align: left; border-color: transparent; background: transparent; }
.sidebar .active { background: var(--bg); border-color: var(--border); }
.sidebar .ticket-groups { flex: 1; overflow-y: auto; }
.sidebar h3 { margin: 12px 4px 4px; font-size: 11px; font-weight: 600; color: var(--muted); }
.sidebar .ticket { display: flex; width: 100%; gap: 6px; align-items: baseline; }
.sidebar .ticket .title { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.key { font-weight: 600; }

.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.page { padding: 20px 24px; overflow-y: auto; }
.empty { padding: 24px; color: var(--muted); }
.card-list { list-style: none; padding: 0; display: grid; gap: 8px; }
.card { width: 100%; display: flex; gap: 10px; text-align: left; padding: 10px 12px; }

.ticket-page { display: flex; flex-direction: column; height: 100%; }
.ticket-header { display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); }
.ticket-header h2 { margin: 0; font-size: 15px; }
.ticket-header .muted { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sessions-bar { display: flex; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--border); overflow-x: auto; }
.session { display: flex; gap: 6px; white-space: nowrap; }
.session.active { border-color: var(--accent); }
.session .action { color: var(--accent); }
.notice { margin: 8px 16px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.terminals { flex: 1; min-height: 0; display: flex; }
.terminal-wrap { flex: 1; min-width: 0; flex-direction: column; background: #000; }
.terminal { flex: 1; min-height: 0; padding: 4px; }
.exited { padding: 6px 12px; background: var(--panel); color: var(--danger); }

.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row { display: flex; gap: 6px; }
.row input { flex: 1; }
.modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; }
.modal { width: 460px; display: flex; flex-direction: column; gap: 10px; padding: 20px; border-radius: 10px; background: var(--bg); border: 1px solid var(--border); }
.modal label { display: flex; flex-direction: column; gap: 4px; }
.modal label.inline { flex-direction: row; align-items: center; gap: 6px; }
.modal fieldset { border: 1px solid var(--border); border-radius: 6px; display: flex; gap: 16px; }
.modal .actions { justify-content: flex-end; }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; word-break: break-all; }
```

- [ ] **Step 7: 检查**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: 全部通过。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: renderer UI with ticket sidebar, embedded terminals, unclaimed and settings pages"
```

---

### Task 12: 主进程组装、托盘与端到端手动验证

**Files:**
- Create: `src/main/tray-bitmap.ts`, `src/main/tray-bitmap.test.ts`
- Modify: `src/main/index.ts`（整体替换）

**Interfaces:**
- Consumes: 前面所有任务的产出
- Produces: 可以日常使用的 app（`pnpm build:hook && pnpm dev`）

- [ ] **Step 1: 写托盘位图的失败测试**

`src/main/tray-bitmap.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { circleBitmap } from "./tray-bitmap";

describe("circleBitmap", () => {
  it("draws an opaque centre and transparent corners in BGRA", () => {
    const size = 16;
    const buf = circleBitmap(size, [0x10, 0x20, 0x30]);
    expect(buf).toHaveLength(size * size * 4);
    const px = (x: number, y: number) => [...buf.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    expect(px(8, 8)).toEqual([0x10, 0x20, 0x30, 255]);
    expect(px(0, 0)[3]).toBe(0);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/tray-bitmap.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 tray-bitmap.ts**

`src/main/tray-bitmap.ts`:
```ts
/** 画一个抗锯齿的实心圆，BGRA 原始像素，供 nativeImage.createFromBitmap 使用（不需要图片资源文件）。 */
export function circleBitmap(size: number, bgr: [number, number, number]): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = d <= r ? 255 : d <= r + 1 ? Math.round(255 * (r + 1 - d)) : 0;
      const i = (y * size + x) * 4;
      buf[i] = bgr[0];
      buf[i + 1] = bgr[1];
      buf[i + 2] = bgr[2];
      buf[i + 3] = alpha;
    }
  }
  return buf;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/tray-bitmap.test.ts`
Expected: PASS。

- [ ] **Step 5: 重写 index.ts**

`src/main/index.ts`（整体替换）:
```ts
import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { IPC } from "../shared/ipc";
import { openDatabase } from "./db/database";
import { SessionsRepo } from "./db/sessions-repo";
import { SettingsRepo } from "./db/settings-repo";
import { TicketsRepo } from "./db/tickets-repo";
import { HealthService } from "./hooks/health";
import { applyHookEnvelope } from "./hooks/hook-events";
import { HookInbox } from "./hooks/inbox";
import { registerIpc } from "./ipc/register";
import { ensureDirs, resolvePaths } from "./paths";
import { scanClaudeProjects, syncDiscovered, UNCLAIMED_WINDOW_MS } from "./sessions/discovery";
import { PtyManager } from "./sessions/pty-manager";
import { nodePtyFactory } from "./sessions/pty-node";
import { SessionService } from "./sessions/session-service";
import { runSmoke } from "./smoke";
import { TicketService } from "./tickets/ticket-service";
import { circleBitmap } from "./tray-bitmap";

const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function bundledHookPath(): string {
  const name = process.platform === "win32" ? "butler-hook.exe" : "butler-hook";
  return app.isPackaged ? join(process.resourcesPath, "hook", name) : join(app.getAppPath(), "build", "hook", name);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "Butler",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.on("ready-to-show", () => w.show());
  // 关窗口只是藏到托盘，终端进程继续运行。
  w.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(join(__dirname, "../renderer/index.html"));
  return w;
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray(): Tray {
  const isMac = process.platform === "darwin";
  const icon = nativeImage.createFromBitmap(circleBitmap(16, isMac ? [0, 0, 0] : [0xdf, 0x6f, 0x2f]), { width: 16, height: 16 });
  if (isMac) icon.setTemplateImage(true);
  const t = new Tray(icon);
  t.setToolTip("Butler");
  t.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Butler", click: showWindow },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  t.on("click", showWindow);
  return t;
}

async function bootstrap(): Promise<void> {
  const paths = resolvePaths();
  await ensureDirs(paths);
  const db = openDatabase(paths.db);
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const settings = new SettingsRepo(db);
  const ticketService = new TicketService({ tickets, settings, now: Date.now });
  const health = new HealthService({ paths, platform: process.platform, env: process.env, settings, bundledHookBin: bundledHookPath() });
  await health.refresh();

  const notify = () => win?.webContents.send(IPC.stateChanged);
  const pty = new PtyManager(nodePtyFactory, {
    data: (id, data) => win?.webContents.send(IPC.ptyData, id, data),
    exit: (id, code) => {
      win?.webContents.send(IPC.ptyExit, id, code);
      notify();
    },
  });
  const sessionService = new SessionService({
    tickets, sessions, settings, ticketService, pty,
    claude: () => health.claude(),
    newId: randomUUID,
    now: Date.now,
    platform: process.platform,
    baseEnv: process.env,
  });

  const runDiscovery = async () => {
    try {
      syncDiscovered(await scanClaudeProjects(paths.claudeProjects, Date.now() - UNCLAIMED_WINDOW_MS), sessions, Date.now());
      notify();
    } catch (e) {
      console.error("discovery failed", e);
    }
  };

  const inbox = new HookInbox({
    dir: paths.inbox,
    badDir: paths.inboxBad,
    log: (m) => console.warn(m),
    handle: (env) => {
      const effect = applyHookEnvelope(env, { sessions, tickets });
      if (effect.kind !== "ignored") notify();
    },
  });

  registerIpc({ tickets, ticketService, sessionService, pty, health, window: () => win, now: Date.now, notify });

  win = createWindow();
  tray = createTray();
  inbox.start();
  void runDiscovery();
  const discoveryTimer = setInterval(() => void runDiscovery(), DISCOVERY_INTERVAL_MS);

  app.on("will-quit", () => {
    clearInterval(discoveryTimer);
    inbox.stop();
    pty.killAll();
    tray?.destroy();
    db.close();
  });
}

if (process.argv.includes("--smoke")) {
  void runSmoke().then((code) => app.exit(code));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    quitting = true;
  });
  // 常驻托盘：窗口全部关闭也不退出。
  app.on("window-all-closed", () => undefined);
  void app
    .whenReady()
    .then(bootstrap)
    .catch((e: unknown) => {
      dialog.showErrorBox("Butler 启动失败", e instanceof Error ? (e.stack ?? e.message) : String(e));
      app.exit(1);
    });
}
```

（`tray` 放在模块作用域，是为了防止托盘图标被垃圾回收。）

- [ ] **Step 6: 自动检查**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm exec electron out/main/index.js --smoke`
Expected: 全部通过，冒烟测试仍输出 `sqlite-ok 1` 和 `pty-ok`。

- [ ] **Step 7: 端到端手动验证**

先准备：`pnpm build:hook`，然后建一个练习用的仓库：
```bash
mkdir -p ~/butler-playground/demo && cd ~/butler-playground/demo && git init -b main && echo hi > a.txt && git add . && git commit -m init
```
回到 Butler 目录执行 `pnpm dev`，逐项检查，任何一项不符合就停下来按 superpowers:systematic-debugging 排查：

1. **设置页**：显示 claude 路径和版本，“缺少的参数”为空；hook 状态为“未安装”。点“安装 / 修复” → 变为“已安装”；`~/.claude/settings.json` 里原有内容保留，多了 4 个 butler-hook 条目，同目录出现 `settings.json.butler-backup`。
2. **新建 ticket**：`DEMO-1`，选 `~/butler-playground/demo`，选 worktree → 侧栏“进行中”出现 DEMO-1；磁盘上出现 `~/butler-playground/demo-worktrees/DEMO-1`。
3. **新 session**：点“+ 新 session” → 终端里启动 claude，界面正常（颜色、中文、光标），能输入。
4. **等你输入标记**：让 claude 回答一句话；回答结束后，侧栏 DEMO-1 和 session 标签出现 ●。你再输入时 ● 消失。
5. **托盘常驻**：关窗口 → app 不退出；点托盘图标重新打开 → 终端还在，内容回放正确。
6. **切换 ticket 后回来**：新建 DEMO-2 并打开，再切回 DEMO-1 → 终端内容回放，继续可用。
7. **/clear**：在 DEMO-1 的终端里执行 `/clear` → session 列表的 id 变成新的；再点这个 session 只是切换，不会启动第二个 claude。
8. **退出后续接**：托盘 → 退出；重新 `pnpm dev`；打开 DEMO-1，点 session 的“打开” → `claude --resume` 恢复到之前的对话。
9. **branch 模式**：新建 `DEMO-3`，选“在原目录用分支” → 打开 session 时提示分支不一致；在 `demo` 目录里改一个文件后再试 → 出现“有未提交的改动”，“切换分支并打开”不可点；还原后点“切换分支并打开” → 成功启动。
10. **未认领**：在系统终端里 `cd ~/butler-playground/demo && git checkout -b feature/demo-9 && claude`，说一句话后退出 → 5 分钟内（或重启 Butler 后立刻）“未认领 session”里出现这条，并建议 `DEMO-9`；新建 DEMO-9（branch 模式，分支名填 `feature/demo-9`）后再回来认领 → 它出现在 DEMO-9 下，可以续接。
11. **卸载 hook**：设置页点“卸载” → `settings.json` 只剩你原有的内容。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: wire up main process with tray, hook inbox and session discovery"
```

---

## 计划完成后

- 计划 1 结束时，Butler 已经可以每天用来管理多个 ticket 的 Claude Code session。
- 接下来写计划 2（Handoff 采集、followups、规则简报、调度），基于本计划落地的 `SessionsRepo`、`SessionService`、`PtyManager.prefill`、`applyHookEnvelope`（`Stop` 事件会扩展为解析 `/handoff` 输出），以及设计文档 13.1 节的验证结果。
