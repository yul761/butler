# Butler 计划 4：StateCore 记忆层、记忆标签、设置补全与首次启动向导 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每次 handoff 之后，Butler 把进度、决策、未完成的 followup 和经验确定性地写进本地 StateCore（设计文档第 8 节）；Butler 启动的每个 Claude Code session 都通过 `--mcp-config` 挂上按 ticket 划分 scope 的 StateCore MCP（另挂一个 `workspace` 实例），能 `recall` 到这些记忆；ticket 详情页多一个“记忆”标签，每条都能看 `why` 链。`full` 档位下，claude 里 `consolidate` 进来的原始事件只在主进程里、只经 PrivacyGateway 蒸馏（带审计和预算），任何 StateCore 进程都拿不到 key。另外补全设置页（claude 路径、分支名模板、ticket 号正则、记忆开关、开机自启），加上首次启动向导。

**Architecture:** 新目录 `src/main/memory/`：`statecore.ts` 是全仓库唯一 import `statecore-mcp/lib` 的生产代码（ESLint 强制），把嵌入式后端包成每次操作“打开 → 做事 → 关闭”的 `withScope()`；`notes.ts` 是纯函数：从 app.db 算出这个 ticket 在 StateCore 里“应该有”的条目，再和现有条目比对出要 forget / remember 的差异（`remember` 没有 key 参数，按设计文档 13.1 的结论用 `[decision:<key>]` / `[followup:<id>]` 稳定前缀 + 先 forget 再 remember）；`memory-service.ts` 串行执行同步、蒸馏和读取，永不抛错。给 claude 挂的 MCP 是 `statecore-mcp` 的 bin 用 esbuild 打成的单文件（`build/memory-mcp/statecore-mcp.cjs`），由 Butler 自己的 Electron 以 `ELECTRON_RUN_AS_NODE=1` 运行，入口先清掉环境变量里所有模型相关的变量。`full` 档位的蒸馏走 StateCore 自带的 `digestLlm` 注入点：`PrivacyGateway.statecoreModel()` 返回一个 `chat(messages)` 对象，每次调用都在 gateway 里做档位检查、预算、审计（新列 `source = 'statecore'`）和发送，key 永远不离开 gateway。

**Tech Stack:** 计划 1–3 的全部依赖（Electron 44.9.0（内置 Node 24.22）、electron-vite 6.0.0、React 19.3.1、node:sqlite、vitest 5.0.5、TypeScript 5.9.3、zod 4.6.5、esbuild 0.28.2）。**新增一个运行时依赖**：`statecore-mcp@1.0.0`（npm，MIT，2026-09-24 发布，`engines.node >= 22.13`）。

**Spec:** `docs/superpowers/specs/2026-10-19-butler-design.md`（重点：第 8 节全部、9 节的记忆标签 / 设置 / 首次启动向导、2.2 节的开机自启、11 节的 “StateCore 写入与 why 链” 集成测试、13.1 节 `statecore-mcp/lib` 一行）。另见遗留清单 `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md` 末尾的 “Still open after plan 3”。

## 本计划在整体中的位置

| 计划 | 内容 | 结束时能做什么 |
|------|------|--------------|
| 1–3（已完成） | 框架、ticket、终端、hook、session 发现、handoff、简报、调度、隐私层、“今日重点”、审计 | 用 Butler 管理 ticket 的 session，每天有晚间小结和早间简报 |
| **4（本计划）** | StateCore 记忆层（写入、挂载、记忆标签、`full` 档位经 gateway 蒸馏）、设置补全、开机自启、首次启动向导 | 同一 ticket 的新 session 能 `recall` 到进度、决策和未完成的 followup；新用户有向导 |
| 5 | CSP、打包（不签名）、Windows 收尾、git 绝对路径、no-eval 规则、Playwright E2E（假 claude）、双平台 CI、开源文档 | 可发布的 v1.0 安装包和仓库 |

## Global Constraints

- 计划 1–3 的约束继续有效：路径一律用 `node:path`；prompt 永远不进 argv；新增 IPC 通道必须进白名单（`src/shared/ipc.test.ts`）；渲染进程不能 import `src/main/**`；UI 文案在 `src/renderer/src/strings.ts`，主进程给用户看的文案在 `src/main/strings.ts`；依赖版本精确锁定；每个任务结束时 `pnpm typecheck`、`pnpm lint`、`pnpm test` 必须通过；commit message 末尾加执行者 harness 署名提醒给出的 `Co-Authored-By:` 行（计划 1 Ruling R3）；数据库迁移只在 `MIGRATIONS` 末尾追加（本计划是第 4 条）；个人 API 的网络请求只能在 `src/main/gateway/**`。
- **R1（key 的交付）**：给 claude 挂的 statecore-mcp 实例（`--mcp-config` 文件）**永远拿不到任何模型 key**：配置文件里只有 `ELECTRON_RUN_AS_NODE`、`STATECORE_SCOPE`、`LOG_LEVEL` 三个变量，进程入口（`memory-mcp/entry.ts`）在加载 StateCore 之前用 `statecoreEnv()` 把 `MODEL_*`、`OPENAI_*`、`ANTHROPIC_*`、`FEATURE_LLM`、`STATECORE_DIGEST_THRESHOLD`（不区分大小写）从 `process.env` 里删掉，claude 传下来的也一样。主进程里的嵌入式后端同样用 `statecoreEnv(process.env)`。LLM 功能（蒸馏）只在 Butler 主进程里、只在隐私档位 `full` 时运行，模型只能是 `PrivacyGateway.statecoreModel()` 给的对象；它在 gateway 里注入 key、写审计（`source = 'statecore'`）、检查月度预算。**不做敏感信息扫描**：`full` 档位下设计文档 8.5 接受发送原始事件（Ruling P4-R1）。`statecoreEnv()` 改成只有一个参数、没有交出 key 的分支（Ruling P4-R3）。
- **R2**：永远不运行会改用户 Claude Code 配置的命令（`claude mcp add/remove`、`claude config set`、编辑 `~/.claude.json` 或 `~/.claude/settings.json`）。Butler 自己的“安装 hook”按钮是用户点击触发的既有功能，不在此列。测试永远不碰真实的 `~/.butler`、`~/.claude`，不调用真实的 LLM 服务商，也不运行真实的 claude（`headless.live.test.ts` 这个既有的 opt-in 测试除外）。
- **StateCore 的依赖方式**：npm 上的 `statecore-mcp@1.0.0`，精确锁定（Ruling P4-R2）。生产代码里只有 `src/main/memory/statecore.ts`（以及 `src/main/memory/**/*.test.ts`）能 import `statecore-mcp/lib`，只有 `memory-mcp/entry.ts` 能 import `statecore-mcp`；由 `eslint.config.mjs` 强制，`src/main/egress-lint.test.ts` 检查。
- **记忆写入全部是确定性路径**（设计文档 8.3）：Butler 自己写 StateCore 时从不调用 LLM（`backgroundDigest: false`，不用 `consolidate`）。
- StateCore 数据目录：`~/.butler/statecore`（`paths.statecore`，文件 `statecore.db`）。scope：每个 ticket 是 `ticket:<KEY>`，全局是 `workspace`。
- Butler 写进 StateCore 的 note 文本格式固定：`[decision:<id>] <正文>`、`[followup:<id>] <正文>`、`[learning:<KEY>] <正文>`；同一条目的变体写成 `[decision:<id>#<n> <区分词>…]`（n = 2..5，区分词是 3×(n−1) 个由 id 决定的 4 字母词）。id 最长 40、正文最长 360 个字符（StateCore 的 note 上限是 500）。
- 记忆功能的任何失败都只写日志：handoff 入库、简报、终端、gateway 的结果都不受影响。
- 挂给 claude 的 MCP server 名是 `butler-memory`（ticket scope）和 `butler-workspace`（workspace scope），不和用户自己装的 `statecore` 重名。
- 测试里用 StateCore 的真实嵌入式存储（临时目录），不 mock 它：设计文档 11 节要求 “StateCore 写入与 why 链” 的集成测试。

## Review Focus

1. **StateCore 打不开或被占用**（数据目录是个文件、没有写权限、claude 里挂的 MCP 正在写同一个库）：`syncTicket()` 照样 resolve，handoff 照常入库，同步游标不前进，下次再补。测试见任务 4（`never rejects and keeps the cursor when StateCore cannot open`）。
2. **完成后又重新打开的 followup、和以前某个被遗忘的条目一字不差的新文本**：StateCore 会把它当成已遗忘的事实永远隐藏（13.1 的 forget 语义）。Butler 必须发现“写了但看不见”，换 `#2` 变体前缀重写，记忆标签里能看到它。测试见任务 1（`a text identical to a forgotten note stays hidden; a variant prefix shows it`）和任务 4（`a reopened followup becomes visible again`）。
3. **用户的 shell 里导出了 `OPENAI_API_KEY` / `MODEL_API_KEY` / `FEATURE_LLM=true`**，claude 把自己的环境变量传给 MCP server：挂载的 StateCore 进程里这些变量必须不存在，`consolidate` 只能得到 “no model configured”。测试见任务 1（`never hands StateCore a model key from the environment`）和任务 7（`strips inherited model keys even when the parent passes them`）。
4. **蒸馏进行到一半时用户把档位从 `full` 改成别的、或打开了“发送前确认”**：后续每一次 `chat()` 都重新检查档位并拒绝，不发请求、不写 `sent` 审计行。测试见任务 5（`refuses every call once the level is no longer full or confirm is on`）。
5. **奇怪的 ticket 号和决策 key**（自定义 ticket 正则允许 `/`、空格；决策 key 里有 `]`、`#`、换行；正文超过 500 字）：mcp 配置文件名不会跑出 `mcpDir`，note 前缀能解析回来，正文被截断而不是被 StateCore 拒收。测试见任务 2（`sanitizes ids and truncates bodies`）和任务 7（`keeps the file for an odd ticket key inside mcpDir`）。

---

## 文件结构

```
package.json                       + statecore-mcp 1.0.0；build / predev / build:memory-mcp 脚本（任务 1、7）
eslint.config.mjs                  StateCore 只能经两个入口使用（任务 1）
tsconfig.node.json, vitest.config.mts  + memory-mcp/**（任务 7）
memory-mcp/                        给 claude 挂载的 StateCore MCP（任务 7）
  sanitize.ts                      清掉模型相关的环境变量
  clean-env.ts                     进程入口的第一步：sanitizeEnv(process.env)
  entry.ts                         import "./clean-env"; import "statecore-mcp";
  sanitize.test.ts, bundle.test.ts
scripts/build-memory-mcp.mjs       esbuild 打成 build/memory-mcp/statecore-mcp.cjs（任务 7）
src/
  shared/
    memory.ts                      记忆的共享类型、scope 名、note 文本格式（任务 1、2）
    settings.ts                    + 可编辑的 claudePath / branchTemplate / ticketPattern / memoryEnabled / onboardingDone（任务 9、10）
    llm.ts                         + AuditSource（任务 3）
    types.ts                       + HealthReport.memory、AutostartState（任务 9）
    ipc.ts                         + memoryView / memoryWhy / appAutostartGet / appAutostartSet（任务 8、9）
  main/
    paths.ts                       + statecore（任务 1）
    smoke.ts                       + statecore-ok（任务 1）
    autostart.ts                   开机自启状态（任务 9）
    gateway/
      statecore-env.ts             只剩“去掉模型变量”（任务 1）
      types.ts                     + StatecoreChatModel（任务 1）
      gateway.ts                   + statecoreModel()（任务 5）
    memory/
      statecore.ts                 唯一的 StateCore 适配层：withScope、listScopeNames（任务 1）
      notes.ts                     期望条目与差异计划（任务 2）
      memory-service.ts            同步、读取、蒸馏（任务 4、6）
      mcp-config.ts                mcp/<ticket>.json（任务 7）
      plugin-check.ts              检测用户另装的 StateCore 捕获插件（任务 9）
    db/
      migrations.ts                + 迁移 4：memory_sync、llm_audit.source、老用户跳过向导（任务 3）
      memory-sync-repo.ts          同步游标（任务 3）
      audit-repo.ts                + source（任务 3）
      settings-repo.ts             + memoryEnabled、onboardingDone 默认值（任务 3、4）
    settings/settings-values.ts    + 新设置的校验，ticket 正则的 ReDoS 检查（任务 9）
    schedule/daily-jobs.ts         晚间任务最后蒸馏（任务 6）
    sessions/session-service.ts    打开 session 时带 --mcp-config（任务 7）
    claude/spawn.ts                + cmdShimSafe（任务 7）
    hooks/health.ts                + 记忆 MCP / StateCore 插件状态（任务 9）
    ipc/register.ts, ipc/validate.ts  新通道与参数检查（任务 8、9）
    index.ts                       组装（任务 4、6、7、8、9）
  renderer/src/
    memory-view.ts                 记忆标签的小工具（任务 8）
    wizard.ts                      向导的步骤逻辑（任务 10）
    audit-view.ts                  + 来源标签（任务 5）
    components/MemoryPanel.tsx（任务 8）、GeneralSettings.tsx（任务 9）、Wizard.tsx（任务 10）
    components/TicketOverview.tsx  + “记忆”标签（任务 8）
    App.tsx                        首次启动向导（任务 10）
```

测试与源文件放在一起（`*.test.ts`）。

---

### Task 1: StateCore 依赖、唯一的适配层、只去不给的环境变量

先装上 `statecore-mcp@1.0.0` 并用一个小实验确认它在本机 Node 和 Electron 主进程里的真实行为（R5），再写 Butler 唯一的 StateCore 适配层 `withScope()` 和它的集成测试。同时把 `statecoreEnv()` 改成只剩“去掉模型变量”：从这一刻起，任何 StateCore 进程的环境变量里都不可能有 key（R1）。

**Files:**
- Modify: `package.json`（dependencies 加 `"statecore-mcp": "1.0.0"`）、`pnpm-lock.yaml`
- Modify: `eslint.config.mjs`
- Modify: `src/main/egress-lint.test.ts`
- Modify: `src/main/gateway/statecore-env.ts`、`src/main/gateway/statecore-env.test.ts`
- Modify: `src/main/gateway/types.ts`
- Modify: `src/main/paths.ts`、`src/main/paths.test.ts`
- Modify: `src/main/smoke.ts`
- Create: `src/shared/memory.ts`
- Create: `src/main/memory/statecore.ts`
- Test: `src/main/memory/statecore.test.ts`

**Interfaces:**
- Consumes: `tempDir()`（`src/main/test-utils.ts`）
- Produces:
  - `statecoreEnv(base: NodeJS.ProcessEnv): Record<string, string>`（`src/main/gateway/statecore-env.ts`，单参数）
  - `interface StatecoreChatModel { chat(messages: { role: "system" | "user"; content: string }[]): Promise<string> }`（`src/main/gateway/types.ts`）
  - `ButlerPaths.statecore: string`（`<BUTLER_HOME>/statecore`）
  - `src/shared/memory.ts`：`WORKSPACE_SCOPE`、`ticketScope(key)`、`MemoryItem`、`MemoryHandoff`、`WhyEntry`、`MemoryView`
  - `src/main/memory/statecore.ts`：
    - `type DigestOutcome = "ran" | "no-llm" | "below-threshold" | "locked" | "failed" | "unsupported"`
    - `interface ScopeHandle { remember(text): Promise<{ superseded: string | null }>; forget(factKey): Promise<void>; facts(): Promise<MemoryItem[]>; why(factId): Promise<WhyEntry[] | null>; handoff(h: { summary: string; nextSteps: string[]; openQuestions: string[] }): Promise<void>; activeHandoff(): Promise<MemoryHandoff | null>; pendingEvents(): Promise<number>; digestNow(): Promise<DigestOutcome> }`
    - `withScope<T>(o: { dataDir: string; scope: string; model?: StatecoreChatModel | null }, fn: (s: ScopeHandle) => Promise<T>): Promise<T>`
    - `listScopeNames(dataDir: string): Promise<string[]>`

- [ ] **Step 1: 安装依赖并做实验（spike）**

```bash
pnpm add statecore-mcp@1.0.0 --save-exact
```

然后在**一次** Bash 调用里跑下面的实验（只用临时目录，不联网、不碰 `~/.statecore`）：

```bash
set -eu
S="$(mktemp -d)"
cat > "$S/spike.cjs" <<'JS'
const { createEmbeddedBackend } = require(process.argv[2]);
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-spike-"));
  const b = createEmbeddedBackend({ dataDir: dir, scopeName: "ticket:PROJ-1", env: {}, backgroundDigest: false });
  await b.init();
  await b.remember({ text: "[decision:db] 用 PostgreSQL 存储会话" });
  await b.remember({ text: "[followup:f_1] 改 staging config（配置，合并后）" });
  await b.remember({ text: "[followup:f_2] 改 staging config（配置，部署后）" });
  let f = await b.facts();
  console.log("A three notes:", f[0].items.length);
  const old = f[0].items.find((i) => i.text.startsWith("[decision:db]"));
  await b.forget({ factKey: old.factKey });
  console.log("B revision:", JSON.stringify(await b.remember({ text: "[decision:db] 用 MySQL 存储会话" })));
  f = await b.facts();
  const cur = f[0].items.find((i) => i.text.startsWith("[decision:db]"));
  console.log("C chain length:", (await b.why({ factId: cur.factId })).chain.length);
  await b.forget({ factKey: cur.factKey });
  await b.remember({ text: "[decision:db] 用 MySQL 存储会话" });
  console.log("D same text visible:", (await b.facts())[0].items.some((i) => i.text === "[decision:db] 用 MySQL 存储会话"));
  await b.remember({ text: "[decision:db#2] 用 MySQL 存储会话" });
  console.log("E variant visible:", (await b.facts())[0].items.some((i) => i.text === "[decision:db#2] 用 MySQL 存储会话"));
  console.log("F consolidate:", JSON.stringify(await b.remember({ text: "raw", consolidate: true })), JSON.stringify(await b.digestNow()));
  await b.remember({ text: "[followup:f_3] 描述 f_3（配置，合并后）" });
  console.log("G cross-key:", JSON.stringify((await b.remember({ text: "[followup:f_4] 描述 f_4（配置，合并后）" })).superseded ?? null));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
JS
node "$S/spike.cjs" "$PWD/node_modules/statecore-mcp/dist/lib.js" 2>/dev/null
```

Expected（2026-10-21 在 statecore-mcp 1.0.0 的源码上实测过同样的脚本）：

```
A three notes: 3
B revision: {"ok":true,"mode":"note","superseded":"[decision:db] 用 PostgreSQL 存储会话"}
C chain length: 2
D same text visible: false
E variant visible: true
F consolidate: {"ok":true,"mode":"event","distillation":"deferred","reason":"background digest disabled"} {"ran":false,"reason":"no-llm"}
G cross-key: "[followup:f_3] 描述 f_3（配置，合并后）"
```

含义：A 正文有实质差别的两个 followup 互不影响；B/C forget 旧条目再 remember 新文本，旧版本留在 `why` 链上；D 和已遗忘条目一字不差的文本会被永久隐藏；E 换变体前缀就能看到；F 没有模型时不会蒸馏；G **正文几乎一样、只有 id 不同的两条，StateCore 会把后写的当成前一条的修订并挤掉前一条**（`isNoteRevision`：Jaccard ≥ 0.7）——任务 2 的变体前缀带一串区分词，任务 4 发现“挤掉了别的条目”时用它把被挤掉的写回去。**备选**：任何一行不一致，停下来把输出贴给控制者——D/E/G 不成立时任务 2、4 的变体逻辑要相应改；`statecore-mcp/lib` 在 Electron 里加载失败（Step 9 的冒烟）时，按设计文档 13 节的备选改成以 MCP 客户端方式访问 StateCore 子进程，这会改变本计划的结构，需要控制者重新裁定。

- [ ] **Step 2: 写失败测试（适配层 + 环境变量 + 路径）**

`src/main/gateway/statecore-env.test.ts` 整个替换为：

```ts
import { describe, expect, it } from "vitest";
import { statecoreEnv } from "./statecore-env";

describe("statecoreEnv (design 8.5, plan 4 R1)", () => {
  it("strips every model setting StateCore could use, at any letter case, and keeps the rest", () => {
    const dirty = {
      PATH: "/bin",
      HOME: "/h",
      MODEL_API_KEY: "a",
      MODEL_BASE_URL: "https://x",
      MODEL_NAME: "m",
      MODEL_STRUCTURED_OUTPUT_API_KEY: "d",
      OPENAI_API_KEY: "b",
      OPENAI_BASE_URL: "https://proxy.corp",
      OPENAI_MODEL: "g",
      ANTHROPIC_API_KEY: "c",
      model_api_key: "e",
      Feature_Llm: "true",
      FEATURE_LLM: "true",
      STATECORE_DIGEST_THRESHOLD: "1",
      UNSET: undefined,
    };
    expect(statecoreEnv(dirty)).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  it("never adds anything", () => {
    expect(statecoreEnv({})).toEqual({});
    expect(Object.keys(statecoreEnv({ STATECORE_SCOPE: "ticket:A-1", LOG_LEVEL: "warn" })).sort()).toEqual(["LOG_LEVEL", "STATECORE_SCOPE"]);
  });
});
```

`src/main/paths.test.ts` 最后一个用例里追加一行：

```ts
    expect(resolvePaths({}, "darwin", "/home/u").statecore).toBe(join("/home/u", ".butler", "statecore"));
```

新建 `src/main/memory/statecore.test.ts`：

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEmbeddedBackend } from "statecore-mcp/lib";
import { afterEach, describe, expect, it } from "vitest";
import { ticketScope, WORKSPACE_SCOPE } from "../../shared/memory";
import { tempDir } from "../test-utils";
import { listScopeNames, withScope } from "./statecore";

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

/** 直接用 StateCore 写一条 consolidate 事件（模拟 claude 里的 remember(consolidate: true)）。 */
async function seedEvent(dataDir: string, scope: string, text: string): Promise<void> {
  const b = createEmbeddedBackend({ dataDir, scopeName: scope, env: {}, backgroundDigest: false });
  await b.init();
  try {
    await b.remember({ text, consolidate: true });
  } finally {
    await b.close();
  }
}

describe("StateCore adapter (design 8, 11: write and why integration)", () => {
  it("remembers, lists and forgets notes, and keeps scopes apart", async () => {
    const dir = tempDir();
    await withScope({ dataDir: dir, scope: ticketScope("PROJ-1") }, async (s) => {
      expect(await s.remember("[decision:db] 用 PostgreSQL")).toEqual({ superseded: null });
      await s.remember("[followup:f_1] 改 staging 配置（配置，合并后）");
      const items = await s.facts();
      expect(items.map((i) => i.text)).toEqual(["[decision:db] 用 PostgreSQL", "[followup:f_1] 改 staging 配置（配置，合并后）"]);
      expect(items.every((i) => i.group === "Notes" && i.factKey.length === 16 && i.factId !== null && i.createdAt !== null)).toBe(true);
      await s.forget(items[0].factKey);
      expect((await s.facts()).map((i) => i.text)).toEqual(["[followup:f_1] 改 staging 配置（配置，合并后）"]);
    });
    await withScope({ dataDir: dir, scope: WORKSPACE_SCOPE }, async (s) => {
      expect(await s.facts()).toEqual([]);
    });
    expect((await listScopeNames(dir)).sort()).toEqual(["ticket:PROJ-1", "workspace"]);
  });

  it("forget then remember a revision keeps the old version on the why chain", async () => {
    const dir = tempDir();
    await withScope({ dataDir: dir, scope: "ticket:PROJ-2" }, async (s) => {
      await s.remember("[decision:db] 用 PostgreSQL 存储会话");
      const [old] = await s.facts();
      await s.forget(old.factKey);
      expect(await s.remember("[decision:db] 用 MySQL 存储会话")).toEqual({ superseded: "[decision:db] 用 PostgreSQL 存储会话" });
      const [cur] = await s.facts();
      const chain = await s.why(cur.factId!);
      expect(chain?.map((e) => e.content)).toEqual(["[decision:db] 用 PostgreSQL 存储会话", "[decision:db] 用 MySQL 存储会话"]);
      expect(chain?.[0].supersededBy).toBe(cur.factId);
      expect(chain?.[1]).toMatchObject({ supersededBy: null, retiredAt: null });
      expect(await s.why("no-such-id")).toBeNull();
    });
  });

  it("a text identical to a forgotten note stays hidden; a variant prefix shows it (design 13.1)", async () => {
    await withScope({ dataDir: tempDir(), scope: "ticket:PROJ-3" }, async (s) => {
      await s.remember("[followup:f_9] 部署后打开开关");
      const [item] = await s.facts();
      await s.forget(item.factKey);
      await s.remember("[followup:f_9] 部署后打开开关");
      expect(await s.facts()).toEqual([]);
      await s.remember("[followup:f_9#2] 部署后打开开关");
      expect((await s.facts()).map((i) => i.text)).toEqual(["[followup:f_9#2] 部署后打开开关"]);
    });
  });

  it("takes a note that differs from another only in its id for a revision of it (why variants carry distinguishing words)", async () => {
    await withScope({ dataDir: tempDir(), scope: "ticket:PROJ-9" }, async (s) => {
      await s.remember("[followup:f_3] 描述 f_3（配置，合并后）");
      expect(await s.remember("[followup:f_4] 描述 f_4（配置，合并后）")).toEqual({ superseded: "[followup:f_3] 描述 f_3（配置，合并后）" });
      expect((await s.facts()).map((i) => i.text)).toEqual(["[followup:f_4] 描述 f_4（配置，合并后）"]);
    });
  });

  it("stores a handoff that supersedes the previous one and walks its chain", async () => {
    await withScope({ dataDir: tempDir(), scope: "ticket:PROJ-4" }, async (s) => {
      expect(await s.activeHandoff()).toBeNull();
      await s.handoff({ summary: "状态：active。", nextSteps: ["写测试"], openQuestions: [] });
      await s.handoff({ summary: "状态：in_review。完成：写测试", nextSteps: ["等 review"], openQuestions: ["要不要拆 PR？"] });
      const h = await s.activeHandoff();
      expect(h).toMatchObject({ versionCount: 2 });
      expect(h?.content).toBe("状态：in_review。完成：写测试\nOpen questions:\n- 要不要拆 PR？\nNext steps:\n- 等 review");
      expect((await s.why(h!.id))?.map((e) => e.content.split("\n")[0])).toEqual(["状态：active。", "状态：in_review。完成：写测试"]);
    });
  });

  it("reports pending consolidate events and cannot digest without a model", async () => {
    const dir = tempDir();
    await seedEvent(dir, "ticket:PROJ-5", "claude 里记下的一段原始对话");
    await withScope({ dataDir: dir, scope: "ticket:PROJ-5" }, async (s) => {
      expect(await s.pendingEvents()).toBe(1);
      expect(await s.digestNow()).toBe("no-llm");
    });
  });

  it("never hands StateCore a model key from the environment (R1)", async () => {
    const dir = tempDir();
    await seedEvent(dir, "ticket:PROJ-6", "原始事件");
    process.env.FEATURE_LLM = "true";
    process.env.MODEL_API_KEY = "sk-inherited";
    process.env.OPENAI_API_KEY = "sk-inherited-2";
    await withScope({ dataDir: dir, scope: "ticket:PROJ-6" }, async (s) => {
      expect(await s.digestNow()).toBe("no-llm");
    });
  });

  it("digests through an injected model only", async () => {
    const dir = tempDir();
    await seedEvent(dir, "ticket:PROJ-7", "原始事件");
    const seen: string[] = [];
    const model = {
      chat: async (messages: { role: "system" | "user"; content: string }[]) => {
        seen.push(messages.map((m) => m.role).join(","));
        throw new Error("stub model");
      },
    };
    await withScope({ dataDir: dir, scope: "ticket:PROJ-7", model }, async (s) => {
      expect(await s.digestNow()).toBe("failed");
      expect(await s.pendingEvents()).toBe(1);
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("lists no scopes and creates nothing when the store does not exist", async () => {
    const dir = tempDir();
    expect(await listScopeNames(dir)).toEqual([]);
    expect(existsSync(join(dir, "statecore.db"))).toBe(false);
  });

  it("closes the store even when the callback throws", async () => {
    const dir = tempDir();
    await expect(withScope({ dataDir: dir, scope: "ticket:PROJ-8" }, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    // 关掉了才能再次打开并写入。
    await withScope({ dataDir: dir, scope: "ticket:PROJ-8" }, async (s) => {
      await s.remember("[decision:x] ok");
      expect(await s.facts()).toHaveLength(1);
    });
  });
});
```

在 `src/main/egress-lint.test.ts` 末尾追加：

```ts
describe("StateCore is reachable only through its two entry points (plan 4 R1)", () => {
  const probe = 'import { createEmbeddedBackend } from "statecore-mcp/lib";\nexport default createEmbeddedBackend;\n';
  async function statecoreMessages(filePath: string, text = probe) {
    const eslint = new ESLint({ cwd: root });
    const [result] = await eslint.lintText(text, { filePath });
    return result.messages.filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax");
  }

  it("flags statecore-mcp everywhere else, in every import form", async () => {
    for (const file of ["src/main/brief/x.ts", "src/main/memory/memory-service.ts", "src/renderer/src/x.tsx", "hook/x.ts", "memory-mcp/clean-env.ts", "src/main/brief/x.test.ts"]) {
      expect((await statecoreMessages(file)).length, file).toBeGreaterThan(0);
    }
    expect((await statecoreMessages("src/main/brief/x.ts", 'import "statecore-mcp";\n')).length).toBeGreaterThan(0);
    expect((await statecoreMessages("src/main/brief/x.ts", 'export const m = import("statecore-mcp/lib");\n')).length).toBeGreaterThan(0);
  }, 60_000);

  it("allows it in the adapter, its tests and the MCP entry", async () => {
    for (const file of ["src/main/memory/statecore.ts", "src/main/memory/statecore.test.ts", "memory-mcp/entry.ts"]) {
      expect(await statecoreMessages(file), file).toEqual([]);
    }
    expect(await statecoreMessages("memory-mcp/entry.ts", 'import "./clean-env";\nimport "statecore-mcp";\n')).toEqual([]);
  }, 60_000);
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/memory/statecore.test.ts src/main/gateway/statecore-env.test.ts src/main/paths.test.ts src/main/egress-lint.test.ts`
Expected: FAIL——`./statecore` 和 `../../shared/memory` 不存在；`statecoreEnv` 的新用例失败（旧实现需要 3 个参数）；`statecore` 路径是 undefined；StateCore 的 lint 用例失败（规则还没有）。

- [ ] **Step 4: 实现共享类型和环境变量**

`src/main/gateway/statecore-env.ts` 整个替换为：

```ts
const STRIPPED_PREFIXES = ["MODEL_", "OPENAI_", "ANTHROPIC_"];
const STRIPPED_NAMES = new Set(["FEATURE_LLM", "STATECORE_DIGEST_THRESHOLD"]);

/**
 * StateCore 进程（主进程里的嵌入式后端、给 claude 挂的 MCP）的环境变量（设计文档 8.5，计划 4 Ruling R1 / P4-R3）。
 * StateCore 的蒸馏会读 FEATURE_LLM 和 MODEL_*（再回退到 OPENAI_*，最后回退到 api.openai.com），把原始事件直接发给服务商。
 * Butler 不让任何 StateCore 进程走这条路：去掉这些变量（不区分大小写），也从不交出 key。
 * full 档位的蒸馏只在主进程里经 PrivacyGateway.statecoreModel() 进行，key 不离开 gateway。
 */
export function statecoreEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    const name = k.toUpperCase();
    if (v === undefined || STRIPPED_NAMES.has(name) || STRIPPED_PREFIXES.some((p) => name.startsWith(p))) continue;
    env[k] = v;
  }
  return env;
}
```

`src/main/gateway/types.ts` 末尾追加：

```ts
/**
 * StateCore 蒸馏用的模型（它的 DigestChatModel 注入点）。只有 PrivacyGateway.statecoreModel() 能造出来：
 * 每次 chat() 都在 gateway 里检查档位、预算，写审计，带上 key 发送（计划 4 R1）。
 */
export interface StatecoreChatModel {
  chat(messages: { role: "system" | "user"; content: string }[]): Promise<string>;
}
```

`src/main/paths.ts`：`ButlerPaths` 里 `mcp: string;` 之后加：

```ts
  /** StateCore 的嵌入式存储目录（里面是 statecore.db）。 */
  statecore: string;
```

`resolvePaths` 的返回对象里 `mcp: join(butlerHome, "mcp"),` 之后加：

```ts
    statecore: join(butlerHome, "statecore"),
```

`ensureDirs` 的目录列表改成：

```ts
  for (const dir of [p.home, p.inbox, p.inboxBad, p.bin, p.logs, p.mcp, p.statecore]) await mkdir(dir, { recursive: true });
```

新建 `src/shared/memory.ts`：

```ts
/**
 * StateCore 记忆（设计文档第 8 节）的共享类型。渲染进程也会 import：这里不能 import zod 或 Node 模块。
 */

/** 全局 scope：跨 ticket 的经验（learnings）。 */
export const WORKSPACE_SCOPE = "workspace";

/** 每个 ticket 一个 scope（设计文档 8.2）。 */
export function ticketScope(key: string): string {
  return `ticket:${key}`;
}

/** StateCore facts() 里的一条（只取 Butler 用得到的字段）。 */
export interface MemoryItem {
  /** forget 用的 key（分组名 + 正文的哈希）。 */
  factKey: string;
  /** why 用的 id；StateCore 没有登记的条目为 null。 */
  factId: string | null;
  text: string;
  /** ISO 时间。 */
  createdAt: string | null;
  /** StateCore 的展示分组，例如 Notes。 */
  group: string;
}

/** scope 当前的交接（StateCore 的 handoff）。 */
export interface MemoryHandoff {
  id: string;
  content: string;
  addedAt: string;
  /** 这个 scope 记录过多少次交接（含被取代的）。 */
  versionCount: number;
}

/** why 链上的一个版本，旧的在前。 */
export interface WhyEntry {
  id: string;
  content: string;
  addedAt: string;
  supersededBy: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
}

/** ticket 详情页“记忆”标签的数据。 */
export interface MemoryView {
  /** 设置里的记忆开关。 */
  enabled: boolean;
  scope: string;
  handoff: MemoryHandoff | null;
  items: MemoryItem[];
  /** 读 StateCore 失败时的原因。 */
  error: string | null;
}
```

- [ ] **Step 5: 实现适配层**

新建 `src/main/memory/statecore.ts`：

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEmbeddedBackend, listScopes } from "statecore-mcp/lib";
import { z } from "zod";
import type { MemoryHandoff, MemoryItem, WhyEntry } from "../../shared/memory";
import { statecoreEnv } from "../gateway/statecore-env";
import type { StatecoreChatModel } from "../gateway/types";

/**
 * Butler 里唯一 import statecore-mcp/lib 的生产代码（ESLint 强制，计划 4 R1）。
 * 每次操作都是“打开 → 做事 → 关闭”：同一个 statecore.db 还会被 claude 里挂的 MCP 进程同时打开（WAL + busy timeout），
 * 主进程不长期占着连接。StateCore 的返回值类型是 unknown，这里用 zod 校验成 Butler 自己的类型。
 */

export type DigestOutcome = "ran" | "no-llm" | "below-threshold" | "locked" | "failed" | "unsupported";

export interface ScopeHandle {
  /** 确定性地写一条 note（不经 LLM）。superseded：被它取代的旧 note 的原文。 */
  remember(text: string): Promise<{ superseded: string | null }>;
  forget(factKey: string): Promise<void>;
  facts(): Promise<MemoryItem[]>;
  /** 一条事实（或交接）从最早到最新的版本；id 不存在时为 null。 */
  why(factId: string): Promise<WhyEntry[] | null>;
  handoff(h: { summary: string; nextSteps: string[]; openQuestions: string[] }): Promise<void>;
  activeHandoff(): Promise<MemoryHandoff | null>;
  /** 等待蒸馏的 consolidate 事件数。 */
  pendingEvents(): Promise<number>;
  /** 立即蒸馏一次（只有 withScope 给了 model 才可能 ran）。 */
  digestNow(): Promise<DigestOutcome>;
}

const FactGroups = z.array(
  z.object({
    group: z.string(),
    items: z.array(z.object({ factKey: z.string(), text: z.string(), createdAt: z.string().nullable(), factId: z.string().nullable() })),
  }),
);
const RegistryEntry = z.object({
  id: z.string(),
  content: z.string(),
  addedAt: z.string(),
  supersededBy: z.string().optional(),
  retiredAt: z.string().optional(),
  retiredReason: z.string().optional(),
});
const WhyResult = z.object({ chain: z.array(RegistryEntry) }).nullable();
const RecallResult = z.object({
  handoff: z.object({ id: z.string(), content: z.string(), addedAt: z.string(), versionCount: z.number() }).nullable(),
});
const Remembered = z.object({ superseded: z.string().optional() });
const Pending = z.object({ events: z.number() }).nullable().optional();

type Backend = ReturnType<typeof createEmbeddedBackend>;

function handle(b: Backend): ScopeHandle {
  return {
    async remember(text) {
      const r = Remembered.parse(await b.remember({ text }));
      return { superseded: r.superseded ?? null };
    },
    async forget(factKey) {
      await b.forget({ factKey });
    },
    async facts() {
      return FactGroups.parse(await b.facts()).flatMap((g) =>
        g.items.map((i) => ({ factKey: i.factKey, factId: i.factId, text: i.text, createdAt: i.createdAt, group: g.group })),
      );
    },
    async why(factId) {
      const r = WhyResult.parse(await b.why({ factId }));
      return r
        ? r.chain.map((e) => ({
            id: e.id,
            content: e.content,
            addedAt: e.addedAt,
            supersededBy: e.supersededBy ?? null,
            retiredAt: e.retiredAt ?? null,
            retiredReason: e.retiredReason ?? null,
          }))
        : null;
    },
    async handoff(h) {
      await b.handoff({ summary: h.summary, nextSteps: h.nextSteps, openQuestions: h.openQuestions });
    },
    async activeHandoff() {
      return RecallResult.parse(await b.recall({})).handoff;
    },
    async pendingEvents() {
      return Pending.parse(await b.pendingEvents?.())?.events ?? 0;
    },
    async digestNow() {
      const r = await b.digestNow();
      return r.ran ? "ran" : r.reason;
    },
  };
}

/**
 * 打开一个 scope，执行 fn，然后一定关闭。环境变量一律经 statecoreEnv() 去掉模型相关的变量（R1）；
 * 后台蒸馏关闭（backgroundDigest: false：Butler 的写入是确定性的，不触发任何 LLM 调用）。
 * 只有给了 model（PrivacyGateway.statecoreModel() 的结果）时 digestNow() 才可能调用模型。
 */
export async function withScope<T>(
  o: { dataDir: string; scope: string; model?: StatecoreChatModel | null },
  fn: (s: ScopeHandle) => Promise<T>,
): Promise<T> {
  const backend = createEmbeddedBackend({
    dataDir: o.dataDir,
    scopeName: o.scope,
    env: statecoreEnv(process.env),
    backgroundDigest: false,
    ...(o.model ? { digestLlm: o.model } : {}),
  });
  try {
    await backend.init();
    return await fn(handle(backend));
  } finally {
    await backend.close();
  }
}

/** 存储里所有 scope 的名字；存储还不存在时返回空，不会创建它。 */
export async function listScopeNames(dataDir: string): Promise<string[]> {
  if (!existsSync(join(dataDir, "statecore.db"))) return [];
  return (await listScopes(dataDir)).map((s) => s.name);
}
```

- [ ] **Step 6: ESLint：StateCore 只能经两个入口使用**

`eslint.config.mjs`：在 `const GATEWAY_INTERNALS = ...` 那段注释之前插入：

```js
/**
 * StateCore（statecore-mcp）自带联网的 http 后端，还会按环境变量（FEATURE_LLM / MODEL_*）直接调用模型。
 * 只有这几处能用它：主进程的适配层 src/main/memory/statecore.ts（环境变量由 statecoreEnv() 生成，模型只能是 PrivacyGateway 给的）、
 * 它所在目录的测试，以及给 claude 挂载的 MCP 入口 memory-mcp/entry.ts（先清掉环境变量里的 key）。见计划 4 Ruling R1。
 */
const STATECORE_MESSAGE = "StateCore 只能经 src/main/memory/statecore.ts 或 memory-mcp/entry.ts 使用（计划 4 R1：模型 key 不能绕过 PrivacyGateway）。";
const STATECORE_ENTRY_FILES = ["src/main/memory/statecore.ts", "memory-mcp/entry.ts"];
const STATECORE_TEST_FILES = ["src/main/memory/**/*.test.ts"];
```

`DYNAMIC_MODULES` 那一行改成（动态 import 里也拦 statecore-mcp）：

```js
const DYNAMIC_MODULES = `/^(node:)?(${BANNED_BUILTINS.join("|")}|undici|axios|got|openai|ws|electron-updater|socket.io-client|https-proxy-agent|statecore-mcp)(\\/.*)?$/`;
```

`egressRules["no-restricted-imports"]` 的 `paths` 数组末尾（`{ name: "electron", importNames: ELECTRON_NETWORK, message: EGRESS_MESSAGE },` 之后）加：

```js
        { name: "statecore-mcp", message: STATECORE_MESSAGE },
```

`patterns` 数组末尾加：

```js
        { group: ["statecore-mcp/*"], message: STATECORE_MESSAGE },
```

在 `const outsideGatewayRules = ...` 定义之后加：

```js
/** 去掉 StateCore 那两条 import 限制（只给 STATECORE_ENTRY_FILES / STATECORE_TEST_FILES 用）。动态 import 仍然被拦。 */
function withoutStatecore(rules) {
  const [level, options] = rules["no-restricted-imports"];
  return {
    ...rules,
    "no-restricted-imports": [
      level,
      {
        ...options,
        paths: options.paths.filter((p) => p.message !== STATECORE_MESSAGE),
        patterns: options.patterns.filter((p) => p.message !== STATECORE_MESSAGE),
      },
    ],
  };
}
```

`export default tseslint.config(...)` 的最后（gateway 那一块之后）加两块：

```js
  // StateCore 的两个入口和适配层的测试（计划 4 R1）。
  { files: STATECORE_ENTRY_FILES, rules: withoutStatecore(outsideGatewayRules) },
  { files: STATECORE_TEST_FILES, rules: withoutStatecore(egressRules) },
```

- [ ] **Step 7: 冒烟检查加上 StateCore**

`src/main/smoke.ts` 顶部 import 改成：

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import { withScope } from "./memory/statecore";
```

在 `console.log(\`sqlite-ok ${row.one}\`);` 和 `db.close();` 之后、pty 检查之前插入：

```ts
    // StateCore 的嵌入式存储（node:sqlite + statecore-mcp/lib）能在 Electron 主进程里写、读。
    const scDir = mkdtempSync(join(tmpdir(), "butler-smoke-"));
    try {
      const n = await withScope({ dataDir: scDir, scope: "smoke" }, async (s) => {
        await s.remember("smoke note");
        return (await s.facts()).length;
      });
      console.log(`statecore-ok ${n}`);
    } finally {
      rmSync(scDir, { recursive: true, force: true });
    }
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/memory/statecore.test.ts src/main/gateway/statecore-env.test.ts src/main/paths.test.ts src/main/egress-lint.test.ts`
Expected: PASS

- [ ] **Step 9: 全量检查 + Electron 冒烟**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm exec electron out/main/index.js --smoke`
Expected: 全部通过；冒烟输出依次有 `sqlite-ok 1`、`statecore-ok 1`、`pty-ok`。

`statecore-ok` 没有出现、或者报 `Cannot find module`：先确认 `out/main/index.js` 里是 `require("statecore-mcp/lib")`（electron-vite 默认把依赖留在 node_modules 里）。仍然失败就是 Step 1 说的备选情况，停下来报告。

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-lock.yaml eslint.config.mjs src/main/egress-lint.test.ts src/main/gateway/statecore-env.ts src/main/gateway/statecore-env.test.ts src/main/gateway/types.ts src/main/paths.ts src/main/paths.test.ts src/main/smoke.ts src/shared/memory.ts src/main/memory/statecore.ts src/main/memory/statecore.test.ts
git commit -m "feat: StateCore adapter with keyless env, single entry point enforced by lint"
```

---

### Task 2: Butler 记忆条目的文本格式与“期望状态”差异计划

`remember` 没有 key 参数（设计文档 13.1），所以“按 key 取代”换成：每个条目有稳定前缀 `[decision:<id>]` / `[followup:<id>]`；Butler 从 app.db 算出这个 ticket 在 StateCore 里**应该有**的条目，再和 `facts()` 的现状比对：前缀相同、正文没变的保留；正文变了的先 forget 旧的再 remember 新的；app.db 里已经没有（followup 完成或忽略）的 forget。全部是纯函数。

**Files:**
- Modify: `src/shared/memory.ts`
- Create: `src/main/memory/notes.ts`
- Test: `src/shared/memory.test.ts`、`src/main/memory/notes.test.ts`

**Interfaces:**
- Consumes: `MemoryItem`（任务 1）、`Followup`、`HandoffRecord`（`src/shared/types.ts`）
- Produces:
  - `src/shared/memory.ts`：`NOTE_KINDS`、`type NoteKind = "decision" | "followup"`、`interface ButlerNote { kind: NoteKind; id: string; body: string }`、`interface ParsedNote extends ButlerNote { variant: number }`、`NOTE_BODY_LIMIT = 360`、`NOTE_ID_LIMIT = 40`、`MAX_NOTE_VARIANT = 5`、`noteId(raw): string`、`noteBody(raw): string`、`noteText(n: ButlerNote, variant?: number): string`（变体 ≥ 2 带区分词）、`parseNote(text): ParsedNote | null`、`sameBody(a, b): boolean`
  - `src/main/memory/notes.ts`：`BUTLER_NOTE_LIMIT = 24`、`followupNote(f: Followup): ButlerNote`、`decisionNote(key, statement): ButlerNote`、`desiredNotes(handoffs: HandoffRecord[], followups: Followup[]): ButlerNote[]`、`interface ReconcilePlan { forget: string[]; write: ButlerNote[] }`、`planReconcile(current: MemoryItem[], desired: ButlerNote[]): ReconcilePlan`

- [ ] **Step 1: 写失败测试**

新建 `src/shared/memory.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { NOTE_BODY_LIMIT, NOTE_ID_LIMIT, noteBody, noteId, noteText, parseNote, sameBody, ticketScope } from "./memory";

describe("Butler memory note format", () => {
  it("writes and parses the stable prefix", () => {
    expect(noteText({ kind: "decision", id: "db", body: "用 PostgreSQL" })).toBe("[decision:db] 用 PostgreSQL");
    expect(parseNote("[decision:db] 用 PostgreSQL")).toEqual({ kind: "decision", id: "db", variant: 1, body: "用 PostgreSQL" });
    expect(parseNote("[decision:a:b] x")).toEqual({ kind: "decision", id: "a:b", variant: 1, body: "x" });
    expect(parseNote("[followup:f_1#3] 改配置")).toEqual({ kind: "followup", id: "f_1", variant: 3, body: "改配置" });
  });

  it("gives every variant a deterministic run of distinguishing words, longer for later variants", () => {
    const v2 = noteText({ kind: "followup", id: "f_1", body: "改配置" }, 2);
    const v3 = noteText({ kind: "followup", id: "f_1", body: "改配置" }, 3);
    expect(v2).toMatch(/^\[followup:f_1#2( [a-z]{4}){3}\] 改配置$/);
    expect(v3).toMatch(/^\[followup:f_1#3( [a-z]{4}){6}\] 改配置$/);
    expect(noteText({ kind: "followup", id: "f_1", body: "改配置" }, 2)).toBe(v2);
    expect(noteText({ kind: "followup", id: "f_2", body: "改配置" }, 2)).not.toBe(v2);
    expect(parseNote(v3)).toEqual({ kind: "followup", id: "f_1", variant: 3, body: "改配置" });
  });

  it("does not take other notes for Butler's", () => {
    for (const t of ["用户喜欢 tabs", "[learning:PROJ-1] 经验", "[decision:] 空 id", "[decision:x]没有空格", "[note:x] 别的前缀", " [decision:x] 前面有空格", "[decision:x#2 ABCD] 大写的区分词"]) {
      expect(parseNote(t), t).toBeNull();
    }
  });

  it("sanitizes ids and truncates bodies (Review Focus 5)", () => {
    expect(noteId("cache ttl]#\nv2")).toBe("cache-ttl-v2");
    expect(noteId("  ")).toBe("_");
    expect(noteId("Ｄｂ")).toBe("Db");
    expect(noteId("x".repeat(100))).toHaveLength(NOTE_ID_LIMIT);
    expect(noteBody("  第一行\n第二行\t\t结束  ")).toBe("第一行 第二行 结束");
    expect(Array.from(noteBody("长".repeat(600)))).toHaveLength(NOTE_BODY_LIMIT);
    // 不把代理对从中间切开。
    const emoji = noteBody("😀".repeat(500));
    expect(Array.from(emoji)).toHaveLength(NOTE_BODY_LIMIT);
    expect(emoji.endsWith("😀")).toBe(true);
    const text = noteText({ kind: "decision", id: noteId("k]ey"), body: noteBody("a\nb") });
    expect(parseNote(text)).toMatchObject({ id: "k-ey", body: "a b" });
    // 最坏情况（最长的 id、最长的正文、第 5 个变体）也在 StateCore 的 500 字上限之内。
    const worst = noteText({ kind: "followup", id: noteId("i".repeat(100)), body: noteBody("长".repeat(1000)) }, 5);
    expect(Array.from(worst).length).toBeLessThanOrEqual(500);
  });

  it("compares bodies the way StateCore dedupes (case, width and spacing insensitive)", () => {
    expect(sameBody(" Use  PostgreSQL ", "use postgresql")).toBe(true);
    expect(sameBody("ＡＢＣ", "abc")).toBe(true);
    expect(sameBody("v1", "v2")).toBe(false);
  });

  it("names ticket scopes", () => {
    expect(ticketScope("PROJ-12")).toBe("ticket:PROJ-12");
  });
});
```

新建 `src/main/memory/notes.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Handoff } from "../../shared/handoff";
import type { MemoryItem } from "../../shared/memory";
import type { Followup, HandoffRecord, HandoffTrigger } from "../../shared/types";
import { BUTLER_NOTE_LIMIT, decisionNote, desiredNotes, followupNote, planReconcile } from "./notes";

const payload = (over: Partial<Handoff> = {}): Handoff => ({
  ticket: "PROJ-1", status: "active", done_today: [], next_steps: [], blockers: [], pr: null, jira: null,
  followups: [], decisions: [], learnings: [], open_questions: [], ...over,
});
let nextId = 1;
const handoff = (createdAt: number, p: Handoff | null, trigger: HandoffTrigger = "nightly"): HandoffRecord => ({
  id: nextId++, ticketKey: "PROJ-1", sessionId: null, trigger, createdAt, payload: p, degraded: p === null, rawText: null, sourceRef: null,
});
const followup = (id: string, over: Partial<Followup> = {}): Followup => ({
  id, ticketKey: "PROJ-1", kind: "config", description: `描述 ${id}`, trigger: "after_merge", dueDate: null,
  status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null, ...over,
});
const item = (text: string, factKey = `k:${text}`): MemoryItem => ({ factKey, factId: null, text, createdAt: null, group: "Notes" });

describe("followup and decision notes", () => {
  it("describes a followup with its kind, trigger and due date", () => {
    expect(followupNote(followup("f_1", { description: "改 staging 配置" }))).toEqual({ kind: "followup", id: "f_1", body: "改 staging 配置（配置，合并后）" });
    expect(followupNote(followup("f_2", { kind: "flag", trigger: "on_date", dueDate: "2026-11-01", description: "关掉开关" })).body).toBe("关掉开关（开关，到期日 2026-11-01）");
    expect(decisionNote("db]#1", "用\nMySQL")).toEqual({ kind: "decision", id: "db-1", body: "用 MySQL" });
  });
});

describe("desiredNotes", () => {
  it("keeps the latest statement per decision key from full handoffs only", () => {
    const hs = [
      handoff(10, payload({ decisions: [{ key: "db", statement: "用 PostgreSQL" }, { key: "cache", statement: "不用缓存" }] })),
      handoff(20, payload({ decisions: [{ key: "db", statement: "用 MySQL" }] })),
      handoff(30, payload({ decisions: [{ key: "db", statement: "刷新里编的" }] }), "refresh"),
      handoff(40, null),
    ];
    expect(desiredNotes(hs, [])).toEqual([
      { kind: "decision", id: "db", body: "用 MySQL" },
      { kind: "decision", id: "cache", body: "不用缓存" },
    ]);
  });

  it("orders handoffs by time no matter how they are passed in", () => {
    const a = handoff(10, payload({ decisions: [{ key: "db", statement: "旧" }] }));
    const b = handoff(20, payload({ decisions: [{ key: "db", statement: "新" }] }));
    expect(desiredNotes([b, a], [])).toEqual([{ kind: "decision", id: "db", body: "新" }]);
  });

  it("lists open and snoozed followups first, skips closed ones and empty bodies", () => {
    const fs = [
      followup("f_1"),
      followup("f_2", { status: "done" }),
      followup("f_3", { status: "ignored" }),
      followup("f_4", { status: "snoozed", createdAt: 2 }),
    ];
    const hs = [handoff(10, payload({ decisions: [{ key: "x", statement: "  " }, { key: "y", statement: "有内容" }] }))];
    expect(desiredNotes(hs, fs).map((n) => `${n.kind}:${n.id}`)).toEqual(["followup:f_1", "followup:f_4", "decision:y"]);
  });

  it("puts recently changed decisions first and caps the total", () => {
    const hs = [
      handoff(10, payload({ decisions: [{ key: "old", statement: "早就定了" }, { key: "changed", statement: "第一版" }] })),
      handoff(20, payload({ decisions: [{ key: "old", statement: "早就定了" }, { key: "changed", statement: "第二版" }] })),
    ];
    expect(desiredNotes(hs, []).map((n) => n.id)).toEqual(["changed", "old"]);
    const many = Array.from({ length: 40 }, (_, i) => followup(`f_${i}`, { createdAt: i }));
    expect(desiredNotes([], many)).toHaveLength(BUTLER_NOTE_LIMIT);
  });
});

describe("planReconcile", () => {
  it("keeps unchanged notes, replaces changed ones and forgets the ones no longer wanted", () => {
    const current = [
      item("[decision:db] 用 PostgreSQL", "k1"),
      item("[followup:f_1] 改配置（配置，合并后）", "k2"),
      item("[followup:f_2] 已经做完的", "k3"),
      item("用户喜欢 tabs", "k4"),
      item("[learning:PROJ-1] 经验", "k5"),
    ];
    const desired = [
      { kind: "decision" as const, id: "db", body: "用 MySQL" },
      { kind: "followup" as const, id: "f_1", body: "改配置（配置，合并后）" },
      { kind: "followup" as const, id: "f_9", body: "新的" },
    ];
    expect(planReconcile(current, desired)).toEqual({
      forget: ["k1", "k3"],
      write: [desired[0], desired[2]],
    });
  });

  it("treats a variant with the same body as already written, and drops duplicates of one key", () => {
    const current = [item("[followup:f_1#2] 改配置", "a"), item("[followup:f_1] 改配置", "b"), item("[followup:f_1#3] 旧的", "c")];
    expect(planReconcile(current, [{ kind: "followup", id: "f_1", body: "改  配置".replace("  ", "") }])).toEqual({ forget: ["b", "c"], write: [] });
  });

  it("ignores repeated desired keys and compares bodies loosely", () => {
    const desired = [
      { kind: "decision" as const, id: "db", body: "Use PostgreSQL" },
      { kind: "decision" as const, id: "db", body: "something else" },
    ];
    expect(planReconcile([item("[decision:db] use  postgresql", "k")], desired)).toEqual({ forget: [], write: [] });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/shared/memory.test.ts src/main/memory/notes.test.ts`
Expected: FAIL——`noteText`、`./notes` 等不存在。

- [ ] **Step 3: 实现文本格式**

`src/shared/memory.ts` 末尾追加：

```ts
/** Butler 自己维护的条目种类（设计文档 8.3）。learnings 写在 workspace，不参与比对。 */
export const NOTE_KINDS = ["decision", "followup"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface ButlerNote {
  kind: NoteKind;
  /** 决策的 key 或 followup 的 id，已经过 noteId() 处理。 */
  id: string;
  /** 已经过 noteBody() 处理的正文。 */
  body: string;
}

export interface ParsedNote extends ButlerNote {
  /** 1 表示没有变体后缀；#n 时为 n。 */
  variant: number;
}

/**
 * StateCore 的 note 上限是 500 字。前缀最长约 115 字（kind、40 字的 id、#5 和 12 个区分词），正文最多 360 字。
 */
export const NOTE_BODY_LIMIT = 360;
export const NOTE_ID_LIMIT = 40;
/** 变体最多到 #5。 */
export const MAX_NOTE_VARIANT = 5;

/** 前缀里的 id：不能有空白、[、]、#（会破坏前缀），控制字符也去掉；NFKC 之后最多 NOTE_ID_LIMIT 字，空的写成 _。 */
export function noteId(raw: string): string {
  const id = raw
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\s\]#[\u0000-\u001f\u007f]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return Array.from(id).slice(0, NOTE_ID_LIMIT).join("") || "_";
}

/** 正文：NFKC，所有空白（含换行）压成一个空格，首尾去空白，最多 NOTE_BODY_LIMIT 个字符（按码点，不切开代理对）。 */
export function noteBody(raw: string): string {
  const text = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, NOTE_BODY_LIMIT).join("").trim();
}

/** FNV-1a（32 位）：渲染进程也会用到这个文件，不能用 node:crypto。 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 变体 v（≥ 2）的区分词：3 × (v − 1) 个 4 个小写字母的词，由 kind:id:v 决定。
 * StateCore 把 Jaccard ≥ 0.7 的两条 note 当成同一条的修订（后写的挤掉先写的，任务 1 实验 G）；
 * 区分词让两条正文几乎一样的不同条目分开，也让和已遗忘条目一字不差的文本重新可见（实验 D/E）。
 */
function variantWords(kind: NoteKind, id: string, v: number): string[] {
  let x = fnv1a(`${kind}:${id}:${v}`) || 1;
  const words: string[] = [];
  for (let i = 0; i < 3 * (v - 1); i++) {
    let w = "";
    for (let j = 0; j < 4; j++) {
      // xorshift32
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      w += String.fromCharCode(97 + (x % 26));
    }
    words.push(w);
  }
  return words;
}

export function noteText(n: ButlerNote, variant = 1): string {
  const suffix = variant > 1 ? `#${variant} ${variantWords(n.kind, n.id, variant).join(" ")}` : "";
  return `[${n.kind}:${n.id}${suffix}] ${n.body}`;
}

const NOTE_RE = /^\[(decision|followup):([^\]#\s]+)(?:#(\d{1,3})(?: [a-z]{4})*)?\] ([\s\S]+)$/;

export function parseNote(text: string): ParsedNote | null {
  const m = NOTE_RE.exec(text);
  if (!m) return null;
  return { kind: m[1] as NoteKind, id: m[2], variant: m[3] ? Number(m[3]) : 1, body: m[4] };
}

/** 和 StateCore 的去重一样宽松：NFKC、忽略大小写和多余空白。 */
export function sameBody(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}
```

- [ ] **Step 4: 实现期望状态和差异计划**

新建 `src/main/memory/notes.ts`：

```ts
import type { Handoff } from "../../shared/handoff";
import { noteBody, noteId, parseNote, sameBody, type ButlerNote, type MemoryItem } from "../../shared/memory";
import type { Followup, FollowupKind, FollowupTrigger, HandoffRecord } from "../../shared/types";

/** 一个 ticket scope 里 Butler 自己最多维护多少条：StateCore 每个 scope 的 notes 上限是 30（超出淘汰最旧的），给 Claude 自己的 remember 留 6 条。 */
export const BUTLER_NOTE_LIMIT = 24;

const KIND_LABEL: Record<FollowupKind, string> = { config: "配置", flag: "开关", deploy: "部署", doc: "文档", other: "其他" };
const TRIGGER_LABEL: Record<FollowupTrigger, string> = { after_merge: "合并后", after_deploy: "部署后", on_date: "到期日", none: "无触发条件" };

export function followupNote(f: Followup): ButlerNote {
  const due = f.trigger === "on_date" && f.dueDate ? ` ${f.dueDate}` : "";
  return { kind: "followup", id: noteId(f.id), body: noteBody(`${f.description}（${KIND_LABEL[f.kind]}，${TRIGGER_LABEL[f.trigger]}${due}）`) };
}

export function decisionNote(key: string, statement: string): ButlerNote {
  return { kind: "decision", id: noteId(key), body: noteBody(statement) };
}

type FullHandoff = HandoffRecord & { payload: Handoff };
const isFull = (h: HandoffRecord): h is FullHandoff => h.payload !== null && h.trigger !== "refresh";

/**
 * 这个 ticket 在 StateCore 里应该有的 Butler 条目（设计文档 8.3）：
 * - 未完成（open / snoozed）的 followup，按创建时间；
 * - 决策：所有有效的完整 handoff（不含早间刷新）里每个 key 最新的那句话，按最近一次变化从新到旧。
 * followup 在前；正文为空的跳过；总数不超过 BUTLER_NOTE_LIMIT。handoffs 的顺序不限。
 */
export function desiredNotes(handoffs: HandoffRecord[], followups: Followup[]): ButlerNote[] {
  const decisions = new Map<string, { note: ButlerNote; at: number }>();
  const full = handoffs.filter(isFull).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  for (const h of full) {
    for (const d of h.payload.decisions) {
      const note = decisionNote(d.key, d.statement);
      if (!note.body) continue;
      const prev = decisions.get(note.id);
      // 同一句话在后面的 handoff 里重复出现，不算“变化”：保留它第一次出现的时间。
      if (prev && sameBody(prev.note.body, note.body)) continue;
      decisions.set(note.id, { note, at: h.createdAt });
    }
  }
  const seen = new Set<string>();
  const open = followups
    .filter((f) => f.status === "open" || f.status === "snoozed")
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map(followupNote)
    .filter((n) => n.body && !seen.has(n.id) && seen.add(n.id));
  const decided = [...decisions.values()].sort((a, b) => b.at - a.at).map((d) => d.note);
  return [...open, ...decided].slice(0, BUTLER_NOTE_LIMIT);
}

export interface ReconcilePlan {
  /** 要 forget 的 factKey。 */
  forget: string[];
  /** 要写的条目（写的时候先试不带变体的前缀）。 */
  write: ButlerNote[];
}

/**
 * 现状（StateCore facts()）和期望之间的差异。只看 Butler 前缀的条目，Claude 自己写的和蒸馏出来的一律不动。
 * 同一个条目：正文相同（宽松比较，任何变体后缀）的留一条，其余的 forget；正文变了就 forget 全部旧的、写新的。
 * 期望里已经没有的条目全部 forget。
 */
export function planReconcile(current: MemoryItem[], desired: ButlerNote[]): ReconcilePlan {
  const byKey = new Map<string, { factKey: string; body: string }[]>();
  for (const it of current) {
    const p = parseNote(it.text);
    if (!p) continue;
    const key = `${p.kind}:${p.id}`;
    byKey.set(key, [...(byKey.get(key) ?? []), { factKey: it.factKey, body: p.body }]);
  }
  const plan: ReconcilePlan = { forget: [], write: [] };
  const wanted = new Set<string>();
  for (const n of desired) {
    const key = `${n.kind}:${n.id}`;
    if (wanted.has(key)) continue;
    wanted.add(key);
    const have = byKey.get(key) ?? [];
    const keep = have.find((h) => sameBody(h.body, n.body));
    for (const h of have) if (h !== keep) plan.forget.push(h.factKey);
    if (!keep) plan.write.push(n);
  }
  for (const [key, have] of byKey) if (!wanted.has(key)) for (const h of have) plan.forget.push(h.factKey);
  return plan;
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm exec vitest run src/shared/memory.test.ts src/main/memory/notes.test.ts`
Expected: PASS

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/shared/memory.ts src/shared/memory.test.ts src/main/memory/notes.ts src/main/memory/notes.test.ts
git commit -m "feat: stable-prefix memory notes and the desired-state reconcile plan"
```

---

### Task 3: 迁移 4：同步游标、审计来源、老用户跳过向导

**Files:**
- Modify: `src/main/db/migrations.ts`
- Create: `src/main/db/memory-sync-repo.ts`
- Modify: `src/main/db/audit-repo.ts`
- Modify: `src/shared/llm.ts`
- Modify: `src/main/db/settings-repo.ts`
- Test: `src/main/db/memory-repos.test.ts`（新建）、`src/main/db/llm-repos.test.ts`、`src/renderer/src/audit-view.test.ts`

**Interfaces:**
- Consumes: `memDb()`、`migrate()`、`MIGRATIONS`
- Produces:
  - 迁移 4（`user_version` 4）：表 `memory_sync(ticket_key PK, handoff_id, synced_at)`；`llm_audit.source TEXT NOT NULL DEFAULT 'narrative' CHECK (source IN ('narrative','statecore'))`；已经有 ticket 的库写入 `settings.onboardingDone = '1'`
  - `class MemorySyncRepo { cursor(ticketKey: string): number; setCursor(ticketKey: string, handoffId: number, at: number): void }`
  - `AUDIT_SOURCES = ["narrative", "statecore"]`、`type AuditSource`（`src/shared/llm.ts`）；`AuditEntry.source: AuditSource`；`NewAudit` 可带 `source?: AuditSource`（缺省 `"narrative"`）
  - `SETTING_DEFAULTS.onboardingDone = "0"`

- [ ] **Step 1: 写失败测试**

新建 `src/main/db/memory-repos.test.ts`：

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { AuditRepo } from "./audit-repo";
import { migrate } from "./database";
import { MemorySyncRepo } from "./memory-sync-repo";
import { MIGRATIONS } from "./migrations";
import { SettingsRepo } from "./settings-repo";
import { TicketsRepo } from "./tickets-repo";

function v3db(withTicket: boolean): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "butler-up4-"));
  const db = new DatabaseSync(join(dir, "v3.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  for (const m of MIGRATIONS.slice(0, 3)) db.exec(m);
  db.exec("PRAGMA user_version = 3");
  if (withTicket) db.exec(`INSERT INTO tickets (key, repo_path, work_mode, branch, created_at) VALUES ('OLD-3', '/r', 'branch', 'b', 1)`);
  db.exec(`INSERT INTO llm_audit (ts, provider, model, level, status) VALUES (1, 'p', 'm', 'metadata', 'sent')`);
  return db;
}

describe("migration 4", () => {
  it("adds the memory sync cursor and the audit source, keeping old audit rows as narrative", () => {
    const db = v3db(true);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(4);
    expect(new AuditRepo(db).list()[0]).toMatchObject({ source: "narrative", status: "sent" });
    expect(() => db.exec(`INSERT INTO llm_audit (ts, provider, model, level, status, source) VALUES (1, 'p', 'm', 'full', 'sent', 'other')`)).toThrow();
    db.close();
  });

  it("does not send an existing user through the first-run wizard, but a new one gets it", () => {
    const old = v3db(true);
    migrate(old);
    expect(new SettingsRepo(old).get("onboardingDone")).toBe("1");
    old.close();
    const fresh = v3db(false);
    migrate(fresh);
    expect(new SettingsRepo(fresh).get("onboardingDone")).toBe("0");
    fresh.close();
    expect(new SettingsRepo(memDb()).get("onboardingDone")).toBe("0");
  });
});

describe("MemorySyncRepo", () => {
  it("starts at 0 and only moves forward", () => {
    const db = memDb();
    new TicketsRepo(db).insert({
      key: "PROJ-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b",
      status: "active", statusManual: null, createdAt: 1, archivedAt: null,
    });
    const sync = new MemorySyncRepo(db);
    expect(sync.cursor("PROJ-1")).toBe(0);
    sync.setCursor("PROJ-1", 5, 100);
    expect(sync.cursor("PROJ-1")).toBe(5);
    sync.setCursor("PROJ-1", 3, 200);
    expect(sync.cursor("PROJ-1")).toBe(5);
    sync.setCursor("PROJ-1", 9, 300);
    expect(sync.cursor("PROJ-1")).toBe(9);
    expect(sync.cursor("NOPE-1")).toBe(0);
  });
});

describe("AuditRepo source", () => {
  it("records where a call came from", () => {
    const audit = new AuditRepo(memDb());
    audit.insert({ ts: 1, provider: "p", model: "m", level: "metadata", status: "pending", payloadSent: "{}" });
    audit.insert({ ts: 2, provider: "p", model: "m", level: "full", status: "pending", payloadSent: "{}", source: "statecore" });
    expect(audit.list().map((e) => e.source)).toEqual(["statecore", "narrative"]);
  });
});
```

`src/main/db/llm-repos.test.ts` 里 `records the request before sending and fills in the result afterwards` 的期望对象改成（加 `source`）：

```ts
      { id, ts: 10, ...base, source: "narrative", status: "sent", payloadSent: '{"a":1}', response: "{}", tokensIn: 100, tokensOut: 20, costUsd: 0.0002, blockedReason: null, error: null },
```

`src/renderer/src/audit-view.test.ts` 的 `entry` 工厂里 `level: "metadata", status: "sent",` 改成 `level: "metadata", source: "narrative", status: "sent",`。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/db/memory-repos.test.ts src/main/db/llm-repos.test.ts`
Expected: FAIL——`./memory-sync-repo` 不存在，`MIGRATIONS.length` 是 3。

- [ ] **Step 3: 实现**

`src/main/db/migrations.ts`：数组末尾（第 3 条之后）追加第 4 条：

```ts
  `
  CREATE TABLE memory_sync (
    ticket_key TEXT PRIMARY KEY REFERENCES tickets(key),
    handoff_id INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
  );
  ALTER TABLE llm_audit ADD COLUMN source TEXT NOT NULL DEFAULT 'narrative' CHECK (source IN ('narrative', 'statecore'));
  INSERT OR IGNORE INTO settings (key, value) SELECT 'onboardingDone', '1' WHERE EXISTS (SELECT 1 FROM tickets);
  `,
```

新建 `src/main/db/memory-sync-repo.ts`：

```ts
import type { Db } from "./database";

/** 每个 ticket 已经写进 StateCore 的最新 handoff id（handoff 和 learnings 只写一次；决策和 followup 每次都按现状比对）。 */
export class MemorySyncRepo {
  constructor(private readonly db: Db) {}

  /** 还没同步过时为 0。 */
  cursor(ticketKey: string): number {
    const r = this.db.prepare(`SELECT handoff_id FROM memory_sync WHERE ticket_key = ?`).get(ticketKey) as { handoff_id: number } | undefined;
    return r?.handoff_id ?? 0;
  }

  /** 只往前走：并发的两次同步里后完成的那次不会把游标拨回去。 */
  setCursor(ticketKey: string, handoffId: number, at: number): void {
    this.db
      .prepare(
        `INSERT INTO memory_sync (ticket_key, handoff_id, synced_at) VALUES (?, ?, ?)
         ON CONFLICT(ticket_key) DO UPDATE SET handoff_id = MAX(handoff_id, excluded.handoff_id), synced_at = excluded.synced_at`,
      )
      .run(ticketKey, handoffId, at);
  }
}
```

`src/shared/llm.ts`：在 `AUDIT_STATUSES` 那段之后加：

```ts
/** narrative：早间简报的“今日重点”；statecore：full 档位下 StateCore 记忆的蒸馏（计划 4 R1）。 */
export const AUDIT_SOURCES = ["narrative", "statecore"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];
```

`AuditEntry` 里 `level: PrivacyLevel;` 之后加：

```ts
  source: AuditSource;
```

`src/main/db/audit-repo.ts`：
- 第一行 import 改成 `import type { AuditEntry, AuditSource, AuditStatus, PrivacyLevel, ScanHit } from "../../shared/llm";`
- `interface AuditRow` 里 `level: string;` 之后加 `source: string;`
- `toEntry` 里 `level: r.level as PrivacyLevel,` 之后加 `source: r.source as AuditSource,`
- `interface NewAuditCommon` 里 `level: PrivacyLevel;` 之后加：

```ts
  /** 缺省是 narrative。 */
  source?: AuditSource;
```

- `insert` 改成：

```ts
  insert(a: NewAudit): number {
    const payload = NO_PAYLOAD_STATUSES.has(a.status) ? null : cap(a.payloadSent ?? null);
    const r = this.db
      .prepare(
        `INSERT INTO llm_audit (ts, provider, model, level, source, status, payload_sent, blocked_reason, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.ts, a.provider, a.model, a.level, a.source ?? "narrative", a.status, payload, a.blockedReason ? JSON.stringify(a.blockedReason) : null, cap(a.error));
    return Number(r.lastInsertRowid);
  }
```

`src/main/db/settings-repo.ts` 的 `SETTING_DEFAULTS` 末尾（`auditRetentionDays` 之后）加：

```ts
  /** 首次启动向导做完（或跳过）了：1。迁移 4 给已经有 ticket 的老用户直接写 1。 */
  onboardingDone: "0",
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/db src/renderer/src/audit-view.test.ts`
Expected: PASS

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/main/db/migrations.ts src/main/db/memory-sync-repo.ts src/main/db/audit-repo.ts src/shared/llm.ts src/main/db/settings-repo.ts src/main/db/memory-repos.test.ts src/main/db/llm-repos.test.ts src/renderer/src/audit-view.test.ts
git commit -m "feat: migration 4 with the memory sync cursor, audit source and onboarding flag for existing users"
```

---

### Task 4: MemoryService：handoff 入库后把记忆写进 StateCore

设计文档 8.3 的四条写入路径：每次 handoff 在 ticket scope 写 `handoff`；决策和未完成的 followup 按任务 2 的差异计划 forget / remember；learnings 写进 `workspace`。同步串行执行、同一个 ticket 的重复请求合并、任何失败只写日志。写了却看不见的条目（和以前某个被遗忘的条目一字不差）换 `#2`…`#5` 变体重写；写一条时 StateCore 把**另一条** Butler 条目当成它的旧版本挤掉了（正文几乎一样，任务 1 实验 G），就用更长区分词的变体把被挤掉的那条写回去。

**Files:**
- Create: `src/main/memory/memory-service.ts`
- Test: `src/main/memory/memory-service.test.ts`
- Modify: `src/main/db/settings-repo.ts`（`memoryEnabled` 默认值）
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `withScope`、`listScopeNames`、`ScopeHandle`（任务 1）；`desiredNotes`、`planReconcile`（任务 2）；`noteText`、`noteBody`、`noteId`、`parseNote`、`MAX_NOTE_VARIANT`、`ticketScope`、`WORKSPACE_SCOPE`（`src/shared/memory.ts`）；`MemorySyncRepo`（任务 3）
- Produces:
  - `SETTING_DEFAULTS.memoryEnabled = "1"`
  - `handoffSummary(p: Handoff): string`
  - `class MemoryService`：
    - `constructor(d: MemoryServiceDeps)`，`MemoryServiceDeps = { dataDir: string; tickets: Pick<TicketsRepo, "get" | "list">; handoffs: Pick<HandoffsRepo, "listByTicket">; followups: Pick<FollowupsRepo, "listByTicket">; sync: MemorySyncRepo; enabled: () => boolean; now: () => number; onSynced?: (key: string) => void; log?: (msg: string, err?: unknown) => void }`（`onSynced`：一次同步成功之后调用，主进程用它通知界面刷新，记忆标签开着时能看到新内容）
    - `syncTicket(key: string): Promise<void>`（排队、合并、永不 reject）
    - `syncAll(): Promise<void>`（所有未归档的 ticket）
    - `view(key: string): Promise<MemoryView>`、`why(key: string, factId: string): Promise<WhyEntry[] | null>`
    - `idle(): Promise<void>`（队列清空时 resolve）、`stop(): void`（之后排队的任务直接跳过）
  - 常量 `BACKFILL_HANDOFFS = 20`

- [ ] **Step 1: 写失败测试**

新建 `src/main/memory/memory-service.test.ts`：

```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Handoff } from "../../shared/handoff";
import type { Followup, FollowupStatus, HandoffTrigger } from "../../shared/types";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { MemorySyncRepo } from "../db/memory-sync-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb, tempDir } from "../test-utils";
import { handoffSummary, MemoryService } from "./memory-service";
import { withScope } from "./statecore";

const payload = (over: Partial<Handoff> = {}): Handoff => ({
  ticket: "PROJ-1", status: "active", done_today: [], next_steps: [], blockers: [], pr: null, jira: null,
  followups: [], decisions: [], learnings: [], open_questions: [], ...over,
});

function setup(o: { dataDir?: string; enabled?: boolean } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const sync = new MemorySyncRepo(db);
  for (const key of ["PROJ-1", "PROJ-2"]) {
    tickets.insert({ key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  }
  const dataDir = o.dataDir ?? tempDir();
  const logs: string[] = [];
  let enabled = o.enabled ?? true;
  let now = 1000;
  const synced: string[] = [];
  const memory = new MemoryService({
    dataDir, tickets, handoffs, followups, sync,
    enabled: () => enabled,
    now: () => now,
    onSynced: (key) => synced.push(key),
    log: (m, e) => logs.push(e === undefined ? m : `${m} ${e instanceof Error ? e.message : String(e)}`),
  });
  const addHandoff = (p: Handoff, trigger: HandoffTrigger = "nightly", key = "PROJ-1") =>
    handoffs.insert({ ticketKey: key, sessionId: null, trigger, createdAt: ++now, payload: p, rawText: null })!;
  const addFollowup = (id: string, over: Partial<Followup> = {}) =>
    followups.insert({
      id, ticketKey: "PROJ-1", kind: "config", description: `描述 ${id}`, trigger: "after_merge", dueDate: null,
      status: "open", snoozedUntil: null, source: "session", createdAt: ++now, doneAt: null, ...over,
    });
  const setFollowup = (id: string, status: FollowupStatus) => followups.setStatus(id, status, ++now);
  const texts = (scope = "ticket:PROJ-1") => withScope({ dataDir, scope }, async (s) => (await s.facts()).map((i) => i.text));
  return { memory, dataDir, sync, logs, synced, addHandoff, addFollowup, setFollowup, texts, setEnabled: (v: boolean) => (enabled = v) };
}

describe("handoffSummary", () => {
  it("states the status and what was done", () => {
    expect(handoffSummary(payload({ status: "in_review", done_today: ["写完接口", " ", "补测试"] }))).toBe("状态：in_review。完成：写完接口；补测试");
    expect(handoffSummary(payload())).toBe("状态：active。");
  });
});

describe("MemoryService.syncTicket (design 8.3)", () => {
  it("writes the handoff, decisions, open followups and learnings of a ticket", async () => {
    const t = setup();
    t.addFollowup("f_1", { description: "改 staging 配置" });
    const id = t.addHandoff(payload({
      done_today: ["接口写完"], next_steps: ["补测试"], open_questions: ["要不要拆 PR？"],
      decisions: [{ key: "db", statement: "用 PostgreSQL" }], learnings: ["gh pr checks 要带 --required"],
    }));
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(["[followup:f_1] 改 staging 配置（配置，合并后）", "[decision:db] 用 PostgreSQL"]);
    expect(await t.texts("workspace")).toEqual(["[learning:PROJ-1] gh pr checks 要带 --required"]);
    const view = await t.memory.view("PROJ-1");
    expect(view).toMatchObject({ enabled: true, scope: "ticket:PROJ-1", error: null });
    expect(view.handoff?.content).toBe("状态：active。完成：接口写完\nOpen questions:\n- 要不要拆 PR？\nNext steps:\n- 补测试");
    expect(t.sync.cursor("PROJ-1")).toBe(id);
    expect(t.synced).toEqual(["PROJ-1"]);
  });

  it("replaces a changed decision and keeps the old one on the why chain", async () => {
    const t = setup();
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 PostgreSQL 存储会话" }] }));
    await t.memory.syncTicket("PROJ-1");
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 MySQL 存储会话" }] }));
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(["[decision:db] 用 MySQL 存储会话"]);
    const view = await t.memory.view("PROJ-1");
    const chain = await t.memory.why("PROJ-1", view.items[0].factId!);
    expect(chain?.map((e) => e.content)).toEqual(["[decision:db] 用 PostgreSQL 存储会话", "[decision:db] 用 MySQL 存储会话"]);
    // 交接也有自己的链：两次 handoff 两个版本。
    expect(view.handoff?.versionCount).toBe(2);
  });

  it("forgets a followup once it is done or ignored, and leaves other notes alone", async () => {
    const t = setup();
    t.addFollowup("f_1");
    t.addFollowup("f_2");
    t.addHandoff(payload());
    await t.memory.syncTicket("PROJ-1");
    await withScope({ dataDir: t.dataDir, scope: "ticket:PROJ-1" }, async (s) => {
      await s.remember("Claude 自己记的：这个仓库用 pnpm");
    });
    t.setFollowup("f_1", "done");
    t.setFollowup("f_2", "ignored");
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(["Claude 自己记的：这个仓库用 pnpm"]);
  });

  it("a reopened followup becomes visible again (Review Focus 2)", async () => {
    const t = setup();
    t.addFollowup("f_1", { description: "部署后打开开关" });
    await t.memory.syncTicket("PROJ-1");
    t.setFollowup("f_1", "done");
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual([]);
    t.setFollowup("f_1", "open");
    await t.memory.syncTicket("PROJ-1");
    const reopened = await t.texts();
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatch(/^\[followup:f_1#2( [a-z]{4}){3}\] 部署后打开开关（配置，合并后）$/);
    // 再同步一次：变体被当作已经写好的那条，不会再写 #3。
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(reopened);
  });

  it("keeps two followups with almost the same text both visible", async () => {
    const t = setup();
    for (const id of ["f_1", "f_2", "f_3"]) t.addFollowup(id);
    await t.memory.syncTicket("PROJ-1");
    const texts = await t.texts();
    expect(texts).toHaveLength(3);
    expect(texts.map((x) => /^\[followup:(f_\d)/.exec(x)?.[1]).sort()).toEqual(["f_1", "f_2", "f_3"]);
    expect(t.logs.filter((l) => l.includes("stays hidden"))).toEqual([]);
    // 已经分开了：再同步不改动任何条目。
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(texts);
  });

  it("is idempotent: a second sync with nothing new writes nothing", async () => {
    const t = setup();
    t.addFollowup("f_1");
    t.addHandoff(payload({ decisions: [{ key: "db", statement: "用 PostgreSQL" }], learnings: ["经验一"] }));
    await t.memory.syncTicket("PROJ-1");
    const before = await t.memory.view("PROJ-1");
    await t.memory.syncTicket("PROJ-1");
    const after = await t.memory.view("PROJ-1");
    expect(after.items).toEqual(before.items);
    expect(after.handoff).toEqual(before.handoff);
    expect(await t.texts("workspace")).toEqual(["[learning:PROJ-1] 经验一"]);
  });

  it("writes only the latest handoff, skips refreshes and degraded ones, and replays at most 20 handoffs of learnings", async () => {
    const t = setup();
    for (let i = 0; i < 25; i++) t.addHandoff(payload({ learnings: [`经验 ${i}`] }));
    t.addHandoff(payload({ status: "blocked", learnings: ["刷新里的"] }), "refresh");
    await t.memory.syncTicket("PROJ-1");
    const ws = await t.texts("workspace");
    expect(ws).toHaveLength(20);
    expect(ws[0]).toBe("[learning:PROJ-1] 经验 5");
    expect(ws).not.toContain("[learning:PROJ-1] 刷新里的");
    const view = await t.memory.view("PROJ-1");
    expect(view.handoff).toMatchObject({ content: "状态：active。", versionCount: 1 });
  });

  it("rewrites the latest handoff when the StateCore data was deleted", async () => {
    const first = tempDir();
    const t = setup({ dataDir: first });
    t.addHandoff(payload({ done_today: ["a"] }));
    await t.memory.syncTicket("PROJ-1");
    // 换一个空的数据目录，相当于用户删掉了 ~/.butler/statecore。
    const t2 = setup({ dataDir: tempDir() });
    t2.addHandoff(payload({ done_today: ["a"] }));
    t2.sync.setCursor("PROJ-1", 999, 1);
    await t2.memory.syncTicket("PROJ-1");
    expect((await t2.memory.view("PROJ-1")).handoff?.content).toBe("状态：active。完成：a");
  });

  it("does nothing when memory is turned off or the ticket is unknown", async () => {
    const t = setup({ enabled: false });
    t.addFollowup("f_1");
    t.addHandoff(payload({ learnings: ["x"] }));
    await t.memory.syncTicket("PROJ-1");
    await t.memory.syncTicket("NOPE-1");
    expect(t.sync.cursor("PROJ-1")).toBe(0);
    expect(await t.memory.view("PROJ-1")).toEqual({ enabled: false, scope: "ticket:PROJ-1", handoff: null, items: [], error: null });
    t.setEnabled(true);
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(["[followup:f_1] 描述 f_1（配置，合并后）"]);
  });

  it("never rejects and keeps the cursor when StateCore cannot open (Review Focus 1)", async () => {
    const blocker = join(tempDir(), "not-a-dir");
    writeFileSync(blocker, "x");
    const t = setup({ dataDir: blocker });
    t.addHandoff(payload({ learnings: ["x"] }));
    await expect(t.memory.syncTicket("PROJ-1")).resolves.toBeUndefined();
    expect(t.sync.cursor("PROJ-1")).toBe(0);
    expect(t.logs.some((l) => l.startsWith("memory sync PROJ-1 failed"))).toBe(true);
    expect(t.synced).toEqual([]);
    const view = await t.memory.view("PROJ-1");
    expect(view.enabled).toBe(true);
    expect(view.error).toBeTruthy();
  });

  it("merges repeated requests for a ticket that is still waiting in the queue", async () => {
    const t = setup();
    const a = t.memory.syncTicket("PROJ-1");
    const b = t.memory.syncTicket("PROJ-1");
    expect(b).toBe(a);
    const c = t.memory.syncTicket("PROJ-2");
    expect(c).not.toBe(a);
    await Promise.all([a, c]);
    await t.memory.idle();
  });

  it("syncs every unarchived ticket and skips everything after stop()", async () => {
    const t = setup();
    t.addFollowup("f_1");
    await t.memory.syncAll();
    expect(await t.texts()).toEqual(["[followup:f_1] 描述 f_1（配置，合并后）"]);
    t.addFollowup("f_2");
    t.memory.stop();
    await t.memory.syncTicket("PROJ-1");
    expect(await t.texts()).toEqual(["[followup:f_1] 描述 f_1（配置，合并后）"]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/memory/memory-service.test.ts`
Expected: FAIL——`./memory-service` 不存在。

- [ ] **Step 3: 实现**

`src/main/db/settings-repo.ts` 的 `SETTING_DEFAULTS` 末尾（`onboardingDone` 之后）加：

```ts
  /** StateCore 记忆（设计文档第 8 节）：1 开 0 关。关闭时不写入、不给 claude 挂记忆 MCP。 */
  memoryEnabled: "1",
```

新建 `src/main/memory/memory-service.ts`：

```ts
import type { Handoff } from "../../shared/handoff";
import {
  MAX_NOTE_VARIANT, noteBody, noteId, noteText, parseNote, ticketScope, WORKSPACE_SCOPE, type ButlerNote, type MemoryView, type WhyEntry,
} from "../../shared/memory";
import type { HandoffRecord } from "../../shared/types";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { MemorySyncRepo } from "../db/memory-sync-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { desiredNotes, planReconcile } from "./notes";
import { withScope, type ScopeHandle } from "./statecore";

/** 一个 ticket 第一次同步（或积压很多）时最多回放多少条 handoff 的 learnings：workspace 的 notes 上限本来就是 30。 */
export const BACKFILL_HANDOFFS = 20;
/** 每次同步读多少条 handoff（决策要看全部历史）。 */
const HANDOFF_SCAN = 200;

export interface MemoryServiceDeps {
  dataDir: string;
  tickets: Pick<TicketsRepo, "get" | "list">;
  handoffs: Pick<HandoffsRepo, "listByTicket">;
  followups: Pick<FollowupsRepo, "listByTicket">;
  sync: MemorySyncRepo;
  /** 设置里的记忆开关（memoryEnabled）。 */
  enabled: () => boolean;
  now: () => number;
  /** 一次同步成功之后调用（主进程用它通知界面刷新记忆标签）。 */
  onSynced?: (key: string) => void;
  log?: (msg: string, err?: unknown) => void;
}

type FullHandoff = HandoffRecord & { payload: Handoff };
const isFull = (h: HandoffRecord): h is FullHandoff => h.payload !== null && h.trigger !== "refresh";

/** StateCore 里交接的摘要（设计文档 8.3：summary = done_today）。 */
export function handoffSummary(p: Handoff): string {
  const done = p.done_today.map((s) => s.trim()).filter(Boolean);
  return done.length ? `状态：${p.status}。完成：${done.join("；")}` : `状态：${p.status}。`;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const noteKey = (n: { kind: string; id: string }): string => `${n.kind}:${n.id}`;

/**
 * StateCore 记忆的唯一写入方（设计文档 8.3，全部是确定性路径）。
 * 所有写入串行执行（同一个 statecore.db 还会被 claude 里挂的 MCP 进程打开）；任何失败只写日志，永不 reject。
 */
export class MemoryService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly d: MemoryServiceDeps) {}

  private log(msg: string, err?: unknown): void {
    try {
      this.d.log?.(msg, err);
    } catch {
      // 写日志失败不能影响记忆，更不能影响调用方。
    }
  }

  /** 排进串行队列；fn 抛错时记日志并返回 fallback。 */
  private enqueue<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.stopped) return fallback;
      try {
        return await fn();
      } catch (e) {
        this.log(`${label} failed`, e);
        return fallback;
      }
    });
    this.queue = run;
    return run;
  }

  /** 把一个 ticket 的记忆写进 StateCore。还在排队的同一个 ticket 只同步一次；正在同步时又来的请求会再排一次。 */
  syncTicket(key: string): Promise<void> {
    const waiting = this.pending.get(key);
    if (waiting) return waiting;
    const p = this.enqueue(
      `memory sync ${key}`,
      async () => {
        this.pending.delete(key);
        await this.syncNow(key);
      },
      undefined,
    );
    this.pending.set(key, p);
    return p;
  }

  /** 所有未归档的 ticket（启动时补齐：老数据、上次退出时没写完的）。 */
  async syncAll(): Promise<void> {
    await Promise.all(this.d.tickets.list().map((t) => this.syncTicket(t.key)));
  }

  /** 队列清空时 resolve。 */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** 退出时调用：之后排队的任务直接跳过（app.db 马上要关了）。 */
  stop(): void {
    this.stopped = true;
  }

  private async syncNow(key: string): Promise<void> {
    if (!this.d.enabled() || !this.d.tickets.get(key)) return;
    const handoffs = this.d.handoffs.listByTicket(key, HANDOFF_SCAN);
    const full = handoffs.filter(isFull).sort((a, b) => a.id - b.id);
    const cursor = this.d.sync.cursor(key);
    const fresh = full.filter((h) => h.id > cursor).slice(-BACKFILL_HANDOFFS);
    const latest = full.at(-1) ?? null;
    const desired = desiredNotes(handoffs, this.d.followups.listByTicket(key));

    await withScope({ dataDir: this.d.dataDir, scope: ticketScope(key) }, async (s) => {
      // 有新的 handoff 就写最新那一条；没有新的但 StateCore 里没有交接（数据被删过）也补写一次。
      if (latest && (fresh.includes(latest) || (await s.activeHandoff()) === null)) {
        await s.handoff({ summary: handoffSummary(latest.payload), nextSteps: latest.payload.next_steps, openQuestions: latest.payload.open_questions });
      }
      await this.reconcile(s, desired);
    });

    const learnings = fresh.flatMap((h) => h.payload.learnings.map(noteBody).filter(Boolean).map((l) => `[learning:${noteId(key)}] ${l}`));
    if (learnings.length > 0) {
      await withScope({ dataDir: this.d.dataDir, scope: WORKSPACE_SCOPE }, async (s) => {
        for (const text of learnings) await s.remember(text);
      });
    }
    const last = fresh.at(-1);
    if (last) this.d.sync.setCursor(key, last.id, this.d.now());
    try {
      this.d.onSynced?.(key);
    } catch (e) {
      this.log("memory onSynced callback failed", e);
    }
  }

  private async reconcile(s: ScopeHandle, desired: ButlerNote[]): Promise<void> {
    const plan = planReconcile(await s.facts(), desired);
    // 先 forget 再 remember（设计文档 13.1）：新文本是旧文本的修订时，StateCore 把它们串成一条 why 链。
    for (const factKey of plan.forget) await s.forget(factKey);
    const wanted = new Map(desired.map((n) => [noteKey(n), n]));
    const queue = plan.write.map((note) => ({ note, from: 1 }));
    // 每次重写都用更长的区分词，几轮之内必然分开；预算只是防止意外的死循环。
    let budget = desired.length * MAX_NOTE_VARIANT;
    while (queue.length > 0 && budget-- > 0) {
      const { note, from } = queue.shift()!;
      const displaced = await this.writeVisible(s, note, from);
      // 新写的这条被 StateCore 当成了另一条 Butler 条目的修订，那一条被挤掉了：用更长的区分词把它写回去。
      const other = displaced ? wanted.get(displaced.key) : undefined;
      if (displaced && other && !queue.some((q) => noteKey(q.note) === displaced.key)) {
        queue.push({ note: other, from: Math.min(MAX_NOTE_VARIANT, Math.max(2, displaced.variant + 1)) });
      }
    }
  }

  /**
   * 从第 from 个变体开始写，直到 facts() 里看得见为止：和已遗忘的条目一字不差时 StateCore 会永久隐藏它。
   * 返回被它挤掉的另一条 Butler 条目（StateCore 把这次写入当成了那一条的修订）。
   */
  private async writeVisible(s: ScopeHandle, note: ButlerNote, from: number): Promise<{ key: string; variant: number } | null> {
    let displaced: { key: string; variant: number } | null = null;
    for (let v = from; v <= MAX_NOTE_VARIANT; v++) {
      const text = noteText(note, v);
      const r = await s.remember(text);
      const old = r.superseded === null ? null : parseNote(r.superseded);
      if (old && noteKey(old) !== noteKey(note)) displaced = { key: noteKey(old), variant: old.variant };
      if ((await s.facts()).some((i) => i.text === text)) return displaced;
    }
    this.log(`memory: ${noteKey(note)} stays hidden after ${MAX_NOTE_VARIANT} variants`);
    return displaced;
  }

  /** ticket 详情页“记忆”标签（设计文档 8.4）。读失败时把原因放进 error，不抛错。 */
  async view(key: string): Promise<MemoryView> {
    const scope = ticketScope(key);
    if (!this.d.enabled()) return { enabled: false, scope, handoff: null, items: [], error: null };
    try {
      return await withScope({ dataDir: this.d.dataDir, scope }, async (s) => ({
        enabled: true,
        scope,
        handoff: await s.activeHandoff(),
        items: await s.facts(),
        error: null,
      }));
    } catch (e) {
      this.log(`memory view ${key} failed`, e);
      return { enabled: true, scope, handoff: null, items: [], error: errorText(e) };
    }
  }

  /** 一条记忆（或交接）的版本链。 */
  async why(key: string, factId: string): Promise<WhyEntry[] | null> {
    if (!this.d.enabled()) return null;
    return withScope({ dataDir: this.d.dataDir, scope: ticketScope(key) }, (s) => s.why(factId));
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/memory/memory-service.test.ts`
Expected: PASS

- [ ] **Step 5: 接进主进程**

`src/main/index.ts`：
- import 区加：

```ts
import { MemorySyncRepo } from "./db/memory-sync-repo";
import { MemoryService } from "./memory/memory-service";
```

- `const jobs = new JobsRepo(db);` 之后加：

```ts
  const memory = new MemoryService({
    dataDir: paths.statecore,
    tickets,
    handoffs,
    followups,
    sync: new MemorySyncRepo(db),
    enabled: () => settings.get("memoryEnabled") !== "0",
    now: Date.now,
    // 记忆标签开着时能看到新写入的内容（notify 在后面定义，这里只在调用时取用）。
    onSynced: () => notify(),
    log: logger,
  });
```

- `const ingest = ...` 整段改成：

```ts
  const ingest = (input: IngestInput) => {
    const r = ingestHandoff({ db, tickets, handoffs, followups, now: Date.now, newFollowupId: () => `f_${randomBytes(4).toString("hex")}` }, input);
    // 设计文档 5.4：入库后同步写入 StateCore（异步，失败只记日志）。
    if (r.stored && !r.degraded) void memory.syncTicket(input.ticketKey);
    return r;
  };
```

- `registerIpc({...})` 里的 `rederive` 改成：

```ts
    rederive: (key) => {
      rederiveTicketStatus({ tickets, handoffs, followups, now: Date.now }, key);
      // followup 完成 / 忽略 / 恢复：StateCore 里对应的条目跟着 forget / 重写。
      void memory.syncTicket(key);
    },
```

- `void runDiscovery();`（窗口创建之后那一行）之后加：

```ts
  // 启动时补齐记忆：老数据、上次退出时没写完的。
  void memory.syncAll();
```

- `app.on("will-quit", ...)` 回调里 `inbox.stop();` 之前加 `memory.stop();`。

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: 全部通过。

```bash
git add src/main/memory/memory-service.ts src/main/memory/memory-service.test.ts src/main/db/settings-repo.ts src/main/index.ts
git commit -m "feat: write handoffs, decisions, followups and learnings into StateCore after each handoff"
```

---

### Task 5: `PrivacyGateway.statecoreModel()`：full 档位的蒸馏只经 gateway（R1）

控制者给的首选方案是 loopback 代理（StateCore 的 `MODEL_BASE_URL` 指向 gateway 里的本机代理，用一次性 token 换真 key）。读了 StateCore 的源码后发现更直接的注入点：`createEmbeddedBackend({ digestLlm })` 接受一个 `chat(messages) → Promise<string>` 对象，一旦给了它，StateCore 就**完全不读** `FEATURE_LLM` / `MODEL_*`、也不自己构造 provider（`apps/mcp/src/digest.ts` 的 `maybeRunDigest`）。于是蒸馏可以直接在主进程里调用 gateway 的一个方法：没有本机端口、没有 bearer token、key 根本不出 gateway（Ruling P4-R4）。代价只有一个：这条路只对主进程里的嵌入式后端有效，claude 里挂的 MCP 进程没有模型（R1 本来就要求它们没有）。

每次 `chat()`：重新检查档位（必须是 `full`、配置齐全、**没开**发送前确认）→ 预算 → 审计 `pending`（`source = 'statecore'`，原样的请求体）→ 发送 → 记账。不扫描（Ruling P4-R1）、不弹确认框（Ruling P4-R5：蒸馏一次要调好几次模型，开着确认就不蒸馏）。失败时 reject：StateCore 把这次蒸馏记为 `failed`，事件留到下次。

**Files:**
- Modify: `src/main/gateway/gateway.ts`
- Test: `src/main/gateway/statecore-model.test.ts`（新建）
- Modify: `src/renderer/src/audit-view.ts`、`src/renderer/src/audit-view.test.ts`
- Modify: `src/renderer/src/strings.ts`

**Interfaces:**
- Consumes: `StatecoreChatModel`（任务 1）；`AuditRepo.insert({ ..., source })`、`AuditEntry.source`（任务 3）；`gatewayHarness`、`chatReply`（`src/main/gateway/testing.ts`）
- Produces:
  - `PrivacyGateway.statecoreModel(signal?: AbortSignal): StatecoreChatModel | null`
  - `STATECORE_MAX_TOKENS = 8192`、`class StatecoreCallError extends Error`（`src/main/gateway/gateway.ts`）
  - `S.auditStatecore`（渲染进程文案）

- [ ] **Step 1: 写失败测试**

新建 `src/main/gateway/statecore-model.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { chatReply, gatewayHarness, type GatewayHarness } from "./testing";

let h: GatewayHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const FAKE_KEY = "sk-test-FAKE0000";
const msgs = [
  { role: "system" as const, content: "你是记忆蒸馏器" },
  { role: "user" as const, content: "原始事件：PROJ-12 的 staging 地址是 https://intranet.corp/x" },
];

describe("PrivacyGateway.statecoreModel (plan 4 R1)", () => {
  it("gives no model below the full level, when not configured, or when confirm-before-send is on", async () => {
    h = await gatewayHarness({ level: "metadata" });
    expect(h.gateway.statecoreModel()).toBeNull();
    h.settings.set("llmLevel", "full");
    expect(h.gateway.statecoreModel()).not.toBeNull();
    h.settings.set("llmConfirm", "1");
    expect(h.gateway.statecoreModel()).toBeNull();
    h.settings.set("llmConfirm", "0");
    h.settings.set("llmModel", "");
    expect(h.gateway.statecoreModel()).toBeNull();
  });

  it("sends StateCore's messages unchanged and unscanned, with the key only in the header, and audits the call as statecore", async () => {
    h = await gatewayHarness({ level: "full" });
    h.keys.save(FAKE_KEY);
    h.provider.handle(() => chatReply('{"digest":"ok"}', { prompt_tokens: 1000, completion_tokens: 500 }));
    const model = h.gateway.statecoreModel()!;
    expect(await model.chat(msgs)).toBe('{"digest":"ok"}');
    expect(h.provider.requests).toHaveLength(1);
    const sent = JSON.parse(h.provider.requests[0].body) as { model: string; messages: unknown; max_tokens: number };
    expect(sent).toMatchObject({ model: "fake-model", messages: msgs, max_tokens: 8192 });
    expect(h.provider.requests[0].headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    const [row] = h.audit.list();
    expect(row).toMatchObject({ source: "statecore", level: "full", status: "sent", tokensIn: 1000, tokensOut: 500, blockedReason: null, error: null });
    expect(row.costUsd).toBeCloseTo((1000 * 1 + 500 * 2) / 1_000_000, 10);
    expect(row.payloadSent).toContain("https://intranet.corp/x");
    expect(JSON.stringify(row)).not.toContain(FAKE_KEY);
    expect(h.confirms).toEqual([]);
  });

  it("refuses every call once the level is no longer full or confirm is on (Review Focus 4)", async () => {
    h = await gatewayHarness({ level: "full" });
    const model = h.gateway.statecoreModel()!;
    h.settings.set("llmLevel", "redacted");
    await expect(model.chat(msgs)).rejects.toThrow();
    h.settings.set("llmLevel", "full");
    h.settings.set("llmConfirm", "1");
    await expect(model.chat(msgs)).rejects.toThrow();
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()).toEqual([]);
    expect(h.confirms).toEqual([]);
  });

  it("stops at the monthly budget without sending", async () => {
    h = await gatewayHarness({ level: "full" });
    // 输出上限 8192 token × $2 / 百万 ≈ $0.016，超过 $0.01。
    h.settings.set("llmMonthlyBudgetUsd", "0.01");
    await expect(h.gateway.statecoreModel()!.chat(msgs)).rejects.toThrow(/预算/);
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()).toMatchObject([{ source: "statecore", status: "budget", payloadSent: null }]);
  });

  it("records a failed call and rejects, so StateCore keeps the events for the next run", async () => {
    h = await gatewayHarness({ level: "full" });
    h.provider.handle(() => ({ status: 500, body: { error: "upstream" } }));
    await expect(h.gateway.statecoreModel()!.chat(msgs)).rejects.toThrow();
    expect(h.audit.list()).toMatchObject([{ source: "statecore", status: "failed" }]);
  });

  it("does not send once the app is quitting", async () => {
    h = await gatewayHarness({ level: "full" });
    const quit = new AbortController();
    const model = h.gateway.statecoreModel(quit.signal)!;
    quit.abort();
    await expect(model.chat(msgs)).rejects.toThrow();
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()).toEqual([]);
  });
});
```

`src/renderer/src/audit-view.test.ts` 的 `summarises an entry and explains a block` 用例末尾加：

```ts
    expect(auditSummary(entry({ source: "statecore", level: "full" }))).toBe("StateCore 记忆蒸馏 · 完整 · 已发送 · 120 / 40 token · $0.0023");
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/gateway/statecore-model.test.ts src/renderer/src/audit-view.test.ts`
Expected: FAIL——`statecoreModel` 不存在；摘要里没有来源。

- [ ] **Step 3: 实现**

`src/main/gateway/gateway.ts`：
- import 区：`import type { NarrativeSource, OutboundPayload, Rng } from "./types";` 改成 `import type { NarrativeSource, OutboundPayload, Rng, StatecoreChatModel } from "./types";`
- `const QUITTING = "app 正在退出";` 之后加：

```ts
/** StateCore 每次蒸馏调用的输出上限（它要求模型输出结构化 JSON）；发送前的预算检查按这个上限估算。 */
export const STATECORE_MAX_TOKENS = 8192;

/** StateCore 蒸馏调用被拒绝或失败：StateCore 把这次蒸馏记为 failed，事件留到下次。 */
export class StatecoreCallError extends Error {}
```

- `const llmOff = ...` 之后加：

```ts
/** StateCore 蒸馏的条件（计划 4 R1 / P4-R5）：full 档位、配置齐全、没开发送前确认。 */
const statecoreAllowed = (cfg: LlmConfig): boolean => cfg.level === "full" && !llmOff(cfg) && !cfg.confirm;
```

- 类里 `narrate()` 整个方法替换为下面三个方法（`serial` 保持原来的行为：一次调用出任何问题，后面的照常排队）：

```ts
  /** 串行队列：预算检查、发送、记账一次只有一个调用在进行（“今日重点”和 StateCore 蒸馏共用）。 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    // 链条本身永远不会失败：一次调用出了任何问题，后面的调用照常排队执行。
    this.chain = run.catch(() => undefined);
    return run;
  }

  narrate(src: NarrativeSource, signal?: AbortSignal): Promise<NarrativeResult> {
    return this.serial(() => this.run(src, signal)).catch((e: unknown): NarrativeResult => {
      // 意外错误（数据库等）里不会有 key：key 只在 run() 里、只进请求头；保险起见仍去掉 Bearer 凭证。
      this.log("narrative failed", new Error(scrub(errorText(e), null)));
      return result("failed");
    });
  }

  /**
   * StateCore 蒸馏用的模型（计划 4 R1）：只有 full 档位、配置齐全、没开“发送前确认”时才给。
   * 每次 chat() 都重新检查这些条件（蒸馏进行中改了档位也立即生效），在 gateway 里带上 key、检查预算、
   * 写审计（source = statecore）后发送。不做敏感信息扫描：full 档位下设计文档 8.5 接受发送原始事件（Ruling P4-R1）。
   * 被拒绝或失败时 reject（StatecoreCallError）。
   */
  statecoreModel(signal?: AbortSignal): StatecoreChatModel | null {
    if (!statecoreAllowed(llmConfig(this.d.settings))) return null;
    return { chat: (messages) => this.serial(() => this.statecoreCall(messages, signal)) };
  }

  private async statecoreCall(input: { role: "system" | "user"; content: string }[], signal?: AbortSignal): Promise<string> {
    const cfg = llmConfig(this.d.settings);
    const now = this.d.now();
    this.d.audit.prune(auditCutoff(now, cfg.retentionDays));
    if (!statecoreAllowed(cfg)) throw new StatecoreCallError("StateCore 蒸馏只在完整档位、关闭发送前确认时运行");
    if (signal?.aborted) throw new StatecoreCallError(QUITTING);
    const url = new URL(cfg.baseUrl);
    const apiKey = this.d.keys.get();
    // 远程服务必须有 key；保存过但解不开的 key 本机服务也不发。
    if (apiKey === null && (this.d.keys.saved() || !isLoopbackHost(url.hostname))) throw new StatecoreCallError("没有可用的 API key");

    // 只取 role 和 content 两个字段，其余一概不发。
    const messages: ChatMessage[] = input.map((m) => ({ role: m.role === "system" ? "system" : "user", content: String(m.content) }));
    const body = chatBody({ model: cfg.model, messages, maxTokens: STATECORE_MAX_TOKENS });
    const base = { ts: now, provider: url.host, model: cfg.model, level: "full" as const, source: "statecore" as const };
    const budget = checkBudget({
      prices: cfg.prices, model: cfg.model, budgetUsd: cfg.budgetUsd, spentUsd: this.d.audit.costSince(monthStart(now)),
      inputText: messages.map((m) => m.content).join("\n"), maxOutputTokens: STATECORE_MAX_TOKENS,
    });
    if (!budget.ok) {
      this.d.audit.insert({ ...base, status: "budget", payloadSent: null, error: budget.message });
      throw new StatecoreCallError(budget.message);
    }

    const auditId = this.d.audit.insert({ ...base, status: "pending", payloadSent: body });
    let res: ChatResponse;
    try {
      res = await (this.d.chat ?? chatCompletion)({ baseUrl: cfg.baseUrl, apiKey, model: cfg.model, messages, maxTokens: STATECORE_MAX_TOKENS, signal });
    } catch (e) {
      const message = scrub(errorText(e), apiKey);
      this.log(`statecore request failed: ${message}`);
      if (e instanceof ProviderError && e.kind === "bad_response" && e.status !== null && e.status >= 200 && e.status < 300) {
        // 服务商以 2xx 收下了请求：可能已经计费，按发出的请求体和输出上限保守记账。
        const sentBody = e.sentBody ?? body;
        this.record(auditId, { status: "sent", payloadSent: sentBody, ...sentWithoutUsage(budget.price, sentBody, STATECORE_MAX_TOKENS), error: message });
      } else {
        const sent = e instanceof ProviderError ? e.sentBody : undefined;
        this.d.audit.finish(auditId, { status: "failed", error: message, ...(sent === undefined ? {} : { payloadSent: sent }) });
      }
      throw new StatecoreCallError(message);
    }

    const content = scrub(res.content, apiKey);
    const tokensIn = res.tokensIn ?? estimateTokens(res.sentBody);
    const tokensOut = res.tokensOut ?? estimateTokens(content);
    const recorded = this.record(auditId, {
      status: "sent",
      payloadSent: res.sentBody,
      response: scrub(res.raw, apiKey),
      tokensIn,
      tokensOut,
      costUsd: costUsd(budget.price, tokensIn, tokensOut),
      error: null,
    });
    // 花费没记上就不交出结果：下一次预算检查必须看得到这次的花费。
    if (!recorded) throw new StatecoreCallError("审计记录写入失败");
    return content;
  }
```

`src/renderer/src/strings.ts`：
- `audit: "审计",` 之后加：

```ts
  auditStatecore: "StateCore 记忆蒸馏",
```

- `auditIntro` 改成：

```ts
  auditIntro: "每次调用个人 LLM API 的记录（早间简报的“今日重点”，以及完整档位下 StateCore 记忆的蒸馏）：原样发出的内容、响应、token 数和费用；被拦截或超预算的请求只记原因，没有发出任何内容。",
```

- `privacyLevelHelp.full` 改成：

```ts
    full: "不做替换，发送真实的 ticket 号和原文；“今日重点”仍然做敏感信息扫描。这一档还会把 claude 里记下的原始对话片段（StateCore 记忆）每晚经个人 API 蒸馏成要点，这部分不做扫描，记在审计页。只应用于你信任其处理工作内容的服务商。",
```

`src/renderer/src/audit-view.ts` 的 `auditSummary` 改成：

```ts
/** 列表里每一行的摘要：（来源）· 档位 · 状态 · token · 费用。“今日重点”不写来源。 */
export function auditSummary(e: AuditEntry): string {
  const parts = [S.privacyLevels[e.level], auditStatusLabel(e.status)];
  if (e.source === "statecore") parts.unshift(S.auditStatecore);
  if (e.tokensIn !== null || e.tokensOut !== null) parts.push(S.auditTokens(e.tokensIn ?? 0, e.tokensOut ?? 0));
  if (e.costUsd !== null) parts.push(formatUsd(e.costUsd));
  return parts.join(" · ");
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/gateway src/renderer/src/audit-view.test.ts`
Expected: PASS（包括 gateway 原有的全部用例：`narrate()` 的行为没有变）。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/main/gateway/gateway.ts src/main/gateway/statecore-model.test.ts src/renderer/src/audit-view.ts src/renderer/src/audit-view.test.ts src/renderer/src/strings.ts
git commit -m "feat: StateCore distillation model that only exists inside the gateway, audited and budgeted"
```

---

### Task 6: full 档位的记忆蒸馏（晚间任务的最后一步）

claude 里挂的 StateCore 收到 `remember(consolidate: true)` 时只存原始事件（它们没有模型，R1）。`full` 档位下，晚间任务在小结之后对每个有待蒸馏事件的 scope 调一次 `digestNow()`，模型是 `gateway.statecoreModel()`。其他档位或没开记忆时什么都不做；事件留在库里，`recall` 照样能按关键词检索到原文。

**Files:**
- Modify: `src/main/memory/memory-service.ts`、`src/main/memory/memory-service.test.ts`
- Modify: `src/main/schedule/daily-jobs.ts`、`src/main/schedule/daily-jobs.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `withScope({ model })`、`listScopeNames`、`DigestOutcome`（任务 1）；`PrivacyGateway.statecoreModel(signal)`（任务 5）
- Produces:
  - `interface DistillResult { scopes: number; ran: number; failed: number }`
  - `MemoryService.distill(model: StatecoreChatModel | null): Promise<DistillResult>`（排在同步队列里，永不 reject）
  - `DailyJobDeps.distill?: () => Promise<unknown>`

- [ ] **Step 1: 写失败测试**

`src/main/memory/memory-service.test.ts`：顶部 import 加：

```ts
import { createEmbeddedBackend } from "statecore-mcp/lib";
```

文件末尾追加：

```ts
/** 模拟 claude 里的 remember(consolidate: true)：写一条待蒸馏的原始事件。 */
async function seedEvent(dataDir: string, scope: string): Promise<void> {
  const b = createEmbeddedBackend({ dataDir, scopeName: scope, env: {}, backgroundDigest: false });
  await b.init();
  try {
    await b.remember({ text: "claude 里记下的一段原始对话", consolidate: true });
  } finally {
    await b.close();
  }
}

describe("MemoryService.distill (consolidate at the full level)", () => {
  const stub = () => {
    const calls: string[] = [];
    return {
      calls,
      model: {
        chat: async (messages: { role: "system" | "user"; content: string }[]) => {
          calls.push(messages.map((m) => m.role).join(","));
          throw new Error("stub model");
        },
      },
    };
  };

  it("does nothing without a model or when memory is off", async () => {
    const t = setup();
    await seedEvent(t.dataDir, "ticket:PROJ-1");
    const s = stub();
    expect(await t.memory.distill(null)).toEqual({ scopes: 0, ran: 0, failed: 0 });
    t.setEnabled(false);
    expect(await t.memory.distill(s.model)).toEqual({ scopes: 0, ran: 0, failed: 0 });
    expect(s.calls).toEqual([]);
  });

  it("digests only the scopes with pending events, through the given model", async () => {
    const t = setup();
    await seedEvent(t.dataDir, "ticket:PROJ-1");
    t.addFollowup("f_1");
    await t.memory.syncTicket("PROJ-2");
    await t.memory.syncTicket("PROJ-1");
    const s = stub();
    // 桩模型抛错：蒸馏失败，事件留到下次。
    expect(await t.memory.distill(s.model)).toEqual({ scopes: 1, ran: 0, failed: 1 });
    expect(s.calls.length).toBeGreaterThan(0);
    await withScope({ dataDir: t.dataDir, scope: "ticket:PROJ-1" }, async (sc) => {
      expect(await sc.pendingEvents()).toBe(1);
    });
  });

  it("returns an empty result instead of rejecting when the store cannot open", async () => {
    const blocker = join(tempDir(), "not-a-dir");
    writeFileSync(blocker, "x");
    const t = setup({ dataDir: blocker });
    expect(await t.memory.distill(stub().model)).toEqual({ scopes: 0, ran: 0, failed: 0 });
  });
});
```

`src/main/schedule/daily-jobs.test.ts` 的 `describe("daily jobs", ...)` 里追加：

```ts
  it("nightly: distills memory last, and its failure does not fail the job", async () => {
    const { d, calls } = deps({
      distill: async () => {
        calls.push("distill");
        throw new Error("boom");
      },
    });
    expect(await nightlyJob(d)).toBe("partial");
    expect(calls).toEqual(["runNightly", "evening", "notify:evening", "distill"]);
  });

  it("nightly: no distillation once the app is quitting", async () => {
    const { d, calls } = deps({ aborted: () => true, distill: async () => calls.push("distill") });
    await nightlyJob(d);
    expect(calls).not.toContain("distill");
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/memory/memory-service.test.ts src/main/schedule/daily-jobs.test.ts`
Expected: FAIL——`distill` 不存在。

- [ ] **Step 3: 实现**

`src/main/memory/memory-service.ts`：
- import 区加 `import type { StatecoreChatModel } from "../gateway/types";`，并把 `import { withScope, type ScopeHandle } from "./statecore";` 改成 `import { listScopeNames, withScope, type ScopeHandle } from "./statecore";`
- `export function handoffSummary` 之前加：

```ts
export interface DistillResult {
  /** 有待蒸馏事件、尝试了蒸馏的 scope 数。 */
  scopes: number;
  ran: number;
  failed: number;
}
```

- 类里 `why()` 之后加：

```ts
  /**
   * full 档位：把 claude 里 consolidate 进来的原始事件蒸馏成记忆（计划 4 R1：模型只能是 PrivacyGateway.statecoreModel() 的结果）。
   * model 为 null（不是 full 档位等）或记忆关闭时什么都不做。排在同步队列里，和写入不并发；一个 scope 失败不影响其他 scope。
   */
  distill(model: StatecoreChatModel | null): Promise<DistillResult> {
    const empty: DistillResult = { scopes: 0, ran: 0, failed: 0 };
    return this.enqueue(
      "memory distill",
      async () => {
        const r = { ...empty };
        if (!model || !this.d.enabled()) return r;
        for (const scope of await listScopeNames(this.d.dataDir)) {
          if (this.stopped) break;
          try {
            const outcome = await withScope({ dataDir: this.d.dataDir, scope, model }, async (s) => ((await s.pendingEvents()) > 0 ? s.digestNow() : null));
            if (outcome === null) continue;
            r.scopes++;
            if (outcome === "ran") r.ran++;
            else if (outcome === "failed") r.failed++;
          } catch (e) {
            r.scopes++;
            r.failed++;
            this.log(`memory distill ${scope} failed`, e);
          }
        }
        return r;
      },
      empty,
    );
  }
```

`src/main/schedule/daily-jobs.ts`：
- `DailyJobDeps` 里 `narrate?` 之后加：

```ts
  /** 晚间小结之后：full 档位下蒸馏 StateCore 记忆（MemoryService.distill，计划 4 R1）。失败不影响晚间任务。 */
  distill?: () => Promise<unknown>;
```

- `nightlyJob` 里 `if (brief.evening.length > 0 && forToday && !d.aborted?.()) d.onEvening(brief);` 之后、`return batch.status;` 之前加：

```ts
  if (d.distill && !d.aborted?.()) {
    const distill = d.distill;
    await Promise.resolve()
      .then(() => distill())
      .catch(() => undefined);
  }
```

`src/main/index.ts`：`dailyDeps` 对象里 `onEvening` 之前加：

```ts
    distill: async () => {
      const r = await memory.distill(gateway.statecoreModel(headlessAbort.signal));
      if (r.scopes > 0) logger(`memory distill: ${r.scopes} scope(s), ${r.ran} ran, ${r.failed} failed`);
    },
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/memory/memory-service.test.ts src/main/schedule/daily-jobs.test.ts`
Expected: PASS

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: 全部通过。

```bash
git add src/main/memory/memory-service.ts src/main/memory/memory-service.test.ts src/main/schedule/daily-jobs.ts src/main/schedule/daily-jobs.test.ts src/main/index.ts
git commit -m "feat: nightly StateCore distillation at the full level, through the gateway model only"
```

---

### Task 7: 给 claude 挂上记忆：打包的 StateCore MCP 与 `mcp/<ticket>.json`

设计文档 8.4：Butler 启动的每个 session 都通过 `--mcp-config ~/.butler/mcp/<ticket>.json` 挂载 statecore-mcp（`STATECORE_SCOPE=ticket:<KEY>`），再以另一个 server 名挂一个 `workspace` 实例。server 进程不能依赖用户装没装 Node：把 `statecore-mcp` 的 bin 用 esbuild 打成一个文件，用 Butler 自己的 Electron 以 `ELECTRON_RUN_AS_NODE=1` 运行（Electron 44 内置 Node 24.22，有 `node:sqlite`）。入口先清环境变量再加载 StateCore（R1）。

Windows 上 npm 装的 `claude.cmd` 要经过 cmd.exe，路径里有空格时 `--mcp-config <路径>` 无法安全传递（计划 1 的遗留）：本计划在这种情况下不挂记忆、session 照常打开并写日志；计划 5 去掉 cmd.exe 这一层后自然解决。

**Files:**
- Create: `memory-mcp/sanitize.ts`、`memory-mcp/clean-env.ts`、`memory-mcp/entry.ts`
- Test: `memory-mcp/sanitize.test.ts`、`memory-mcp/bundle.test.ts`
- Create: `scripts/build-memory-mcp.mjs`
- Modify: `package.json`（scripts）、`tsconfig.node.json`、`vitest.config.mts`
- Create: `src/main/memory/mcp-config.ts`
- Test: `src/main/memory/mcp-config.test.ts`
- Modify: `src/main/claude/spawn.ts`、`src/main/claude/spawn.test.ts`
- Modify: `src/main/sessions/session-service.ts`、`src/main/sessions/session-service.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `statecoreEnv(base)`（任务 1）；`ticketScope`、`WORKSPACE_SCOPE`（`src/shared/memory.ts`）；`claudeArgs({ mode, sessionId, mcpConfigPath })`（`src/main/claude/spawn.ts`，已有）
- Produces:
  - `sanitizeEnv(env: NodeJS.ProcessEnv): void`（`memory-mcp/sanitize.ts`）
  - `build/memory-mcp/statecore-mcp.cjs`（`pnpm build:memory-mcp`；`pnpm build` 和 `pnpm dev` 会先跑它）；脚本接受一个可选的输出路径参数
  - `src/main/memory/mcp-config.ts`：`MEMORY_SERVER = "butler-memory"`、`WORKSPACE_SERVER = "butler-workspace"`、`interface MemoryMcpLauncher { command: string; script: string }`、`interface McpServerSpec { type: "stdio"; command: string; args: string[]; env: Record<string, string> }`、`memoryServers(o: { launcher; statecoreDir; ticketKey }): Record<string, McpServerSpec>`、`ticketMcpFile(mcpDir, ticketKey): string`、`writeTicketMcpConfig(o: { mcpDir; ticketKey; launcher; statecoreDir }): string`
  - `cmdShimSafe(file: string, arg: string, platform: NodeJS.Platform): boolean`（`src/main/claude/spawn.ts`）
  - `SessionServiceDeps.mcpConfig?: (ticketKey: string) => string | null`

- [ ] **Step 1: 写失败测试**

新建 `memory-mcp/sanitize.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { sanitizeEnv } from "./sanitize";

describe("memory MCP environment (R1)", () => {
  it("deletes every model variable in place, whatever the letter case, and keeps the rest", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/bin", STATECORE_SCOPE: "ticket:A-1", ELECTRON_RUN_AS_NODE: "1",
      MODEL_API_KEY: "k", openai_api_key: "k2", ANTHROPIC_API_KEY: "k3", FEATURE_LLM: "true", STATECORE_DIGEST_THRESHOLD: "1",
    };
    sanitizeEnv(env);
    expect(env).toEqual({ PATH: "/bin", STATECORE_SCOPE: "ticket:A-1", ELECTRON_RUN_AS_NODE: "1" });
  });
});
```

新建 `memory-mcp/bundle.test.ts`：

```ts
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { withScope } from "../src/main/memory/statecore";
import { tempDir } from "../src/main/test-utils";

const root = fileURLToPath(new URL("../", import.meta.url));
let bundle = "";

beforeAll(() => {
  bundle = join(tempDir(), "statecore-mcp.cjs");
  execFileSync(process.execPath, ["scripts/build-memory-mcp.mjs", bundle], { cwd: root, stdio: "pipe" });
}, 120_000);

interface Reply {
  id?: number;
  result?: { content?: { text: string }[]; tools?: { name: string }[] };
}

/** 像 claude 按 --mcp-config 那样启动 bundle：stdio 上的 JSON-RPC，一问一答。 */
async function open(env: NodeJS.ProcessEnv, dataDir: string) {
  const child = spawn(process.execPath, [bundle, "--data", dataDir], { env, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (r: Reply) => void>();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    buf += c;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Reply;
      if (typeof msg.id === "number") waiting.get(msg.id)?.(msg);
    }
  });
  let nextId = 0;
  const call = (method: string, params?: unknown) =>
    new Promise<Reply>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "butler-test", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tool = async (name: string, args: Record<string, unknown>) => (await call("tools/call", { name, arguments: args })).result?.content?.[0]?.text ?? "";
  const close = () =>
    new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.kill();
    });
  return { call, tool, close };
}

describe("bundled StateCore MCP (design 8.4)", () => {
  it("serves StateCore's tools in the scope from STATECORE_SCOPE, and Butler reads what it wrote", async () => {
    const dataDir = tempDir();
    const s = await open({ ...process.env, STATECORE_SCOPE: "ticket:T-1", LOG_LEVEL: "warn" }, dataDir);
    try {
      const names = ((await s.call("tools/list")).result?.tools ?? []).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["remember", "recall", "facts", "why", "forget", "handoff"]));
      expect(await s.tool("remember", { text: "Claude 记的：这个仓库用 pnpm" })).toContain('"ok": true');
    } finally {
      await s.close();
    }
    const texts = await withScope({ dataDir, scope: "ticket:T-1" }, async (sc) => (await sc.facts()).map((i) => i.text));
    expect(texts).toEqual(["Claude 记的：这个仓库用 pnpm"]);
  }, 60_000);

  it("strips inherited model keys even when the parent passes them (Review Focus 3)", async () => {
    // 万一清理失效，请求也只会打到本机一个关闭的端口，绝不会到真实的服务商。
    const s = await open(
      {
        ...process.env, STATECORE_SCOPE: "ticket:T-2", LOG_LEVEL: "warn",
        FEATURE_LLM: "true", MODEL_API_KEY: "sk-inherited", OPENAI_API_KEY: "sk-inherited-2", MODEL_BASE_URL: "http://127.0.0.1:9/v1", STATECORE_DIGEST_THRESHOLD: "1",
      },
      tempDir(),
    );
    try {
      expect(await s.tool("remember", { text: "一段原始对话", consolidate: true })).toContain("no model configured");
    } finally {
      await s.close();
    }
  }, 60_000);
});
```

新建 `src/main/memory/mcp-config.test.ts`：

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { memoryServers, ticketMcpFile, writeTicketMcpConfig } from "./mcp-config";

const launcher = { command: "/Applications/Butler.app/Contents/MacOS/Butler", script: "/Applications/Butler.app/Contents/Resources/memory-mcp/statecore-mcp.cjs" };

describe("ticket MCP config (design 4.2, 8.4)", () => {
  it("mounts the ticket scope and the workspace scope under Butler's own server names", () => {
    const server = (scope: string) => ({
      type: "stdio",
      command: launcher.command,
      args: [launcher.script, "--data", "/h/.butler/statecore"],
      env: { ELECTRON_RUN_AS_NODE: "1", STATECORE_SCOPE: scope, LOG_LEVEL: "warn" },
    });
    expect(memoryServers({ launcher, statecoreDir: "/h/.butler/statecore", ticketKey: "PROJ-1" })).toEqual({
      "butler-memory": server("ticket:PROJ-1"),
      "butler-workspace": server("workspace"),
    });
  });

  it("writes mcp/<ticket>.json privately, replaces it atomically and never puts a model key in it (R1)", () => {
    const mcpDir = join(tempDir(), "mcp");
    const file = writeTicketMcpConfig({ mcpDir, ticketKey: "PROJ-1", launcher, statecoreDir: "/sc" });
    expect(file).toBe(join(mcpDir, "PROJ-1.json"));
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text)).toEqual({ mcpServers: memoryServers({ launcher, statecoreDir: "/sc", ticketKey: "PROJ-1" }) });
    expect(text).not.toMatch(/MODEL_|OPENAI|ANTHROPIC|FEATURE_LLM|API_KEY/i);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    writeTicketMcpConfig({ mcpDir, ticketKey: "PROJ-1", launcher, statecoreDir: "/sc2" });
    expect(readFileSync(file, "utf8")).toContain("/sc2");
    expect(readdirSync(mcpDir)).toEqual(["PROJ-1.json"]);
  });

  it("keeps the file for an odd ticket key inside mcpDir (Review Focus 5)", () => {
    const mcpDir = join(tempDir(), "mcp");
    for (const key of ["../../etc/passwd", "A B/C", "..", "PROJ-1", "名字-1"]) {
      const f = ticketMcpFile(mcpDir, key);
      expect(dirname(f), key).toBe(mcpDir);
      expect(basename(f), key).toMatch(/^[A-Za-z0-9._-]+\.json$/);
    }
    expect(ticketMcpFile(mcpDir, "A B")).not.toBe(ticketMcpFile(mcpDir, "A_B"));
    expect(ticketMcpFile(mcpDir, "PROJ-1")).toBe(join(mcpDir, "PROJ-1.json"));
  });
});
```

`src/main/claude/spawn.test.ts` 末尾追加：

```ts
describe("cmdShimSafe", () => {
  it("accepts anything when no cmd.exe is involved", () => {
    expect(cmdShimSafe("/usr/local/bin/claude", "/Users/John Smith/.butler/mcp/A-1.json", "darwin")).toBe(true);
    expect(cmdShimSafe("C:\\bin\\claude.exe", "C:\\Users\\John Smith\\x.json", "win32")).toBe(true);
  });

  it("rejects spaces, quotes and cmd metacharacters for a .cmd shim on Windows", () => {
    expect(cmdShimSafe("C:\\npm\\claude.cmd", "C:\\Users\\john\\.butler\\mcp\\A-1.json", "win32")).toBe(true);
    for (const bad of ["C:\\Users\\John Smith\\x.json", 'C:\\a"b.json', "C:\\a&b.json", "C:\\a%b.json", "C:\\a^b.json", "C:\\a(b).json"]) {
      expect(cmdShimSafe("C:\\npm\\claude.cmd", bad, "win32"), bad).toBe(false);
    }
  });
});
```

并把文件顶部的 import 加上 `cmdShimSafe`（与已有的 `claudeArgs` 等同一行）。

`src/main/sessions/session-service.test.ts`：
- `setup` 的参数类型里 `factory?: PtyFactory;` 之后加：

```ts
  mcpConfig?: (ticketKey: string) => string | null;
  platform?: NodeJS.Platform;
```

- `new SessionService({...})` 里 `platform: "darwin",` 改成 `platform: opts.platform ?? "darwin",`，并在 `baseEnv: { HOME: "/h" },` 之后加：

```ts
    mcpConfig: opts.mcpConfig,
    log: (m) => logs.push(m),
```

- `let n = 0;` 之前加 `const logs: string[] = [];`，`return { ... }` 里加上 `logs`。
- `describe("SessionService.open", ...)` 里追加：

```ts
  it("mounts the ticket's memory MCP config on new and resumed sessions (design 4.2)", async () => {
    const asked: string[] = [];
    const { service, spawned, sessions } = await setup({ mcpConfig: (key) => (asked.push(key), "/b/mcp/PROJ-1.json") });
    await service.open({ ticketKey: "PROJ-1" });
    expect(spawned[0].args).toEqual(["--session-id", "new-1", "--mcp-config", "/b/mcp/PROJ-1.json"]);
    sessions.insertIfAbsent({ id: "old", ticketKey: "PROJ-1", cwd: "/elsewhere", origin: "butler", createdAt: 1 });
    await service.open({ ticketKey: "PROJ-1", sessionId: "old" });
    expect(spawned[1].args).toEqual(["--resume", "old", "--mcp-config", "/b/mcp/PROJ-1.json"]);
    expect(asked).toEqual(["PROJ-1", "PROJ-1"]);
  });

  it("opens the session without memory when the config is off, fails, or cannot pass through cmd.exe", async () => {
    const off = await setup({ mcpConfig: () => null });
    await off.service.open({ ticketKey: "PROJ-1" });
    expect(off.spawned[0].args).toEqual(["--session-id", "new-1"]);

    const broken = await setup({
      mcpConfig: () => {
        throw new Error("disk full");
      },
    });
    expect(await broken.service.open({ ticketKey: "PROJ-1" })).toMatchObject({ ok: true });
    expect(broken.spawned[0].args).toEqual(["--session-id", "new-1"]);
    expect(broken.logs.some((l) => l.includes("memory MCP config for PROJ-1 not written"))).toBe(true);

    const shim = await setup({ platform: "win32", claudePath: "C:\\npm\\claude.cmd", mcpConfig: () => "C:\\Users\\John Smith\\.butler\\mcp\\PROJ-1.json" });
    await shim.service.open({ ticketKey: "PROJ-1" });
    expect(shim.spawned[0].args).not.toContain("--mcp-config");
    expect(shim.logs.some((l) => l.includes("memory MCP not mounted for PROJ-1"))).toBe(true);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run memory-mcp src/main/memory/mcp-config.test.ts src/main/claude/spawn.test.ts src/main/sessions/session-service.test.ts`
Expected: FAIL——vitest 还不收 `memory-mcp/**`（先改 Step 3 的配置再看到真正的失败）；`./mcp-config`、`cmdShimSafe` 不存在；session 的参数里没有 `--mcp-config`。

- [ ] **Step 3: 打包的 MCP 入口和构建脚本**

`vitest.config.mts` 的 `include` 改成：

```ts
    include: ["src/**/*.test.ts", "hook/**/*.test.ts", "memory-mcp/**/*.test.ts"],
```

`tsconfig.node.json` 的 `include` 里 `"hook/**/*",` 之后加 `"memory-mcp/**/*",`。

新建 `memory-mcp/sanitize.ts`：

```ts
import { statecoreEnv } from "../src/main/gateway/statecore-env";

/**
 * 原地删掉 StateCore 会用来调用模型的变量（计划 4 R1）。claude 启动 MCP server 时会把它自己的环境变量
 * （可能有用户 shell 里导出的 OPENAI_API_KEY 等）一起传下来，所以 server 进程启动时必须自己再清一遍。
 */
export function sanitizeEnv(env: NodeJS.ProcessEnv): void {
  const keep = statecoreEnv(env);
  for (const k of Object.keys(env)) if (!(k in keep)) delete env[k];
}
```

新建 `memory-mcp/clean-env.ts`：

```ts
import { sanitizeEnv } from "./sanitize";

// entry.ts 的第一个 import：在 StateCore 加载、读取 process.env 之前执行。
sanitizeEnv(process.env);
```

新建 `memory-mcp/entry.ts`：

```ts
// 给 claude 挂载的 StateCore MCP server（设计文档 8.4）。
// 顺序就是执行顺序（ES 模块按 import 的先后求值，esbuild 打包后保持不变）：先清掉环境变量里的模型 key（R1），
// 再加载 statecore-mcp 的 bin：它在加载时解析 --data、读 STATECORE_SCOPE，经 stdio 提供 MCP。
import "./clean-env";
import "statecore-mcp";
```

新建 `scripts/build-memory-mcp.mjs`：

```js
// 把 statecore-mcp 的 MCP server 连同依赖打成一个文件。Butler 用自己的 Electron（ELECTRON_RUN_AS_NODE=1）运行它，挂给 claude。
// 用法：node scripts/build-memory-mcp.mjs [输出文件]，默认 build/memory-mcp/statecore-mcp.cjs。
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { build } from "esbuild";

const outfile = process.argv[2] ?? "build/memory-mcp/statecore-mcp.cjs";
mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: ["memory-mcp/entry.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile,
  // statecore-mcp 自己打包时也把它留在外面：@statecore/core 里一个嵌入式后端永远走不到的懒加载 import。
  external: ["@statecore/db"],
  logLevel: "warning",
});
console.log(`built ${outfile}`);
```

`package.json` 的 `scripts`：
- `"build": "electron-vite build",` 改成 `"build": "electron-vite build && node scripts/build-memory-mcp.mjs",`
- 加 `"predev": "node scripts/build-memory-mcp.mjs",` 和 `"build:memory-mcp": "node scripts/build-memory-mcp.mjs",`

- [ ] **Step 4: 实验：Electron 能不能当 Node 跑这个 bundle（spike）**

在**一次** Bash 调用里执行（只用临时目录；故意给一个 `MODEL_API_KEY` 和本机关闭的端口，验证 R1 的清理）：

```bash
set -eu
pnpm build:memory-mcp
D="$(mktemp -d)"
ELECTRON="$(node -e 'console.log(require("electron"))')"
( printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"spike","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"remember","arguments":{"text":"spike","consolidate":true}}}'; sleep 3 ) \
| ELECTRON_RUN_AS_NODE=1 MODEL_API_KEY=sk-x MODEL_BASE_URL=http://127.0.0.1:9/v1 FEATURE_LLM=true STATECORE_SCOPE=ticket:T-1 LOG_LEVEL=warn \
  "$ELECTRON" build/memory-mcp/statecore-mcp.cjs --data "$D" 2>"$D/err.txt" | cut -c1-200
tail -2 "$D/err.txt"; ls "$D"
```

Expected（2026-10-21 用 StateCore 源码打的同样的 bundle 实测过，大小约 1.8 MB）：第一行是 `{"result":{"protocolVersion":"2025-06-18",...,"serverInfo":{"name":"statecore","version":"1.0.0"}...`；第二行的 text 里有 `"reason": "no model configured"`；stderr 有 `[statecore-mcp] ready over stdio (embedded ...)`；目录里出现 `statecore.db`。**备选**：Electron 不能当 Node 用（`ELECTRON_RUN_AS_NODE` 被 fuse 关掉等），改成用登录 shell PATH 里 ≥ 22.13 的 `node` 作为 `launcher.command`，没有就不挂记忆并在健康页提示——这会改任务 9 的健康检查，先停下来报告控制者。

- [ ] **Step 5: 实现 mcp 配置文件和 session 挂载**

新建 `src/main/memory/mcp-config.ts`：

```ts
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ticketScope, WORKSPACE_SCOPE } from "../../shared/memory";

/** 挂给 claude 的 server 名：不和用户自己装的 statecore 重名（设计文档 8.4）。 */
export const MEMORY_SERVER = "butler-memory";
export const WORKSPACE_SERVER = "butler-workspace";

/** 怎么启动打包好的 StateCore MCP：command 是 Butler 自己的 Electron（process.execPath），script 是 bundle。 */
export interface MemoryMcpLauncher {
  command: string;
  script: string;
}

export interface McpServerSpec {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function memoryServers(o: { launcher: MemoryMcpLauncher; statecoreDir: string; ticketKey: string }): Record<string, McpServerSpec> {
  const server = (scope: string): McpServerSpec => ({
    type: "stdio",
    command: o.launcher.command,
    args: [o.launcher.script, "--data", o.statecoreDir],
    // 只有这三个变量，没有任何 key（R1）。claude 还会把自己的环境变量传下来，memory-mcp/entry.ts 启动时再清一遍。
    env: { ELECTRON_RUN_AS_NODE: "1", STATECORE_SCOPE: scope, LOG_LEVEL: "warn" },
  });
  return { [MEMORY_SERVER]: server(ticketScope(o.ticketKey)), [WORKSPACE_SERVER]: server(WORKSPACE_SCOPE) };
}

/**
 * mcp/<ticket>.json（设计文档 2.3）。自定义的 ticket 正则可能放进 /、空格之类的字符：
 * 不能做文件名的字符换成 _，并加上原值的短哈希免得两个 ticket 撞名；结果永远在 mcpDir 里面。
 */
export function ticketMcpFile(mcpDir: string, ticketKey: string): string {
  const safe = ticketKey.replace(/[^A-Za-z0-9._-]/g, "_");
  const plain = safe === ticketKey && !/^\.*$/.test(safe);
  const name = plain ? safe : `${safe.slice(0, 60)}-${createHash("sha1").update(ticketKey).digest("hex").slice(0, 8)}`;
  return join(mcpDir, `${name}.json`);
}

/** 写（覆盖）这个 ticket 的 --mcp-config 文件：随机名的临时文件（0600、wx）再 rename，返回文件路径。 */
export function writeTicketMcpConfig(o: { mcpDir: string; ticketKey: string; launcher: MemoryMcpLauncher; statecoreDir: string }): string {
  const file = ticketMcpFile(o.mcpDir, o.ticketKey);
  mkdirSync(o.mcpDir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ mcpServers: memoryServers(o) }, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件没建成。
    }
    throw e;
  }
  return file;
}
```

`src/main/claude/spawn.ts` 的 `spawnSpec` 之后加：

```ts
/**
 * Windows 上 npm 装的 claude.cmd 要经过 cmd.exe：参数里有空白、引号、括号或 cmd 元字符时没法安全传递。
 * 这种情况下调用方不传这个参数（计划 5 去掉 cmd.exe 这一层）。
 */
export function cmdShimSafe(file: string, arg: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) return true;
  return /^[^\s"&|<>^%()!]+$/.test(arg);
}
```

`src/main/sessions/session-service.ts`：
- import 改成 `import { claudeArgs, cmdShimSafe, sessionEnv, spawnSpec } from "../claude/spawn";`
- `SessionServiceDeps` 里 `baseEnv: NodeJS.ProcessEnv;` 之后加：

```ts
  /** 写好这个 ticket 的记忆 --mcp-config 文件并返回路径；记忆关闭或 bundle 不存在时返回 null（设计文档 8.4）。 */
  mcpConfig?: (ticketKey: string) => string | null;
```

- `open()` 里 `const workDir = this.d.ticketService.workDir(ticket);` 之后加：

```ts
    const mcpConfigPath = this.mcpConfigFor(ticket.key, claudePath);
```

- 同一个方法里两处 `claudeArgs(...)` 改成：

```ts
      args = claudeArgs({ mode: this.d.transcriptExists(head.id) ? "resume" : "new", sessionId: head.id, mcpConfigPath });
```

```ts
      args = claudeArgs({ mode: "new", sessionId: termId, mcpConfigPath });
```

- 类里 `handleExit` 之前加：

```ts
  /** 这个 ticket 的记忆 MCP 配置。写不出来、或者在 Windows 的 .cmd 下无法安全传递时不挂，session 照常打开。 */
  private mcpConfigFor(ticketKey: string, claudePath: string): string | undefined {
    let file: string | null;
    try {
      file = this.d.mcpConfig?.(ticketKey) ?? null;
    } catch (e) {
      this.d.log?.(`memory MCP config for ${ticketKey} not written`, e);
      return undefined;
    }
    if (!file) return undefined;
    if (!cmdShimSafe(claudePath, file, this.d.platform)) {
      this.d.log?.(`memory MCP not mounted for ${ticketKey}: the config path cannot pass through cmd.exe safely`);
      return undefined;
    }
    return file;
  }
```

`src/main/index.ts`：
- `import { statSync } from "node:fs";` 改成 `import { existsSync, statSync } from "node:fs";`；import 区加 `import { writeTicketMcpConfig } from "./memory/mcp-config";`
- `bundledHookPath()` 整个替换为下面两个函数。开发时按 `__dirname`（`out/main`）找仓库的 `build/`，不用 `app.getAppPath()`：实测用 `electron out/main/index.js` 启动时 `app.getAppPath()` 是 `out/main`，原来的 hook 路径在这种启动方式下是错的（`electron .` 和 `pnpm dev` 下两者相同）。

```ts
/** 开发时仓库根目录下的 build/（out/main/index.js 往上两级）。 */
const devBuildDir = (): string => join(__dirname, "..", "..", "build");

function bundledHookPath(): string {
  const name = process.platform === "win32" ? "butler-hook.exe" : "butler-hook";
  return app.isPackaged ? join(process.resourcesPath, "hook", name) : join(devBuildDir(), "hook", name);
}

/** 打包好的 StateCore MCP（任务 7）：开发时在 build/ 下（pnpm dev / build 会先生成），安装包里在 resources 下。 */
function bundledMemoryMcpPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "memory-mcp", "statecore-mcp.cjs") : join(devBuildDir(), "memory-mcp", "statecore-mcp.cjs");
}
```

- `const sessionService = new SessionService({` 之前加：

```ts
  const memoryMcpScript = bundledMemoryMcpPath();
  let memoryMcpMissingLogged = false;
  /** 每次打开 session 时重写这个 ticket 的 --mcp-config 文件（设计文档 4.2、8.4）。 */
  const memoryMcpConfig = (ticketKey: string): string | null => {
    if (settings.get("memoryEnabled") === "0") return null;
    if (!existsSync(memoryMcpScript)) {
      if (!memoryMcpMissingLogged) logger(`memory MCP bundle missing at ${memoryMcpScript}; sessions start without memory (run pnpm build:memory-mcp)`);
      memoryMcpMissingLogged = true;
      return null;
    }
    return writeTicketMcpConfig({ mcpDir: paths.mcp, ticketKey, launcher: { command: process.execPath, script: memoryMcpScript }, statecoreDir: paths.statecore });
  };
```

- `new SessionService({...})` 里 `baseEnv: process.env,` 之后加 `mcpConfig: memoryMcpConfig,`

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm exec vitest run memory-mcp src/main/memory/mcp-config.test.ts src/main/claude/spawn.test.ts src/main/sessions/session-service.test.ts`
Expected: PASS（bundle 测试会先用 esbuild 打一次包，约几秒）。

- [ ] **Step 7: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && ls -la build/memory-mcp/statecore-mcp.cjs`
Expected: 全部通过，bundle 存在。

```bash
git add memory-mcp scripts/build-memory-mcp.mjs package.json tsconfig.node.json vitest.config.mts src/main/memory/mcp-config.ts src/main/memory/mcp-config.test.ts src/main/claude/spawn.ts src/main/claude/spawn.test.ts src/main/sessions/session-service.ts src/main/sessions/session-service.test.ts src/main/index.ts
git commit -m "feat: mount a keyless bundled StateCore MCP for the ticket and workspace scopes in every Butler session"
```

---

### Task 8: ticket 详情页的“记忆”标签

设计文档 8.4：“ticket 详情页的‘记忆’标签列出这个 scope 当前的所有记忆条目，每条都可以查看 `why` 链”。Butler 写的决策和 follow-up 去掉前缀分区显示，其余（Claude 自己记的、蒸馏出来的）按 StateCore 的分组显示；最近一次交接单独显示，同样可以看历史版本。

**Files:**
- Modify: `src/shared/ipc.ts`、`src/shared/ipc.test.ts`
- Modify: `src/main/ipc/validate.ts`、`src/main/ipc/validate.test.ts`
- Modify: `src/main/ipc/register.ts`、`src/main/index.ts`
- Modify: `src/renderer/src/api.ts`、`src/renderer/src/strings.ts`、`src/renderer/src/styles.css`
- Create: `src/renderer/src/memory-view.ts`
- Test: `src/renderer/src/memory-view.test.ts`
- Create: `src/renderer/src/components/MemoryPanel.tsx`
- Modify: `src/renderer/src/components/TicketOverview.tsx`

**Interfaces:**
- Consumes: `MemoryService.view(key)`、`MemoryService.why(key, factId)`（任务 4）；`MemoryView`、`WhyEntry`、`parseNote`（`src/shared/memory.ts`）
- Produces:
  - IPC：`IPC.memoryView = "memory:view"`（`(ticketKey) → MemoryView`）、`IPC.memoryWhy = "memory:why"`（`(ticketKey, factId) → WhyEntry[] | null`）
  - `ticketKeyArg(v: unknown): string`、`factIdArg(v: unknown): string`（`src/main/ipc/validate.ts`）
  - `api.memoryView(ticketKey)`、`api.memoryWhy(ticketKey, factId)`
  - `memorySections(items: MemoryItem[]): MemorySection[]`、`whyLines(chain: WhyEntry[], formatTime: (iso: string) => string): WhyLine[]`（`src/renderer/src/memory-view.ts`）

- [ ] **Step 1: 写失败测试**

`src/shared/ipc.test.ts` 里追加：

```ts
  it("exposes the memory channels as invoke-only", () => {
    for (const c of [IPC.memoryView, IPC.memoryWhy]) {
      expect(INVOKE_CHANNELS).toContain(c);
      expect(EVENT_CHANNELS).not.toContain(c);
    }
  });
```

`src/main/ipc/validate.test.ts` 末尾追加（并在顶部 import 里加上 `factIdArg, ticketKeyArg`）：

```ts
describe("memory IPC arguments", () => {
  it("accepts a ticket key and a StateCore fact id, nothing else", () => {
    expect(ticketKeyArg("PROJ-12")).toBe("PROJ-12");
    expect(factIdArg("0e133fce-6f5f-40b6-9905-4119541d9a7e")).toBe("0e133fce-6f5f-40b6-9905-4119541d9a7e");
    for (const bad of [undefined, null, 1, "", "x".repeat(201), {}]) expect(() => ticketKeyArg(bad), String(bad)).toThrow();
    for (const bad of [undefined, "", "a b", "../x", "x".repeat(101), 5]) expect(() => factIdArg(bad), String(bad)).toThrow();
  });
});
```

新建 `src/renderer/src/memory-view.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { MemoryItem, WhyEntry } from "../../shared/memory";
import { memorySections, whyLines } from "./memory-view";
import { S } from "./strings";

const item = (text: string, group = "Notes", factId: string | null = "id"): MemoryItem => ({ factKey: text, factId, text, createdAt: null, group });
const entry = (over: Partial<WhyEntry>): WhyEntry => ({ id: "x", content: "", addedAt: "2026-10-21T01:00:00.000Z", supersededBy: null, retiredAt: null, retiredReason: null, ...over });

describe("memory view helpers", () => {
  it("splits Butler's decisions and followups from other notes and strips the prefix", () => {
    const sections = memorySections([
      item("[decision:db] 用 MySQL"),
      item("[followup:f_1#2 abcd efgh ijkl] 改配置"),
      item("Claude 记的：用 pnpm"),
      item("偏好 tabs", "Preferences"),
      item("[decision:cache] 不用缓存"),
    ]);
    expect(sections.map((s) => s.title)).toEqual([S.memoryDecisions, S.memoryFollowups, S.memoryNotes, "Preferences"]);
    expect(sections[0].rows.map((r) => r.text)).toEqual(["用 MySQL", "不用缓存"]);
    expect(sections[1].rows.map((r) => r.text)).toEqual(["改配置"]);
    expect(sections[2].rows.map((r) => r.text)).toEqual(["Claude 记的：用 pnpm"]);
    expect(memorySections([])).toEqual([]);
  });

  it("labels every version of a why chain", () => {
    const lines = whyLines(
      [
        entry({ content: "[decision:db] 用 PostgreSQL", supersededBy: "b" }),
        entry({ content: "[decision:db] 用 MySQL" }),
        entry({ content: "被淘汰的笔记", retiredAt: "2026-10-22T00:00:00.000Z", retiredReason: "cap_evicted" }),
      ],
      (iso) => iso.slice(0, 10),
    );
    expect(lines).toEqual([
      { text: "用 PostgreSQL", when: "2026-10-21", state: "replaced", note: null },
      { text: "用 MySQL", when: "2026-10-21", state: "current", note: null },
      { text: "被淘汰的笔记", when: "2026-10-21", state: "retired", note: S.whyRetiredReason("cap_evicted") },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/shared/ipc.test.ts src/main/ipc/validate.test.ts src/renderer/src/memory-view.test.ts`
Expected: FAIL——通道、参数检查和 `./memory-view` 都不存在。

- [ ] **Step 3: 实现 IPC**

`src/shared/ipc.ts`：`IPC` 对象里 `auditList: "audit:list",` 之后加：

```ts
  memoryView: "memory:view",
  memoryWhy: "memory:why",
```

`INVOKE_CHANNELS` 末尾（`IPC.auditList,` 之后）加 `IPC.memoryView, IPC.memoryWhy,`。

`src/main/ipc/validate.ts` 末尾追加：

```ts
/** ticket 号：1–200 字的字符串（格式由 ticket 正则决定；查不到就是空结果）。 */
export function ticketKeyArg(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) throw new Error("invalid ticket key");
  return v;
}

/** StateCore 的事实 / 交接 id（UUID）。 */
export function factIdArg(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(v)) throw new Error("invalid memory id");
  return v;
}
```

`src/main/ipc/register.ts`：
- import 区加 `import type { MemoryService } from "../memory/memory-service";`，并把 `import { apiKeyArg, auditCursorArg, termsArg } from "./validate";` 改成 `import { apiKeyArg, auditCursorArg, factIdArg, termsArg, ticketKeyArg } from "./validate";`
- `IpcDeps` 里 `audit: AuditRepo;` 之后加 `memory: Pick<MemoryService, "view" | "why">;`
- `registerIpc` 末尾加：

```ts
  // StateCore 记忆（设计文档 8.4）：只读。
  handle(IPC.memoryView, (key: unknown) => d.memory.view(ticketKeyArg(key)));
  handle(IPC.memoryWhy, (key: unknown, factId: unknown) => d.memory.why(ticketKeyArg(key), factIdArg(factId)));
```

`src/main/index.ts`：`registerIpc({` 的参数里 `keys, terms, audit,` 改成 `keys, terms, audit, memory,`。

`src/renderer/src/api.ts`：
- 顶部加 `import type { MemoryView, WhyEntry } from "../../shared/memory";`
- `api` 对象里 `audit: ...` 之后加：

```ts
  memoryView: (ticketKey: string) => call<MemoryView>(IPC.memoryView, ticketKey),
  memoryWhy: (ticketKey: string, factId: string) => call<WhyEntry[] | null>(IPC.memoryWhy, ticketKey, factId),
```

- [ ] **Step 4: 实现界面**

`src/renderer/src/strings.ts` 的 `S` 末尾（`auditLoadFailed` 之后）加：

```ts
  memoryTab: "记忆",
  memoryHint: "同一个 ticket 的新 session 里，Claude 会用 recall 读到这些：最近一次交接、决策、未完成的 follow-up，以及它自己记下的内容。",
  memoryOff: "记忆已关闭（设置 → 记忆）。",
  memoryEmpty: "这个 ticket 还没有记忆。handoff 之后会出现进度、决策和未完成的 follow-up。",
  memoryLoadFailed: (m: string) => `读取记忆失败：${m}`,
  memoryHandoff: "最近一次交接",
  memoryVersions: (n: number) => `共 ${n} 个版本`,
  memoryWhy: "来历",
  memoryWhyTitle: "版本历史（旧的在前）",
  memoryDecisions: "决策",
  memoryFollowups: "未完成的 follow-up",
  memoryNotes: "其他笔记",
  whyState: { current: "当前", replaced: "已被新版本取代", retired: "已移除" } as Record<string, string>,
  whyRetiredReason: (r: string) => `原因：${r}`,
  whyNone: "没有找到这条记忆的历史。",
```

新建 `src/renderer/src/memory-view.ts`：

```ts
import { parseNote, type MemoryItem, type WhyEntry } from "../../shared/memory";
import { S } from "./strings";

export interface MemoryRow {
  item: MemoryItem;
  /** 显示的文字：Butler 的条目去掉前缀。 */
  text: string;
}

export interface MemorySection {
  title: string;
  rows: MemoryRow[];
}

/** 记忆标签的分区：决策、未完成的 follow-up（Butler 写的），然后按 StateCore 的分组列出其余的。空的分区不显示。 */
export function memorySections(items: MemoryItem[]): MemorySection[] {
  const decisions: MemoryRow[] = [];
  const followups: MemoryRow[] = [];
  const others = new Map<string, MemoryRow[]>();
  for (const item of items) {
    const p = parseNote(item.text);
    if (p?.kind === "decision") decisions.push({ item, text: p.body });
    else if (p?.kind === "followup") followups.push({ item, text: p.body });
    else {
      const title = item.group === "Notes" ? S.memoryNotes : item.group;
      others.set(title, [...(others.get(title) ?? []), { item, text: item.text }]);
    }
  }
  return [
    { title: S.memoryDecisions, rows: decisions },
    { title: S.memoryFollowups, rows: followups },
    ...[...others].map(([title, rows]) => ({ title, rows })),
  ].filter((s) => s.rows.length > 0);
}

export type WhyState = "current" | "replaced" | "retired";

export interface WhyLine {
  text: string;
  when: string;
  state: WhyState;
  note: string | null;
}

/** why 链的每个版本（旧的在前）：正文（去掉 Butler 前缀）、时间、状态。 */
export function whyLines(chain: WhyEntry[], formatTime: (iso: string) => string): WhyLine[] {
  return chain.map((e) => ({
    text: parseNote(e.content)?.body ?? e.content,
    when: formatTime(e.addedAt),
    state: e.retiredAt ? "retired" : e.supersededBy ? "replaced" : "current",
    note: e.retiredReason ? S.whyRetiredReason(e.retiredReason) : null,
  }));
}
```

新建 `src/renderer/src/components/MemoryPanel.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import type { MemoryView, WhyEntry } from "../../../shared/memory";
import { api } from "../api";
import { reportError } from "../errors";
import { memorySections, whyLines } from "../memory-view";
import { S } from "../strings";

function formatIso(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function MemoryPanel({ ticketKey }: { ticketKey: string }) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [why, setWhy] = useState<{ id: string; chain: WhyEntry[] | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.memoryView(ticketKey));
    } catch (e) {
      reportError(e);
    }
  }, [ticketKey]);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  async function toggleWhy(id: string) {
    if (why?.id === id) {
      setWhy(null);
      return;
    }
    try {
      setWhy({ id, chain: await api.memoryWhy(ticketKey, id) });
    } catch (e) {
      reportError(e);
    }
  }

  function whyBlock(id: string) {
    if (why?.id !== id) return null;
    return (
      <div className="why-chain">
        <span className="muted">{S.memoryWhyTitle}</span>
        {why.chain === null ? (
          <p className="muted">{S.whyNone}</p>
        ) : (
          <ol>
            {whyLines(why.chain, formatIso).map((l, i) => (
              <li key={i} className={`why-${l.state}`}>
                <span>{l.text}</span>{" "}
                <span className="muted">
                  {l.when} · {S.whyState[l.state]}
                  {l.note ? ` · ${l.note}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  if (!view) return <p className="muted">{S.loading}</p>;
  if (!view.enabled) return <p className="muted">{S.memoryOff}</p>;
  const sections = memorySections(view.items);
  const handoff = view.handoff;
  return (
    <div className="memory-panel">
      {view.error && <p className="error">{S.memoryLoadFailed(view.error)}</p>}
      <p className="muted">{S.memoryHint}</p>
      {handoff && (
        <div className="memory-handoff">
          <div className="actions">
            <strong>{S.memoryHandoff}</strong>
            <span className="muted">
              {formatIso(handoff.addedAt)} · {S.memoryVersions(handoff.versionCount)}
            </span>
            <button onClick={() => void toggleWhy(handoff.id)}>{S.memoryWhy}</button>
          </div>
          <pre className="raw">{handoff.content}</pre>
          {whyBlock(handoff.id)}
        </div>
      )}
      {!handoff && sections.length === 0 && !view.error && <p className="muted">{S.memoryEmpty}</p>}
      {sections.map((sec) => (
        <div key={sec.title} className="memory-section">
          <span className="muted">{sec.title}</span>
          {sec.rows.map(({ item, text }) => (
            <div key={item.factKey} className="memory-item">
              <div className="actions">
                <span className="text">{text}</span>
                {item.createdAt && <span className="muted">{formatIso(item.createdAt)}</span>}
                {item.factId && <button onClick={() => void toggleWhy(item.factId!)}>{S.memoryWhy}</button>}
              </div>
              {item.factId && whyBlock(item.factId)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

`src/renderer/src/styles.css` 末尾追加：

```css
.memory-panel { display: flex; flex-direction: column; gap: 10px; }
.memory-section { display: flex; flex-direction: column; gap: 4px; }
.memory-item .text { flex: 1; }
.why-chain { margin: 4px 0 8px 16px; font-size: 12px; }
.why-chain ol { margin: 4px 0; padding-left: 20px; }
.why-replaced span:first-child, .why-retired span:first-child { color: var(--muted); text-decoration: line-through; }
```

`src/renderer/src/components/TicketOverview.tsx`：
- import 区加 `import { MemoryPanel } from "./MemoryPanel";`
- `type Panel = "followups" | "history";` 改成 `type Panel = "followups" | "history" | "memory";`
- `overview-bar` 里“历史”按钮之后加：

```tsx
        <button className={panel === "memory" ? "active" : ""} onClick={() => toggle("memory")}>{S.memoryTab}</button>
```

- `{panel === "history" && (...)}` 那一块之后加：

```tsx
      {panel === "memory" && (
        <div className="overview-panel">
          <MemoryPanel ticketKey={ticketKey} />
        </div>
      )}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm exec vitest run src/shared/ipc.test.ts src/main/ipc/validate.test.ts src/renderer/src/memory-view.test.ts`
Expected: PASS

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: 全部通过。（组件没有单元测试，计划 1 Ruling R2；由任务 11 的手动验证和计划 5 的 E2E 覆盖。）

```bash
git add src/shared/ipc.ts src/shared/ipc.test.ts src/main/ipc/validate.ts src/main/ipc/validate.test.ts src/main/ipc/register.ts src/main/index.ts src/renderer/src/api.ts src/renderer/src/strings.ts src/renderer/src/styles.css src/renderer/src/memory-view.ts src/renderer/src/memory-view.test.ts src/renderer/src/components/MemoryPanel.tsx src/renderer/src/components/TicketOverview.tsx
git commit -m "feat: memory tab on the ticket page with why chains for every entry and the handoff"
```

---

### Task 9: 设置补全：claude 路径、分支名模板、ticket 号正则、记忆、开机自启

设计文档第 9 节的设置页还缺：claude 路径（自检之外可以手动指定）、分支名模板、ticket 号正则（12 节的可配置项），以及本计划的记忆开关和 8.5 节的提醒（不要另装 StateCore 的捕获插件），2.2 节的开机自启。ticket 号正则会在主进程的扫描器、发现、建 ticket 里反复执行，保存前要挡住会让回溯指数增长的写法（计划 3 遗留的 ReDoS 检查）。

**Files:**
- Modify: `src/shared/settings.ts`、`src/shared/types.ts`、`src/shared/ipc.ts`、`src/shared/ipc.test.ts`
- Modify: `src/main/settings/settings-values.ts`、`src/main/settings/settings-values.test.ts`
- Create: `src/main/memory/plugin-check.ts`
- Test: `src/main/memory/plugin-check.test.ts`
- Modify: `src/main/hooks/health.ts`、`src/main/hooks/health.test.ts`
- Create: `src/main/autostart.ts`
- Test: `src/main/autostart.test.ts`
- Modify: `src/main/ipc/validate.ts`、`src/main/ipc/validate.test.ts`、`src/main/ipc/register.ts`、`src/main/index.ts`
- Modify: `src/renderer/src/api.ts`、`src/renderer/src/strings.ts`
- Create: `src/renderer/src/components/GeneralSettings.tsx`
- Modify: `src/renderer/src/components/SettingsPage.tsx`

**Interfaces:**
- Consumes: `SettingError`、`normalizeFlag`（`src/main/settings/settings-values.ts`）；`readSettings`（`src/main/hooks/installer.ts`）；`paths.statecore`（任务 1）；`SETTING_DEFAULTS.memoryEnabled`、`onboardingDone`（任务 3、4）
- Produces:
  - `EDITABLE_SETTINGS` 增加 `claudePath`、`branchTemplate`、`ticketPattern`、`memoryEnabled`、`onboardingDone`
  - `normalizeBranchTemplate(value): string`、`normalizeTicketPattern(value): string`（`src/main/settings/settings-values.ts`）
  - `statecorePluginInstalled(settings: unknown): boolean`（`src/main/memory/plugin-check.ts`）
  - `HealthReport.memory: { enabled: boolean; dataDir: string; mcpBundle: boolean; statecorePlugin: boolean }`；`HealthDeps.memoryMcpScript?: string`
  - `interface AutostartState { supported: boolean; enabled: boolean }`（`src/shared/types.ts`）；`autostartState(o: { packaged: boolean; platform: NodeJS.Platform; openAtLogin: () => boolean }): AutostartState`（`src/main/autostart.ts`）
  - IPC：`IPC.appAutostartGet = "app:autostartGet"`、`IPC.appAutostartSet = "app:autostartSet"`；`boolArg(v): boolean`；`api.autostart()`、`api.setAutostart(on)`

- [ ] **Step 1: 写失败测试**

`src/main/settings/settings-values.test.ts`：import 列表里加 `normalizeBranchTemplate, normalizeTicketPattern`，文件末尾追加：

```ts
describe("general settings (design 9, 12)", () => {
  it("accepts an empty or absolute claude path only", () => {
    expect(normalizeSetting("claudePath", "  ")).toBe("");
    expect(normalizeSetting("claudePath", " /usr/local/bin/claude ")).toBe("/usr/local/bin/claude");
    for (const bad of ["claude", "./bin/claude", "/usr/bin/cl\naude", `/${"x".repeat(1000)}`]) {
      expect(() => normalizeSetting("claudePath", bad), bad).toThrow(SettingError);
    }
  });

  it("accepts branch templates git can turn into a branch name", () => {
    for (const ok of ["feature/{key}", "{key}", "users/me/{key}-wip", "fix_{key}"]) expect(normalizeBranchTemplate(ok), ok).toBe(ok);
    for (const bad of ["feature/", "feat ure/{key}", "-{key}", "/{key}", "feature/{key}/", "a..b/{key}", "{key}.lock", "{key}.", "a//{key}", "a/.{key}", "{ticket}/{key}", `${"x".repeat(100)}{key}`]) {
      expect(() => normalizeBranchTemplate(bad), bad).toThrow(SettingError);
    }
  });

  it("accepts ordinary ticket patterns and rejects ones that could hang the main process", () => {
    for (const ok of ["[A-Z][A-Z0-9]+-\\d+", "[A-Z]{2,10}-\\d{1,6}", "#\\d+", "(?:ENG|OPS)-\\d+"]) expect(normalizeTicketPattern(ok), ok).toBe(ok);
    for (const bad of ["", "(", "x".repeat(101), "(a+)+", "(\\w*)*-\\d+", "([A-Z]+-?)+\\d", "(A|AB)*-\\d+", "(?:x{1,3})+", "(\\w)\\1", ".*", "\\d*"]) {
      expect(() => normalizeTicketPattern(bad), bad).toThrow(SettingError);
    }
  });

  it("validates the new flags through normalizeSetting", () => {
    expect(normalizeSetting("memoryEnabled", "0")).toBe("0");
    expect(normalizeSetting("onboardingDone", "1")).toBe("1");
    expect(() => normalizeSetting("memoryEnabled", "yes")).toThrow(SettingError);
    expect(normalizeSetting("branchTemplate", " feature/{key} ")).toBe("feature/{key}");
    expect(normalizeSetting("ticketPattern", " #\\d+ ")).toBe("#\\d+");
  });
});
```

新建 `src/main/memory/plugin-check.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { statecorePluginInstalled } from "./plugin-check";

describe("StateCore capture plugin check (design 8.5)", () => {
  it("finds an enabled StateCore plugin or a StateCore hook command", () => {
    expect(statecorePluginInstalled({ enabledPlugins: { "statecore@statecore-marketplace": true } })).toBe(true);
    expect(statecorePluginInstalled({ hooks: { Stop: [{ hooks: [{ type: "command", command: "npx -y statecore-mcp hook stop" }] }] } })).toBe(true);
  });

  it("ignores disabled plugins, Butler's own hook and anything malformed", () => {
    expect(statecorePluginInstalled({ enabledPlugins: { "statecore@x": false } })).toBe(false);
    expect(statecorePluginInstalled({ hooks: { Stop: [{ hooks: [{ type: "command", command: '"/Users/me/.butler/bin/butler-hook"' }] }] } })).toBe(false);
    expect(statecorePluginInstalled({ mcpServers: { statecore: { command: "statecore-mcp" } } })).toBe(false);
    for (const v of [null, undefined, "x", 1, [], { enabledPlugins: "statecore" }]) expect(statecorePluginInstalled(v)).toBe(false);
  });
});
```

新建 `src/main/autostart.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { autostartState } from "./autostart";

describe("autostart (design 2.2)", () => {
  it("is only offered by an installed app on macOS and Windows", () => {
    expect(autostartState({ packaged: true, platform: "darwin", openAtLogin: () => true })).toEqual({ supported: true, enabled: true });
    expect(autostartState({ packaged: true, platform: "win32", openAtLogin: () => false })).toEqual({ supported: true, enabled: false });
    let asked = false;
    const read = () => (asked = true);
    expect(autostartState({ packaged: false, platform: "darwin", openAtLogin: read })).toEqual({ supported: false, enabled: false });
    expect(autostartState({ packaged: true, platform: "linux", openAtLogin: read })).toEqual({ supported: false, enabled: false });
    expect(asked).toBe(false);
  });
});
```

`src/main/hooks/health.test.ts` 的 `describe("HealthService", ...)` 里追加：

```ts
  it("reports the memory store, the MCP bundle and a StateCore capture plugin the user installed", async () => {
    const home = tempDir();
    const paths = resolvePaths({ BUTLER_HOME: join(home, ".butler"), CLAUDE_CONFIG_DIR: join(home, ".claude") }, "darwin", home);
    mkdirSync(paths.claudeConfigDir, { recursive: true });
    const bundle = join(home, "statecore-mcp.cjs");
    const settings = new SettingsRepo(memDb());
    const health = new HealthService({
      paths, platform: "darwin", env: {}, settings, bundledHookBin: "/none", memoryMcpScript: bundle,
      readPath: async () => "/usr/bin", run: async () => "",
    });
    expect((await health.refresh()).memory).toEqual({ enabled: true, dataDir: paths.statecore, mcpBundle: false, statecorePlugin: false });
    writeFileSync(bundle, "");
    writeFileSync(paths.claudeSettings, JSON.stringify({ enabledPlugins: { "statecore@market": true } }));
    settings.set("memoryEnabled", "0");
    expect((await health.refresh()).memory).toEqual({ enabled: false, dataDir: paths.statecore, mcpBundle: true, statecorePlugin: true });
  });
```

`src/main/ipc/validate.test.ts` 的 `memory IPC arguments` 里追加（import 加 `boolArg`）：

```ts
  it("accepts only a boolean for on/off switches", () => {
    expect(boolArg(true)).toBe(true);
    expect(boolArg(false)).toBe(false);
    for (const bad of ["true", 1, null, undefined]) expect(() => boolArg(bad)).toThrow();
  });
```

`src/shared/ipc.test.ts` 里追加：

```ts
  it("exposes the autostart channels as invoke-only", () => {
    for (const c of [IPC.appAutostartGet, IPC.appAutostartSet]) expect(INVOKE_CHANNELS).toContain(c);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/settings src/main/memory/plugin-check.test.ts src/main/autostart.test.ts src/main/hooks/health.test.ts src/main/ipc/validate.test.ts src/shared/ipc.test.ts`
Expected: FAIL——新函数、新字段、新通道都不存在。

- [ ] **Step 3: 设置的校验**

`src/shared/settings.ts`：注释改成 `/** 渲染进程可以读写的设置。 */`，`EDITABLE_SETTINGS` 末尾（`auditRetentionDays` 之后）加：

```ts
  "claudePath",
  "branchTemplate",
  "ticketPattern",
  "memoryEnabled",
  "onboardingDone",
```

`src/main/settings/settings-values.ts`：
- 顶部加 `import { isAbsolute } from "node:path";`
- `normalizeSetting` 之前加：

```ts
/** 分支名模板（设计文档 4.1）：必须含 {key}；代入一个 ticket 号之后要是 git 接受的分支名（保守的子集）。 */
export function normalizeBranchTemplate(value: string): string {
  const t = value.trim();
  if (!t.includes("{key}")) throw new SettingError("分支名模板必须包含 {key}，例如 feature/{key}");
  const sample = t.replaceAll("{key}", "PROJ-1");
  const bad =
    t.length > 100 ||
    !/^[A-Za-z0-9._/-]+$/.test(sample) ||
    sample.startsWith("-") ||
    sample.startsWith("/") ||
    sample.endsWith("/") ||
    sample.endsWith(".") ||
    sample.endsWith(".lock") ||
    sample.includes("..") ||
    sample.includes("//") ||
    sample.includes("/.");
  if (bad) throw new SettingError("分支名模板只能用字母、数字和 . _ / -（不能以 - 或 / 开头、不能有 .. 或 //），最长 100 字，例如 feature/{key}");
  return t;
}

/** 量词套量词：(a+)+、(\w*)*、(x{1,3})+ 这类，回溯随输入长度指数增长。 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/;
/** 被量词修饰的分组里有分支：(A|AB)* 这类，分支重叠时同样指数增长。 */
const QUANTIFIED_ALTERNATION = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/;
/** 再用几段“差一点就匹配”的输入实测：每段超过 PROBE_BUDGET_MS 就拒绝（输入很短，最坏情况也只卡几十毫秒）。 */
const REDOS_PROBES = ["A".repeat(22), "A-".repeat(11), "1".repeat(22), "a".repeat(22), "AB".repeat(11)].map((s) => `${s}!`);
const PROBE_BUDGET_MS = 20;

/**
 * ticket 号正则（设计文档 4.4、12）：在扫描器、session 发现和建 ticket 里反复执行，保存前挡住
 * 写错的、能匹配空字符串的、带反向引用的、以及回溯会指数增长的写法（计划 3 遗留的 ReDoS 检查）。
 */
export function normalizeTicketPattern(value: string): string {
  const t = value.trim();
  if (!t || t.length > 100) throw new SettingError("ticket 号正则不能为空，最长 100 字");
  let anchored: RegExp;
  let search: RegExp;
  try {
    anchored = new RegExp(`^(?:${t})$`);
    search = new RegExp(`(?<![A-Za-z0-9])(?:${t})(?![0-9])`, "i");
  } catch {
    throw new SettingError("ticket 号正则写法不对");
  }
  if (/\\[1-9]|\\k</.test(t)) throw new SettingError("ticket 号正则不能用反向引用");
  if (NESTED_QUANTIFIER.test(t) || QUANTIFIED_ALTERNATION.test(t)) {
    throw new SettingError("ticket 号正则里有套在一起的量词或被量词修饰的分支（例如 (a+)+、(A|AB)*），可能让匹配卡死");
  }
  if (anchored.test("")) throw new SettingError("ticket 号正则不能匹配空字符串");
  for (const probe of REDOS_PROBES) {
    const start = performance.now();
    search.test(probe);
    anchored.test(probe);
    if (performance.now() - start > PROBE_BUDGET_MS) throw new SettingError("ticket 号正则太慢（可能让匹配卡死），请简化");
  }
  return t;
}
```

- `normalizeSetting` 的 `switch` 里 `case "auditRetentionDays": {...}` 之后、`default` 之前加：

```ts
    case "claudePath": {
      const t = value.trim();
      if (!t) return "";
      // eslint-disable-next-line no-control-regex
      if (t.length > 1000 || /[\u0000-\u001f\u007f]/.test(t) || !isAbsolute(t)) {
        throw new SettingError("claude 路径必须是绝对路径，例如 /usr/local/bin/claude；留空则自动查找");
      }
      return t;
    }
    case "branchTemplate":
      return normalizeBranchTemplate(value);
    case "ticketPattern":
      return normalizeTicketPattern(value);
    case "memoryEnabled":
    case "onboardingDone":
      return normalizeFlag(value);
```

- [ ] **Step 4: StateCore 插件检测、健康检查、开机自启**

新建 `src/main/memory/plugin-check.ts`：

```ts
/**
 * 用户是不是另外装了 StateCore 自己的 Claude Code 捕获插件（设计文档 8.5：Butler 已覆盖它的功能，不要另装）。
 * 看用户级 settings.json：enabledPlugins 里有启用的 statecore 插件，或者有调用 `statecore-mcp hook` 的 hook 命令。
 * 只读，不改任何东西。
 */
export function statecorePluginInstalled(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const s = settings as Record<string, unknown>;
  const plugins = s.enabledPlugins;
  if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
    if (Object.entries(plugins as Record<string, unknown>).some(([name, on]) => /statecore/i.test(name) && on !== false)) return true;
  }
  return /statecore-mcp[^"]*\bhook\b/i.test(JSON.stringify(s.hooks ?? null));
}
```

`src/shared/types.ts`：`HealthReport` 里 `claudeSettingsPath: string;` 之后加：

```ts
  /** StateCore 记忆（设计文档第 8 节）。 */
  memory: {
    enabled: boolean;
    dataDir: string;
    /** 打包的 StateCore MCP 在不在（不在时 session 不挂记忆）。 */
    mcpBundle: boolean;
    /** 用户另外装了 StateCore 的捕获插件（8.5：应该卸掉）。 */
    statecorePlugin: boolean;
  };
```

文件末尾加：

```ts
/** 开机自启（设计文档 2.2）。supported 为 false 时（开发模式、其他平台）设置页的开关是灰的。 */
export interface AutostartState {
  supported: boolean;
  enabled: boolean;
}
```

`src/main/hooks/health.ts`：
- import 区加 `import { statecorePluginInstalled } from "../memory/plugin-check";`
- `HealthDeps` 里 `bundledHookBin: string;` 之后加：

```ts
  /** 打包的 StateCore MCP（任务 7）；不给时视为不存在。 */
  memoryMcpScript?: string;
```

- `refresh()` 里读 settings 的那段改成：

```ts
    let hooks: HookStatus;
    let statecorePlugin = false;
    try {
      const claudeSettings = await readSettings(this.d.paths.claudeSettings);
      hooks = hookStatus(claudeSettings, hookCommand(this.d.paths.hookBin, this.d.platform));
      statecorePlugin = statecorePluginInstalled(claudeSettings);
    } catch {
      // 解析失败、是目录、没有权限等：一律视为 settings 不可用，不让启动失败。
      hooks = "settings_invalid";
    }
```

- 返回对象里 `claudeSettingsPath: this.d.paths.claudeSettings,` 之后加：

```ts
      memory: {
        enabled: this.d.settings.get("memoryEnabled") !== "0",
        dataDir: this.d.paths.statecore,
        mcpBundle: !!this.d.memoryMcpScript && existsSync(this.d.memoryMcpScript),
        statecorePlugin,
      },
```

新建 `src/main/autostart.ts`：

```ts
import type { AutostartState } from "../shared/types";

/**
 * 开机自启（设计文档 2.2，app.setLoginItemSettings）只对安装好的 app 有意义：开发模式下登记的会是 node_modules 里的 Electron。
 * 只支持 macOS 和 Windows。不支持时不去读系统设置。
 */
export function autostartState(o: { packaged: boolean; platform: NodeJS.Platform; openAtLogin: () => boolean }): AutostartState {
  const supported = o.packaged && (o.platform === "darwin" || o.platform === "win32");
  return { supported, enabled: supported ? o.openAtLogin() : false };
}
```

- [ ] **Step 5: IPC 与组装**

`src/shared/ipc.ts`：`IPC` 里加 `appAutostartGet: "app:autostartGet",`、`appAutostartSet: "app:autostartSet",`；`INVOKE_CHANNELS` 末尾加 `IPC.appAutostartGet, IPC.appAutostartSet,`。

`src/main/ipc/validate.ts` 末尾追加：

```ts
/** 开关：只接受真正的布尔值。 */
export function boolArg(v: unknown): boolean {
  if (typeof v !== "boolean") throw new Error("invalid switch value");
  return v;
}
```

`src/main/ipc/register.ts`：
- import：`AutostartState` 加进 `../../shared/types` 那一行的 type import；`./validate` 那一行加上 `boolArg`
- `IpcDeps` 里加：

```ts
  autostart: { get(): AutostartState; set(on: boolean): AutostartState };
```

- `settingsSet` 的处理改成（换了 claude 路径要重新检测）：

```ts
  handle(IPC.settingsSet, async (key: string, value: unknown) => {
    const k = settingKey(key);
    d.settings.set(k, normalizeSetting(k, String(value ?? "")));
    if (k === "claudePath") await d.health.refresh();
    d.notify();
  });
```

- `settingsReset` 同理：

```ts
  handle(IPC.settingsReset, async (key: string) => {
    const k = settingKey(key);
    d.settings.reset(k);
    if (k === "claudePath") await d.health.refresh();
    d.notify();
  });
```

- `registerIpc` 末尾加：

```ts
  handle(IPC.appAutostartGet, () => d.autostart.get());
  handle(IPC.appAutostartSet, (on: unknown) => d.autostart.set(boolArg(on)));
```

`src/main/index.ts`：
- import 区加 `import { autostartState } from "./autostart";`；`./settings/settings-values` 那一行改成 `import { llmConfig, scheduleConfig, SettingError } from "./settings/settings-values";`
- `new HealthService({...})` 那一行加上 `memoryMcpScript: bundledMemoryMcpPath(),`（放在 `bundledHookBin: bundledHookPath()` 之后）
- `registerIpc({` 之前加：

```ts
  const autostart = {
    get: () => autostartState({ packaged: app.isPackaged, platform: process.platform, openAtLogin: () => app.getLoginItemSettings().openAtLogin }),
    set: (on: boolean) => {
      if (!autostart.get().supported) throw new SettingError("只有安装好的 Butler 才能设置开机自启");
      app.setLoginItemSettings({ openAtLogin: on });
      return autostart.get();
    },
  };
```

- `registerIpc({` 的参数里加 `autostart,`。

`src/renderer/src/api.ts`：type import 里加 `AutostartState`；`api` 里加：

```ts
  autostart: () => call<AutostartState>(IPC.appAutostartGet),
  setAutostart: (on: boolean) => call<AutostartState>(IPC.appAutostartSet, on),
```

- [ ] **Step 6: 设置页的“常规”和“记忆”**

`src/renderer/src/strings.ts` 的 `S` 末尾加：

```ts
  general: "常规",
  generalFields: { claudePath: "claude 路径", branchTemplate: "分支名模板", ticketPattern: "ticket 号正则" } as Record<string, string>,
  generalPlaceholders: { claudePath: "留空：从登录 shell 的 PATH 里自动查找", branchTemplate: "feature/{key}", ticketPattern: "[A-Z][A-Z0-9]+-\\d+" } as Record<string, string>,
  generalHelp: {
    claudePath: "公司的 claude 不在 PATH 上时填它的绝对路径。改完会重新检测。",
    branchTemplate: "worktree 模式新建分支时用；{key} 换成 ticket 号。",
    ticketPattern: "用来识别 ticket 号（新建 ticket、认领 session、隐私扫描）。不要写会让匹配卡死的写法，例如 (a+)+。",
  } as Record<string, string>,
  autostart: "开机时自动启动 Butler",
  autostartUnsupported: "只有安装好的 Butler 才能设置开机自启（开发模式下不可用）。",
  memorySettings: "记忆（StateCore）",
  memoryEnabled: "把 handoff 的进度、决策、follow-up 和经验写进 StateCore，并在 Butler 打开的 session 里挂上记忆",
  memoryDataDir: "数据目录",
  memoryMcp: "给 claude 的记忆 MCP",
  memoryMcpReady: "就绪",
  memoryMcpMissing: "没有找到（开发模式请先运行 pnpm build:memory-mcp）：session 不会挂记忆",
  memoryExplain: "StateCore 只在本机。claude 里挂的记忆进程拿不到任何模型 key；只有隐私档位为“完整”时，Butler 才会在每晚把 claude 记下的原始片段经个人 API 蒸馏（记在审计页）。",
  statecorePluginWarning: "检测到你另外装了 StateCore 的 Claude Code 捕获插件。Butler 已经覆盖了它的功能，同时开着会重复记录，建议在 Claude Code 里卸掉它。",
  rerunWizard: "重新运行首次启动向导",
```

新建 `src/renderer/src/components/GeneralSettings.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import type { AutostartState, HealthReport } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";

const TEXT_FIELDS = ["claudePath", "branchTemplate", "ticketPattern"] as const;

export function GeneralSettings({ report, onHealth }: { report: HealthReport; onHealth: (r: HealthReport) => void }) {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  const [autostart, setAutostart] = useState<AutostartState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, a] = await Promise.all([api.settings(), api.autostart()]);
      setValues(v);
      setAutostart(a);
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!values) return <p className="muted">{S.loading}</p>;
  const current = values;
  const value = (k: EditableSettingKey): string => draft[k] ?? current[k];
  const clearDraft = (k: EditableSettingKey) =>
    setDraft((d) => {
      const next = { ...d };
      delete next[k];
      return next;
    });

  function failed(e: unknown) {
    if (e instanceof ButlerError && e.code === "invalid_setting") setError(e.message);
    else reportError(e);
  }

  async function save(k: EditableSettingKey, v: string = value(k)) {
    setError(null);
    try {
      await api.setSetting(k, v);
      clearDraft(k);
      await load();
      if (k === "claudePath" || k === "memoryEnabled") onHealth(await api.health());
    } catch (e) {
      failed(e);
    }
  }

  async function reset(k: EditableSettingKey) {
    setError(null);
    try {
      await api.resetSetting(k);
      clearDraft(k);
      await load();
      if (k === "claudePath") onHealth(await api.health());
    } catch (e) {
      failed(e);
    }
  }

  async function toggleAutostart(on: boolean) {
    try {
      setAutostart(await api.setAutostart(on));
    } catch (e) {
      reportError(e);
    }
  }

  const m = report.memory;
  return (
    <section className="settings-section">
      <h2>{S.general}</h2>
      {error && <p className="error">{error}</p>}
      {TEXT_FIELDS.map((k) => (
        <div key={k} className="field">
          {S.generalFields[k]}
          <input
            className="mono"
            value={value(k)}
            placeholder={S.generalPlaceholders[k]}
            onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
            onBlur={() => {
              if (draft[k] !== undefined && draft[k] !== current[k]) void save(k);
              else clearDraft(k);
            }}
          />
          <p className="muted">{S.generalHelp[k]}</p>
          <div className="actions">
            <button onClick={() => void reset(k)}>{S.resetDefault}</button>
          </div>
        </div>
      ))}
      <label className="inline">
        <input type="checkbox" disabled={!autostart?.supported} checked={autostart?.enabled ?? false} onChange={(e) => void toggleAutostart(e.target.checked)} />
        {S.autostart}
      </label>
      {autostart && !autostart.supported && <p className="muted">{S.autostartUnsupported}</p>}

      <h2>{S.memorySettings}</h2>
      <label className="inline">
        <input type="checkbox" checked={current.memoryEnabled !== "0"} onChange={(e) => void save("memoryEnabled", e.target.checked ? "1" : "0")} />
        {S.memoryEnabled}
      </label>
      <dl className="kv">
        <dt>{S.memoryDataDir}</dt>
        <dd>{m.dataDir}</dd>
        <dt>{S.memoryMcp}</dt>
        <dd className={m.mcpBundle ? "ok" : "error"}>{m.mcpBundle ? S.memoryMcpReady : S.memoryMcpMissing}</dd>
      </dl>
      <p className="muted">{S.memoryExplain}</p>
      {m.statecorePlugin && <p className="error">{S.statecorePluginWarning}</p>}
      <div className="actions">
        <button onClick={() => api.setSetting("onboardingDone", "0").catch(reportError)}>{S.rerunWizard}</button>
      </div>
    </section>
  );
}
```

`src/renderer/src/components/SettingsPage.tsx`：
- import 加 `import { GeneralSettings } from "./GeneralSettings";`
- `<ScheduleSettings />` 之前加 `<GeneralSettings report={report} onHealth={setReport} />`

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/settings src/main/memory/plugin-check.test.ts src/main/autostart.test.ts src/main/hooks/health.test.ts src/main/ipc/validate.test.ts src/shared/ipc.test.ts`
Expected: PASS

- [ ] **Step 8: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: 全部通过。

```bash
git add src/shared/settings.ts src/shared/types.ts src/shared/ipc.ts src/shared/ipc.test.ts src/main/settings/settings-values.ts src/main/settings/settings-values.test.ts src/main/memory/plugin-check.ts src/main/memory/plugin-check.test.ts src/main/hooks/health.ts src/main/hooks/health.test.ts src/main/autostart.ts src/main/autostart.test.ts src/main/ipc/validate.ts src/main/ipc/validate.test.ts src/main/ipc/register.ts src/main/index.ts src/renderer/src/api.ts src/renderer/src/strings.ts src/renderer/src/components/GeneralSettings.tsx src/renderer/src/components/SettingsPage.tsx
git commit -m "feat: general and memory settings with a ReDoS-safe ticket pattern, StateCore plugin warning and autostart"
```

---

### Task 10: 首次启动向导

设计文档第 9 节：自检 `claude` → 安装 hook 和 `/handoff` → 配置 tracker MCP 工具名（从 Claude Code 配置里检测）→ 选择隐私档位 → 可选配置个人 API。第 10 节：找不到 `claude` 时向导阻止进入下一步并给出修复指引。新用户（`onboardingDone` 不是 `1`）启动时看到向导；任何一步都可以“稍后再说”跳过整个向导；设置页可以重新运行（任务 9 的按钮）。老用户由迁移 4 直接标记为已完成（任务 3）。

**Files:**
- Create: `src/renderer/src/wizard.ts`
- Test: `src/renderer/src/wizard.test.ts`
- Create: `src/renderer/src/components/Wizard.tsx`
- Modify: `src/renderer/src/App.tsx`、`src/renderer/src/strings.ts`

**Interfaces:**
- Consumes: `api.health()`、`api.installHooks()`、`api.detectTrackerTools()`、`api.settings()`、`api.setSetting()`；`mergeTools`（`src/renderer/src/settings-form.ts`）；`PrivacySettings` 组件；`EditableSettings.onboardingDone`（任务 9）
- Produces:
  - `WIZARD_STEPS = ["claude", "hooks", "tracker", "privacy", "done"]`、`type WizardStep`、`canAdvance(step, report: HealthReport | null): boolean`、`nextStep(step)`、`prevStep(step)`、`stepNumber(step): { n: number; total: number }`、`needsOnboarding(settings: Pick<EditableSettings, "onboardingDone"> | null): boolean`
  - `<Wizard onDone={() => void} />`

- [ ] **Step 1: 写失败测试**

新建 `src/renderer/src/wizard.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { HealthReport } from "../../shared/types";
import { canAdvance, needsOnboarding, nextStep, prevStep, stepNumber, WIZARD_STEPS } from "./wizard";

const report = (claude: Partial<HealthReport["claude"]>): HealthReport => ({
  claude: { path: "/usr/local/bin/claude", version: "2.1.306", flags: {}, missingFlags: [], error: null, ...claude },
  hooks: "missing",
  hookBinInstalled: false,
  handoffCommand: "missing",
  butlerHome: "/h/.butler",
  claudeSettingsPath: "/h/.claude/settings.json",
  memory: { enabled: true, dataDir: "/h/.butler/statecore", mcpBundle: true, statecorePlugin: false },
});

describe("first-run wizard (design 9, 10)", () => {
  it("walks the steps in the design's order", () => {
    expect(WIZARD_STEPS).toEqual(["claude", "hooks", "tracker", "privacy", "done"]);
    expect(nextStep("claude")).toBe("hooks");
    expect(nextStep("done")).toBe("done");
    expect(prevStep("hooks")).toBe("claude");
    expect(prevStep("claude")).toBe("claude");
    expect(stepNumber("claude")).toEqual({ n: 1, total: 4 });
    expect(stepNumber("privacy")).toEqual({ n: 4, total: 4 });
  });

  it("blocks the first step until a working claude is found", () => {
    expect(canAdvance("claude", null)).toBe(false);
    expect(canAdvance("claude", report({ path: null, error: "claude_not_found" }))).toBe(false);
    expect(canAdvance("claude", report({ error: "spawn failed" }))).toBe(false);
    expect(canAdvance("claude", report({}))).toBe(true);
    // 其余步骤都可以先跳过。
    for (const s of ["hooks", "tracker", "privacy"] as const) expect(canAdvance(s, null)).toBe(true);
    expect(canAdvance("done", report({}))).toBe(false);
  });

  it("shows the wizard only once settings are loaded and onboarding is not done", () => {
    expect(needsOnboarding(null)).toBe(false);
    expect(needsOnboarding({ onboardingDone: "0" })).toBe(true);
    expect(needsOnboarding({ onboardingDone: "1" })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/renderer/src/wizard.test.ts`
Expected: FAIL——`./wizard` 不存在。

- [ ] **Step 3: 实现步骤逻辑**

新建 `src/renderer/src/wizard.ts`：

```ts
import type { EditableSettings } from "../../shared/settings";
import type { HealthReport } from "../../shared/types";

/** 设计文档第 9 节的顺序：自检 claude → hook 和 /handoff → tracker MCP → 隐私档位与个人 API → 完成。 */
export const WIZARD_STEPS = ["claude", "hooks", "tracker", "privacy", "done"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** 第一步必须找到能用的 claude（设计文档第 10 节）；其余步骤都可以先跳过，之后在设置页补。 */
export function canAdvance(step: WizardStep, report: HealthReport | null): boolean {
  if (step === "claude") return !!report?.claude.path && report.claude.error === null;
  return step !== "done";
}

export function nextStep(step: WizardStep): WizardStep {
  return WIZARD_STEPS[Math.min(WIZARD_STEPS.indexOf(step) + 1, WIZARD_STEPS.length - 1)];
}

export function prevStep(step: WizardStep): WizardStep {
  return WIZARD_STEPS[Math.max(WIZARD_STEPS.indexOf(step) - 1, 0)];
}

/** 第几步 / 共几步（完成页不算）。 */
export function stepNumber(step: WizardStep): { n: number; total: number } {
  const total = WIZARD_STEPS.length - 1;
  return { n: Math.min(WIZARD_STEPS.indexOf(step) + 1, total), total };
}

/** 设置读出来了、而且向导还没做完（或被设置页要求重新运行）。 */
export function needsOnboarding(settings: Pick<EditableSettings, "onboardingDone"> | null): boolean {
  return settings !== null && settings.onboardingDone !== "1";
}
```

- [ ] **Step 4: 实现界面**

`src/renderer/src/strings.ts` 的 `S` 末尾加：

```ts
  wizardTitle: "欢迎使用 Butler",
  wizardStep: (n: number, total: number) => `第 ${n} 步，共 ${total} 步`,
  wizardNext: "下一步",
  wizardBack: "上一步",
  wizardSkip: "稍后再说（跳过向导）",
  wizardFinish: "开始使用",
  wizardClaudeTitle: "检查 Claude Code",
  wizardClaudeHelp: "Butler 只用你本机已登录的公司 claude 干活。找不到时：确认在终端里能运行 claude；从 Finder 启动的 app 读不到某些 shell 配置，可以在下面直接填 claude 的绝对路径（终端里 which claude 的结果）。",
  wizardClaudeMissing: "没有找到能用的 claude：这一步完成之前不能继续。",
  wizardHooksTitle: "安装 hook 和 /handoff 命令",
  wizardHooksHelp: "Butler 会在你的用户级 Claude Code 设置里合并写入几个 hook（不覆盖你已有的），并加一个 /handoff 命令。它们只把事件写进 ~/.butler/inbox，不联网、不阻塞 Claude Code，随时可以在设置页一键卸载。",
  wizardTrackerTitle: "tracker 的 MCP 工具",
  wizardTrackerHelp: "handoff 会用你在 Claude Code 里配好的 tracker MCP（Jira、Linear、GitLab……）读取 ticket。检测之后勾选只读的查询工具；没有 tracker 也可以跳过。",
  wizardTrackerSaved: "已保存。",
  wizardPrivacyTitle: "隐私档位与个人 API（可选）",
  wizardPrivacyHelp: "个人 API 只用来润色早间简报的“今日重点”，默认只发占位符和状态。不想用就选“关闭”或者什么都不填。",
  wizardDoneTitle: "准备好了",
  wizardDoneHelp: "点左侧“新建 ticket”开始。每晚 Butler 会为有活动的 ticket 生成 handoff，早上打开就能看到简报。这些设置之后都能在设置页修改，也可以从设置页重新运行这个向导。",
```

新建 `src/renderer/src/components/Wizard.tsx`：

```tsx
import { useEffect, useState } from "react";
import type { HealthReport, McpProbe } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { mergeTools, probeIncomplete } from "../settings-form";
import { S } from "../strings";
import { canAdvance, nextStep, prevStep, stepNumber, type WizardStep } from "../wizard";
import { PrivacySettings } from "./PrivacySettings";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Wizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<WizardStep>("claude");
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [claudePath, setClaudePath] = useState("");
  const [probe, setProbe] = useState<McpProbe | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  async function run(fn: () => Promise<HealthReport>) {
    setBusy(true);
    setMessage(null);
    try {
      setReport(await fn());
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run(api.health);
  }, []);

  async function finish() {
    try {
      await api.setSetting("onboardingDone", "1");
      onDone();
    } catch (e) {
      reportError(e);
    }
  }

  async function saveClaudePath() {
    setMessage(null);
    try {
      await api.setSetting("claudePath", claudePath);
      await run(api.health);
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  async function detect() {
    setBusy(true);
    setMessage(null);
    try {
      const p = await api.detectTrackerTools();
      setProbe(p);
      setPicked(p.suggested);
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveTools() {
    setMessage(null);
    try {
      const current = await api.settings();
      await api.setSetting("trackerTools", mergeTools(current.trackerTools, picked));
      setMessage(S.wizardTrackerSaved);
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  const { n, total } = stepNumber(step);
  const togglePick = (t: string) => setPicked(picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t]);

  return (
    <div className="page wizard" data-testid="wizard">
      <h2>{S.wizardTitle}</h2>
      {step !== "done" && <p className="muted">{S.wizardStep(n, total)}</p>}

      {step === "claude" && (
        <section className="settings-section">
          <h3>{S.wizardClaudeTitle}</h3>
          <p className="muted">{S.wizardClaudeHelp}</p>
          {report && (
            <dl className="kv">
              <dt>{S.claudePath}</dt>
              <dd>{report.claude.path ?? <span className="error">{S.notFound}</span>}</dd>
              <dt>{S.claudeVersion}</dt>
              <dd>{report.claude.version ?? "—"}</dd>
              {report.claude.missingFlags.length > 0 && (
                <>
                  <dt>{S.missingFlags}</dt>
                  <dd className="error">{report.claude.missingFlags.join(" ")}</dd>
                </>
              )}
            </dl>
          )}
          {!canAdvance("claude", report) && !busy && <p className="error">{S.wizardClaudeMissing}</p>}
          <div className="field">
            {S.generalFields.claudePath}
            <input className="mono" value={claudePath} placeholder={S.generalPlaceholders.claudePath} onChange={(e) => setClaudePath(e.target.value)} />
            <div className="actions">
              <button onClick={() => void saveClaudePath()}>{S.save}</button>
              <button disabled={busy} onClick={() => void run(api.health)}>{S.recheck}</button>
            </div>
          </div>
        </section>
      )}

      {step === "hooks" && (
        <section className="settings-section">
          <h3>{S.wizardHooksTitle}</h3>
          <p className="muted">{S.wizardHooksHelp}</p>
          {report && (
            <dl className="kv">
              <dt>{S.hooks}</dt>
              <dd className={report.hooks === "installed" ? "ok" : "error"}>{S.hookStatus[report.hooks]}</dd>
              <dt>{S.handoffCommand}</dt>
              <dd className={report.handoffCommand === "installed" ? "ok" : "error"}>{S.handoffCommandStatus[report.handoffCommand]}</dd>
            </dl>
          )}
          <div className="actions">
            <button className="primary" disabled={busy || report?.hooks === "settings_invalid"} onClick={() => void run(api.installHooks)}>
              {S.installHooks}
            </button>
          </div>
        </section>
      )}

      {step === "tracker" && (
        <section className="settings-section">
          <h3>{S.wizardTrackerTitle}</h3>
          <p className="muted">{S.wizardTrackerHelp}</p>
          <div className="actions">
            <button disabled={busy} onClick={() => void detect()}>{busy ? S.detecting : S.detectTools}</button>
          </div>
          {probe && probeIncomplete(probe) && <p className="muted">{S.probeIncomplete}</p>}
          {probe && probe.tools.length === 0 && <p className="muted">{S.noDetectedTools}</p>}
          {probe && probe.tools.length > 0 && (
            <div className="probe">
              <p className="muted">{S.detectedTools(probe.tools.length, probe.suggested.length)}</p>
              {probe.tools.map((t) => (
                <label key={t} className="inline">
                  <input type="checkbox" checked={picked.includes(t)} onChange={() => togglePick(t)} />
                  <code>{t}</code>
                </label>
              ))}
              <div className="actions">
                <button className="primary" disabled={picked.length === 0} onClick={() => void saveTools()}>{S.addSelected}</button>
              </div>
            </div>
          )}
        </section>
      )}

      {step === "privacy" && (
        <section className="settings-section">
          <h3>{S.wizardPrivacyTitle}</h3>
          <p className="muted">{S.wizardPrivacyHelp}</p>
          <PrivacySettings />
        </section>
      )}

      {step === "done" && (
        <section className="settings-section">
          <h3>{S.wizardDoneTitle}</h3>
          <p>{S.wizardDoneHelp}</p>
        </section>
      )}

      {message && <p className="muted">{message}</p>}
      <div className="actions">
        {step !== "claude" && step !== "done" && <button onClick={() => setStep(prevStep(step))}>{S.wizardBack}</button>}
        {step === "done" ? (
          <button className="primary" onClick={() => void finish()}>{S.wizardFinish}</button>
        ) : (
          <button className="primary" disabled={busy || !canAdvance(step, report)} onClick={() => setStep(nextStep(step))}>
            {S.wizardNext}
          </button>
        )}
        {step !== "done" && <button onClick={() => void finish()}>{S.wizardSkip}</button>}
      </div>
    </div>
  );
}
```

`src/renderer/src/App.tsx`：
- import 加 `import { Wizard } from "./components/Wizard";` 和 `import { needsOnboarding } from "./wizard";`
- `const [pendingOpen, ...]` 之后加 `const [onboarding, setOnboarding] = useState(false);`
- `refresh` 改成（多读一次设置，决定要不要显示向导）：

```tsx
  const refresh = useCallback(async () => {
    try {
      const [t, u, s] = await Promise.all([api.listTickets(), api.unclaimed(), api.settings()]);
      setTickets(t);
      setUnclaimedCount(u.length);
      setOnboarding(needsOnboarding(s));
    } catch (e) {
      reportError(e);
    }
  }, []);
```

- `<main className="main">` 里，错误条之后的所有页面改成在 `onboarding` 时只显示向导：

```tsx
        {onboarding ? (
          <Wizard
            onDone={() => {
              setOnboarding(false);
              setRoute({ page: "home" });
            }}
          />
        ) : (
          <>
            {route.page === "home" && <BriefPage key={navNonce} initialKind={route.kind} tickets={tickets} onOpenTicket={openTicket} onUnclaimed={() => setRoute({ page: "unclaimed" })} />}
            {route.page === "ticket" && current && (
              <TicketPage
                key={current.key}
                ticket={current}
                initialOpen={pendingOpen?.ticketKey === current.key ? pendingOpen : null}
                onInitialOpenDone={() => setPendingOpen(null)}
                onArchived={() => setRoute({ page: "home" })}
              />
            )}
            {route.page === "unclaimed" && <UnclaimedPage tickets={tickets} />}
            {route.page === "settings" && <SettingsPage />}
            {route.page === "audit" && <AuditPage />}
          </>
        )}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm exec vitest run src/renderer/src/wizard.test.ts`
Expected: PASS

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: 全部通过。

```bash
git add src/renderer/src/wizard.ts src/renderer/src/wizard.test.ts src/renderer/src/components/Wizard.tsx src/renderer/src/App.tsx src/renderer/src/strings.ts
git commit -m "feat: first-run wizard: claude check, hooks, tracker tools, privacy and personal API"
```

---

### Task 11: 全量检查、隔离启动（StateCore 端到端）与遗留清单

不调用任何 LLM 服务商。隔离启动分两次：第一次让 Butler 建库（`BUTLER_HOME` 和 `CLAUDE_CONFIG_DIR` 都指向临时目录）；然后往临时库里放一个带决策、follow-up 和经验的 ticket，把 `claudePath` 设成一个不存在的绝对路径（第二次启动不会运行任何 claude），再启动一次：启动时的 `syncAll()` 应当把记忆写进临时目录里的 StateCore。最后用打包的记忆 MCP（Electron 当 Node）对同一个 scope 做 `recall`，就像 session 里的 Claude 那样，证明 claude 一侧读得到。第一次启动的健康检查会像计划 3 一样运行 `claude --version` / `--help`（不产生模型调用）。

**Files:**
- Modify: `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md`

- [ ] **Step 1: 全量自动检查**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm exec electron out/main/index.js --smoke`
Expected: 全部通过；`headless.live.test.ts` 显示 skipped；冒烟输出 `sqlite-ok 1`、`statecore-ok 1`、`pty-ok`；`build/memory-mcp/statecore-mcp.cjs` 存在。

再确认 StateCore 只从两个入口进来（ESLint 已经保证，这里是人工复核）：

Run: `grep -rnE "from \"statecore-mcp|import \"statecore-mcp|require\(\"statecore-mcp" src memory-mcp hook scripts | grep -v -e "^src/main/memory/statecore.ts:" -e "^memory-mcp/entry.ts:" -e "^src/main/memory/.*\.test\.ts:" -e "^src/main/egress-lint.test.ts:" || echo "statecore only via its entry points"`
Expected: `statecore only via its entry points`

- [ ] **Step 2: 隔离启动，StateCore 端到端**

整段在一次 Bash 调用里执行：

```bash
set -u
T="$(mktemp -d)"
mkdir -p "$T/claude"
launch() {
  BUTLER_HOME="$T" CLAUDE_CONFIG_DIR="$T/claude" node -e '
const { spawn } = require("node:child_process");
const c = spawn(require("electron"), ["out/main/index.js"], { env: process.env, stdio: "inherit" });
setTimeout(() => c.kill("SIGTERM"), 20000);
c.on("exit", (code, signal) => console.log("electron exited", code, signal));
'
}
# 1. 第一次启动：建库。
launch
# 2. 放一个 ticket、一条完整的 handoff 和一条未完成的 follow-up；claude 路径指向不存在的文件，第二次启动不会运行任何 claude。
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
const now = Date.now();
db.prepare("INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  .run("DEMO-42", null, "/tmp/demo-repo", "branch", null, "feature/DEMO-42", "active", now);
const payload = { ticket: "DEMO-42", status: "active", done_today: ["接口写完"], next_steps: ["补测试"], blockers: [], pr: null, jira: null, followups: [],
  decisions: [{ key: "db", statement: "用 PostgreSQL" }], learnings: ["gh pr checks 要带 --required"], open_questions: [] };
db.prepare("INSERT INTO handoffs (ticket_key, session_id, trigger, created_at, payload, degraded, raw_text) VALUES (?, NULL, ?, ?, ?, 0, NULL)")
  .run("DEMO-42", "manual", now, JSON.stringify(payload));
db.prepare("INSERT INTO followups (id, ticket_key, kind, description, trigger, due_date, status, snoozed_until, source, created_at, done_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL)")
  .run("f_demo", "DEMO-42", "config", "改 staging 配置", "after_merge", "open", "session", now);
const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
set.run("onboardingDone", "1");
set.run("claudePath", "/nonexistent/claude");
' "$T/app.db"
# 3. 第二次启动：syncAll() 把记忆写进 $T/statecore。
launch
# 4. 主进程一侧的结果。
node -e '
const { DatabaseSync } = require("node:sqlite");
const { createEmbeddedBackend } = require("statecore-mcp/lib");
(async () => {
  const db = new DatabaseSync(process.argv[1]);
  console.log(db.prepare("PRAGMA user_version").get(), db.prepare("SELECT ticket_key, handoff_id FROM memory_sync").all());
  for (const scope of ["ticket:DEMO-42", "workspace"]) {
    const b = createEmbeddedBackend({ dataDir: process.argv[2], scopeName: scope, env: {}, backgroundDigest: false });
    await b.init();
    console.log(scope, JSON.stringify((await b.facts()).flatMap((g) => g.items.map((i) => i.text))));
    await b.close();
  }
})();
' "$T/app.db" "$T/statecore" 2>/dev/null
# 5. claude 一侧：打包的记忆 MCP（Electron 当 Node）recall 同一个 scope。
ELECTRON="$(node -e 'console.log(require("electron"))')"
( printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"recall","arguments":{}}}'; sleep 3 ) \
| ELECTRON_RUN_AS_NODE=1 STATECORE_SCOPE=ticket:DEMO-42 LOG_LEVEL=warn "$ELECTRON" build/memory-mcp/statecore-mcp.cjs --data "$T/statecore" 2>/dev/null \
| grep -c "接口写完"
echo "mcp dir: $(ls -A "$T/mcp" | wc -l | tr -d ' ') file(s)"
grep -E "uncaughtException|unhandledRejection|memory .* failed" "$T/logs/main.log" || echo "no errors logged"
```

Expected：
- 两次都打印 `electron exited`。
- `{ user_version: 4 }`，`memory_sync` 一行：`ticket_key: 'DEMO-42'`，`handoff_id` 是插入的那条 handoff 的 id（1）。
- `ticket:DEMO-42 ["[followup:f_demo] 改 staging 配置（配置，合并后）","[decision:db] 用 PostgreSQL"]`
- `workspace ["[learning:DEMO-42] gh pr checks 要带 --required"]`
- MCP 的 recall 结果里有交接内容：`grep -c` 打印 `1`。
- `mcp dir: 0 file(s)`（没有打开任何 session）。
- 日志里没有错误（打印 `no errors logged`）。

任何一项不符合：先看 `$T/logs/main.log` 里 `memory` 开头的行，按 superpowers:systematic-debugging 排查，不要改检查条件。

- [ ] **Step 3: 更新遗留清单**

在 `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md` 末尾追加：

```markdown

# Plan 4 follow-ups

## Live checks
- Plan 4 Task 1 (statecore-mcp 1.0.0, embedded, temp dir): two followups with materially different text coexist; forget + remember of a revision keeps the old version on the why chain (chain length 2); a text identical to a forgotten note stays hidden; a variant prefix shows it; without a model `digestNow` is `no-llm`; two notes differing only in their id → the second supersedes the first (Jaccard ≥ 0.7) — Butler's variants carry distinguishing words and re-write a displaced note
- Plan 4 Task 7 (Electron 44 as Node, bundled statecore-mcp ≈ 1.8 MB): initialize / tools / remember over stdio work; `MODEL_API_KEY` + `FEATURE_LLM=true` in the environment give `no model configured`

## Rulings
- Ruling P4-R1: StateCore distillation at the full level is not scanned — design 8.5 accepts sending raw events at full; it is audited (source = statecore) and budgeted — cost if wrong: raw work content reaches the user's own provider at the level whose label says so
- Ruling P4-R2: depend on `statecore-mcp@1.0.0` from npm, exact pin (published 2026-09-24, MIT, ships `./lib` with types); no vendoring, no git dependency — cost if wrong: a later StateCore fix needs a version bump
- Ruling P4-R3: `statecoreEnv()` loses its key-handover branch (single argument); no StateCore process ever gets a model key through its environment — cost if wrong: none (no caller used the branch)
- Ruling P4-R4: R1 implemented through StateCore's `digestLlm` injection point (`PrivacyGateway.statecoreModel()`), not a loopback proxy: no port, no bearer token, the key never leaves the gateway — cost if wrong: claude-mounted MCP processes cannot distil (R1 forbids it anyway)
- Ruling P4-R5: no confirm-before-send dialog for distillation; with confirm-before-send on, distillation does not run — a digest makes several model calls in the background — cost if wrong: users with confirm on get no distillation
- Ruling P4-R6: headless handoffs / refreshes do not mount the memory MCP — their prompt already carries the previous handoff and open followups, and fewer MCP servers means fewer moving parts in unattended runs — cost if wrong: handoff prompts miss Claude's own notes
- Ruling P4-R7: on Windows with a `.cmd` claude and a config path that cmd.exe cannot carry safely, sessions start without memory (logged) until plan 5 removes cmd.exe — cost if wrong: Windows users with spaces in their home path have no memory in sessions for one plan

## Resolved in plan 4
- Plan 3 still open: StateCore wiring builds its env with `statecoreEnv()` (Tasks 1, 7)
- Plan 3 still open: StateCore at full bypassed the gateway / key in plaintext for claude-mounted MCP → R1: keyless MCP, distillation only via `PrivacyGateway.statecoreModel()` (Tasks 5, 6, 7)
- Plan 3 parked (scanner): custom `ticketPattern` ReDoS validation in settings (Task 9)
- Design 8.5: warning when the user also installed StateCore's capture plugin (Task 9)
- Found while planning: in dev, `app.getAppPath()` is `out/main` when launched as `electron out/main/index.js`, so the bundled hook path was wrong in that launch style; bundled paths now resolve from `__dirname` (Task 7)

## Still open after plan 4
- Everything plan 5 lists (CSP, packaging, Windows items incl. cmd.exe quoting with `--mcp-config` and the killTree orphan gap, absolute git path, AUMID, SEA size / build Node, Playwright E2E, CI, no-eval lint, open-source docs)
- StateCore note cap (30 per scope, forgotten notes included): Butler maintains at most 24 of its own notes per ticket, never evicts a note in its desired set (Ruling PF2) and skips writes that would not fit (logged as counts); a long-lived ticket with followup churn stops gaining new notes once its scope has seen 30 notes (statecore-mcp 1.0.0: a full digest does not free forgotten slots); `workspace` keeps the latest 30 learnings (the oldest are evicted by StateCore)
- Variant distinguishing words are visible to Claude in recall (`[followup:f_1#2 abcd efgh ijkl] …`)
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md
git commit -m "docs: record plan 4 live checks, rulings and what stays open"
```

---

## 手动验证

由用户在合并后用真实的 Butler 执行（执行者没有运行过真实的 claude session，也没有调用过 LLM 服务商）。任何一项不符合就停下来，按 superpowers:systematic-debugging 排查。

1. **老用户不进向导**：升级后第一次启动，直接看到简报（迁移 4 把已有 ticket 的库标记为向导已完成）。设置页“常规”里能看到 claude 路径、分支名模板、ticket 号正则；“记忆（StateCore）”显示数据目录 `~/.butler/statecore` 和“就绪”。
2. **重新运行向导**：设置页点“重新运行首次启动向导” → 主区域换成向导第 1 步，显示 claude 路径和版本，“下一步”可点；第 2 步“安装 / 修复”后两项都是“已安装”；第 3 步“从 Claude Code 检测”列出 tracker 工具；第 4 步是隐私设置；“开始使用”回到简报。再运行一次，在第 1 步点“稍后再说”也能回到简报。
3. **claude 找不到时**：临时把 claude 路径填成 `/nonexistent/claude` 并重新运行向导 → 第 1 步红字提示、“下一步”灰掉；把路径清空、点“重新检测”后恢复。
4. **记忆写入**：在某个 ticket 的 session 里执行 `/handoff`（或点“立即 handoff”），等它入库 → ticket 页“记忆”标签里出现“最近一次交接”、这次的决策和未完成的 follow-up；“来历”展开后显示版本列表。
5. **follow-up 变化**：在概览里把一个 follow-up 标为完成 → 记忆标签里它消失；再“恢复” → 它重新出现（文字前可能多一串区分词，属于预期）。
6. **session 里 recall**：从 Butler 给这个 ticket 开一个新 session，问 Claude “用 recall 看看这个 ticket 之前的进度” → 它能说出刚才的交接、决策和 follow-up。在 Claude Code 里 `/mcp` 能看到 `butler-memory` 和 `butler-workspace` 两个 server 是 connected。
7. **key 不进记忆进程**：在一个导出了 `OPENAI_API_KEY` 的终端里 `open -a Butler`（macOS）启动 Butler，开一个 session，让 Claude 用 `remember` 存一段 `consolidate: true` 的内容 → 返回 `no model configured`。`grep -rE "MODEL_|OPENAI|FEATURE_LLM" ~/.butler/mcp` 没有输出。
8. **完整档位的蒸馏**：隐私档位选“完整”、配好个人 API、关闭“发送前确认”，在 session 里让 Claude `remember(consolidate: true)` 几段内容；设置页点“立即运行晚间 handoff” → 审计页出现来源为“StateCore 记忆蒸馏”的记录（档位“完整”，有 token 和费用）；记忆标签里出现蒸馏出来的条目。打开“发送前确认”再跑一次 → 审计里没有新的蒸馏记录。改回原来的档位。
9. **记忆开关**：关掉“记忆” → 记忆标签显示“记忆已关闭”，新开的 session 里 `/mcp` 没有 `butler-memory`；打开后恢复。
10. **StateCore 插件提醒**：如果你另装过 StateCore 的 Claude Code 插件，设置页“记忆”下面有红字提醒。
11. **ticket 号正则**：填 `(a+)+` → 表单下方红字说明原因，没有保存；填 `[A-Z]{2,10}-\d+` → 保存成功。
12. **开机自启**：开发模式下开关是灰的并有说明；安装包版本（计划 5）勾选后，重启电脑 Butler 自动打开。
13. **发送前确认的对话框高度（计划 3 遗留）**：打开“发送前确认”，在出站内容很长时（多个 ticket、“脱敏文本”档位）重新生成简报 → macOS 的确认框能完整显示或可以滚动，“发送 / 不发送”按钮可见。
14. **Windows（如有条件）**：用户目录没有空格时，第 6 项照样成功；有空格且 claude 是 `claude.cmd` 时，session 能打开但没有 `butler-memory`（日志有 `memory MCP not mounted`），计划 5 之后恢复。

---

## 附录 A：裁定（Rulings）

| 编号 | 裁定 | 理由 |
|------|------|------|
| R1（控制者） | claude 里挂的 statecore-mcp 永远拿不到 key；LLM 功能只在主进程、只在 `full` 档位、只经 gateway | 计划 3 的最终评审：把 `MODEL_API_KEY` 交给 claude 挂的 MCP 会让 key 以明文出现在配置文件或 session 环境里 |
| R2（控制者） | 不运行任何会改用户 Claude Code 配置的命令；测试不碰真实的 `~/.butler`、`~/.claude`，不调用真实的服务商和 claude | 用户的真实环境 |
| R3（控制者） | CI 工作流在本地写好并校验，不推送；打包产物不签名；发布由用户完成 | 见计划 5 |
| R4（控制者） | 完整范围，拆成计划 4（记忆、向导、设置）和计划 5（发布） | 每个计划单独可用、可测 |
| R5（控制者） | 依赖外部行为的任务先做小实验并写明备选 | 任务 1、7 的 spike 步骤 |
| P4-R1 | `full` 档位的蒸馏不做敏感信息扫描，但写审计、受预算约束 | 设计文档 8.5 接受在 `full` 档位发送原始事件；扫描会把几乎所有真实对话拦下来，等于没有这个功能 |
| P4-R2 | 依赖 npm 上的 `statecore-mcp@1.0.0`（精确版本） | 已发布、MIT、自带 `./lib` 入口和类型，`engines.node >= 22.13`（Electron 44 内置 24.22）；不需要 vendoring 或 git 依赖 |
| P4-R3 | `statecoreEnv()` 改为单参数、只去不给 | 结构上保证任何 StateCore 进程的环境变量里都没有 key；原来的交出分支没有调用方 |
| P4-R4 | R1 的“经 gateway 调用模型”用 StateCore 的 `digestLlm` 注入点实现，不做 loopback 代理 | `apps/mcp/src/digest.ts`：给了 `digestLlm` 就完全不读 `FEATURE_LLM` / `MODEL_*`、不构造 provider。没有端口、没有 token，key 根本不出 gateway，审计和预算与“今日重点”共用一条串行队列。代理方案的唯一额外能力是给子进程用，而 R1 禁止子进程用模型 |
| P4-R5 | 蒸馏不弹发送前确认；确认开着时不蒸馏 | 一次蒸馏要调好几次模型、在后台运行，弹窗会连环出现 |
| P4-R6 | 后台 handoff / 刷新不挂记忆 MCP | prompt 已经带着上一次 handoff 和未完成的 follow-up；后台运行少一个 MCP 少一个故障点 |
| P4-R7 | Windows 上 `.cmd` 的 claude 遇到 cmd.exe 无法安全传递的配置路径时，这一计划先不挂记忆 | 计划 5 任务 3 去掉 cmd.exe 后自然解决；在此之前 session 照常可用 |
| P4-R8 | Butler 的变体前缀带由 id 决定的区分词，发现“挤掉了别的条目”时用更长的区分词把被挤掉的写回去 | 任务 1 的实验 G：StateCore 把 Jaccard ≥ 0.7 的两条 note 当成修订，只差 id 的两条 follow-up 会互相挤掉 |

## 附录 B：与设计文档的差异（本计划有意为之）

1. 8.3 节 “`remember(key=decision:<key>)` / `remember(key=followup:<id>)`”：StateCore 的 `remember` 没有 key 参数（13.1），改为稳定前缀 + 从 app.db 计算期望状态再比对（任务 2、4）；同一条目先 forget 再 remember。和已遗忘条目一字不差、或者正文和另一条几乎一样时，写成带区分词的变体（P4-R8）。
2. 8.3 节的 handoff 写入：`summary` 是 `状态：<status>。完成：<done_today>`（StateCore 要求 summary 非空）。只写每次同步时最新的那一条；learnings 写进 `workspace` 时带 `[learning:<KEY>]` 前缀标明来源。第一次同步最多回放 20 条 handoff 的 learnings。
3. 8.3 节没有说 notes 的数量上限：StateCore 每个 scope 最多 30 条 notes（被 forget 的也占位，满了再追加会淘汰最旧的一条）。Butler 每个 ticket 的期望集合最多 24 条（follow-up 优先，决策按最近变化）；每次写入前实测空位，没有空位就不写（日志只记跳过的条数），从不让 StateCore 挤掉期望集合里的条目（PF2）。statecore-mcp 1.0.0 的完整档位蒸馏也不释放被遗忘条目的位置，所以长期使用、follow-up 来回变化的 ticket 在 scope 累计满 30 条后不再增加新条目。`workspace` 的经验只保留最近的 30 条（StateCore 淘汰最旧的）。
4. 8.4 节的两个 MCP 实例命名为 `butler-memory` / `butler-workspace`（不和用户自己的 `statecore` 重名）；server 进程是打包的单文件，由 Butler 自己的 Electron 运行，不依赖用户装的 Node。
5. 8.5 节 “`full` 时给 StateCore 设置 `FEATURE_LLM=true`”：改为任何 StateCore 进程都没有 key（R1），`full` 档位下由主进程每晚经 gateway 蒸馏（P4-R4）；不扫描（P4-R1）、开着发送前确认时不蒸馏（P4-R5）。
6. 9 节的首次启动向导可以整体跳过；只有第一步（找到能用的 claude）阻止“下一步”。老用户由迁移 4 直接标记为已完成。
7. 设置页新增“记忆”开关（设计文档没有）：关掉后不写入、不挂载，已有的记忆保留。
8. 开机自启只在安装包里可用（开发模式下登记的会是 node_modules 里的 Electron），自启时正常显示窗口（早上打开就是简报）。

## 附录 C：遗留项的去向（计划 1–3 的 “→ plan 4” 和 “Still open after plan 3”）

| 遗留项 | 去向 |
|--------|------|
| 计划 1 R2：Playwright E2E 覆盖 IPC / 组件 | 计划 5 任务 8、9 |
| 计划 1 Task 1：node-pty `spawn-helper` 在全新安装上没有执行权限 | 计划 5 任务 7（afterPack 补执行位）、任务 10（CI 全新安装） |
| 计划 1 Task 1：pnpm 忽略 electron-winstaller 的 build 脚本 | **不做**：Windows 安装包用 electron-builder 自己的 NSIS，不用 Squirrel.Windows / electron-winstaller |
| 计划 1 Task 1：node-pty 重建需要 C++ 工具链 | 计划 5 任务 11（CONTRIBUTING）、任务 10（CI 用 runner 自带的工具链） |
| 计划 1 Task 5：`butler-hook` SEA 约 136 MiB；Windows `.exe` 未测 | 计划 5 任务 5（裁定保留 SEA 并写明原因）、任务 10（Windows 上构建并测试）、任务 9（Windows E2E 实际执行 hook） |
| 计划 1 Task 5：`build:hook` 需要支持 `--build-sea` 的 Node；hook 没有 uncaughtException 兜底；rename 失败留下 .tmp | 计划 5 任务 5 |
| 计划 1 Task 6：Windows 上 rename 的 EPERM / EBUSY 重试；Windows 的 hook 执行 shell | 计划 5 任务 4（重试）、任务 4 + 9（Git Bash 和 cmd.exe 下实际执行 hook 命令） |
| 计划 1 Task 9：Windows cmd.exe 下带空格的 `--mcp-config` 路径 | 本计划任务 7 先安全降级（P4-R7），计划 5 任务 3 去掉 cmd.exe |
| 计划 1 Task 12：关窗口阻止可能挡住 Windows 注销 / 关机；托盘图标没有 @2x | 计划 5 任务 4 |
| 计划 2 Task 10：killTree 在 claude 已退出时的 Windows 孤儿进程；退出时 SIGKILL 定时器被 unref；spawn 选项和 runHeadless 重复 | 计划 5 任务 3 |
| 计划 2 Task 13：Windows 通知的 AUMID | 计划 5 任务 4 |
| 计划 3：Windows 和打包相关的全部项 | 计划 5 任务 3、4、5、7、10 |
| 计划 3：渲染进程 CSP | 计划 5 任务 6 |
| 计划 3：个人 API 用 Node 的 fetch，不走系统代理 | **不做**（写进 README 的已知限制）：目前没有用户需要；改成 Electron 的 `net.fetch` 会让 provider 脱离计划 3 的进程内假服务器测试 |
| 计划 3：StateCore 的环境变量必须由 `statecoreEnv()` 生成 | 本计划任务 1、7 |
| 计划 3：`full` 档位下 StateCore 绕过 gateway，claude 挂的 MCP 会拿到明文 key | 本计划任务 5、6、7（R1） |
| 计划 3：低影响的小问题（内存里的 tombstone、INSERT OR IGNORE 掩盖 CHECK、ROLLBACK TO 掩盖原错误、悬空符号链接、轮次中途的 isMeta 让 /handoff 采集失败、server 名跳过的漏报、未认领条目的 key 每天变、30 分钟时区的 DST 测试、预填上限处的字素簇） | **不做**：都是“失败即安全”或纯外观的问题（采集失败只是少一次 handoff、标记每天重置、截断位置略偏），E2E 也覆盖不到；没有用户报告前不值得改动已经稳定的代码 |
| 计划 3：嵌套的 `claude --resume/-c` 会重新关联 | **不做**：计划 1 Ruling F2 已接受 |
| 计划 3 parked（项目级 MCP 信任）：APFS 大小写别名的回归测试；`core.fsmonitor=false` 全局；`wx` 的随机临时文件名；Windows 上 git 的绝对路径 | 计划 5 任务 2 |
| 计划 3 parked（项目级 MCP 信任）：读文件的 fd 绑定信任检查；非 git 目录在上层仓库里被信任 | **不做**：项目级 MCP 是默认关闭的可选功能，已有 lstat + realpath 检查，剩下的竞态需要攻击者在读取的那一刻改写用户自己的仓库；非 git 目录按设计信任 |
| 计划 3 parked（扫描器）：自定义 `ticketPattern` 的 ReDoS 检查 | 本计划任务 9 |
| 计划 3 parked（扫描器）：小写 / 带空格的 ticket 号、八进制 IP、下划线主机名、IDN、两段式 `.local`、大写的歧义 TLD、最坏性能 | **不做**：每一条都要加新规则并承担误拦“今日重点”的风险；已知原值由假名化处理、随机化不变量测试覆盖；写进 README 的隐私说明 |
| 计划 3 parked（假名化）：子串过度替换、没有重音的人名、只写名不写姓、繁简不一致、英文句子整句丢弃 | **不做**：设计文档 7.4 已写明这些限制，且都是“失败即安全”的方向 |
| 计划 3 parked（gateway / provider）：被中止的 2xx 没有记账；scrub 认不出 base64 / 分行 / 部分回显的 key | **不做**：前者只会少算一次费用（下次调用前预算仍保守估算）；后者需要服务商以变形的方式回显 key |
| 计划 3 parked（今日重点的数据源）：少于 3 个字符的 PR 组织名、每个 ticket 最多扫 1000 条 handoff、仓库名恰好是停用词 | **不做**：扫描器兜底 |
| 计划 3 parked（审计 / 设置）：`finish()` 没有状态检查、大小写不同的敏感词去重未测、非 CJK 文字的 token 估算、钥匙串中途失效后 `llmStatus` 仍缓存、审计页每次状态变化回到第 1 页、JSON 被重新排版、被拒的 key 从输入框清掉 | **不做**：都是保守方向或外观问题；`llmStatus` 重启即恢复 |
| 计划 3 parked（任务 1–4 的小问题）：health 测试里手写的帮助文本、`BUTLER_HOME` 里的 `~` 不展开、用户 LC_ALL 下的本地化 `hint:` 行、保存期间同一字段的草稿丢失 | `~` 展开：计划 5 任务 4；其余**不做**（测试夹具 / 外观） |
| 计划 3 parked：macOS 确认框在出站内容很长时的高度 | 本计划手动验证第 13 项 |
| 计划 3 parked：出口 lint 只能防误用，不能防故意绕过（`Reflect.get(globalThis, "fetch")`、`eval`、`new Function`、模板字符串下标、改名的 `session`） | `eval` / `new Function`：计划 5 任务 1（`no-eval`、`no-new-func`、`no-implied-eval`）；其余**不做**：只有故意绕过才会写出来，靠代码评审 |
| 计划 3 parked：退出时确认框还开着留下的 `pending` 行被标成“可能已发出”；没有价格的模型的过期行按 $0 记 | **不做**：保守方向，已在计划 3 接受 |
