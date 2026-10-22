# Butler 计划 5：发布（CSP、打包、Windows 收尾、E2E、CI、开源文档） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把计划 1–4 做成可以发布的 v1.0：渲染进程有 CSP；`git` 和 Windows 上的 `claude.cmd` 都按绝对路径直接启动（去掉 cmd.exe 这一层，`--mcp-config` 路径里有空格也能传、超时能杀干净整棵进程树）；Windows 的通知身份、注销关机、rename 重试补齐；`butler-hook` 的构建工具链有检查；electron-builder 产出不签名的 `.dmg` 和 NSIS `.exe`；Playwright for Electron 用一个假的 claude 跑通“新建 ticket → 启动 session → hook 上报 → handoff → 早间简报 → 点击打开”；GitHub Actions 在 macOS 和 Windows 上跑全部检查和 E2E；仓库有 README、LICENSE、CONTRIBUTING 和“接入另一家公司的配置”指南。

**Architecture:** 不加运行时依赖。Windows 上 npm / pnpm 生成的 `claude.cmd` 是一个固定格式的批处理文件：新模块 `src/main/claude/launch.ts` 读出它指向的 JS 入口，直接用 `node` 启动（认不出来时才回退到 cmd.exe 加原来的参数检查）；PTY、后台运行、MCP 探测共用它。`git` 的绝对路径在启动时从 PATH 里解析一次（只看绝对路径的目录），所有 git 调用都带 `-c core.fsmonitor=false`。CSP 写在 `index.html` 的 meta 里，开发模式由一个 Vite 小插件放宽（HMR 需要内联脚本和 websocket）。E2E 的假 claude 是一个 Node 脚本：交互模式写 transcript、按 `CLAUDE_CONFIG_DIR/settings.json` 里的 hook 配置用 shell 执行 hook（Windows 上用 Git Bash，和 Claude Code 一样），`-p` 模式按 `--json-schema` 回一个预设的 handoff 或刷新结果。

**Tech Stack:** 计划 1–4 的全部依赖。新增两个**开发**依赖：`@playwright/test@1.64.0`（只用 `_electron`，不下载浏览器）、`yaml@2.9.1`（CI 工作流的结构测试）。electron-builder 26.15.3（已在 devDependencies）。构建 `butler-hook` 用 Node 26.3.0（`.node-version`，需要 `--build-sea`）。

**Spec:** `docs/superpowers/specs/2026-10-19-butler-design.md`（重点：1.3 节 “Windows + macOS”、2.1 节打包、11 节 E2E 与 CI、12 节开源与分发、13.1 节 Windows hook 一行）。另见遗留清单 `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md` 和计划 4 的附录 C（遗留项去向表，本计划逐项落实其中指向计划 5 的部分）。

## 本计划在整体中的位置

| 计划 | 内容 | 结束时能做什么 |
|------|------|--------------|
| 1–3（已完成） | 框架、session、hook、handoff、简报、调度、隐私层、审计 | 日常使用 |
| 4 | StateCore 记忆层、记忆标签、设置补全、开机自启、首次启动向导 | session 能 recall 到记忆；新用户有向导 |
| **5（本计划）** | CSP、git / Windows 进程收尾、hook 工具链、打包、Playwright E2E、双平台 CI、开源文档 | 不签名的 v1.0 安装包；用户自己推仓库、发 release |

## Global Constraints

- 计划 1–4 的约束继续有效（路径用 `node:path`；prompt 不进 argv；新 IPC 通道进白名单；渲染进程不 import `src/main/**`；文案集中在 `strings.ts`；依赖精确锁定；每个任务结束时 `pnpm typecheck`、`pnpm lint`、`pnpm test` 通过；`Co-Authored-By:` 用执行者 harness 给的署名；个人 API 的网络请求只在 `src/main/gateway/**`；StateCore 只经计划 4 的两个入口；R1：任何 StateCore 进程都拿不到模型 key）。
- **R2**：永远不运行会改用户 Claude Code 配置的命令（`claude mcp add/remove`、`claude config set`、编辑 `~/.claude.json` 或 `~/.claude/settings.json`）。测试（包括 E2E）永远不碰真实的 `~/.butler`、`~/.claude`：E2E 把 `BUTLER_HOME`、`CLAUDE_CONFIG_DIR` 都指向临时目录，claude 一律是假的（`claudePath` 指向它）。不调用真实的 LLM 服务商。
- **R3**：CI 工作流在本地写好并校验（`actionlint` 可用时跑它；另有结构测试），**不推送、不创建 GitHub 仓库、不发 release**。打包产物不签名（设计文档 12 节），README 写清楚 Gatekeeper 和 SmartScreen 怎么放行。
- **R5**：依赖外部行为的任务（electron-builder、Playwright for Electron、Windows shim 格式）先做小实验并写明备选。
- 应用标识 `APP_ID = "io.github.yul761.butler"`：Windows 通知的 AUMID 和 electron-builder 的 `appId` 必须相同（测试强制，Ruling P5-R1）。
- 打包：macOS `dmg` + `zip`（arm64，ad-hoc 签名，不公证），Windows NSIS（x64，不签名）；`publish: null`，不配置自动更新（Ruling P5-R4）。
- 新的开发依赖只有 `@playwright/test@1.64.0` 和 `yaml@2.9.1`，精确版本。
- `node-pty`、`butler-hook` SEA 和打包都在当前平台上构建（SEA 只能为宿主平台生成）：CI 的每个 OS 自己构建自己的产物。

## Review Focus

1. **Windows 上路径里有空格或非 ASCII**（用户名 `John Smith` / `张三`）：claude 是 npm 装的 `claude.cmd`，`--mcp-config` 路径、`BUTLER_HOME`、hook 二进制都在这样的目录下。session 照常打开、记忆挂上、hook 照常上报。测试见任务 3（`resolves npm and pnpm shims to node and the script, keeping spaces`）和任务 9（E2E 的 `BUTLER_HOME` 故意带空格）。
2. **仓库里自带一个 `git.exe` / `git.cmd`**（Windows 会先在当前目录找可执行文件）：Butler 永远不执行它。测试见任务 2（`never picks git from the current directory or a relative PATH entry`）。
3. **从网上下载、没签名的安装包第一次运行**：macOS 的隔离属性 / Gatekeeper，Windows 的 SmartScreen；装好的 app 能在 resources 里找到 `butler-hook` 和记忆 MCP，node-pty 的 `spawn-helper` 有执行权限。验证见任务 7（打包产物的 `--smoke` 和隔离启动）、任务 11（README 的放行说明）。
4. **CSP 把 app 自己需要的东西拦了**（xterm 的样式、开发模式的热更新）：终端变成空白。测试见任务 6（`dev and production policies`）和任务 9（E2E 断言终端有内容、控制台没有 CSP 报错）。
5. **Windows 上 Claude Code 用 Git Bash 执行 hook**：正斜杠、带引号的路径必须能跑；hook 二进制缺失或出错时绝不阻塞 claude。测试见任务 9（Windows E2E 里假 claude 用 Git Bash 执行安装好的 hook 命令，侧栏出现“等你输入”）和任务 5（`exits 0 even when the inbox cannot be written`）。

---

## 文件结构

```
.node-version                      构建用的 Node 版本（任务 5）
electron-builder.yml               打包配置（任务 7）
playwright.config.ts               E2E 配置（任务 8）
.github/workflows/ci.yml           双平台检查 + E2E + 打包产物（任务 10）
.github/workflows/release.yml      打 tag 时构建不签名的安装包并建 draft release（任务 10）
README.md, LICENSE, CONTRIBUTING.md, docs/configuration.md（任务 11）
eslint.config.mjs                  + no-eval / no-new-func / no-implied-eval；e2e 和 .cjs 的 Node 环境（任务 1、8）
scripts/
  build-hook.mjs                   检查 --build-sea（任务 5）
  after-pack.cjs                   给 spawn-helper 补执行位、macOS ad-hoc 签名（任务 7）
e2e/
  fake-claude/fake-claude.cjs      假的 claude（任务 8）
  fixtures.ts                      临时目录、假 claude 包装、启动 Butler（任务 8）
  wizard.spec.ts                   首次启动向导（任务 8）
  main-flow.spec.ts                主流程（任务 9）
hook/entry.ts, hook/butler-hook.ts  兜底退出码、rename 重试与临时文件清理（任务 4、5）
src/
  renderer/index.html, src/renderer/csp.ts  CSP（任务 6）
  main/
    app-id.ts                      APP_ID（任务 4）
    paths.ts                       BUTLER_HOME 里的 ~（任务 4）
    util/git-path.ts               git 的绝对路径（任务 2）
    util/fs-retry.ts               Windows 的 rename 重试（任务 4）
    claude/launch.ts               .cmd shim → node + 脚本（任务 3）
    claude/spawn.ts, headless.ts, mcp-probe.ts  用 launch.ts（任务 3）
    tickets/git.ts, claude/project-mcp.ts       git 绝对路径、fsmonitor、临时文件（任务 2）
    hooks/installer.ts, handoff/command.ts, memory/mcp-config.ts  rename 重试（任务 4）
    index.ts                       AUMID、注销关机、托盘 @2x、CSP 日志、git 路径（任务 2、4、6）
```

---

### Task 1: 禁止 `eval` / `new Function`（计划 3 遗留的出口 lint 残余）

出口规则只能看静态的 import 和 API 名字；`eval`、`new Function`、字符串形式的 `setTimeout` 能在运行时拼出任何代码。全仓库（包括 gateway）都禁止。

**Files:**
- Modify: `eslint.config.mjs`
- Test: `src/main/egress-lint.test.ts`

**Interfaces:**
- Consumes: 现有的 `SOURCE_FILES`、`root`（`src/main/egress-lint.test.ts`）
- Produces: ESLint 规则 `no-eval`、`no-new-func`、`no-implied-eval` 对所有源文件为 `error`

- [ ] **Step 1: 写失败测试**

`src/main/egress-lint.test.ts` 末尾追加：

```ts
describe("no eval or Function constructor anywhere (plan 3 residual)", () => {
  const FORMS: Record<string, string> = {
    eval: 'export const x = eval("1 + 1");',
    "new Function": 'export const f = new Function("return 1");',
    "Function call": 'export const f = Function("return 1");',
    "string setTimeout": 'setTimeout("doIt()", 10);',
  };
  const RULES = ["no-eval", "no-new-func", "no-implied-eval"];
  for (const [name, code] of Object.entries(FORMS)) {
    it(`${name}: flagged in main, gateway, renderer and hook code`, async () => {
      const eslint = new ESLint({ cwd: root });
      for (const file of ["src/main/brief/x.ts", "src/main/gateway/x.ts", "src/renderer/src/x.tsx", "hook/x.ts"]) {
        const [r] = await eslint.lintText(code, { filePath: file });
        expect(r.messages.filter((m) => RULES.includes(m.ruleId ?? "")).length, `${name} ${file}`).toBeGreaterThan(0);
      }
    }, 60_000);
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/egress-lint.test.ts`
Expected: FAIL——这几种写法目前都不报错。

- [ ] **Step 3: 实现**

`eslint.config.mjs` 的 `export default tseslint.config(...)` 里，`{ files: SOURCE_FILES, rules: outsideGatewayRules },` 之前插入一块（gateway 那一块只关掉出口规则，不会关掉这三条）：

```js
  // 计划 3 遗留：eval / new Function / 字符串 setTimeout 能在运行时拼出任何代码，出口规则看不到。gateway 里也一样禁止。
  { files: SOURCE_FILES, rules: { "no-eval": "error", "no-new-func": "error", "no-implied-eval": "error" } },
```

- [ ] **Step 4: 运行测试，确认通过；确认现有代码没有违规**

Run: `pnpm exec vitest run src/main/egress-lint.test.ts && pnpm lint`
Expected: PASS；`pnpm lint` 没有新的报错（仓库里本来没有这些写法）。

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs src/main/egress-lint.test.ts
git commit -m "feat: forbid eval, new Function and string timers everywhere, gateway included"
```

---

### Task 2: git 的绝对路径、全局关闭 fsmonitor、项目 MCP 的临时文件（计划 3 遗留）

Windows 上直接执行 `git` 会先在**当前目录**找 `git.exe`：在一个自带 `git.exe` 的仓库里建 ticket、做分支检查，就会执行仓库里的程序。启动时从 PATH 的**绝对目录**里解析 `git.exe`（POSIX 上找 `git`）一次，所有 git 调用都用这个路径，并且都带 `-c core.fsmonitor=false`（仓库配置里的 fsmonitor 钩子同样能执行任意程序）。顺带把项目级 MCP 的临时文件换成随机名 + `wx`，加上 APFS 大小写别名的回归测试。

**Files:**
- Modify: `src/main/claude/locate.ts`、`src/main/claude/locate.test.ts`
- Create: `src/main/util/git-path.ts`
- Test: `src/main/util/git-path.test.ts`
- Modify: `src/main/tickets/git.ts`、`src/main/tickets/git.test.ts`
- Modify: `src/main/claude/project-mcp.ts`、`src/main/claude/project-mcp.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `findOnPath(name, pathValue, platform, pathext?, exists?)`（`src/main/claude/locate.ts`）；`pathKey()`（`src/main/util/env.ts`）
- Produces:
  - `absolutePathEntries(pathValue: string, platform: NodeJS.Platform): string`（`locate.ts`：去掉相对目录和引号后重新拼回 PATH）
  - `src/main/util/git-path.ts`：`resolveGit(pathValue, platform, exists?): string | null`、`setGitBinary(p: string): void`、`gitBinary(): string`、`GIT_SAFE_ARGS = ["-c", "core.fsmonitor=false"]`

- [ ] **Step 1: 写失败测试**

`src/main/claude/locate.test.ts` 末尾追加（import 里加 `absolutePathEntries`）：

```ts
describe("absolutePathEntries", () => {
  it("drops relative and empty PATH entries and unquotes Windows entries", () => {
    expect(absolutePathEntries(".:/usr/bin::bin:/opt/x", "darwin")).toBe("/usr/bin:/opt/x");
    expect(absolutePathEntries('.;"C:\\Program Files\\Git\\cmd";bin;;D:\\tools', "win32")).toBe("C:\\Program Files\\Git\\cmd;D:\\tools");
  });
});
```

新建 `src/main/util/git-path.test.ts`：

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GIT_SAFE_ARGS, gitBinary, resolveGit, setGitBinary } from "./git-path";

describe("git binary (plan 3 residual: Windows looks in the current directory first)", () => {
  it("finds git only in absolute PATH directories", () => {
    const exists = (p: string) => p === join("/usr/bin", "git") || !p.startsWith("/");
    expect(resolveGit(".:relative/bin:/usr/bin", "darwin", exists)).toBe(join("/usr/bin", "git"));
    expect(resolveGit("relative/bin", "darwin", () => true)).toBeNull();
  });

  it("never picks git from the current directory or a relative PATH entry on Windows (Review Focus 2)", () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return p === "C:\\Program Files\\Git\\cmd\\git.exe" || !/^[A-Za-z]:\\/.test(p);
    };
    expect(resolveGit('.;"C:\\Program Files\\Git\\cmd";bin', "win32", exists)).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(seen.every((p) => /^[A-Za-z]:\\/.test(p))).toBe(true);
    // 只认 git.exe：git.cmd 需要 cmd.exe 才能执行。
    expect(resolveGit("C:\\tools", "win32", (p) => p.endsWith("git.cmd"))).toBeNull();
  });

  it("defaults to plain git until a path is set, and always disables fsmonitor", () => {
    expect(gitBinary()).toBe("git");
    setGitBinary("/opt/git/bin/git");
    expect(gitBinary()).toBe("/opt/git/bin/git");
    setGitBinary("git");
    expect(GIT_SAFE_ARGS).toEqual(["-c", "core.fsmonitor=false"]);
  });
});
```

`src/main/tickets/git.test.ts` 末尾追加（import 加上 `git`，并加 `import { chmodSync, readFileSync, writeFileSync } from "node:fs";`、`import { join } from "node:path";`、`import { setGitBinary } from "../util/git-path";`、`import { tempDir } from "../test-utils";`；已有的 import 合并，不要重复）：

```ts
describe("git invocation", () => {
  it.skipIf(process.platform === "win32")("runs the resolved git with fsmonitor disabled", async () => {
    const dir = tempDir();
    const log = join(dir, "args.txt");
    const fake = join(dir, "git");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\necho ok\n`);
    chmodSync(fake, 0o755);
    setGitBinary(fake);
    try {
      expect(await git(dir, ["status", "--porcelain"])).toBe("ok");
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["-c", "core.fsmonitor=false", "status", "--porcelain"]);
    } finally {
      setGitBinary("git");
    }
  });
});
```

`src/main/claude/project-mcp.test.ts` 末尾追加：

```ts
describe("projectMcpConfigs: case-insensitive file systems (plan 3 parked)", () => {
  it.skipIf(process.platform !== "darwin")("does not trust a settings.local.json that git tracks under another letter case (APFS alias)", () => {
    const s = setup();
    s.gitInit();
    s.writeMcp(["repoServer"]);
    // 仓库提交的是 .CLAUDE/SETTINGS.LOCAL.JSON；在大小写不敏感的 APFS 上它就是 .claude/settings.local.json。
    mkdirSync(join(s.repo, ".CLAUDE"));
    writeFileSync(join(s.repo, ".CLAUDE", "SETTINGS.LOCAL.JSON"), JSON.stringify({ enabledMcpjsonServers: ["repoServer"] }));
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "ship approvals");
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
  });

  it("writes through a randomly named temporary file and leaves none behind", () => {
    const s = setup();
    s.writeMcp(["a"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    projectMcpConfigs(s.repo, s.p);
    projectMcpConfigs(s.repo, s.p);
    expect(readdirSync(s.mcpDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/claude/locate.test.ts src/main/util/git-path.test.ts src/main/tickets/git.test.ts src/main/claude/project-mcp.test.ts`
Expected: FAIL——`absolutePathEntries`、`./git-path` 不存在；git 调用没有 `-c core.fsmonitor=false`。APFS 用例在 macOS 上应当已经通过（现有的 `:(icase)` 检查，这里是加回归测试）。

- [ ] **Step 3: 实现**

`src/main/claude/locate.ts` 的 `findOnPath` 之前加：

```ts
/** PATH 里只保留绝对目录（去掉 Windows 条目两边的引号）：相对目录等于“当前目录”，仓库里的人能往里放同名程序。 */
export function absolutePathEntries(pathValue: string, platform: NodeJS.Platform): string {
  const sep = platform === "win32" ? ";" : ":";
  const p = platform === "win32" ? path.win32 : path.posix;
  return pathValue
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter((d) => d && p.isAbsolute(d))
    .join(sep);
}
```

新建 `src/main/util/git-path.ts`：

```ts
import { absolutePathEntries, findOnPath } from "../claude/locate";

/** 每个 git 调用都带上：仓库配置里的 fsmonitor 钩子能执行任意程序（计划 3 遗留）。 */
export const GIT_SAFE_ARGS = ["-c", "core.fsmonitor=false"];

let binary = "git";

/**
 * git 的绝对路径：只在 PATH 的绝对目录里找。Windows 上直接执行 "git" 会先在当前目录找 git.exe，
 * 在一个自带 git.exe 的仓库里建 ticket 就会执行它；只认 git.exe（git.cmd 要经 cmd.exe）。找不到时返回 null。
 */
export function resolveGit(pathValue: string, platform: NodeJS.Platform, exists?: (p: string) => boolean): string | null {
  return findOnPath("git", absolutePathEntries(pathValue, platform), platform, ".EXE", exists);
}

export function setGitBinary(p: string): void {
  binary = p;
}

export function gitBinary(): string {
  return binary;
}
```

`src/main/tickets/git.ts`：
- import 区加 `import { GIT_SAFE_ARGS, gitBinary } from "../util/git-path";`
- `git()` 里 `execFile("git", args, {` 改成 `execFile(gitBinary(), [...GIT_SAFE_ARGS, ...args], {`（报错信息里仍然只写 `args`）。

`src/main/claude/project-mcp.ts`：
- import 区：`import { createHash } from "node:crypto";` 改成 `import { createHash, randomBytes } from "node:crypto";`，并加 `import { GIT_SAFE_ARGS, gitBinary } from "../util/git-path";`
- `git()` 里 `spawnSync("git", args, {` 改成 `spawnSync(gitBinary(), [...GIT_SAFE_ARGS, ...args], {`
- `writePrivate` 里：

```ts
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600, flag: "w" });
```

改成：

```ts
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600, flag: "wx" });
```

`src/main/index.ts`：
- import 区加 `import { resolveGit, setGitBinary } from "./util/git-path";` 和 `import { pathKey } from "./util/env";`
- `bootstrap()` 的第一行（`const paths = resolvePaths();` 之前）加：

```ts
  // 先用 Butler 自己的 PATH 定下 git 的绝对路径；登录 shell 的 PATH 读到之后再更新一次。
  const envGit = resolveGit(process.env[pathKey(process.env)] ?? "", process.platform);
  if (envGit) setGitBinary(envGit);
```

- `const healthReady: Promise<void> = health.refresh().then(` 里的成功回调 `() => notify(),` 改成：

```ts
    () => {
      const loginGit = resolveGit(health.claude().pathValue, process.platform);
      if (loginGit) setGitBinary(loginGit);
      notify();
    },
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/claude src/main/util src/main/tickets`
Expected: PASS

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/main/claude/locate.ts src/main/claude/locate.test.ts src/main/util/git-path.ts src/main/util/git-path.test.ts src/main/tickets/git.ts src/main/tickets/git.test.ts src/main/claude/project-mcp.ts src/main/claude/project-mcp.test.ts src/main/index.ts
git commit -m "fix: run git by absolute path with fsmonitor off; random temp names for project MCP files"
```

---

### Task 3: Windows 上不经 cmd.exe 启动 `claude.cmd`（`--mcp-config` 引号、killTree 孤儿进程）

npm / pnpm 装的 `claude.cmd` 只是一个固定格式的批处理文件，最后一行用 node 执行一个 JS 入口。经过 cmd.exe 有两个老问题：带空格的 `--mcp-config` 路径没法安全传递（计划 1 Task 9，计划 4 只能先不挂记忆）；cmd.exe 先退出时 `taskkill /T` 找不到 claude 的进程树（计划 2 Task 10）。本任务读出 shim 指向的 JS 入口，直接用 `node` 启动（shim 旁边有 `node.exe` 就用它，否则在 PATH 的绝对目录里找）；认不出来的 shim 才回退到 cmd.exe（PTY 用 `cmd.exe /c`，后台运行交给 cross-spawn 的转义，并保留原来的参数检查）。PTY、后台运行、MCP 探测共用一个启动函数（计划 2 的“spawn 选项重复”）。退出时取消的后台运行直接 SIGKILL（计划 2 的“退出时 SIGKILL 定时器被 unref”）。

**Files:**
- Create: `src/main/claude/launch.ts`
- Test: `src/main/claude/launch.test.ts`
- Modify: `src/main/claude/spawn.ts`、`src/main/claude/spawn.test.ts`
- Modify: `src/main/claude/headless.ts`、`src/main/claude/headless.test.ts`
- Modify: `src/main/claude/mcp-probe.ts`
- Modify: `src/main/sessions/session-service.ts`

**Interfaces:**
- Consumes: `absolutePathEntries`、`findOnPath`（`locate.ts`，任务 2）；`pathKey`；`cmdShimSafe`（计划 4 任务 7）；`unsafeCmdArg`、`killTree`（`headless.ts`）
- Produces:
  - `src/main/claude/launch.ts`：`interface Launch { file: string; args: string[]; viaCmd: boolean }`、`interface LaunchDeps { pathValue?: string; read?: (f: string) => string; exists?: (p: string) => boolean }`、`parseCmdShim(content): string | null`、`isCmdShim(file, platform): boolean`、`resolveLaunch(claudePath, args, platform, deps?): Launch`、`childLaunch(claudePath, args, platform, deps?): Launch`、`spawnClaude(claudePath, args, o: { cwd: string; env: Record<string, string>; stdio: StdioOptions }): ChildProcess`
  - `spawnSpec(claudePath, args, platform, pathValue?: string): SpawnSpec`（多一个参数）
  - `killTree(child, now?: boolean)`：`now` 为 true 时 POSIX 上直接 SIGKILL

- [ ] **Step 1: 写失败测试**

新建 `src/main/claude/launch.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { childLaunch, isCmdShim, parseCmdShim, resolveLaunch } from "./launch";

/** npm 的 cmd-shim 生成的 claude.cmd（换行是 CRLF）。 */
const NPM_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join("\r\n");
/** pnpm 生成的 claude.cmd。 */
const PNPM_SHIM = [
  "@SETLOCAL",
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*',
  ") ELSE (",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  '  node  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*',
  ")",
].join("\r\n");

const NPM_DIR = "C:\\Users\\John Smith\\AppData\\Roaming\\npm";
const CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

describe("Windows claude shims (plan 1 Task 9, plan 2 Task 10)", () => {
  it("reads the script out of npm and pnpm shims", () => {
    expect(parseCmdShim(NPM_SHIM)).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseCmdShim(PNPM_SHIM)).toBe("..\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseCmdShim('@echo off\r\nnode "C:\\x\\fake.cjs" %*')).toBeNull();
    expect(parseCmdShim("")).toBeNull();
  });

  it("only treats .cmd and .bat on Windows as shims", () => {
    expect(isCmdShim("C:\\npm\\claude.cmd", "win32")).toBe(true);
    expect(isCmdShim("C:\\npm\\CLAUDE.BAT", "win32")).toBe(true);
    expect(isCmdShim("C:\\bin\\claude.exe", "win32")).toBe(false);
    expect(isCmdShim("/usr/local/bin/claude.cmd", "darwin")).toBe(false);
  });

  it("resolves npm and pnpm shims to node and the script, keeping spaces (Review Focus 1)", () => {
    const files = new Map([[`${NPM_DIR}\\claude.cmd`, NPM_SHIM], [`${NPM_DIR}\\node.exe`, ""], [CLI, ""]]);
    const deps = { read: (f: string) => files.get(f) ?? "", exists: (p: string) => files.has(p) };
    const args = ["--session-id", "u1", "--mcp-config", "C:\\Users\\John Smith\\.butler\\mcp\\PROJ-1.json"];
    expect(resolveLaunch(`${NPM_DIR}\\claude.cmd`, args, "win32", deps)).toEqual({ file: `${NPM_DIR}\\node.exe`, args: [CLI, ...args], viaCmd: false });

    const pnpmDir = "D:\\pnpm\\bin";
    const pnpmCli = "D:\\pnpm\\@anthropic-ai\\claude-code\\cli.js";
    const nodeOnPath = "C:\\Program Files\\nodejs\\node.exe";
    const files2 = new Map([[`${pnpmDir}\\claude.cmd`, PNPM_SHIM], [pnpmCli, ""], [nodeOnPath, ""], [".\\node.exe", ""]]);
    const deps2 = { read: (f: string) => files2.get(f) ?? "", exists: (p: string) => files2.has(p), pathValue: ".;C:\\Program Files\\nodejs" };
    expect(resolveLaunch(`${pnpmDir}\\claude.cmd`, ["-p"], "win32", deps2)).toEqual({ file: nodeOnPath, args: [pnpmCli, "-p"], viaCmd: false });
  });

  it("falls back to cmd.exe when the shim cannot be understood", () => {
    const cases = [
      { read: () => "@echo off\r\nsomething else %*", exists: () => true },
      { read: () => NPM_SHIM, exists: () => false },
      {
        read: () => {
          throw new Error("EACCES");
        },
        exists: () => true,
      },
    ];
    for (const deps of cases) {
      expect(resolveLaunch("C:\\npm\\claude.cmd", ["x"], "win32", deps)).toEqual({ file: "cmd.exe", args: ["/c", "C:\\npm\\claude.cmd", "x"], viaCmd: true });
    }
  });

  it("leaves everything else alone, and hands unknown shims back to cross-spawn untouched", () => {
    expect(resolveLaunch("/usr/local/bin/claude", ["x"], "darwin")).toEqual({ file: "/usr/local/bin/claude", args: ["x"], viaCmd: false });
    expect(resolveLaunch("C:\\bin\\claude.exe", ["x"], "win32")).toEqual({ file: "C:\\bin\\claude.exe", args: ["x"], viaCmd: false });
    expect(childLaunch("C:\\npm\\claude.cmd", ["x"], "win32", { read: () => "junk", exists: () => true })).toEqual({ file: "C:\\npm\\claude.cmd", args: ["x"], viaCmd: true });
  });
});
```

`src/main/claude/headless.test.ts` 末尾追加（import 加上 `killTree`；再加 `import { spawn } from "node:child_process";` 和 `import { waitUntilDead } from "../test-utils";`，已有的合并）：

```ts
describe("killTree", () => {
  it.skipIf(process.platform === "win32")("kills at once when the app is quitting, even a child that ignores SIGTERM", async () => {
    const child = spawn("/bin/sh", ["-c", 'trap "" TERM; sleep 30'], { detached: true, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    killTree(child, true);
    expect(await waitUntilDead(child.pid!, 1500)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
```

`src/main/claude/spawn.test.ts` 的 `runs .cmd shims through cmd.exe on Windows only` 用例保持不变（`C:\npm\claude.cmd` 在测试机上不存在，读不到就回退到 cmd.exe），并在后面加：

```ts
  it("passes the login PATH on so a shim's node can be found", () => {
    expect(spawnSpec("/usr/local/bin/claude", ["x"], "darwin", "/usr/bin")).toEqual({ file: "/usr/local/bin/claude", args: ["x"] });
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/claude/launch.test.ts src/main/claude/headless.test.ts src/main/claude/spawn.test.ts`
Expected: FAIL——`./launch` 不存在；`killTree` 不接受第二个参数，忽略 SIGTERM 的子进程要等 2 秒。

- [ ] **Step 3: 实现启动函数**

新建 `src/main/claude/launch.ts`：

```ts
import type { ChildProcess, StdioOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import spawn from "cross-spawn";
import { pathKey } from "../util/env";
import { absolutePathEntries, findOnPath } from "./locate";

/** 实际要执行的程序和参数。viaCmd：认不出 shim，只能经过 cmd.exe。 */
export interface Launch {
  file: string;
  args: string[];
  viaCmd: boolean;
}

export interface LaunchDeps {
  /** 登录 shell 的 PATH（找 node.exe 用，只看绝对目录）。 */
  pathValue?: string;
  read?: (file: string) => string;
  exists?: (p: string) => boolean;
}

/** npm 的 cmd-shim 写 "%dp0%\..."，pnpm 写 "%~dp0\..."：取出 JS 入口的相对路径。 */
const SHIM_SCRIPT_RE = /"%(?:~dp0|dp0%)\\([^"%]+?\.[cm]?js)"/i;

export function parseCmdShim(content: string): string | null {
  return SHIM_SCRIPT_RE.exec(content)?.[1] ?? null;
}

export function isCmdShim(file: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

/**
 * Windows 上 npm / pnpm 装的 claude.cmd 直接用 node 执行它的 JS 入口，不经过 cmd.exe：
 * 参数（例如带空格的 --mcp-config 路径）原样传递，taskkill /T 也能找到整棵进程树。
 * shim 旁边有 node.exe 就用它，否则在 PATH 的绝对目录里找 node.exe。认不出来时回退到 cmd.exe /c。
 */
export function resolveLaunch(claudePath: string, args: string[], platform: NodeJS.Platform, deps: LaunchDeps = {}): Launch {
  if (!isCmdShim(claudePath, platform)) return { file: claudePath, args, viaCmd: false };
  const read = deps.read ?? ((f: string) => readFileSync(f, "utf8"));
  const exists = deps.exists ?? existsSync;
  try {
    const rel = parseCmdShim(read(claudePath));
    if (rel) {
      const dir = path.win32.dirname(claudePath);
      const script = path.win32.resolve(dir, rel);
      const local = path.win32.join(dir, "node.exe");
      const node = exists(local) ? local : findOnPath("node", absolutePathEntries(deps.pathValue ?? "", "win32"), "win32", ".EXE", exists);
      if (node && exists(script)) return { file: node, args: [script, ...args], viaCmd: false };
    }
  } catch {
    // 读不了 shim：按原来的方式经过 cmd.exe。
  }
  return { file: "cmd.exe", args: ["/c", claudePath, ...args], viaCmd: true };
}

/** 给 cross-spawn 用：认出了 shim 就直接起 node；认不出来就把 .cmd 原样交给 cross-spawn（它会按 cmd.exe 的规则转义）。 */
export function childLaunch(claudePath: string, args: string[], platform: NodeJS.Platform, deps: LaunchDeps = {}): Launch {
  const l = resolveLaunch(claudePath, args, platform, deps);
  return l.viaCmd ? { file: claudePath, args, viaCmd: true } : l;
}

/** 后台运行和 MCP 探测共用的启动方式：POSIX 上独立进程组（killTree 才能整组杀掉），Windows 上不弹窗口。 */
export function spawnClaude(claudePath: string, args: string[], o: { cwd: string; env: Record<string, string>; stdio: StdioOptions }): ChildProcess {
  const l = childLaunch(claudePath, args, process.platform, { pathValue: o.env[pathKey(o.env)] });
  return spawn(l.file, l.args, { cwd: o.cwd, env: o.env, stdio: o.stdio, windowsHide: true, detached: process.platform !== "win32" });
}
```

`src/main/claude/spawn.ts`：
- import 区加 `import { resolveLaunch } from "./launch";`
- `spawnSpec` 整个替换为：

```ts
/** PTY 里的 claude：Windows 上能认出的 .cmd shim 直接用 node 执行，认不出来才经过 cmd.exe（launch.ts）。 */
export function spawnSpec(claudePath: string, args: string[], platform: NodeJS.Platform, pathValue = ""): SpawnSpec {
  const l = resolveLaunch(claudePath, args, platform, { pathValue });
  return { file: l.file, args: l.args };
}
```

- [ ] **Step 4: 接到后台运行、探测和 session**

`src/main/claude/headless.ts`：
- import 区：删掉 `import spawn from "cross-spawn";`，加 `import { resolveLaunch, spawnClaude } from "./launch";` 和 `import { pathKey } from "../util/env";`
- `killTree` 整个替换为：

```ts
/**
 * 结束子进程及其子进程。POSIX 杀整个进程组（即使直接子进程已退出）；Windows 上用 taskkill /T /F。
 * now：app 正在退出——直接 SIGKILL，不等宽限期（退出后定时器不会再触发）。
 */
export function killTree(child: ChildProcess, now = false): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  const sig = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      // 进程组已经不存在。
    }
  };
  if (now) {
    sig("SIGKILL");
    return;
  }
  sig("SIGTERM");
  setTimeout(() => sig("SIGKILL"), GRACE_MS).unref();
}
```

- `runHeadless` 里 `function onAbort() {` 的第一行 `if (child) killTree(child);` 改成 `if (child) killTree(child, true);`
- `const bad = unsafeCmdArg(req.args, req.claudePath, process.platform);` 改成：

```ts
    // 只有认不出 shim、必须经过 cmd.exe 时才需要这道检查。
    const viaCmd = resolveLaunch(req.claudePath, [], process.platform, { pathValue: req.env[pathKey(req.env)] }).viaCmd;
    const bad = viaCmd ? unsafeCmdArg(req.args, req.claudePath, process.platform) : null;
```

- `child = spawn(req.claudePath, req.args, { cwd: req.cwd, env: req.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });` 改成：

```ts
      child = spawnClaude(req.claudePath, req.args, { cwd: req.cwd, env: req.env, stdio: ["pipe", "pipe", "pipe"] });
```

`src/main/claude/mcp-probe.ts`：
- import 区：删掉 `import spawn from "cross-spawn";`，加 `import { resolveLaunch, spawnClaude } from "./launch";` 和 `import { pathKey } from "../util/env";`
- `function onAbort(): void { finish(new Error("已取消")); }` 改成：

```ts
    function onAbort(): void {
      // app 正在退出：直接杀，不等宽限期。
      if (child) killTree(child, true);
      finish(new Error("已取消"));
    }
```

- `if (unsafeCmdArg(args, o.claudePath, process.platform) !== null) {` 改成：

```ts
    const viaCmd = resolveLaunch(o.claudePath, [], process.platform, { pathValue: o.env[pathKey(o.env)] }).viaCmd;
    if (viaCmd && unsafeCmdArg(args, o.claudePath, process.platform) !== null) {
```

- `child = spawn(o.claudePath, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32" });` 改成：

```ts
      child = spawnClaude(o.claudePath, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"] });
```

`src/main/sessions/session-service.ts`：
- import 区加 `import { resolveLaunch } from "../claude/launch";`
- `open()` 里 `const mcpConfigPath = this.mcpConfigFor(ticket.key, claudePath);` 改成 `const mcpConfigPath = this.mcpConfigFor(ticket.key, claudePath, pathValue);`
- `this.d.pty.open(termId, spawnSpec(claudePath, args, this.d.platform), {` 改成 `this.d.pty.open(termId, spawnSpec(claudePath, args, this.d.platform, pathValue), {`
- `mcpConfigFor` 的签名和检查改成：

```ts
  private mcpConfigFor(ticketKey: string, claudePath: string, pathValue: string): string | undefined {
```

```ts
    // 计划 5：能认出的 shim 不经过 cmd.exe，路径原样传递；只有回退到 cmd.exe 时才需要这道检查。
    const viaCmd = resolveLaunch(claudePath, [], this.d.platform, { pathValue }).viaCmd;
    if (viaCmd && !cmdShimSafe(claudePath, file, this.d.platform)) {
```

（`session-service.test.ts` 里计划 4 的 `C:\npm\claude.cmd` 用例不用改：那个文件不存在，回退到 cmd.exe，检查照旧生效。）

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/claude src/main/sessions`
Expected: PASS

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/main/claude/launch.ts src/main/claude/launch.test.ts src/main/claude/spawn.ts src/main/claude/spawn.test.ts src/main/claude/headless.ts src/main/claude/headless.test.ts src/main/claude/mcp-probe.ts src/main/sessions/session-service.ts
git commit -m "fix: start npm and pnpm claude shims with node directly on Windows; kill at once on quit"
```

---

### Task 4: Windows 与平台收尾：AUMID、注销关机、rename 重试、`~`、托盘 @2x

计划 1–3 留下的 Windows / 平台小项：通知需要 AppUserModelID（否则 Windows 上点通知没反应，计划 2 Task 13）；“关窗口只是藏到托盘”会挡住 Windows 注销和关机（计划 1 Task 12）；杀毒软件、索引服务或正在运行的 hook 会短暂占着文件，rename 报 EPERM / EBUSY（计划 1 Task 6）；`BUTLER_HOME=~/x` 不展开（计划 3）；托盘图标只有 1x（计划 1 Task 12）。

**Files:**
- Create: `src/main/app-id.ts`
- Create: `src/main/util/fs-retry.ts`
- Test: `src/main/util/fs-retry.test.ts`
- Modify: `src/main/paths.ts`、`src/main/paths.test.ts`
- Modify: `hook/butler-hook.ts`、`hook/butler-hook.test.ts`
- Modify: `src/main/hooks/installer.ts`、`src/main/handoff/command.ts`、`src/main/claude/project-mcp.ts`、`src/main/memory/mcp-config.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `circleBitmap(size, bgr)`（`src/main/tray-bitmap.ts`）
- Produces:
  - `APP_ID = "io.github.yul761.butler"`（`src/main/app-id.ts`；任务 7 的 electron-builder `appId` 必须与它相同）
  - `src/main/util/fs-retry.ts`：`RENAME_ATTEMPTS = 6`、`renameWithRetry(from, to, o?): Promise<void>`、`renameWithRetrySync(from, to, o?): void`（只重试 EPERM / EBUSY / EACCES）
  - `dirFromEnv(v, home?)`：`~`、`~/x`、`~\x` 展开到 home
  - `writeEnvelope(dir, envelope, rename?)`（`hook/butler-hook.ts`）：rename 失败时删掉临时文件再抛出

- [ ] **Step 1: 写失败测试**

新建 `src/main/util/fs-retry.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { RENAME_ATTEMPTS, renameWithRetry, renameWithRetrySync } from "./fs-retry";

const err = (code: string) => Object.assign(new Error(code), { code });

describe("rename with retry (plan 1 Task 6: Windows EPERM / EBUSY)", () => {
  it("retries a briefly locked file and then succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    await renameWithRetry("a", "b", {
      rename: async () => {
        if (++calls < 3) throw err(calls === 1 ? "EPERM" : "EBUSY");
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(calls).toBe(3);
    expect(waits).toEqual([20, 40]);
  });

  it("gives up after a bounded number of attempts and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      renameWithRetry("a", "b", {
        rename: async () => {
          calls++;
          throw err("EACCES");
        },
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("EACCES");
    expect(calls).toBe(RENAME_ATTEMPTS);
  });

  it("does not retry other errors", () => {
    let calls = 0;
    expect(() =>
      renameWithRetrySync("a", "b", {
        rename: () => {
          calls++;
          throw err("ENOENT");
        },
        sleep: () => undefined,
      }),
    ).toThrow("ENOENT");
    expect(calls).toBe(1);
  });

  it("works synchronously too", () => {
    let calls = 0;
    renameWithRetrySync("a", "b", {
      rename: () => {
        if (++calls < 2) throw err("EBUSY");
      },
      sleep: () => undefined,
    });
    expect(calls).toBe(2);
  });
});
```

`src/main/paths.test.ts` 末尾追加：

```ts
  it("expands ~ in BUTLER_HOME and CLAUDE_CONFIG_DIR", () => {
    expect(resolvePaths({ BUTLER_HOME: "~/bh" }, "darwin", "/home/u").home).toBe(join("/home/u", "bh"));
    expect(resolvePaths({ BUTLER_HOME: "~" }, "darwin", "/home/u").home).toBe("/home/u");
    expect(resolvePaths({ CLAUDE_CONFIG_DIR: "~\\cc" }, "win32", "/home/u").claudeConfigDir).toBe(join("/home/u", "cc"));
  });
```

（放进 `describe("resolvePaths", ...)` 里面。）

`hook/butler-hook.test.ts` 的 `describe("butler-hook", ...)` 里追加（import 加 `existsSync`）：

```ts
  it("expands ~ in BUTLER_HOME like the app does", () => {
    expect(inboxDir({ BUTLER_HOME: "~/b" }, "/h")).toBe(join("/h", "b", "inbox"));
  });

  it("removes its temporary file when the rename fails", () => {
    const dir = join(tempDir(), "inbox");
    const env = buildEnvelope("{}", {}, 1);
    expect(() =>
      writeEnvelope(dir, env, () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }),
    ).toThrow("EPERM");
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/util/fs-retry.test.ts src/main/paths.test.ts hook/butler-hook.test.ts`
Expected: FAIL——`./fs-retry` 不存在；`~` 没有展开；`writeEnvelope` 不接受第三个参数、失败时留下 `.tmp`。

- [ ] **Step 3: 实现 rename 重试和 `~`**

新建 `src/main/util/fs-retry.ts`：

```ts
import { renameSync } from "node:fs";
import { rename } from "node:fs/promises";

/** Windows 上杀毒软件、索引服务或正在运行的 hook 会短暂占着文件：这几种错误等一下再试（计划 1 Task 6）。 */
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
export const RENAME_ATTEMPTS = 6;
/** 20、40、80、160、320 毫秒：最多多等约 0.6 秒。 */
const delay = (attempt: number): number => 20 * 2 ** attempt;
const retryable = (e: unknown): boolean => RETRYABLE.has((e as NodeJS.ErrnoException)?.code ?? "");

export async function renameWithRetry(
  from: string,
  to: string,
  o: { rename?: (a: string, b: string) => Promise<void>; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const doRename = o.rename ?? rename;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (e) {
      if (attempt >= RENAME_ATTEMPTS - 1 || !retryable(e)) throw e;
      await sleep(delay(attempt));
    }
  }
}

/** 同步版本（hook、--mcp-config 文件这些同步写入的地方）。 */
export function renameWithRetrySync(
  from: string,
  to: string,
  o: { rename?: (a: string, b: string) => void; sleep?: (ms: number) => void } = {},
): void {
  const doRename = o.rename ?? renameSync;
  const sleep = o.sleep ?? ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  for (let attempt = 0; ; attempt++) {
    try {
      doRename(from, to);
      return;
    } catch (e) {
      if (attempt >= RENAME_ATTEMPTS - 1 || !retryable(e)) throw e;
      sleep(delay(attempt));
    }
  }
}
```

`src/main/paths.ts` 的 `dirFromEnv` 改成：

```ts
/** 环境变量给的目录：~ 展开到 home（GUI 启动时没有 shell 替你展开），相对路径按当前目录解析（Electron 的 setPath 只接受绝对路径）。 */
export function dirFromEnv(v: string | undefined, home: string = homedir()): string | null {
  const t = v?.trim();
  if (!t) return null;
  if (t === "~") return home;
  if (t.startsWith("~/") || t.startsWith("~\\")) return join(home, t.slice(2));
  return isAbsolute(t) ? t : resolve(t);
}
```

并把 `resolvePaths` 里的两处调用改成传 home：

```ts
  const butlerHome = dirFromEnv(env.BUTLER_HOME, home) ?? join(home, ".butler");
  const configOverride = dirFromEnv(env.CLAUDE_CONFIG_DIR, home);
```

`hook/butler-hook.ts`：
- import 区：`import { mkdirSync, renameSync, writeFileSync } from "node:fs";` 改成 `import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";`，并加：

```ts
import { dirFromEnv } from "../src/main/paths";
import { renameWithRetrySync } from "../src/main/util/fs-retry";
```

- `inboxDir` 改成：

```ts
export function inboxDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return join(dirFromEnv(env.BUTLER_HOME, home) ?? join(home, ".butler"), "inbox");
}
```

- `writeEnvelope` 改成：

```ts
/** 先写 .tmp 再 rename，读取方永远看不到写了一半的文件。文件名以时间戳开头，按名字排序即按时间排序。rename 失败时删掉 .tmp。 */
export function writeEnvelope(dir: string, envelope: HookEnvelope, rename: (from: string, to: string) => void = renameWithRetrySync): string {
  mkdirSync(dir, { recursive: true });
  const name = `${envelope.receivedAt}-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  const tmp = join(dir, `${name}.tmp`);
  const file = join(dir, name);
  writeFileSync(tmp, JSON.stringify(envelope));
  try {
    rename(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 已经不在了。
    }
    throw e;
  }
  return file;
}
```

（hook 的 bundle 由 esbuild 打包，`src/main/paths.ts` 只用到 `node:fs/promises`、`node:os`、`node:path`，不会把主进程的其他代码带进来。）

- [ ] **Step 4: 所有 rename 换成重试版本**

- `src/main/hooks/installer.ts`：第一行 import 里去掉 `rename`；加 `import { renameWithRetry } from "../util/fs-retry";`；`writeSettingsAtomic` 和 `installHookBinary` 里的 `await rename(tmp, target);` / `await rename(tmp, dest);` 改成 `await renameWithRetry(tmp, target);` / `await renameWithRetry(tmp, dest);`
- `src/main/handoff/command.ts`：第一行 import 里去掉 `rename`；加 `import { renameWithRetry } from "../util/fs-retry";`；`await rename(tmp, target);` 改成 `await renameWithRetry(tmp, target);`
- `src/main/claude/project-mcp.ts`：import 里去掉 `renameSync`；加 `import { renameWithRetrySync } from "../util/fs-retry";`；`writePrivate` 里 `renameSync(tmp, file);` 改成 `renameWithRetrySync(tmp, file);`
- `src/main/memory/mcp-config.ts`：import 里去掉 `renameSync`；加 `import { renameWithRetrySync } from "../util/fs-retry";`；`renameSync(tmp, file);` 改成 `renameWithRetrySync(tmp, file);`

- [ ] **Step 5: 主进程：AUMID、注销关机、托盘 @2x**

新建 `src/main/app-id.ts`：

```ts
/**
 * 应用标识：Windows 通知的 AppUserModelID，也是 electron-builder 的 appId（electron-builder.yml，测试保证两者相同）。
 * 发布第一个版本之后不要再改：Windows 的开始菜单快捷方式、通知和开机自启都按它识别 Butler。
 */
export const APP_ID = "io.github.yul761.butler";
```

`src/main/index.ts`：
- import 区加 `import { APP_ID } from "./app-id";`
- `if (process.env.BUTLER_HOME?.trim()) app.setPath(...)` 那一行之后加：

```ts
// Windows 的通知要有 AppUserModelID，否则点击通知没有反应（计划 2 Task 13）。
if (process.platform === "win32") app.setAppUserModelId(APP_ID);
```

- `createWindow()` 里 `w.on("closed", ...)` 之后加：

```ts
  // Windows 注销 / 关机：不能再把关窗口拦成“藏到托盘”，否则会挡住系统（计划 1 Task 12）。
  w.on("session-end", () => {
    quitting = true;
  });
```

- `createTray()` 里 `const icon = nativeImage.createFromBitmap(...)` 那一行改成：

```ts
  const color: [number, number, number] = isMac ? [0, 0, 0] : [0xdf, 0x6f, 0x2f];
  const icon = nativeImage.createFromBitmap(circleBitmap(16, color), { width: 16, height: 16, scaleFactor: 1 });
  // 高分屏用 32×32 的 @2x 版本（计划 1 Task 12）。
  icon.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: circleBitmap(32, color) });
```

- `bootstrap()` 里 `powerMonitor.on("unlock-screen", ...)` 之后加：

```ts
  // macOS / Linux 关机：和 Windows 的 session-end 一样，不再拦着关窗口。
  powerMonitor.on("shutdown", () => {
    quitting = true;
    app.quit();
  });
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/util src/main/paths.test.ts hook src/main/hooks src/main/handoff src/main/claude src/main/memory`
Expected: PASS

- [ ] **Step 7: 全量检查、hook 重建并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm build:hook && pnpm exec electron out/main/index.js --smoke`
Expected: 全部通过；`build/hook/butler-hook` 重新生成；冒烟输出 `sqlite-ok 1`、`statecore-ok 1`、`pty-ok`。

```bash
git add src/main/app-id.ts src/main/util/fs-retry.ts src/main/util/fs-retry.test.ts src/main/paths.ts src/main/paths.test.ts hook/butler-hook.ts hook/butler-hook.test.ts src/main/hooks/installer.ts src/main/handoff/command.ts src/main/claude/project-mcp.ts src/main/memory/mcp-config.ts src/main/index.ts
git commit -m "fix: Windows notification identity, logoff and shutdown, rename retries, ~ in BUTLER_HOME, @2x tray icon"
```

---

### Task 5: `butler-hook` 的构建工具链与兜底

计划 1 Task 5 留下：`build:hook` 需要支持 `--build-sea` 的 Node（本机是 26.3.0），版本不对时报错很难懂；hook 进程没有 `uncaughtException` 兜底（“任何异常都以退出码 0 结束”是设计文档 4.3 的硬要求）；SEA 约 136 MiB。

**SEA 体积的裁定（Ruling P5-R2）**：保留 Node SEA。备选方案是用 Go / Rust 写一个小程序，或者让 hook 命令经 Butler 自己的 Electron（`ELECTRON_RUN_AS_NODE=1`）运行一个 JS 文件——前者给贡献者加一套工具链；后者要在 hook 命令里设置环境变量，而 Claude Code 在 macOS 和 Windows 上执行 hook 的 shell 不同（sh / Git Bash），写法没法统一，而且 Butler 被移动或卸载时 hook 会立刻失效。136 MiB 只占磁盘（安装包里压缩后约 50 MB），不影响运行。

**Files:**
- Create: `.node-version`
- Modify: `scripts/build-hook.mjs`
- Modify: `hook/entry.ts`
- Create: `hook/entry.test.ts`
- Modify: `package.json`（`engines`）

**Interfaces:**
- Consumes: `main()`（`hook/butler-hook.ts`）
- Produces: `.node-version` = `26.3.0`（CI 的 `setup-node` 读它）；`build:hook` 在 Node 不支持 `--build-sea` 时以清楚的错误退出；`hook/entry.ts` 在任何异常下都以 0 退出

- [ ] **Step 1: 写失败测试**

新建 `hook/entry.test.ts`（真的运行一次 hook 入口：用 esbuild 打包后的同一份代码，只是不做成 SEA）：

```ts
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../src/main/test-utils";

const root = fileURLToPath(new URL("../", import.meta.url));
let bundle = "";

beforeAll(async () => {
  bundle = join(tempDir(), "hook.cjs");
  await build({ entryPoints: [join(root, "hook", "entry.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: bundle, logLevel: "silent" });
}, 60_000);

describe("butler-hook entry (design 4.3: never block Claude Code)", () => {
  it("writes the envelope and exits 0", () => {
    const home = tempDir();
    const r = spawnSync(process.execPath, [bundle], { input: '{"hook_event_name":"Stop","session_id":"s1"}', env: { ...process.env, BUTLER_HOME: home }, timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(readdirSync(join(home, "inbox")).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("exits 0 even when the inbox cannot be written (Review Focus 5)", () => {
    const home = tempDir();
    mkdirSync(join(home, "inbox"));
    chmodSync(join(home, "inbox"), 0o500);
    try {
      const r = spawnSync(process.execPath, [bundle], { input: "{}", env: { ...process.env, BUTLER_HOME: home }, timeout: 10_000 });
      expect(r.status).toBe(0);
    } finally {
      chmodSync(join(home, "inbox"), 0o700);
    }
  });

  it("exits 0 when BUTLER_HOME points at a file", () => {
    const home = join(tempDir(), "not-a-dir");
    writeFileSync(home, "x");
    const r = spawnSync(process.execPath, [bundle], { input: "{}", env: { ...process.env, BUTLER_HOME: home }, timeout: 10_000 });
    expect(r.status).toBe(0);
  });
});

describe("build:hook toolchain check", () => {
  it("accepts the Node this repo pins and exits early with --check-only", () => {
    expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const r = spawnSync(process.execPath, ["scripts/build-hook.mjs", "--check-only"], { cwd: root, encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run hook/entry.test.ts`
Expected: FAIL——`.node-version` 不存在，构建脚本不认识 `--check-only`（会真的去构建）。前三条可能已经通过（`main()` 自己吞掉了异常），它们是兜底的回归测试。

（Node 不支持 `--build-sea` 时的报错没有自动测试：脚本必须用当前 Node 自己的 `--help` 判断，测试里换不掉 `process.execPath`。Step 4 用 `--check-only` 手动确认正常路径。）

- [ ] **Step 3: 实现**

新建 `.node-version`：

```
26.3.0
```

`scripts/build-hook.mjs` 整个替换为：

```js
// 把 hook 打成不依赖系统 Node 的单文件可执行程序（Node SEA）。需要支持 --build-sea 的 Node（见 .node-version）。
// 用法：node scripts/build-hook.mjs [--check-only]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const help = execFileSync(process.execPath, ["--help"], { encoding: "utf8" });
if (!help.includes("--build-sea")) {
  console.error(`build:hook 需要支持 --build-sea 的 Node（当前 ${process.version}）。请换成 .node-version 里写的版本，例如 nvm install && nvm use。`);
  process.exit(1);
}
if (process.argv.includes("--check-only")) process.exit(0);

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

`hook/entry.ts` 整个替换为：

```ts
import { main } from "./butler-hook";

// 设计文档 4.3：任何异常都以退出码 0 静默结束，绝不阻塞 Claude Code。
process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

void main().finally(() => process.exit(0));
```

`package.json` 里加（与 `"license"` 同级）：

```json
  "engines": {
    "node": ">=22.13"
  },
```

- [ ] **Step 4: 运行测试，确认通过；重建 hook**

Run: `pnpm exec vitest run hook && pnpm build:hook`
Expected: PASS；`built build/hook/butler-hook`。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add .node-version scripts/build-hook.mjs hook/entry.ts hook/entry.test.ts package.json
git commit -m "fix: check the hook toolchain up front and make the hook exit 0 on any error"
```

---

### Task 6: 渲染进程的 CSP

渲染进程只显示本地界面，从不联网（个人 API 在主进程的 gateway 里）。安装包里用严格的 CSP：脚本只能来自本地文件；xterm 会插入 `<style>`，样式允许内联；没有 `unsafe-eval`。开发模式下 Vite 的 React 热更新需要内联脚本和本机 websocket，由一个 Vite 小插件换成放宽的版本。主进程把渲染进程控制台里的 CSP 报错写进日志，E2E（任务 9）断言一条都没有。不用 `session.webRequest` 加响应头：`session` 在出口规则里只允许 gateway 使用。

**Files:**
- Create: `src/renderer/csp.ts`
- Test: `src/renderer/csp.test.ts`
- Modify: `src/renderer/index.html`
- Modify: `electron.vite.config.ts`、`tsconfig.node.json`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces: `PROD_CSP`、`DEV_CSP`、`CSP_PLACEHOLDER = "%BUTLER_CSP%"`、`applyCsp(html: string, dev: boolean): string`（`src/renderer/csp.ts`）；主进程日志行 `renderer CSP violation: ...`

- [ ] **Step 1: 写失败测试**

新建 `src/renderer/csp.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyCsp, CSP_PLACEHOLDER, DEV_CSP, PROD_CSP } from "./csp";

const directives = (csp: string): Record<string, string[]> =>
  Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

describe("renderer CSP (Review Focus 4)", () => {
  it("lets the packaged renderer load only its own files", () => {
    const d = directives(PROD_CSP);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(d["connect-src"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    // xterm 会插入 <style>。
    expect(d["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(PROD_CSP).not.toMatch(/https?:|ws:|unsafe-eval/);
  });

  it("relaxes only what Vite's dev server needs", () => {
    const d = directives(DEV_CSP);
    expect(d["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d["connect-src"]).toEqual(["'self'", "ws://localhost:*", "http://localhost:*"]);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(DEV_CSP).not.toMatch(/unsafe-eval/);
  });

  it("is filled into index.html exactly once", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    expect(html.split(CSP_PLACEHOLDER)).toHaveLength(2);
    expect(applyCsp(html, false)).toContain(`content="${PROD_CSP}"`);
    expect(applyCsp(html, true)).toContain(`content="${DEV_CSP}"`);
    expect(() => applyCsp("<html></html>", false)).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/renderer/csp.test.ts`
Expected: FAIL——`./csp` 不存在。

- [ ] **Step 3: 实现**

新建 `src/renderer/csp.ts`：

```ts
/**
 * 渲染进程的 Content-Security-Policy。界面只加载 app 自己的文件，从不联网（个人 API 在主进程的 gateway 里）。
 * xterm 会往页面里插 <style>，所以样式允许内联；脚本不允许内联，也没有 unsafe-eval。
 */
export const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** 开发模式：Vite 的 React 热更新要一段内联脚本和本机的 websocket。 */
export const DEV_CSP = PROD_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace(
  "connect-src 'self'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
);

export const CSP_PLACEHOLDER = "%BUTLER_CSP%";

/** 构建（或开发服务器）处理 index.html 时填入 CSP。占位符不存在就报错：宁可构建失败，也不能发出一个没有 CSP 的界面。 */
export function applyCsp(html: string, dev: boolean): string {
  if (!html.includes(CSP_PLACEHOLDER)) throw new Error(`index.html has no ${CSP_PLACEHOLDER} placeholder`);
  return html.replace(CSP_PLACEHOLDER, dev ? DEV_CSP : PROD_CSP);
}
```

`tsconfig.node.json` 的 `include` 里加 `"src/renderer/csp.ts", "src/renderer/csp.test.ts",`（它们在构建配置和主进程测试里用，不属于渲染进程的代码）。

`src/renderer/index.html` 里的注释行 `<!-- CSP 在计划 4 加：开发模式下 Vite 的 React 热更新需要内联脚本。 -->` 换成：

```html
    <meta http-equiv="Content-Security-Policy" content="%BUTLER_CSP%" />
```

`electron.vite.config.ts` 整个替换为：

```ts
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { applyCsp } from "./src/renderer/csp";

/** 把 index.html 里的 %BUTLER_CSP% 换成 CSP：开发服务器用放宽的版本，构建用严格的版本。 */
function csp(): Plugin {
  let dev = false;
  return {
    name: "butler-csp",
    configResolved(config) {
      dev = config.command === "serve";
    },
    transformIndexHtml: { order: "pre", handler: (html) => applyCsp(html, dev) },
  };
}

export default defineConfig({
  main: {
    build: { rollupOptions: { external: ["node-pty"] } },
  },
  preload: {},
  renderer: {
    plugins: [react(), csp()],
  },
});
```

`src/main/index.ts` 的 `createWindow()` 里 `w.webContents.setWindowOpenHandler(...)` 之后加：

```ts
  // CSP 拦下了什么就记一笔（任务 6）：界面某处空白时先看这里。
  w.webContents.on("console-message", (e) => {
    if (/Content Security Policy/i.test(e.message)) logger(`renderer CSP violation: ${e.message}`);
  });
```

（Electron 44 的 `console-message` 事件对象带 `message` 字段。`pnpm typecheck` 不认这个签名时，改用旧的位置参数写法 `(_e, _level, message) => ...`。）

- [ ] **Step 4: 运行测试，确认通过；构建后检查 CSP 真的写进去了**

Run: `pnpm exec vitest run src/renderer/csp.test.ts && pnpm build && grep -c "Content-Security-Policy" out/renderer/index.html && grep -c "%BUTLER_CSP%" out/renderer/index.html`
Expected: 测试 PASS；第一个 grep 输出 `1`，第二个输出 `0`（命令以退出码 1 结束是因为第二个 grep 没有匹配，属于预期）。

- [ ] **Step 5: 隔离启动，确认没有 CSP 报错**

```bash
set -u
T="$(mktemp -d)"
BUTLER_HOME="$T" CLAUDE_CONFIG_DIR="$T/claude" node -e '
const { spawn } = require("node:child_process");
const c = spawn(require("electron"), ["."], { env: process.env, stdio: "inherit" });
setTimeout(() => c.kill("SIGTERM"), 15000);
c.on("exit", (code, signal) => console.log("electron exited", code, signal));
'
grep -c "renderer CSP violation" "$T/logs/main.log" || echo "no CSP violations"
```

Expected: `electron exited`；`no CSP violations`（`grep -c` 输出 0 后打印这句）。有报错时按日志里被拦的资源修改 `PROD_CSP`，并在任务 9 的 E2E 里确认。

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/renderer/csp.ts src/renderer/csp.test.ts src/renderer/index.html electron.vite.config.ts tsconfig.node.json src/main/index.ts
git commit -m "feat: strict CSP for the packaged renderer, relaxed only for the Vite dev server; log violations"
```

---

### Task 7: 打包：不签名的 `.dmg` 和 NSIS `.exe`

设计文档 2.1 / 12 节：electron-builder 产出 `.dmg` 和 NSIS `.exe`，首版不做代码签名。几件必须在打包时处理的事：`butler-hook` 和记忆 MCP 的 bundle 放进 `resources`（主进程按 `process.resourcesPath` 找它们）；node-pty 是原生模块，要放在 asar 外面，`spawn-helper` 要有执行权限（pnpm 装的 prebuilds 里没有，计划 1 Task 1）；macOS arm64 上完全不签名的 app 无法启动，要做 ad-hoc 签名（不是开发者签名，Gatekeeper 照样会拦，README 写清楚怎么放行）；记忆 MCP 靠 `ELECTRON_RUN_AS_NODE`，不能打开 Electron 的 RunAsNode fuse 限制。不配置自动更新（Ruling P5-R4：没有签名时 macOS 的自动更新本来就不能用，`electron-updater` 也会成为 gateway 之外的联网代码）。

**Files:**
- Create: `electron-builder.yml`
- Create: `scripts/after-pack.cjs`
- Modify: `package.json`（`version`、`author`、scripts、devDependencies 加 `yaml`）
- Modify: `eslint.config.mjs`（`.cjs` 脚本的 CommonJS 环境）
- Test: `src/main/packaging.test.ts`

**Interfaces:**
- Consumes: `APP_ID`（任务 4）；`build/hook/butler-hook[.exe]`（`pnpm build:hook`）；`build/memory-mcp/statecore-mcp.cjs`（`pnpm build`）
- Produces: `pnpm dist`（`dist/` 下的 `Butler-1.0.0-arm64.dmg`、`Butler-1.0.0-arm64-mac.zip` 或 `Butler Setup 1.0.0.exe`）、`pnpm dist:dir`（只出目录，不打安装包）；安装好的 app 里 `resources/hook/`、`resources/memory-mcp/`、`resources/app.asar.unpacked/node_modules/node-pty/`

- [ ] **Step 1: 写失败测试**

```bash
pnpm add -D yaml@2.9.1 --save-exact
```

新建 `src/main/packaging.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_ID } from "./app-id";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (f: string) => readFileSync(`${root}${f}`, "utf8");

interface BuilderConfig {
  appId: string;
  productName: string;
  publish: unknown;
  afterPack: string;
  asarUnpack: string[];
  extraResources: { from: string; to: string; filter: string[] }[];
  electronFuses?: Record<string, boolean>;
  mac: { identity: unknown; target: { target: string; arch: string[] }[] };
  win: { target: { target: string; arch: string[] }[] };
}

describe("packaging config (design 2.1, 12)", () => {
  const cfg = parse(read("electron-builder.yml")) as BuilderConfig;
  const pkg = JSON.parse(read("package.json")) as { version: string; main: string; author: string; scripts: Record<string, string> };

  it("uses the same app id as the Windows notification identity", () => {
    expect(cfg.appId).toBe(APP_ID);
    expect(cfg.productName).toBe("Butler");
  });

  it("is unsigned, never publishes, and keeps RunAsNode available for the memory MCP", () => {
    expect(cfg.publish).toBeNull();
    expect(cfg.mac.identity).toBeNull();
    expect(cfg.afterPack).toBe("scripts/after-pack.cjs");
    expect(cfg.electronFuses?.runAsNode).not.toBe(false);
  });

  it("ships the hook, the memory MCP and an unpacked node-pty", () => {
    expect(cfg.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "build/hook", to: "hook" }),
        expect.objectContaining({ from: "build/memory-mcp", to: "memory-mcp", filter: ["statecore-mcp.cjs"] }),
      ]),
    );
    expect(cfg.asarUnpack).toContain("**/node_modules/node-pty/**");
  });

  it("builds a dmg and zip for Apple silicon and an NSIS installer for x64 Windows", () => {
    expect(cfg.mac.target).toEqual([{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }]);
    expect(cfg.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
  });

  it("has release metadata and scripts", () => {
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.main).toBe("out/main/index.js");
    expect(pkg.author).toBe("Yuchen Lin");
    expect(pkg.scripts.dist).toBe("electron-builder --publish never");
    expect(pkg.scripts["dist:dir"]).toBe("electron-builder --dir --publish never");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/packaging.test.ts`
Expected: FAIL——`electron-builder.yml` 不存在。

- [ ] **Step 3: 实现**

新建 `electron-builder.yml`：

```yaml
# 不签名的安装包（设计文档 2.1、12 节）。发布（推 tag、建 release）由用户完成：publish 关掉，也不配置自动更新。
appId: io.github.yul761.butler
productName: Butler
copyright: Copyright © 2026 Yuchen Lin
directories:
  output: dist
  # 图标等打包资源的目录（没有就用 Electron 默认图标）。不能用 build/：那里是 hook 和记忆 MCP 的构建产物。
  buildResources: build-resources
files:
  - out/**/*
  - package.json
# 原生模块不能在 asar 里执行。
asarUnpack:
  - "**/node_modules/node-pty/**"
extraResources:
  - from: build/hook
    to: hook
    filter:
      - butler-hook
      - butler-hook.exe
  - from: build/memory-mcp
    to: memory-mcp
    filter:
      - statecore-mcp.cjs
# spawn-helper 的执行位、macOS 的 ad-hoc 签名、resources 的完整性检查。
afterPack: scripts/after-pack.cjs
publish: null
# 不配置 electronFuses：记忆 MCP 靠 ELECTRON_RUN_AS_NODE 运行，RunAsNode 必须保持可用。
mac:
  target:
    - target: dmg
      arch: [arm64]
    - target: zip
      arch: [arm64]
  category: public.app-category.developer-tools
  # 不用开发者证书签名；after-pack.cjs 做 ad-hoc 签名（arm64 上完全不签名的 app 无法启动）。
  identity: null
  hardenedRuntime: false
  gatekeeperAssess: false
win:
  target:
    - target: nsis
      arch: [x64]
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
```

新建 `scripts/after-pack.cjs`：

```js
// electron-builder 的 afterPack（计划 5 任务 7），在生成 dmg / 安装程序之前执行：
// 1. 检查 hook 和记忆 MCP 都放进了 resources、node-pty 在 asar 外面；
// 2. macOS：node-pty 的 spawn-helper 和 butler-hook 要有执行位（pnpm 装的 prebuilds 里 spawn-helper 没有，计划 1 Task 1）；
// 3. macOS：ad-hoc 签名整个 app——electron-builder 改过 Info.plist，原来的签名失效，arm64 上没有签名的 app 无法启动。
const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

function findAll(dir, name, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) findAll(p, name, out);
    else if (entry === name) out.push(p);
  }
  return out;
}

exports.default = async function afterPack(context) {
  const mac = context.electronPlatformName === "darwin";
  const appPath = mac ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`) : context.appOutDir;
  const resources = mac ? join(appPath, "Contents", "Resources") : join(appPath, "resources");
  const hook = join(resources, "hook", mac ? "butler-hook" : "butler-hook.exe");
  for (const f of [hook, join(resources, "memory-mcp", "statecore-mcp.cjs")]) {
    if (!existsSync(f)) throw new Error(`missing ${f}: run pnpm build && pnpm build:hook before packaging`);
  }
  const pty = join(resources, "app.asar.unpacked", "node_modules", "node-pty");
  if (!existsSync(pty)) throw new Error(`node-pty is not unpacked at ${pty}`);
  if (!mac) return;
  const helpers = findAll(pty, "spawn-helper");
  if (helpers.length === 0) throw new Error("no spawn-helper found in node-pty");
  for (const h of helpers) chmodSync(h, 0o755);
  chmodSync(hook, 0o755);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
```

`package.json`：
- `"version": "0.1.0"` 改成 `"version": "1.0.0"`
- 在 `"description"` 之后加 `"author": "Yuchen Lin",`
- `scripts` 里加 `"dist": "electron-builder --publish never",` 和 `"dist:dir": "electron-builder --dir --publish never",`

`eslint.config.mjs` 的 `tseslint.config(...)` 里，`scripts/**/*.mjs` 那一块之后加：

```js
  // CommonJS 的脚本（electron-builder 的 afterPack、E2E 的假 claude）：Node 的全局变量，允许 require。
  {
    files: ["scripts/**/*.cjs", "e2e/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", exports: "writable", process: "readonly", console: "readonly", __dirname: "readonly", Buffer: "readonly", setTimeout: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/packaging.test.ts && pnpm lint`
Expected: PASS

- [ ] **Step 5: 实验：本机打出目录版并实测（spike）**

在**一次** Bash 调用里执行（只读写 `dist/` 和临时目录）：

```bash
set -eu
pnpm build && pnpm build:hook && pnpm dist:dir
APP="$(ls -d dist/mac-arm64/Butler.app)"
R="$APP/Contents/Resources"
ls -la "$R/hook/butler-hook" "$R/memory-mcp/statecore-mcp.cjs"
find "$R/app.asar.unpacked/node_modules/node-pty" -name spawn-helper -exec ls -la {} \;
codesign -dv "$APP" 2>&1 | grep -E "Signature|Identifier"
"$APP/Contents/MacOS/Butler" --smoke
# 记忆 MCP 用安装包里的 Butler 当 Node 运行（RunAsNode 没被关掉）。
D="$(mktemp -d)"
( printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"pkg","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"remember","arguments":{"text":"pkg"}}}'; sleep 3 ) \
| ELECTRON_RUN_AS_NODE=1 STATECORE_SCOPE=ticket:PKG-1 "$APP/Contents/MacOS/Butler" "$R/memory-mcp/statecore-mcp.cjs" --data "$D" 2>/dev/null | grep -c '"ok": true'
# 隔离启动安装包本身。
T="$(mktemp -d)"
BUTLER_HOME="$T" CLAUDE_CONFIG_DIR="$T/claude" "$APP/Contents/MacOS/Butler" & PID=$!
sleep 15; kill "$PID"; wait "$PID" 2>/dev/null || true
grep -E "uncaughtException|unhandledRejection|renderer CSP violation|memory MCP bundle missing" "$T/logs/main.log" || echo "no errors logged"
```

Expected：
- `butler-hook` 和 `statecore-mcp.cjs` 都在；每个 `spawn-helper` 都是 `-rwxr-xr-x`。
- `codesign -dv` 显示 `Signature=adhoc`。
- 冒烟输出 `sqlite-ok 1`、`statecore-ok 1`、`pty-ok`（安装包里的 node-pty、node:sqlite、statecore-mcp/lib 都能用）。
- 记忆 MCP 那一行打印 `1`。
- `no errors logged`。

**备选**：
- electron-builder 在 pnpm 的 isolated 布局下漏装依赖（冒烟报 `Cannot find module`）：加 `.npmrc`，内容 `node-linker=hoisted`，`rm -rf node_modules && pnpm install` 后重试，并把 `.npmrc` 一起提交。
- `codesign` 报错或 app 打不开（`killed: 9`）：确认 after-pack 的签名在 electron-builder 改完 Info.plist 之后执行（`afterPack` 就是这个时机）；仍不行就改成 `afterSign` 钩子再签一次。
- 记忆 MCP 那一行是 `0`：说明 RunAsNode 被关掉了，检查 `electron-builder.yml` 里没有 `electronFuses`。

- [ ] **Step 6: 打出安装包**

Run: `pnpm dist && ls -la dist/*.dmg dist/*.zip`
Expected: `Butler-1.0.0-arm64.dmg` 和 `Butler-1.0.0-arm64-mac.zip`。（Windows 安装包只能在 Windows 上打，由任务 10 的 CI 负责。）

- [ ] **Step 7: Commit**

```bash
git add electron-builder.yml scripts/after-pack.cjs package.json pnpm-lock.yaml eslint.config.mjs src/main/packaging.test.ts
git commit -m "feat: unsigned dmg, zip and NSIS packaging with hook and memory MCP in resources"
```

---

### Task 8: E2E 的地基：假 claude、Playwright for Electron、首次启动向导

设计文档 11 节：Playwright for Electron，macOS + Windows。计划 1 Ruling R2 把 IPC、preload 和 React 组件的覆盖留给了这里。本任务搭好地基并先跑通一条最短的路：全新的 `BUTLER_HOME` → 首次启动向导 → 填假 claude 的路径 → 安装 hook（写进临时的 `CLAUDE_CONFIG_DIR`）→ 进入简报页。

假 claude 只实现 Butler 用到的部分：`--version` / `--help`（列出 `REQUIRED_FLAGS`）；交互模式（在 PTY 里）：打印就绪行和挂载的 MCP server 名，读一行输入就写 transcript、按 `CLAUDE_CONFIG_DIR/settings.json` 执行 hook（macOS 用 `/bin/sh -c`，Windows 用 Git Bash，和 Claude Code 一样）；`-p`：按 `--json-schema` 回一个预设的 handoff 或刷新结果。Windows 上它被包成 npm 格式的 `claude.cmd`，顺带走一遍任务 3 的 shim 解析。

**Files:**
- Create: `e2e/fake-claude/fake-claude.cjs`
- Create: `e2e/fixtures.ts`
- Create: `e2e/wizard.spec.ts`
- Create: `playwright.config.ts`
- Modify: `package.json`（devDependencies 加 `@playwright/test`，scripts 加 `e2e`）、`pnpm-lock.yaml`
- Modify: `tsconfig.node.json`（include 加 `e2e/**/*`、`playwright.config.ts`）
- Modify: `.gitignore`（加 `test-results/`）

**Interfaces:**
- Consumes: 计划 4 的向导（`data-testid="wizard"`、`S.generalPlaceholders.claudePath`、`S.wizardNext`、`S.installHooks`、`S.wizardFinish`）；`S`（`src/renderer/src/strings.ts`）；`REQUIRED_FLAGS`（`src/main/claude/capabilities.ts`，假 claude 的 `--help` 必须列全）
- Produces:
  - `e2e/fixtures.ts`：`ROOT`、`interface Sandbox { dir: string; butlerHome: string; claudeConfigDir: string; claudePath: string; repo: string; fakeLog: string }`、`makeSandbox(): Sandbox`、`launch(s: Sandbox): Promise<{ app: ElectronApplication; page: Page; console: string[] }>`、`completeWizard(page: Page, s: Sandbox): Promise<void>`、`terminalText(page: Page): Promise<string>`
  - `pnpm e2e`（`playwright test`；需要先 `pnpm build` 和 `pnpm build:hook`）

- [ ] **Step 1: 安装 Playwright，写假 claude**

```bash
pnpm add -D @playwright/test@1.64.0 --save-exact
```

（只用 `_electron`，不需要 `playwright install` 下载浏览器。）

新建 `e2e/fake-claude/fake-claude.cjs`：

```js
#!/usr/bin/env node
// E2E 用的假 claude（计划 5 任务 8）。只实现 Butler 用到的部分，绝不联网：
//   --version / --help（列出 Butler 检查的全部参数）；
//   交互模式（在 PTY 里）：打印就绪行和挂载的 MCP server 名；每读到一行输入就写 transcript、
//     按 CLAUDE_CONFIG_DIR/settings.json 执行 hook（macOS 用 /bin/sh，Windows 用 Git Bash，和 Claude Code 一样）；
//   -p：从 stdin 读 prompt，按 --json-schema 回预设的 handoff 或刷新结果；stream-json 的 MCP 探测只回 init。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const log = (line) => {
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${new Date().toISOString()} ${line}\n`);
};

const FLAGS = [
  "--print", "--session-id", "--resume", "--fork-session", "--mcp-config", "--output-format", "--json-schema",
  "--allowedTools", "--disallowedTools", "--no-session-persistence", "--permission-mode", "--setting-sources",
];
const PR = { number: 7, url: "https://example.invalid/pull/7", state: "merged", review: "approved" };
const HANDOFF = {
  ticket: "",
  status: "merged_pending_followup",
  done_today: ["接口写完"],
  next_steps: ["上线后改 staging 配置"],
  blockers: [],
  pr: PR,
  jira: null,
  followups: [{ id: null, kind: "config", description: "改 staging 配置", trigger: "after_merge", due_date: null, done: false }],
  decisions: [{ key: "db", statement: "用 PostgreSQL" }],
  learnings: ["假 claude 的经验"],
  open_questions: [],
};
const REFRESH = { status: "merged_pending_followup", pr: PR, jira: null };

/** 和 Claude Code 一样执行 settings.json 里这个事件的 command hook：stdin 是 JSON，超时 15 秒。 */
function runHooks(event, payload) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return;
  }
  const groups = (settings.hooks && settings.hooks[event]) || [];
  const shell = process.platform === "win32" ? process.env.CLAUDE_CODE_GIT_BASH_PATH || "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/sh";
  for (const group of groups) {
    for (const h of group.hooks || []) {
      if (h.type !== "command") continue;
      const r = spawnSync(shell, ["-c", h.command], { input: JSON.stringify({ ...payload, hook_event_name: event }), env: process.env, timeout: 15_000, windowsHide: true });
      log(`hook ${event} exit=${r.status}${r.error ? ` error=${r.error.message}` : ""}`);
    }
  }
}

function headless() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    log(`headless ${args.filter((a) => !a.startsWith("{")).join(" ")} prompt=${input.length}`);
    if (flag("--output-format") === "stream-json") {
      process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "probe", mcp_servers: [], tools: [] })}\n`);
      return;
    }
    let schema = {};
    try {
      schema = JSON.parse(flag("--json-schema") || "{}");
    } catch {
      // 按 handoff 处理。
    }
    const structured = schema.properties && schema.properties.followups ? HANDOFF : REFRESH;
    const result = { type: "result", subtype: "success", is_error: false, session_id: `fork-${Date.now()}`, result: JSON.stringify(structured), structured_output: structured, permission_denials: [], total_cost_usd: 0 };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });
}

function interactive() {
  const sessionId = flag("--session-id") || flag("--resume") || "unknown";
  const cwd = process.cwd();
  const transcript = path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
  const out = (s) => process.stdout.write(s.replace(/\n/g, "\r\n"));
  const append = (entry) => {
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.appendFileSync(transcript, `${JSON.stringify({ ...entry, sessionId, cwd, timestamp: new Date().toISOString() })}\n`);
  };
  const mcp = flag("--mcp-config");
  let servers = [];
  if (mcp) {
    try {
      servers = Object.keys(JSON.parse(fs.readFileSync(mcp, "utf8")).mcpServers || {});
    } catch (e) {
      servers = [`unreadable ${mcp}: ${e.message}`];
    }
  }
  log(`interactive ${has("--resume") ? "resume" : "new"} ${sessionId} mcp=${servers.join(",")}`);
  runHooks("SessionStart", { session_id: sessionId, cwd, source: has("--resume") ? "resume" : "startup", transcript_path: transcript });
  out(`fake claude ready (${sessionId.slice(0, 8)})\n`);
  if (mcp) out(`mcp: ${servers.join(", ")}\n`);
  out("> ");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) {
      out("> ");
      return;
    }
    if (line === "exit") {
      runHooks("SessionEnd", { session_id: sessionId, cwd, reason: "exit", transcript_path: transcript });
      process.exit(0);
    }
    append({ type: "user", message: { role: "user", content: line } });
    runHooks("UserPromptSubmit", { session_id: sessionId, cwd, prompt: line, transcript_path: transcript });
    const reply = `收到：${line}`;
    append({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
    out(`${reply}\n`);
    runHooks("Stop", { session_id: sessionId, cwd, stop_hook_active: false, transcript_path: transcript });
    out("> ");
  });
  rl.on("close", () => process.exit(0));
}

if (has("--version")) {
  process.stdout.write("2.1.306 (Claude Code)\n");
} else if (has("--help")) {
  process.stdout.write(`Usage: claude [options] [prompt]\n\nOptions:\n${FLAGS.map((f) => `  ${f} <value>  (fake)`).join("\n")}\n`);
} else if (has("-p") || has("--print")) {
  headless();
} else {
  interactive();
}
```

- [ ] **Step 2: 夹具、配置和第一条 E2E**

新建 `e2e/fixtures.ts`：

```ts
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { S } from "../src/renderer/src/strings";

export const ROOT = resolve(__dirname, "..");

export interface Sandbox {
  dir: string;
  /** 故意带空格（Review Focus 1）：--mcp-config 路径和 hook 路径都会有空格。 */
  butlerHome: string;
  claudeConfigDir: string;
  claudePath: string;
  repo: string;
  /** 假 claude 的运行记录（CI 失败时上传）。 */
  fakeLog: string;
}

/** Windows 上用 npm 的 cmd-shim 格式包装假 claude，走一遍任务 3 的 shim 解析。 */
const NPM_STYLE_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\fake-claude.cjs" %*',
  "",
].join("\r\n");

/** 每个测试一套全新的临时目录：BUTLER_HOME、CLAUDE_CONFIG_DIR、假 claude、带一个提交的 git 仓库。 */
export function makeSandbox(): Sandbox {
  for (const f of ["out/main/index.js", "build/memory-mcp/statecore-mcp.cjs", process.platform === "win32" ? "build/hook/butler-hook.exe" : "build/hook/butler-hook"]) {
    if (!existsSync(join(ROOT, f))) throw new Error(`${f} is missing: run pnpm build && pnpm build:hook before pnpm e2e`);
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "butler-e2e-")));
  const butlerHome = join(dir, "Butler Home");
  const claudeConfigDir = join(dir, "claude-config");
  const bin = join(dir, "bin");
  mkdirSync(claudeConfigDir, { recursive: true });
  mkdirSync(bin);
  copyFileSync(join(ROOT, "e2e", "fake-claude", "fake-claude.cjs"), join(bin, "fake-claude.cjs"));
  let claudePath: string;
  if (process.platform === "win32") {
    claudePath = join(bin, "claude.cmd");
    writeFileSync(claudePath, NPM_STYLE_SHIM);
  } else {
    claudePath = join(bin, "claude");
    // 写死这次运行用的 node：GUI 进程读到的登录 shell PATH 里不一定有它。
    writeFileSync(claudePath, `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-claude.cjs")}" "$@"\n`);
    chmodSync(claudePath, 0o755);
  }
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "e2e\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { dir, butlerHome, claudeConfigDir, claudePath, repo, fakeLog: join(dir, "fake-claude.log") };
}

/** 启动 Butler（`electron .`，和 pnpm start 一样），收集渲染进程的控制台输出。 */
export async function launch(s: Sandbox): Promise<{ app: ElectronApplication; page: Page; console: string[] }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // 在 Claude Code 里跑测试时，去掉外层会话的标记变量。
    if (v === undefined || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "ELECTRON_RUN_AS_NODE") continue;
    env[k] = v;
  }
  env.BUTLER_HOME = s.butlerHome;
  env.CLAUDE_CONFIG_DIR = s.claudeConfigDir;
  env.FAKE_CLAUDE_LOG = s.fakeLog;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  const page = await app.firstWindow();
  const messages: string[] = [];
  page.on("console", (m) => messages.push(m.text()));
  return { app, page, console: messages };
}

/** 走完首次启动向导：填假 claude 的路径、安装 hook、其余步骤跳过。 */
export async function completeWizard(page: Page, s: Sandbox): Promise<void> {
  await expect(page.getByTestId("wizard")).toBeVisible();
  await page.getByPlaceholder(S.generalPlaceholders.claudePath).fill(s.claudePath);
  await page.getByRole("button", { name: S.save, exact: true }).click();
  const next = page.getByRole("button", { name: S.wizardNext });
  await expect(next).toBeEnabled();
  await next.click();
  await page.getByRole("button", { name: S.installHooks }).click();
  await expect(page.getByText(S.hookStatus.installed).first()).toBeVisible();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: S.wizardNext }).click();
  await page.getByRole("button", { name: S.wizardFinish }).click();
  await expect(page.getByTestId("wizard")).toHaveCount(0);
}

/** 当前显示的终端里的文字（xterm 的 DOM 渲染器）。 */
export async function terminalText(page: Page): Promise<string> {
  return page.locator(".terminal-wrap:visible .xterm-rows").innerText();
}
```

新建 `e2e/wizard.spec.ts`：

```ts
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, launch, makeSandbox } from "./fixtures";

test("first run: the wizard finds claude, installs hooks into the given config dir and lands on the brief", async () => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  try {
    await completeWizard(page, s);
    await expect(page.getByRole("button", { name: S.regenerate })).toBeVisible();
    const settings = readFileSync(join(s.claudeConfigDir, "settings.json"), "utf8");
    expect(settings).toContain("butler-hook");
    expect(readFileSync(join(s.claudeConfigDir, "commands", "handoff.md"), "utf8")).toContain("butler-handoff");
  } finally {
    await app.close();
  }
});

test("the wizard does not let the user continue without a working claude", async () => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  try {
    await expect(page.getByTestId("wizard")).toBeVisible();
    await page.getByPlaceholder(S.generalPlaceholders.claudePath).fill(join(s.dir, "no-such-claude"));
    await page.getByRole("button", { name: S.save, exact: true }).click();
    await expect(page.getByText(S.wizardClaudeMissing)).toBeVisible();
    await expect(page.getByRole("button", { name: S.wizardNext })).toBeDisabled();
    // 可以跳过整个向导。
    await page.getByRole("button", { name: S.wizardSkip }).click();
    await expect(page.getByTestId("wizard")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
```

新建 `playwright.config.ts`：

```ts
import { defineConfig } from "@playwright/test";

/** E2E（设计文档 11 节）：Playwright for Electron，一个 worker，测试之间不共享任何目录。 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "test-results/e2e",
  use: { trace: "retain-on-failure" },
});
```

`package.json` 的 scripts 加 `"e2e": "playwright test",`；`tsconfig.node.json` 的 `include` 加 `"e2e/**/*", "playwright.config.ts"`；`.gitignore` 加一行 `test-results/`。

- [ ] **Step 3: 实验：Playwright 能不能驱动 Electron 44（spike）**

Run: `pnpm build && pnpm build:hook && pnpm e2e e2e/wizard.spec.ts`
Expected: 2 passed。

**备选**：`_electron.launch` 连不上 Electron 44（超时在 `firstWindow`、或报协议错误）：改成自己用 `child_process.spawn` 以 `--remote-debugging-port=0` 启动 Electron，从 stderr 读出 `DevTools listening on ws://...`，再用 `chromium.connectOverCDP(wsUrl)` 拿到页面；`launch()` 的返回值改成 `{ close(), page, console }`，两个 spec 的用法不变。把实际走的路线记进遗留清单（任务 12）。

- [ ] **Step 4: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过（vitest 不会收 `e2e/*.spec.ts`）。

```bash
git add e2e playwright.config.ts package.json pnpm-lock.yaml tsconfig.node.json .gitignore
git commit -m "test: Playwright for Electron with a fake claude; first-run wizard end to end"
```

---

### Task 9: 主流程 E2E：新建 ticket → session → hook → handoff → 记忆 → 早间简报 → 打开

设计文档 11 节的 E2E 路线，外加计划 4 的记忆标签和本计划的 CSP。全部经过真实的 Electron 主进程、preload 白名单、React 界面、node-pty、`butler-hook`（SEA，经 shell 执行）、HookInbox、HandoffRunner、StateCore 和简报引擎；只有 claude 是假的。

**Files:**
- Create: `e2e/main-flow.spec.ts`

**Interfaces:**
- Consumes: `makeSandbox`、`launch`、`completeWizard`、`terminalText`（任务 8）；`S`；`.brief-item`、`.sidebar .ticket .badge`、`.terminal-wrap`（现有的 class）

- [ ] **Step 1: 写测试**

新建 `e2e/main-flow.spec.ts`：

```ts
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { S } from "../src/renderer/src/strings";
import { completeWizard, launch, makeSandbox, terminalText } from "./fixtures";

test("new ticket → session → hook → handoff → memory → morning brief → open with prefill", async () => {
  const s = makeSandbox();
  const { app, page, console: messages } = await launch(s);
  try {
    await completeWizard(page, s);

    // 1. 新建 ticket（worktree 模式）。
    await page.getByRole("button", { name: `+ ${S.newTicket}` }).click();
    await page.getByLabel(S.ticketKey).fill("E2E-1");
    await page.getByLabel(S.repo).fill(s.repo);
    await page.getByRole("button", { name: S.create }).click();
    await expect(page.getByRole("heading", { name: /E2E-1/ })).toBeVisible();

    // 2. 新 session：假 claude 在 PTY 里启动，--mcp-config 带着两个记忆 server（路径里有空格，Review Focus 1）。
    await page.getByRole("button", { name: `+ ${S.newSession}` }).click();
    await expect.poll(() => terminalText(page)).toContain("fake claude ready");
    await expect.poll(() => terminalText(page)).toContain("mcp: butler-memory, butler-workspace");

    // 3. 输入一句话：UserPromptSubmit / Stop hook 经 shell 执行 butler-hook → inbox → 侧栏“等你输入”。
    await page.locator(".terminal-wrap:visible .xterm").click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Enter");
    await expect.poll(() => terminalText(page)).toContain("收到：hello");
    await expect(page.locator(".sidebar .ticket .badge")).toBeVisible();

    // 4. 立即 handoff（假 claude 的 -p 模式）：合并后任务入库，状态变成“已合并·待收尾”。
    await page.getByRole("button", { name: S.runHandoff }).click();
    await page.getByRole("button", { name: S.followupsTab(1) }).click();
    await expect(page.getByText("改 staging 配置", { exact: true })).toBeVisible();

    // 5. 记忆标签：决策和 follow-up 已经写进 StateCore，交接也在。
    await page.getByRole("button", { name: S.memoryTab, exact: true }).click();
    await expect(page.getByText("用 PostgreSQL")).toBeVisible();
    await expect(page.getByText("改 staging 配置（配置，合并后）")).toBeVisible();
    await expect(page.getByText(S.memoryHandoff)).toBeVisible();

    // 6. 早间简报：“先做”里有这条合并后任务；点“打开”回到同一个终端并预填提示（不回车）。
    await page.getByRole("button", { name: S.home }).click();
    await page.getByRole("button", { name: S.regenerate }).click();
    const item = page.locator(".brief-item", { hasText: "合并后任务：改 staging 配置" });
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: S.itemActions.open }).click();
    await expect.poll(() => terminalText(page)).toContain("继续 follow-up：改 staging 配置");

    // 7. CSP 没有拦下任何东西（Review Focus 4）。
    expect(messages.filter((m) => /Content Security Policy/i.test(m))).toEqual([]);
  } catch (e) {
    // 失败时把假 claude 的记录和 Butler 的日志打出来，CI 里直接能看。
    for (const f of [s.fakeLog, `${s.butlerHome}/logs/main.log`]) {
      try {
        console.log(`--- ${f}\n${readFileSync(f, "utf8")}`);
      } catch {
        // 文件不存在。
      }
    }
    throw e;
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: 运行**

Run: `pnpm build && pnpm build:hook && pnpm e2e`
Expected: 3 passed（任务 8 的两条和这一条）。

失败时按打印出来的日志排查（superpowers:systematic-debugging），常见原因和处理：
- 第 3 步没有出现“等你输入”：看 `fake-claude.log` 里 `hook Stop exit=` 的退出码；非 0 说明 hook 命令在这个 shell 里跑不起来——这正是 Review Focus 5 要抓的问题，修 `hookCommand()`，不要改测试。
- 第 2 步没有 `mcp:` 那一行：看 `main.log` 里 `memory MCP` 开头的行（bundle 缺失或路径不能安全传递）。
- 第 6 步找不到条目：确认 ticket 状态是“已合并·待收尾”（handoff 的 payload 状态就是它），以及 `.brief-item` 的文字格式没变。

- [ ] **Step 3: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add e2e/main-flow.spec.ts
git commit -m "test: end-to-end main flow from new ticket to opening a brief item, with hooks, memory and CSP"
```

---

### Task 10: GitHub Actions：macOS + Windows 的检查、E2E 与打包（只写不推）

设计文档 1.3 / 11 节：两个平台功能一致，CI 双平台测试；ESLint 出口规则在 CI 中强制执行。`ci.yml` 在 push 到 main 和 pull request 时跑：安装、typecheck、lint、单元测试、构建、构建 hook、E2E，失败时上传 E2E 的记录；push 到 main 时再打出不签名的安装包作为 workflow 产物。`release.yml` 在推 `v*` tag（或手动触发）时构建两个平台的安装包，并建一个 **draft** release（不会自动公开）。按 R3，本任务只在本地写好、校验，不推送。仓库加 `.gitattributes` 统一 LF：Windows 的 checkout 默认会把文本文件换成 CRLF，读取固定文件内容的测试会因此失败。

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `.gitattributes`
- Test: `src/main/workflows.test.ts`

**Interfaces:**
- Consumes: `.node-version`（任务 5）；`pnpm e2e`（任务 8）；`pnpm dist`（任务 7）；`yaml`（任务 7 装的开发依赖）
- Produces: 两个工作流文件；`src/main/workflows.test.ts` 的结构检查

- [ ] **Step 1: 写失败测试**

新建 `src/main/workflows.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (f: string) => readFileSync(`${root}${f}`, "utf8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  if?: string;
}
interface Job {
  "runs-on": string;
  needs?: string | string[];
  if?: string;
  strategy?: { "fail-fast"?: boolean; matrix: { os: string[] } };
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const runs = (job: Job) => job.steps.map((s) => s.run ?? "").filter(Boolean);

describe("CI workflows (design 1.3, 11)", () => {
  const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
  const release = parse(read(".github/workflows/release.yml")) as Workflow;

  it("tests on macOS and Windows with every check, the E2E suite included", () => {
    const test = ci.jobs.test;
    expect(test.strategy?.matrix.os).toEqual(["macos-14", "windows-latest"]);
    expect(test.strategy?.["fail-fast"]).toBe(false);
    for (const cmd of ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build", "pnpm build:hook", "pnpm e2e"]) {
      expect(runs(test), cmd).toContain(cmd);
    }
    expect(test.steps.some((s) => s.uses?.startsWith("actions/setup-node@") && s.with?.["node-version-file"] === ".node-version")).toBe(true);
  });

  it("builds unsigned installers on both platforms and only drafts a release", () => {
    expect(release.jobs.build.strategy?.matrix.os).toEqual(["macos-14", "windows-latest"]);
    expect(runs(release.jobs.build)).toContain("pnpm dist");
    const publish = runs(release.jobs.release).join("\n");
    expect(publish).toContain("gh release create");
    expect(publish).toContain("--draft");
  });

  it("never pushes code or publishes packages, and asks for the least permissions", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(release.permissions).toEqual({ contents: "write" });
    for (const text of [read(".github/workflows/ci.yml"), read(".github/workflows/release.yml")]) {
      expect(text).not.toMatch(/git push|npm publish|pnpm publish|secrets\.(?!GITHUB_TOKEN)/);
    }
  });

  it("keeps LF line endings on Windows checkouts", () => {
    expect(read(".gitattributes")).toContain("* text=auto eol=lf");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/workflows.test.ts`
Expected: FAIL——文件不存在。

- [ ] **Step 3: 实现**

新建 `.gitattributes`：

```
* text=auto eol=lf
*.cmd text eol=crlf
*.bat text eol=crlf
*.png binary
*.ico binary
*.icns binary
```

新建 `.github/workflows/ci.yml`：

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-14, windows-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: pnpm
      - name: Install (rebuilds node-pty for Electron)
        run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - name: Lint (includes the egress rules, design 7.1)
        run: pnpm lint
      - name: Unit and integration tests (includes the privacy invariant, a release blocker)
        run: pnpm test
      - run: pnpm build
      - name: Build butler-hook (Node SEA for this platform)
        run: pnpm build:hook
      - name: End-to-end tests with a fake claude
        run: pnpm e2e
      - name: Upload E2E traces
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-${{ matrix.os }}
          path: test-results/
          retention-days: 7

  package:
    needs: test
    if: github.event_name == 'push'
    strategy:
      fail-fast: false
      matrix:
        os: [macos-14, windows-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm build:hook
      - name: Unsigned installers (design 12)
        run: pnpm dist
      - uses: actions/upload-artifact@v4
        with:
          name: butler-${{ matrix.os }}
          path: |
            dist/*.dmg
            dist/*.zip
            dist/*.exe
          retention-days: 14
```

新建 `.github/workflows/release.yml`：

```yaml
name: Release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    strategy:
      fail-fast: true
      matrix:
        os: [macos-14, windows-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build
      - run: pnpm build:hook
      - name: Unsigned installers (design 12)
        run: pnpm dist
      - uses: actions/upload-artifact@v4
        with:
          name: butler-${{ matrix.os }}
          path: |
            dist/*.dmg
            dist/*.zip
            dist/*.exe

  release:
    needs: build
    if: startsWith(github.ref, 'refs/tags/')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: artifacts
          merge-multiple: true
      - name: Draft release (the maintainer reviews and publishes it by hand)
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" artifacts/* --repo "$GITHUB_REPOSITORY" --draft --title "Butler $GITHUB_REF_NAME" --notes "Unsigned build. See the README for how to open it on macOS (Gatekeeper) and Windows (SmartScreen)."
```

- [ ] **Step 4: 运行测试，确认通过；本地校验工作流**

Run: `pnpm exec vitest run src/main/workflows.test.ts`
Expected: PASS

Run: `if command -v actionlint >/dev/null; then actionlint .github/workflows/*.yml && echo "actionlint ok"; else echo "actionlint not installed: structure test only"; fi`
Expected: `actionlint ok`，或者 `actionlint not installed: structure test only`（本机没有 actionlint 时；不要为此安装全局工具，在遗留清单里记一笔，用户推送前可以自己跑）。

- [ ] **Step 5: 确认 `.gitattributes` 不会改动已提交的文件**

Run: `git add --renormalize . && git status --short`
Expected: 只有本任务新增的文件（仓库原本就是 LF）。如果出现大量已有文件被改动，说明有文件是 CRLF：`git diff --cached --stat` 看清楚是哪些，确认只是换行符后一并提交。

- [ ] **Step 6: 全量检查并提交（不推送）**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml .gitattributes src/main/workflows.test.ts
git commit -m "ci: macOS and Windows checks with E2E and unsigned packaging; draft releases on tags"
```

---

### Task 11: 开源文档：README、LICENSE、CONTRIBUTING、接入指南

设计文档 12 节：MIT；可配置项（tracker MCP 工具名、prompt 模板、ticket 号正则、分支名模板、调度、隐私档位与词表、LLM 服务商）；首版不签名，README 说明如何绕过 Gatekeeper 和 SmartScreen。8.5 节：README 提醒不要另装 StateCore 的捕获插件。文档用英文写（面向开源用户），界面上的中文标签原样引用并附英文说明。一个小测试保证接入指南覆盖了设置页的每一个可编辑项，免得以后加了设置忘了写文档。

**Files:**
- Create: `README.md`、`LICENSE`、`CONTRIBUTING.md`、`docs/configuration.md`
- Test: `src/main/docs.test.ts`

**Interfaces:**
- Consumes: `EDITABLE_SETTINGS`（`src/shared/settings.ts`，计划 4 补全后的列表）

- [ ] **Step 1: 写失败测试**

新建 `src/main/docs.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EDITABLE_SETTINGS } from "../shared/settings";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (f: string) => readFileSync(`${root}${f}`, "utf8");

describe("open-source docs (design 12)", () => {
  it("documents every setting a user can change", () => {
    const doc = read("docs/configuration.md");
    for (const key of EDITABLE_SETTINGS) expect(doc, key).toContain(`\`${key}\``);
  });

  it("explains how to open the unsigned build and what not to install alongside", () => {
    const readme = read("README.md");
    for (const s of ["Gatekeeper", "SmartScreen", "xattr -dr com.apple.quarantine", "~/.butler", "StateCore", "docs/configuration.md", "CONTRIBUTING.md"]) {
      expect(readme, s).toContain(s);
    }
  });

  it("is MIT licensed", () => {
    const license = read("LICENSE");
    expect(license.startsWith("MIT License")).toBe(true);
    expect(license).toContain("Copyright (c) 2026 Yuchen Lin");
  });

  it("tells contributors which toolchain to install", () => {
    const c = read("CONTRIBUTING.md");
    for (const s of [".node-version", "pnpm", "Xcode Command Line Tools", "Desktop development with C++", "Git Bash", "pnpm e2e", "PrivacyGateway"]) expect(c, s).toContain(s);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/docs.test.ts`
Expected: FAIL——文件不存在。

- [ ] **Step 3: 写文档**

新建 `LICENSE`：

```
MIT License

Copyright (c) 2026 Yuchen Lin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

新建 `README.md`：

````markdown
# Butler

A desktop "work butler" for people who run several [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions at once, one per ticket.
macOS and Windows. MIT licensed. Everything stays on your machine.

> 中文简介：Butler 用一个桌面应用管理“每个 ticket 一个 Claude Code session”的工作方式：每晚自动为有进展的 ticket 生成交接（handoff），早上一打开就是简报，点一下就回到对应的 session；记忆由本地的 StateCore 管理。界面是中文的。

## What it does

- **Tickets first.** Each ticket has its worktree or branch, its Claude Code sessions (embedded terminals), its PR state and its after-merge follow-ups.
- **Nightly handoffs.** At a time you choose, Butler asks your own logged-in `claude` (read-only tools only) to write a structured handoff for every ticket that had activity. You can also run `/handoff` inside a session.
- **Morning brief.** "Do first" (approved PRs, requested changes, after-merge follow-ups, due items), "Today", "Watch", and what you did on the previous working day. One click resumes the right session with a prompt already typed in.
- **Memory.** Progress, decisions, open follow-ups and cross-ticket learnings are written to a local [StateCore](https://github.com/yul761/StateCore) store, and every session Butler starts can `recall` them. The ticket page has a Memory tab with the history (`why` chain) of every entry.
- **Optional personal LLM summary.** A short "today's focus" paragraph from an OpenAI-compatible API you pay for, behind a privacy gateway: field allow-listing, per-request pseudonyms, a scanner that refuses to send anything that looks like a secret, URL, host, email, path or ticket id, an audit page with the exact bytes sent, a monthly budget and optional confirm-before-send. Off by default unless you configure it; the default level sends metadata only.

Butler never holds your Jira, GitHub or Claude credentials: all real work goes through the `claude` you already use.

## Requirements

- macOS 13+ on Apple silicon, or Windows 10/11 x64.
- Claude Code installed and logged in (`claude --version` works in a terminal). On Windows, Claude Code needs Git for Windows (Git Bash).
- Optional: a tracker MCP server configured in Claude Code (Jira, Linear, GitLab, …) so handoffs can read ticket status.

## Install

Download the latest `.dmg` (macOS) or `Butler Setup x.y.z.exe` (Windows) from the Releases page of this repository.

The first release is **not code-signed**, so the operating system will warn you once:

### macOS (Gatekeeper)

1. Open the `.dmg` and drag Butler into Applications.
2. Open Butler. macOS says it "cannot be opened because the developer cannot be verified" (or that it is "damaged").
3. Either go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**, or run this once in Terminal:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Butler.app
   ```

The app is ad-hoc signed (not notarized). You only need to do this after each download.

### Windows (SmartScreen)

1. Run `Butler Setup x.y.z.exe`.
2. SmartScreen says "Windows protected your PC". Click **More info → Run anyway**.
3. Choose an install folder (per-user install, no admin rights needed).

There is no auto-update yet: download new versions from Releases and install over the old one. Your data is kept.

## First run

A short wizard (首次启动向导) walks you through:

1. **Claude Code check** — finds `claude` (or let it know the absolute path) and checks the flags Butler relies on.
2. **Hooks and `/handoff`** — merges a few hooks into your user-level Claude Code `settings.json` (your existing hooks are kept) and adds a `/handoff` command. The hooks only write small JSON files into `~/.butler/inbox`; they never touch the network and never block Claude Code. **Settings → 卸载 (Uninstall)** removes them again.
3. **Tracker MCP tools** — detects the MCP tools your Claude Code has and lets you pick the read-only ones handoffs may call.
4. **Privacy level and personal API** — optional.

You can re-run it from Settings at any time. See [docs/configuration.md](docs/configuration.md) for every setting, including how to plug in another company's tracker and conventions.

## Where your data lives

| Path | What |
|------|------|
| `~/.butler/app.db` | Tickets, sessions, handoffs, follow-ups, briefs, the LLM audit log (SQLite) |
| `~/.butler/statecore/statecore.db` | StateCore memory |
| `~/.butler/inbox/` | Hook reports waiting to be processed |
| `~/.butler/bin/butler-hook` | The hook executable Claude Code runs |
| `~/.butler/mcp/<ticket>.json` | The `--mcp-config` file each session is started with |
| `~/.butler/logs/main.log` | Logs (never contain your API key) |

On Windows `~` is `%USERPROFILE%`. Set `BUTLER_HOME` to use another folder (for example a separate profile for a second company); Butler also honours `CLAUDE_CONFIG_DIR`.

Your personal API key is encrypted with the OS keychain (macOS Keychain / Windows DPAPI) and is never shown again after you save it.

## StateCore memory

Butler embeds StateCore and mounts it into the sessions it starts as two MCP servers, `butler-memory` (this ticket) and `butler-workspace` (cross-ticket learnings). **Do not also install StateCore's own Claude Code capture plugin**: Butler already covers it, and both together record everything twice. Settings shows a warning if it finds the plugin.

The memory processes Claude Code starts never receive any model API key. Only when your privacy level is **完整 (full)** does Butler, once a night, distil raw notes Claude saved with `consolidate: true` through your personal API — audited and budgeted like everything else.

## Privacy model in one paragraph

Company work goes only through your company's `claude`. Your personal API sees, by default, placeholders, status enums, counts and day numbers — no ticket ids, repo names, people or code. Higher levels send short pseudonymized texts (`redacted`) or real text (`full`); the scanner still refuses to send secrets, URLs, internal hosts, IPs, emails or file paths. Names that are not in your sensitive-terms list, accent-less spellings and GitHub org/repo names Butler has never seen cannot be pseudonymized; the scanner is the backstop. Every call (and every refused call) is on the audit page.

## Known limitations

- Unsigned builds (see above); Apple silicon only on macOS (Intel Macs can build from source).
- No auto-update.
- The personal API is called with Node's `fetch`, which does not use the system proxy.
- The UI is Chinese.

## Uninstall

1. Settings → **卸载 (Uninstall)** to remove Butler's hooks and `/handoff` command from Claude Code.
2. Delete the app (macOS: drag Butler out of Applications; Windows: Settings → Apps → Butler → Uninstall).
3. Delete `~/.butler` if you also want to remove your data.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
````

新建 `CONTRIBUTING.md`：

````markdown
# Contributing to Butler

Thanks for helping. Butler is a personal productivity tool that handles other people's work data, so a few rules below are non-negotiable (privacy, no network outside the gateway, no real `claude` or LLM calls in tests).

## Toolchain

- **Node.js**: the version in `.node-version` (26.3.0). It is needed to build `butler-hook` (Node SEA with `--build-sea`); tests need at least 22.13 (`node:sqlite`). With nvm: `nvm install && nvm use`.
- **pnpm** 9.15.0 (`corepack enable` or `npm i -g pnpm@9.15.0`).
- **A C++ toolchain** for `node-pty`, which is rebuilt for Electron on install:
  - macOS: Xcode Command Line Tools (`xcode-select --install`).
  - Windows: Visual Studio Build Tools with the "Desktop development with C++" workload, and Python 3.
- **Git**, and on Windows **Git for Windows** (Git Bash): Claude Code runs hooks through it, and the E2E tests do too.

## Setup

```sh
pnpm install          # also rebuilds node-pty for Electron
pnpm build:hook       # builds build/hook/butler-hook (needed to install hooks)
pnpm dev              # runs Butler with hot reload (also builds the StateCore MCP bundle)
```

Use a throwaway data folder while developing so you never touch your real `~/.butler` or `~/.claude`:

```sh
BUTLER_HOME=/tmp/butler-dev CLAUDE_CONFIG_DIR=/tmp/claude-dev pnpm dev
```

## Scripts

| Script | What |
|--------|------|
| `pnpm typecheck` | TypeScript for main, preload, shared and renderer |
| `pnpm lint` | ESLint, including the egress rules |
| `pnpm test` | Vitest unit and integration tests |
| `pnpm build` | Main, preload, renderer, and the StateCore MCP bundle |
| `pnpm build:hook` | The `butler-hook` executable for this platform |
| `pnpm e2e` | Playwright for Electron with a fake `claude` (run `pnpm build` and `pnpm build:hook` first) |
| `pnpm dist` | Unsigned installers into `dist/` (this platform only) |

CI (`.github/workflows/ci.yml`) runs all of the above on macOS and Windows.

## Architecture in brief

- `src/main` — Electron main process: sessions in node-pty, hook inbox, handoff runner, scheduler, brief engine, StateCore memory, settings.
- `src/main/gateway` — **PrivacyGateway**, the only place allowed to make network requests (personal LLM API). ESLint enforces this (`eslint.config.mjs`); `src/main/egress-lint.test.ts` proves the rules bite.
- `src/main/memory/statecore.ts` and `memory-mcp/entry.ts` — the only two entry points to StateCore. No StateCore process ever receives a model key; distillation runs only in the main process through `PrivacyGateway.statecoreModel()`.
- `src/renderer` — React UI; no Node access, talks to main through the typed IPC whitelist in `src/shared/ipc.ts`.
- `hook/` — the tiny `butler-hook` program Claude Code runs. It must always exit 0 and never touch the network.

The design document is in `docs/superpowers/specs/`, the implementation plans in `docs/superpowers/plans/`.

## Rules

- **No network outside `src/main/gateway`.** Not even "just a quick fetch".
- **The privacy invariant test is a release blocker** (`src/main/gateway/privacy-invariant.test.ts`): random ticket ids, repo names, people and terms must never appear in what is sent.
- **Tests never call a real LLM provider or the real `claude`**, and never read or write the real `~/.butler` or `~/.claude`. Use the in-process fake provider (`src/main/gateway/testing.ts`), the fake `claude` helpers (`src/main/test-utils.ts`, `e2e/fake-claude`) and temporary directories.
- **Never run commands that change a user's Claude Code configuration** (`claude mcp add`, `claude config set`, …) from code or tests.
- **Database migrations are append-only** (`src/main/db/migrations.ts`).
- **User-facing text** lives in `src/renderer/src/strings.ts` (UI) and `src/main/strings.ts` (main process).
- Pin dependency versions exactly.

## Pull requests

Keep them focused, with tests. `pnpm typecheck && pnpm lint && pnpm test` must pass; run `pnpm e2e` when you touch the UI, IPC, sessions or hooks.
````

新建 `docs/configuration.md`：

````markdown
# Configuring Butler for your company

Butler has no config files: everything is in **设置 (Settings)** and stored in `~/.butler/app.db`. This page lists every setting, what it is for, and how to adapt Butler to another company's tracker and conventions. The names in `code` are the internal keys (useful when reading logs or the database).

## 常规 (General)

| Setting | Key | Default | Notes |
|---------|-----|---------|-------|
| claude 路径 (claude path) | `claudePath` | empty (search the login shell's PATH) | Absolute path to your company's `claude` if it is not on PATH. |
| 分支名模板 (branch template) | `branchTemplate` | `feature/{key}` | Used when Butler creates a worktree. Must contain `{key}`; only letters, digits and `. _ / -`. Examples: `users/alice/{key}`, `{key}`. |
| ticket 号正则 (ticket pattern) | `ticketPattern` | `[A-Z][A-Z0-9]+-\d+` | Recognises ticket ids when creating tickets, suggesting tickets for unclaimed sessions and in the privacy scanner. Jira and Linear (`ENG-123`) work with the default. GitHub issues: `#\d+`. Patterns that can hang the app (nested quantifiers like `(a+)+`, quantified alternations like `(A\|AB)*`, back-references, anything matching the empty string) are rejected. |
| 开机自启 (start at login) | — | off | Installed app only. |
| 首次启动向导 (first-run wizard) | `onboardingDone` | `0` for new installs | "重新运行首次启动向导" sets it back to `0`. |

## 调度与 handoff (Schedule and handoffs)

| Setting | Key | Default | Notes |
|---------|-----|---------|-------|
| 晚间 handoff 时间 | `nightlyTime` | `16:00` | Local time. Missed runs catch up on wake/unlock, before the morning brief. |
| 工作日 | `workingDays` | Mon–Fri | Nightly handoffs only run on these days; Monday's brief looks back to Friday. |
| 简报阈值 | `blockedDays`, `reviewWaitDays`, `staleDays` | 2, 2, 5 | Days before a blocked ticket, a waiting review or an idle ticket shows up in the brief. |
| tracker MCP 工具 | `trackerTools` | empty | One MCP tool name per line. Handoffs may call only these plus read-only git/gh commands. |
| 后台加载项目级 MCP | `headlessProjectMcp` | off | Also mount local-scope MCP servers and the repo's `.mcp.json` servers you approved in Claude Code. |
| handoff prompt | `handoffPrompt` | built in | The instructions sent to `claude` for a handoff. The JSON schema (status, PR, follow-ups, decisions, learnings…) is appended by Butler and validated; change the wording, not the schema. |
| 刷新 prompt | `refreshPrompt` | built in | The quick morning refresh for tickets in review or merged with follow-ups (PR and tracker status only). |

### Plugging in your tracker

Butler talks to your tracker only through Claude Code's MCP servers, with **read-only** tools:

1. Configure the tracker's MCP server in Claude Code as you normally would (user scope is simplest).
2. Settings → **从 Claude Code 检测 (Detect)** lists every MCP tool Claude Code exposes; tools whose names look like reads (`get…`, `search…`, `list…`) are pre-ticked. Add the ones you need.
3. Typical picks:
   - **Jira** (Atlassian MCP): `mcp__atlassian__getJiraIssue`, `mcp__atlassian__searchJiraIssuesUsingJql`.
   - **Linear**: `mcp__linear__get_issue`, `mcp__linear__list_comments`.
   - **GitLab**: `mcp__gitlab__get_issue`, `mcp__gitlab__get_merge_request`.
4. If your tracker MCP is configured in a repository's `.mcp.json` or in local scope, turn on `headlessProjectMcp`: unattended runs only read your user-level Claude Code settings by default, so repository allow-rules and hooks never apply to them.

Tool names depend on how you named the server in Claude Code: `mcp__<server>__<tool>`.

### Adapting the prompts

The default prompts are written for Jira-like trackers and GitHub PRs (`gh pr view`, `gh pr checks`). For GitLab, mention the MCP tools for merge requests in `handoffPrompt` and `refreshPrompt`. Keep the output instructions intact: Butler validates the JSON, retries once with the validation errors, and stores a "degraded" handoff when it still fails.

## 隐私与个人 API (Privacy and personal API)

| Setting | Key | Default | Notes |
|---------|-----|---------|-------|
| 隐私档位 | `llmLevel` | `metadata` | `off` · `metadata` (placeholders, enums, counts) · `redacted` (adds short pseudonymized texts) · `full` (real text; the scanner still applies to "today's focus"; also enables nightly StateCore distillation). |
| 服务地址 | `llmBaseUrl` | empty | Any OpenAI-compatible endpoint, e.g. `https://api.openai.com/v1`, `https://api.deepseek.com/v1`, `https://openrouter.ai/api/v1`, `http://localhost:11434/v1` (Ollama). Only `https://`, except localhost. |
| 模型 | `llmModel` | empty | e.g. `gpt-5-mini`, `deepseek-chat`. |
| API key | — | — | Stored encrypted with the OS keychain; never shown again. Not needed for localhost. |
| 每月预算 | `llmMonthlyBudgetUsd` | `1` | Calls stop for the month once the estimate would exceed it. |
| 价格表 | `llmPrices` | `* 15 75` | One rule per line: `model-pattern input-price output-price` in USD per million tokens, first match wins, `*` is a wildcard. The default is deliberately expensive; set your provider's real prices, e.g. `deepseek-chat 0.27 1.1`. A model without a price is never called. |
| 发送前确认 | `llmConfirm` | off | Shows the exact outbound request before every "today's focus" call. While it is on, StateCore distillation does not run. |
| 审计保留天数 | `auditRetentionDays` | `90` | The current month is always kept for the budget. |
| 敏感词表 | — | empty | People and other terms (project code names, customers) to pseudonymize. Ticket ids, repo and branch names are handled automatically. |

## 记忆 (StateCore memory)

| Setting | Key | Default | Notes |
|---------|-----|---------|-------|
| 记忆 | `memoryEnabled` | on | Writes handoffs, decisions, open follow-ups and learnings to `~/.butler/statecore`, and mounts `butler-memory` / `butler-workspace` into sessions Butler starts. Turning it off keeps existing memory. |

Butler keeps at most 24 of its own entries per ticket (StateCore keeps 30 notes per scope) and the latest 30 learnings across tickets.

## Several companies or profiles

Start Butler with a different `BUTLER_HOME` (and, if each company has its own Claude Code login, a different `CLAUDE_CONFIG_DIR`). Each folder is a fully separate Butler: its own database, memory, hooks binary and settings.
````

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/docs.test.ts`
Expected: PASS

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add README.md LICENSE CONTRIBUTING.md docs/configuration.md src/main/docs.test.ts
git commit -m "docs: README with Gatekeeper and SmartScreen steps, MIT license, contributing guide, configuration guide"
```

---

### Task 12: 全量检查、E2E、安装包的隔离启动与遗留清单

不推送、不发布（R3）。本机是 macOS：Windows 的单元测试、E2E 和安装包只能由用户推送后在 CI 上验证，列进手动验证。

**Files:**
- Modify: `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md`

- [ ] **Step 1: 全量自动检查（含 E2E）**

Run: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm build:hook && pnpm exec electron out/main/index.js --smoke && pnpm e2e`
Expected: 全部通过；`headless.live.test.ts` 显示 skipped；冒烟输出 `sqlite-ok 1`、`statecore-ok 1`、`pty-ok`；E2E 3 passed。

人工复核出口和 StateCore 入口（ESLint 已经保证）：

Run: `grep -rnE "\bfetch\(|from \"(node:)?(http|https|net|tls|undici)\"" src hook scripts memory-mcp e2e | grep -v -e "^src/main/gateway/" -e "^src/main/egress-lint.test.ts:" || echo "no egress outside the gateway"`
Expected: `no egress outside the gateway`

Run: `if command -v actionlint >/dev/null; then actionlint .github/workflows/*.yml && echo "actionlint ok"; else echo "actionlint not installed"; fi`
Expected: `actionlint ok` 或 `actionlint not installed`（记进遗留清单）。

- [ ] **Step 2: 安装包：打包并隔离启动**

```bash
set -eu
pnpm dist
APP="dist/mac-arm64/Butler.app"
codesign -dv "$APP" 2>&1 | grep Signature
"$APP/Contents/MacOS/Butler" --smoke
T="$(mktemp -d)"
BUTLER_HOME="$T" CLAUDE_CONFIG_DIR="$T/claude" "$APP/Contents/MacOS/Butler" & PID=$!
sleep 15; kill "$PID"; wait "$PID" 2>/dev/null || true
node -e 'const { DatabaseSync } = require("node:sqlite"); console.log(new DatabaseSync(process.argv[1]).prepare("PRAGMA user_version").get())' "$T/app.db"
grep -E "uncaughtException|unhandledRejection|renderer CSP violation|memory MCP bundle missing" "$T/logs/main.log" || echo "no errors logged"
ls -la dist/*.dmg dist/*.zip
```

Expected：`Signature=adhoc`；冒烟三行都在；`{ user_version: 4 }`；`no errors logged`；`.dmg` 和 `.zip` 都在。

- [ ] **Step 3: 更新遗留清单**

在 `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md` 末尾追加（把 Step 1 里 actionlint 的实际结果和任务 8 的 spike 实际走的路线写进去）：

```markdown

# Plan 5 follow-ups

## Live checks
- Plan 5 Task 7 (electron-builder 26.15.3, macOS arm64): `--dir` build smoke `sqlite-ok 1` / `statecore-ok 1` / `pty-ok`; `Signature=adhoc`; memory MCP runs with the packaged binary as Node (RunAsNode available); spawn-helper executable after afterPack
- Plan 5 Task 8: Playwright 1.64.0 `_electron.launch` drives Electron 44 (or: the CDP fallback was needed — record which)
- actionlint: ran / not installed locally (record which)

## Rulings
- Ruling P5-R1: APP_ID `io.github.yul761.butler` is both the electron-builder appId and the Windows AUMID (test-enforced); do not change it after the first release
- Ruling P5-R2: keep the Node SEA `butler-hook` (~136 MiB on disk) — a Go/Rust helper adds a toolchain; running it through Electron needs per-shell env syntax in the hook command and breaks when the app moves
- Ruling P5-R3: Windows hooks are executed by Claude Code through Git Bash; the quoted forward-slash command works there (E2E on windows-latest); PowerShell is not a hook shell for Claude Code, so its quirk (a bare quoted string is not executed) does not apply
- Ruling P5-R4: no auto-update in v1 — macOS auto-update requires a signed app, and electron-updater would be network code outside the gateway
- Ruling P5-R5: macOS builds are arm64 only and ad-hoc signed in afterPack; Intel users build from source
- Ruling P5-R6: npm/pnpm `claude.cmd` shims are started as `node <script>` (no cmd.exe); unknown shims fall back to cmd.exe with the old argument checks
- Ruling P5-R7: docs are in English for open-source readers; UI labels are quoted in Chinese with an English gloss

## Resolved in plan 5
- Plan 1 R2: Playwright E2E for IPC / preload / components (Tasks 8, 9)
- Plan 1 Task 1: spawn-helper exec bit (Task 7 afterPack); C++ toolchain documented (Task 11)
- Plan 1 Task 5: build:hook Node check (Task 5), uncaughtException guard (Task 5), orphan .tmp on rename failure (Task 4); SEA size kept (P5-R2); Windows exe built and exercised in CI E2E (Tasks 9, 10)
- Plan 1 Task 6: rename EPERM/EBUSY retry (Task 4); Windows hook shell (P5-R3, Task 9)
- Plan 1 Task 9: cmd.exe quoting with `--mcp-config` (Task 3)
- Plan 1 Task 12: window close blocking Windows logoff / shutdown; @2x tray icon (Task 4)
- Plan 2 Task 10: Windows killTree orphan gap for shims; SIGKILL timer at quit; duplicated spawn options (Task 3)
- Plan 2 Task 13: Windows AUMID (Task 4)
- Plan 3: renderer CSP (Task 6); `~` in BUTLER_HOME (Task 4); git absolute path, fsmonitor off, random temp names, APFS regression test (Task 2); no-eval / no-new-func / no-implied-eval (Task 1)

## Still open after plan 5
- Windows: unit tests, E2E and the NSIS installer are verified only by CI after the user pushes (this machine is macOS)
- Code signing / notarization and auto-update (design 12: later)
- Personal API ignores the system proxy (README known limitation)
- Low-impact minors ruled out in plan 4 appendix C
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md
git commit -m "docs: record plan 5 live checks, rulings and what stays open"
```

---

## 手动验证

由用户执行（执行者在 macOS 上、没有 Windows 机器，也没有推送任何东西）。任何一项不符合就停下来，按 superpowers:systematic-debugging 排查。

1. **推送前**：`actionlint .github/workflows/*.yml`（本机没有时可以 `brew install actionlint`）没有报错。
2. **推送并看 CI**：在 GitHub 上建仓库、推送 main → `CI` 工作流在 `macos-14` 和 `windows-latest` 上都通过（typecheck、lint、test、build、build:hook、e2e）；`package` 任务产出 `butler-macos-14`（dmg + zip）和 `butler-windows-latest`（exe）两个产物。Windows 上失败时下载 `e2e-windows-latest` 产物看 trace 和日志。
3. **macOS 安装包**：从 CI 产物或本机 `dist/` 安装 `.dmg` → 第一次打开被 Gatekeeper 拦下 → 按 README 的两种方法之一放行 → 向导出现。
4. **Windows 安装包**：运行 `Butler Setup 1.0.0.exe` → SmartScreen“更多信息 → 仍要运行” → 可以选择安装目录 → 开始菜单里有 Butler。
5. **Windows 真机：claude.cmd 与空格路径**：用户名带空格（或把 `BUTLER_HOME` 设到带空格的目录）、claude 用 npm 安装 → 从 Butler 开 session → 在 Claude Code 里 `/mcp` 能看到 `butler-memory` 和 `butler-workspace`；`~/.butler/logs/main.log` 里没有 `memory MCP not mounted`。
6. **Windows 真机：hook**：在 Butler 开的 session 里说一句话 → 侧栏出现“等你输入”；`/handoff` 之后 ticket 页的 handoff 历史多一条。
7. **Windows 通知**：设置页“立即运行晚间 handoff”，有内容时弹出晚间小结通知，点击通知回到 Butler 的晚间小结。
8. **Windows 注销 / 关机**：Butler 开着（窗口已关、在托盘里）时注销或关机，系统不会被 Butler 挡住。
9. **开机自启**：安装包版本里勾选“开机时自动启动 Butler” → 重启电脑后 Butler 自动打开并显示简报。
10. **托盘图标**：高分屏上托盘的圆点图标清晰，不发虚。
11. **CSP**：安装包版本里打开一个 session，终端正常显示；`~/.butler/logs/main.log` 里没有 `renderer CSP violation`。
12. **仓库自带 git.exe（Windows，可选）**：在一个根目录放了 `git.exe`（随便复制一个别的 exe 改名）的仓库里新建 ticket → Butler 执行的仍是系统的 git（新建成功、那个假 exe 没有被运行）。
13. **发布**：推一个 `v1.0.0` tag → `Release` 工作流建出一个 draft release，附带 dmg、zip 和 exe；检查后由你手动发布。

---

## 附录 A：裁定（Rulings）

| 编号 | 裁定 | 理由 |
|------|------|------|
| R2（控制者） | 不运行会改用户 Claude Code 配置的命令；测试和 E2E 不碰真实的 `~/.butler`、`~/.claude`，不调用真实的 LLM 服务商和 claude | E2E 用临时的 `BUTLER_HOME` / `CLAUDE_CONFIG_DIR` 和假 claude |
| R3（控制者） | CI 只在本地写好并校验，不推送；产物不签名；发布由用户完成 | 任务 10、12 |
| R5（控制者） | 外部行为先做小实验 | 任务 7（electron-builder）、任务 8（Playwright for Electron）；任务 3 的 shim 格式用 npm 和 pnpm 生成的真实格式做夹具 |
| P5-R1 | `APP_ID = io.github.yul761.butler`，同时是 electron-builder 的 appId 和 Windows 的 AUMID | 两者不一致时 Windows 通知点不开；用用户自己的 GitHub 名做反向域名。第一次发布前可以改，之后不要改 |
| P5-R2 | 保留 Node SEA 的 `butler-hook` | 见任务 5：其他方案要么加工具链，要么让 hook 命令依赖 shell 语法和 app 的安装位置 |
| P5-R3 | Windows 上 hook 由 Claude Code 经 Git Bash 执行；不为 PowerShell 改命令格式 | Claude Code 在 Windows 上要求 Git Bash 并用它执行 hook；E2E 在 windows-latest 上用 Git Bash 实际执行安装好的命令（手动验证第 6 项在真机上复核） |
| P5-R4 | v1 不做自动更新 | 没有签名时 macOS 的自动更新不可用；`electron-updater` 会成为 gateway 之外的联网代码 |
| P5-R5 | macOS 只出 arm64，afterPack 做 ad-hoc 签名 | GitHub 的 `macos-14` 是 arm64；Intel 用户可以从源码构建；arm64 上完全不签名的 app 无法启动 |
| P5-R6 | npm / pnpm 的 `claude.cmd` 直接用 `node <脚本>` 启动，认不出的 shim 回退到 cmd.exe | 一次解决 `--mcp-config` 引号和 killTree 孤儿两个问题；回退路径保留原来的参数检查 |
| P5-R7 | 开源文档用英文 | 面向开源读者；界面标签原样引用中文并附英文说明 |
| P5-R8 | 加 `.gitattributes` 统一 LF（`.cmd` / `.bat` 保持 CRLF） | Windows 的 checkout 默认把文本换成 CRLF，读取固定内容的测试会失败 |

## 附录 B：与设计文档的差异（本计划有意为之）

1. 2.1 节“通过 GitHub Releases 自动更新”：v1 不做（P5-R4）。`release.yml` 只建 draft release，由维护者手动发布。
2. 12 节“首版不做代码签名”：macOS 上做 ad-hoc 签名（不是开发者签名、不公证），否则 arm64 上无法启动；Gatekeeper 仍会拦，README 写了放行方法。
3. 11 节 E2E 路线之外，还覆盖了首次启动向导（计划 4）、记忆标签（计划 4）和 CSP（任务 6）。
4. 13.1 节“`butler-hook` 用正斜杠的绝对路径并加引号，cmd、PowerShell、Git Bash 都能执行”：实际只依赖 Git Bash（Claude Code 在 Windows 上执行 hook 的 shell）和 POSIX sh；PowerShell 不执行裸的带引号字符串，但它不是 Claude Code 的 hook shell（P5-R3）。
5. macOS 只出 arm64 安装包（P5-R5）。

## 附录 C：遗留项去向

完整的去向表见计划 4 的附录 C。其中指向本计划的各项都在上面的任务里落实（逐项对应见任务 12 Step 3 的 “Resolved in plan 5”）；标为“不做”的项及理由以计划 4 附录 C 为准，本计划没有改变任何一项的裁定。
