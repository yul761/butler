# Butler 计划 3：隐私层与“今日重点” Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 早间简报顶部多一段由个人 LLM API 生成的“今日重点”。所有出站内容都经过 PrivacyGateway：字段白名单投影 → 每次请求随机的假名化 → 敏感信息扫描（命中即整次拒发）→ 写审计 → 可选的发送前确认 → 发送 → 校验与还原。另有月度预算、用 safeStorage 加密保存的 key、审计页。同时收尾计划 2 留下的 MCP 来源实测、`--setting-sources` 健康检查和一批稳健性小问题。

**Architecture:** 新代码集中在 `src/main/gateway/`，这是全仓库唯一允许发网络请求的目录，由 ESLint 规则强制。管道每一步都是不依赖 Electron 的纯函数或小类：`projection`（按档位投影字段）、`pseudonym`（假名化与还原）、`scanner`（敏感信息扫描）、`budget`（价格与预算）、`provider`（全局 `fetch`，OpenAI 兼容接口），由 `PrivacyGateway` 串起来，串行执行、永不抛错。简报照常先生成并入库，再补“今日重点”；任何失败只改 `narrativeStatus`。key 用 Electron `safeStorage` 加密后存进新表 `secrets`，渲染进程只能拿到打码后的形式。测试在进程内用 `node:http` 起一个假的 OpenAI 兼容服务器（127.0.0.1），端到端地跑客户端和整条管道。

**Tech Stack:** 计划 1–2 的全部依赖（Electron 44.9.0、electron-vite 6.0.0、React 19.3.1、node:sqlite、vitest 5.0.5、TypeScript 5.9.3、zod 4.6.5、cross-spawn 7.0.6）。**不新增运行时依赖**：用 Node 自带的 `fetch`、`AbortSignal.timeout`、`AbortSignal.any`；zod 校验模型响应；Electron 的 `safeStorage` 和 `dialog.showMessageBox({ signal })`。测试用 `node:http` 做假服务器，用 ESLint 10 自带的 `ESLint` API 验证出口规则。

**Spec:** `docs/superpowers/specs/2026-10-19-butler-design.md`（重点：第 7 节全部、6.2 节第 3 步、8.5 节、第 10 节最后一行、11 节隐私不变量测试）。另见遗留清单 `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md` 末尾的 “Plan 2 follow-ups”。

## 本计划在整体中的位置

| 计划 | 内容 | 结束时能做什么 |
|------|------|--------------|
| 1（已完成） | 框架、数据库、ticket、内嵌终端、hook、session 发现、托盘 | 用 Butler 管理所有 ticket 的 Claude Code session |
| 2（已完成） | handoff 采集、followups、状态推导、规则简报、调度、简报首页 | 晚间小结 + 早间简报（纯规则），一键回到 session |
| **3（本计划）** | 计划 2 遗留（MCP 来源、能力检查、稳健性）、出口 lint、PrivacyGateway、服务商客户端、key 加密保存、预算、审计页、“今日重点” | 简报带“今日重点”；出站内容可审计、可拒发、可确认 |
| 4 | StateCore 记忆层（含 8.5 节的 key 约束接线）、`--mcp-config`、首次启动向导、CSP、打包、E2E、双平台 CI | 可发布的 v1.0 |

## Global Constraints

- 计划 2 的约束继续有效：路径一律用 `node:path`；prompt 永远不进 argv；Butler 启动的每个 headless claude 都用 `headlessEnv()` 并带 `--no-session-persistence`；新增 IPC 通道必须进白名单（`src/shared/ipc.test.ts`）；渲染进程不能 import `src/main/**`；UI 文案在 `src/renderer/src/strings.ts`，主进程给用户看的文案在 `src/main/strings.ts`；依赖版本精确锁定；每个任务结束时 `pnpm typecheck`、`pnpm lint`、`pnpm test` 必须通过；commit message 末尾加执行者 harness 署名提醒给出的 `Co-Authored-By:` 行（计划 1 Ruling R3）。
- **唯一出口**：个人 API 的网络调用只能出现在 `src/main/gateway/**`。其他任何文件都不能用 `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource`，也不能 import `http`、`https`、`http2`、`net`、`tls`、`dgram`、`dns`（含 `node:` 前缀）、`undici`、通用 HTTP 客户端、LLM SDK 或 Electron 的 `net`。由 `eslint.config.mjs` 强制，`src/main/egress-lint.test.ts` 检查规则确实生效（任务 6）。
- **测试和验证永远不调用真实的 LLM 服务商**：一律用测试进程里起在 `127.0.0.1`、端口 0 的假 OpenAI 兼容服务器（`src/main/gateway/testing.ts`）。用户之后自己配置 key。
- **API key**：只经 Electron `safeStorage` 加密后存进 `secrets` 表；永远不写日志、不进审计内容和报错信息，保存后永远不再发给渲染进程，渲染进程只拿到打码形式（`••••` + 末 4 位）。
- **隐私档位**默认 `metadata`；`off` 不调用；未配置 base URL / 模型（或远程服务没有 key）时等同 `off`。
- **假名化映射每次请求随机生成**，只在内存里，用完即弃；同一个原值在两次请求里的占位符不同。
- **敏感信息扫描命中就整次拒发**，不尝试替换后再发；拒发的出站内容不落盘，审计只记命中的规则和打码样本。
- **个人 API 只用于早间简报的“今日重点”**。简报先入库，“今日重点”是尽力而为：失败、超时、拒发、超预算、用户拒绝确认，都只改 `narrativeStatus`（`failed` / `blocked` / `budget` / `off`），简报其余内容不受影响。
- **预算**：费用 = token 用量 × 用户可编辑的价格表（美元 / 百万 token）。发送前用保守估算检查“本月已花 + 本次估算 ≤ 月度预算”，超出时 `narrativeStatus: "budget"` 且不调用；模型在价格表里找不到价格时也不调用。
- 服务商的 base URL 必须是 `https://`，只有本机地址（`localhost`、`127.0.0.1`、`[::1]`）可以用 `http://`；请求不跟随重定向（`redirect: "error"`）。
- 出站和扫描前的文本一律先做 Unicode NFKC 规范化（全角字母数字不能绕过替换和扫描）。
- 数据库迁移只在 `MIGRATIONS` 末尾追加（本计划是第 3 条）。
- 只有任务 1 会运行真实的 `claude`，而且只读到 init 消息就结束（不产生模型输出）；运行方式与计划 2 任务 16 相同：去掉外层会话的标记变量，`BUTLER_HOME` 指向临时目录。

## Review Focus

1. **模型改写或编造了占位符**（大小写变了、只剩一层括号、出现本次请求没有的占位符）：含这种占位符的那一句整句丢弃，界面上永远看不到裸占位符，也不会把别的原值“还原”进去。测试见任务 9（`restore drops sentences with unknown or mangled placeholders`）和任务 13（`drops a sentence with an invented placeholder`）。
2. **自由文本里的原值换了写法**：全角（`ＰＲＯＪ－１２`）、小写（`proj-12`）、和中文粘在一起（`修好PROJ-12的bug`）、ticket 号是分支名的一部分（`feature/PROJ-12-login`）、`PROJ-12` 和 `PROJ-123` 同时存在。这些都必须被替换，出站内容里不出现原值。测试见任务 9（`replaces every spelling of a known value`）和任务 14 的随机化不变量测试。
3. **服务商行为异常**：一直不返回、302 跳到别的地址、返回 200 但内容是 HTML、响应超大、报错时把 `Authorization` 头原样回显。结果都是 `failed`，key 不进审计也不进日志，跳转目标收不到请求。测试见任务 11 和任务 13（`never writes the key into the audit or the log`）。
4. **同时触发两次早间简报**（解锁和点“重新生成”撞在一起），以及**跨月**：预算检查串行进行，第二次能看到第一次的实际花费；月初重新计数；手动排队的那次如果在排队期间已经由调度跑过，就不再重复（省一次个人 API 的费用）。测试见任务 2（`a manual morning brief queued behind a scheduled one is not run again`）、任务 8（`monthStart`）和任务 13（`serialises requests so the budget sees the first request's cost`）。
5. **发送前确认被拒绝、对话框抛错或超时、app 正在退出**：不发送，简报完整，`narrativeStatus` 为 `off`（拒绝）或 `failed`（出错），审计里留下一条 `declined`。测试见任务 13（`asks before sending and sends nothing when declined`）和任务 15（`does not narrate once the app is quitting`）。

---

## 文件结构

```
eslint.config.mjs                出口规则（任务 6）
src/
  shared/
    llm.ts                       档位、敏感词、审计、扫描命中、LlmStatus 的共享类型（任务 7）
    text.ts                      + formatDuration（任务 3）
    settings.ts                  + 个人 API 相关的可编辑设置键（任务 5、8）
    brief.ts                     BriefView + narrating（任务 16）
    types.ts                     + JobStateView（任务 4）
    ipc.ts                       + 6 个通道（任务 16）
  main/
    egress-lint.test.ts          出口规则的检查（任务 6）
    paths.ts                     + claudeJson、mcp；相对的 BUTLER_HOME（任务 2）
    strings.ts                   + 发送前确认对话框的文案（任务 16）
    claude/
      capabilities.ts            + --setting-sources（任务 1）
      headless.ts                限流判断、超时文案、mcpConfigs 参数（任务 3、5）
      mcp-probe.ts               + mcpConfigs 参数（任务 5）
      project-mcp.ts             仓库 .mcp.json / 本地级 MCP → --mcp-config 文件（任务 5，按任务 1 的实测结果）
    db/
      migrations.ts              + 迁移 3：llm_audit、sensitive_terms、secrets（任务 7）
      audit-repo.ts, terms-repo.ts, secrets-repo.ts（任务 7）
      briefs-repo.ts             notices 规范化（任务 2）、setNarrative（任务 15）
      jobs-repo.ts               JobState = JobStateView（任务 4）
      settings-repo.ts           + 新设置的默认值（任务 5、8）
    settings/settings-values.ts  + 个人 API 设置的校验、价格表、llmConfig、敏感词规范化（任务 8）
    gateway/                     唯一允许联网的目录
      types.ts                   NarrativeSource / OutboundPayload 等（任务 9）
      pseudonym.ts               假名化与还原（任务 9）
      projection.ts              按档位的字段白名单投影（任务 9）
      scanner.ts                 敏感信息扫描（任务 10）
      budget.ts                  月初、token 估算、费用、预算检查（任务 8）
      provider.ts                OpenAI 兼容客户端（任务 11）
      testing.ts                 测试用：可复现随机数、假服务器、假加密盒、gateway 测试夹具（任务 9、11、12、13）
      key-store.ts               加密保存 key（任务 12）
      safe-storage.ts            Electron safeStorage 适配（任务 12）
      statecore-env.ts           8.5 节：只有 full 档位才把 key 交给 StateCore（任务 12）
      narrative.ts               “今日重点”的 prompt 与响应校验（任务 13）
      gateway.ts                 PrivacyGateway（任务 13）
      status.ts                  设置页用的 LlmStatus（任务 16）
    brief/
      brief-service.ts           + narrativeSource（任务 15）
      narrate.ts                 把“今日重点”写回简报（任务 15）
    schedule/
      daily-jobs.ts              早间任务最后补“今日重点”（任务 15）
      scheduler.ts               手动任务的去重（任务 2）
    ipc/register.ts              新通道（任务 4、16）
    index.ts                     组装（任务 2、4、5、16）
  renderer/src/
    job-view.ts                  手动运行结果的文案（任务 4）
    privacy-form.ts              隐私设置表单小工具（任务 17）
    audit-view.ts                审计页小工具（任务 18）
    brief-view.ts                + openRequest 跳过已忽略的 session（任务 4）、今日重点（任务 18）
    components/PrivacySettings.tsx（任务 17）、AuditPage.tsx（任务 18）
```

测试与源文件放在一起（`*.test.ts`）。`src/main/gateway/testing.ts` 只被测试 import，不会被打进主进程包。

---

### Task 1: `--setting-sources` 能力检查，以及真实仓库里的 MCP 来源实测（计划 2 遗留）

计划 2 遗留的两项：`REQUIRED_FLAGS` 里没有 `--setting-sources`，老版本的 claude 会让每一次后台运行都失败却没有健康告警；`--setting-sources user`（已在 `headlessArgs` 和 `PROBE_ARGS` 里）可能让项目级 `.mcp.json` 和本地级 MCP 在后台运行里消失，计划 2 只在临时目录里测过。本任务先补上能力检查，再在一个真实的 git 仓库里实测，结果决定任务 5 怎么做。

**Files:**
- Modify: `src/main/claude/capabilities.ts`
- Modify: `src/main/claude/capabilities.test.ts`
- Modify: `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md`（记录实测结果）

**Interfaces:**
- Consumes: `REQUIRED_FLAGS`、`parseFlags`、`probeClaude`（`src/main/claude/capabilities.ts`）
- Produces:
  - `REQUIRED_FLAGS` 增加 `"--setting-sources"`
  - 遗留清单里的 **Ruling P3-R1**：A/B/C/D 四次探测的结果，以及任务 5 走 “路线 A” 还是 “路线 B”、`INCLUDE_LOCAL_SCOPE` 取 `true` 还是 `false`

- [ ] **Step 1: 写失败测试**

`src/main/claude/capabilities.test.ts` 里，`HELP` 末尾（`--permission-mode` 那行之后）加一行：

```ts
  --setting-sources <sources>           Comma-separated list of setting sources to load (user, project, local)
```

并在 `describe("capabilities", ...)` 里追加：

```ts
  it("warns when claude is too old to know --setting-sources", async () => {
    const old = HELP.split("\n").filter((l) => !l.includes("--setting-sources")).join("\n");
    const run = async (_f: string, args: string[]) => (args[0] === "--version" ? "2.0.0" : old);
    const h = await probeClaude("/bin/claude", {}, run);
    expect(h.missingFlags).toEqual(["--setting-sources"]);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/claude/capabilities.test.ts`
Expected: FAIL，新用例里 `missingFlags` 是 `[]`

- [ ] **Step 3: 实现**

`src/main/claude/capabilities.ts` 的 `REQUIRED_FLAGS` 在 `"--permission-mode",` 之后加一行：

```ts
  /** 后台运行只读用户级设置（headlessArgs / PROBE_ARGS）。老版本没有它，每次后台运行都会失败。 */
  "--setting-sources",
```

设置页已经会把 `missingFlags` 显示成红字，不需要改界面。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/claude/capabilities.test.ts`
Expected: PASS

- [ ] **Step 5: 在真实 git 仓库里实测 MCP 来源（只读到 init，不产生模型输出）**

脚本在一个新的 git 仓库里放一个项目级 `.mcp.json`（server `butlerproj`，并在 `.claude/settings.local.json` 里批准它），再用 `claude mcp add --scope local` 加一个本地级 server `butlerlocal`。两个 server 都是脚本自己写的最小 stdio MCP。然后用和 `PROBE_ARGS` 相同的参数跑四次探测，每次读到 `system/init` 就杀掉整组进程：

- A：不带 `--setting-sources`（对照组）
- B：`--setting-sources user`（Butler 现在的做法）
- C：B + `--mcp-config <仓库>/.mcp.json`（任务 5 打算用来找回项目级 MCP 的办法）
- D：B + `--mcp-config <从 ~/.claude.json 导出的本地级配置>`（任务 5 打算用来找回本地级 MCP 的办法）

`claude mcp add/remove` 会修改 `~/.claude.json`（设了 `CLAUDE_CONFIG_DIR` 时是 `$CLAUDE_CONFIG_DIR/.claude.json`），但只动临时仓库那一个目录下的条目，脚本结束时会删除。运行前先备份一份到 `$S/claude.json.bak`，只在 `mcp remove` 失败时才用它手动恢复（不要无条件覆盖回去：正在运行的 claude 会持续改写这个文件）。如果执行者自己就在 Claude Code 里，`run` 已经去掉了外层会话的标记变量。整段在**一次** Bash 调用里执行：

```bash
set -u
S="$(cd "$(mktemp -d)" && pwd -P)"
mkdir -p "$S/bh" "$S/repo"
run() {
  env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SESSION_ATTENDED \
      -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
      -u CLAUDE_PID -u CLAUDE_CODE_SSE_PORT BUTLER_HOME="$S/bh" BUTLER_SESSION="headless:mcp-check" "$@"
}
cat > "$S/stub.cjs" <<'JS'
// 最小的 stdio MCP server：只回答 initialize 和 tools/list。
const rl = require("node:readline").createInterface({ input: process.stdin });
const name = process.argv[2];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "0.0.1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "get_item", description: "probe", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
JS
cat > "$S/probe.cjs" <<'JS'
// node probe.cjs <label> [额外参数...]：在当前目录起 headless claude，读到 init 就杀掉整组进程，只打印 butler* 的 MCP。
const { spawn } = require("node:child_process");
const [label, ...extra] = process.argv.slice(2);
const args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", "dontAsk", ...extra];
const c = spawn("claude", args, { stdio: ["pipe", "pipe", "ignore"], detached: true });
let buf = "";
let sawAssistant = false;
const kill = () => { try { process.kill(-c.pid, "SIGKILL"); } catch {} };
const timer = setTimeout(() => { console.log(JSON.stringify({ label, error: "timeout" })); kill(); }, 60000);
c.stdout.setEncoding("utf8");
c.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "assistant") sawAssistant = true;
    if (m.type === "system" && m.subtype === "init") {
      const servers = (m.mcp_servers || []).filter((s) => /^butler/.test(s.name)).map((s) => `${s.name}:${s.status}`);
      const tools = (m.tools || []).filter((t) => /butler/.test(t));
      console.log(JSON.stringify({ label, servers, tools, sawAssistant }));
      clearTimeout(timer);
      kill();
      return;
    }
  }
});
c.stdin.end("Reply with OK.");
JS
cd "$S/repo"
git init -q -b main
printf '{ "mcpServers": { "butlerproj": { "command": "node", "args": ["%s/stub.cjs", "butlerproj"] } } }\n' "$S" > .mcp.json
mkdir -p .claude && printf '{ "enabledMcpjsonServers": ["butlerproj"] }\n' > .claude/settings.local.json
git add .mcp.json && git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -qm init
CJ="${CLAUDE_CONFIG_DIR:+$CLAUDE_CONFIG_DIR/.claude.json}"; CJ="${CJ:-$HOME/.claude.json}"
cp "$CJ" "$S/claude.json.bak"
trap 'cd "$S/repo" && run claude mcp remove --scope local butlerlocal >/dev/null 2>&1; echo "local entries left: $(grep -c butlerlocal "$CJ" || true)"' EXIT
run claude --version
run claude mcp add --scope local butlerlocal -- node "$S/stub.cjs" butlerlocal
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).projects||{};const s=(p[process.argv[2]]||{}).mcpServers||{};fs.writeFileSync(process.argv[3],JSON.stringify({mcpServers:s}));console.log("local servers:",Object.keys(s))' "$CJ" "$S/repo" "$S/local.json"
run node "$S/probe.cjs" A
run node "$S/probe.cjs" B --setting-sources user
run node "$S/probe.cjs" C --setting-sources user --mcp-config "$S/repo/.mcp.json"
run node "$S/probe.cjs" D --setting-sources user --mcp-config "$S/local.json"
```

Expected：
- `local servers: [ 'butlerlocal' ]`，四行 JSON，每行 `sawAssistant: false`，最后打印 `local entries left: 0`。
- A 的 `servers` 同时有 `butlerproj` 和 `butlerlocal`（状态可以是 `connected` 或 `pending`；这里只看在不在列表里）。A 里缺任何一个，说明实验本身没搭好（例如 `.mcp.json` 没被批准），先修实验再看 B。

**判定**（写进下一步的 Ruling）：
- B 里 `butlerproj` 和 `butlerlocal` **都在** → 任务 5 走**路线 B**（只改提示文案，不加设置）。
- B 里至少缺一个 → 任务 5 走**路线 A**。B 里缺 `butlerlocal` 时 `INCLUDE_LOCAL_SCOPE = true`，否则为 `false`。此时 C 必须列出 `butlerproj`；`INCLUDE_LOCAL_SCOPE = true` 时 D 还必须列出 `butlerlocal`。不满足的话，任务 5 设计的办法不成立：**停下来**，把四行输出报告给 controller，不要自行发挥。
- 输出里出现 `"error":"timeout"`：重跑一次那一行；仍然超时就停下来报告。

- [ ] **Step 6: 记录结果**

在 `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md` 末尾追加（尖括号里填实际输出，不要保留尖括号）：

```markdown
# Plan 3 follow-ups

## Live checks
- Plan 3 Task 1 (claude <版本>): MCP sources in a real git repo cwd with a project `.mcp.json` (approved in `.claude/settings.local.json`) and a local-scope server
  - A default: <A 的 servers>
  - B `--setting-sources user`: <B 的 servers>
  - C B + `--mcp-config .mcp.json`: <C 的 servers>
  - D B + `--mcp-config <exported local servers>`: <D 的 servers>
  - no assistant message observed before kill in any run
- Ruling P3-R1: Task 5 takes route <A 或 B>; INCLUDE_LOCAL_SCOPE = <true 或 false> — <一句话理由> — cost if wrong: tracker MCP tools from .mcp.json / local scope unavailable to nightly handoffs (detectable in the probe)
```

- [ ] **Step 7: Commit**

```bash
git add src/main/claude/capabilities.ts src/main/claude/capabilities.test.ts docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md
git commit -m "feat: health check warns when claude lacks --setting-sources; record MCP source live check"
```

---

### Task 2: 路径、设置与调度的稳健性（计划 2 遗留）

计划 2 遗留的几个会悄悄出错的小问题：`BUTLER_HOME` 是相对路径时 Electron 的 `setPath` 直接崩；`normalizeSetting` 没有 default 分支；简报 JSON 里只有一半 `notices` 时会把 `undefined` 带进界面；晚间批量跨过午夜时按“现在”判断是不是今天的时刻；手动点“重新生成”如果排在一次调度的早间简报后面，会再跑一次（从本计划起每次早间简报都可能花个人 API 的钱）。另外为任务 5 先加上 `claudeJson`、`mcp` 两个路径。

**Files:**
- Modify: `src/main/paths.ts`、`src/main/paths.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/settings/settings-values.ts`、`src/main/settings/settings-values.test.ts`
- Modify: `src/main/db/briefs-repo.ts`、`src/main/db/handoff-repos.test.ts`
- Modify: `src/main/schedule/daily-jobs.ts`、`src/main/schedule/daily-jobs.test.ts`
- Modify: `src/main/schedule/scheduler.ts`、`src/main/schedule/scheduler.test.ts`

**Interfaces:**
- Consumes: `resolvePaths`、`ensureDirs`、`normalizeSetting`、`BriefsRepo`、`nightlyJob`、`Scheduler`
- Produces:
  - `ButlerPaths.claudeJson: string`（Claude Code 的全局配置文件，含本地级 MCP）
  - `ButlerPaths.mcp: string`（`~/.butler/mcp`，Butler 生成的 `--mcp-config` 文件放这里；`ensureDirs` 会创建）
  - `normalizeFlag(value: string): string`（`src/main/settings/settings-values.ts`，只接受 `"0"` / `"1"`）
  - `Scheduler.runNightlyNow()` / `runMorningNow()`：排队期间同名任务已经由调度跑过（开始时间晚于按按钮的时刻、且不是 seed 记录）时，这次手动请求直接完成，不再运行

- [ ] **Step 1: 写失败测试**

`src/main/paths.test.ts` 顶部的 import 改为 `import { join, resolve } from "node:path";`，并在 `describe("resolvePaths", ...)` 里追加：

```ts
  it("resolves a relative BUTLER_HOME against the current directory", () => {
    expect(resolvePaths({ BUTLER_HOME: "rel/b" }, "darwin", "/home/u").home).toBe(resolve("rel/b"));
  });

  it("finds Claude Code's global config in the config dir only when CLAUDE_CONFIG_DIR is set, and the mcp dir under BUTLER_HOME", () => {
    expect(resolvePaths({}, "darwin", "/home/u").claudeJson).toBe(join("/home/u", ".claude.json"));
    expect(resolvePaths({ CLAUDE_CONFIG_DIR: "/data/c" }, "darwin", "/home/u").claudeJson).toBe(join("/data/c", ".claude.json"));
    expect(resolvePaths({}, "darwin", "/home/u").mcp).toBe(join("/home/u", ".butler", "mcp"));
  });
```

`src/main/settings/settings-values.test.ts` 顶部加 `import type { EditableSettingKey } from "../../shared/settings";`，并在 `describe("settings values", ...)` 里追加：

```ts
  it("rejects a key that is not editable even if a caller forgets the IPC gate", () => {
    expect(() => normalizeSetting("claudePath" as EditableSettingKey, "/bin/sh")).toThrow(SettingError);
  });

  it("accepts only 0 or 1 for a flag", () => {
    expect(normalizeFlag(" 1 ")).toBe("1");
    expect(normalizeFlag("0")).toBe("0");
    expect(() => normalizeFlag("yes")).toThrow(SettingError);
  });
```

并把该文件 `./settings-values` 的 import 加上 `normalizeFlag`。

`src/main/db/handoff-repos.test.ts` 的 `describe("BriefsRepo / MarksRepo / JobsRepo / SettingsRepo", ...)` 里追加：

```ts
  it("fills in missing notice lists from an older or partial brief row", () => {
    const db = memDb();
    db.prepare(`INSERT INTO briefs (kind, date, created_at, items) VALUES ('morning', '2026-10-21', 1, ?)`).run(
      JSON.stringify({ items: [], notices: { degraded: ["A-1"] } }),
    );
    expect(new BriefsRepo(db).latest("morning")?.notices).toEqual({ degraded: ["A-1"], trackerUnavailable: [] });
  });
```

`src/main/schedule/daily-jobs.test.ts` 的 `describe("daily jobs", ...)` 里追加：

```ts
  it("nightly: a run that starts before midnight still notifies for its own day", async () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
    const times = [at(20, 23, 50), at(21, 0, 5)];
    const late = deps({ now: () => (times.length > 1 ? times.shift()! : times[0]) });
    await nightlyJob(late.d, at(20, 16));
    expect(late.calls).toEqual(["runNightly", "evening", "notify:evening"]);
  });
```

`src/main/schedule/scheduler.test.ts` 的 `describe("Scheduler", ...)` 里追加：

```ts
  it("a manual morning brief queued behind a scheduled one is not run again", async () => {
    let now = at(21, 9);
    let morning = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const jobs = new JobsRepo(memDb());
    jobs.record(JOB_NIGHTLY, at(19, 16, 1), "ok", null);
    jobs.record(JOB_MORNING, at(20, 9), "ok", null);
    const scheduler = new Scheduler({
      jobs, config: () => cfg, now: () => now, userActive: () => true,
      nightly: async () => {
        await gate;
        return "ok";
      },
      morning: async () => {
        morning++;
      },
    });
    // 解锁：先补跑昨天的晚间批量（卡在 gate 上），之后才是早间简报。
    const scheduled = scheduler.check("unlock");
    await Promise.resolve();
    expect(scheduler.isRunning(JOB_NIGHTLY)).toBe(true);
    // 用户这时点了“重新生成”。
    const manual = scheduler.runMorningNow();
    now = at(21, 9, 1);
    release();
    await Promise.all([scheduled, manual]);
    expect(morning).toBe(1);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/paths.test.ts src/main/settings/settings-values.test.ts src/main/db/handoff-repos.test.ts src/main/schedule/daily-jobs.test.ts src/main/schedule/scheduler.test.ts`
Expected: FAIL，新加的 7 个用例失败（`home` 不是绝对路径、`claudeJson` / `mcp` 为 undefined、`normalizeSetting` 返回 undefined 而不是抛错、`normalizeFlag` 不存在、`trackerUnavailable` 为 undefined、没有通知、`morning` 是 2）

- [ ] **Step 3: 实现**

`src/main/paths.ts` 改为：

```ts
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface ButlerPaths {
  home: string;
  db: string;
  inbox: string;
  inboxBad: string;
  bin: string;
  hookBin: string;
  logs: string;
  /** Butler 生成的 --mcp-config 文件。 */
  mcp: string;
  claudeConfigDir: string;
  claudeSettings: string;
  claudeProjects: string;
  claudeCommands: string;
  /** Claude Code 的全局配置（含本地级 MCP）：设了 CLAUDE_CONFIG_DIR 时在它下面，否则在 home 下。 */
  claudeJson: string;
}

/** 环境变量给的目录：相对路径按当前目录解析（Electron 的 setPath 只接受绝对路径）。 */
function dirFromEnv(v: string | undefined): string | null {
  const t = v?.trim();
  if (!t) return null;
  return isAbsolute(t) ? t : resolve(t);
}

export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): ButlerPaths {
  const butlerHome = dirFromEnv(env.BUTLER_HOME) ?? join(home, ".butler");
  const configOverride = dirFromEnv(env.CLAUDE_CONFIG_DIR);
  const claudeConfigDir = configOverride ?? join(home, ".claude");
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
    mcp: join(butlerHome, "mcp"),
    claudeConfigDir,
    claudeSettings: join(claudeConfigDir, "settings.json"),
    claudeProjects: join(claudeConfigDir, "projects"),
    claudeCommands: join(claudeConfigDir, "commands"),
    claudeJson: configOverride ? join(configOverride, ".claude.json") : join(home, ".claude.json"),
  };
}

export async function ensureDirs(p: ButlerPaths): Promise<void> {
  for (const dir of [p.home, p.inbox, p.inboxBad, p.bin, p.logs, p.mcp]) await mkdir(dir, { recursive: true });
}
```

`src/main/index.ts` 里隔离运行那两行改为（`resolvePaths` 已经 import）：

```ts
// 隔离运行（BUTLER_HOME 指向别的目录）时也换一个 Electron 用户目录，否则单实例锁会和正在用的 Butler 冲突。
// 用 resolvePaths 解析：相对路径会变成绝对路径（setPath 只接受绝对路径）。
if (process.env.BUTLER_HOME?.trim()) app.setPath("userData", join(resolvePaths().home, "electron"));
```

并删掉原来的 `const isolatedHome = process.env.BUTLER_HOME?.trim();` 一行。

`src/main/settings/settings-values.ts`：在 `parseDays` 之后加一个开关类设置的校验（任务 5、8 使用）：

```ts
/** 开关类设置：只接受 0 / 1。 */
export function normalizeFlag(value: string): string {
  const t = value.trim();
  if (t !== "0" && t !== "1") throw new SettingError("开关只能是 0 或 1");
  return t;
}
```

并在 `normalizeSetting` 里，`switch` 的最后一个 `case`（`handoffPrompt` / `refreshPrompt`）之后加：

```ts
    default: {
      // IPC 层已经用 isEditableSetting 拦过；这里再兜一次，免得以后新增的调用方绕过。
      const unknown: never = key;
      throw new SettingError(`这个设置不能在这里修改：${String(unknown)}`);
    }
```

`src/main/db/briefs-repo.ts`：import 里加上 `BriefNotices`，并把 `parseContent` 改为：

```ts
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function parseContent(text: string): BriefContent {
  try {
    const v = JSON.parse(text) as Partial<BriefContent> & { notices?: Partial<BriefNotices> };
    return {
      items: v.items ?? [],
      previousDay: v.previousDay ?? null,
      evening: v.evening ?? [],
      // 旧的或不完整的行：缺哪个列表就补成空的，界面不会拿到 undefined。
      notices: { degraded: list(v.notices?.degraded), trackerUnavailable: list(v.notices?.trackerUnavailable) },
    };
  } catch {
    return structuredClone(EMPTY_BRIEF_CONTENT);
  }
}
```

`src/main/schedule/daily-jobs.ts` 的 `nightlyJob` 改为：

```ts
/** 晚间：批量 handoff → 晚间小结 → 系统通知。 */
export async function nightlyJob(d: DailyJobDeps, slot?: number | null): Promise<"ok" | "partial"> {
  // 用开始时间判断“是不是今天的时刻”：批量跑过午夜也照常通知。
  const startedAt = d.now();
  // runner 的方法不是 async，可能同步抛错：包一层，让它变成 rejection 由调度器记录。
  const batch = await Promise.resolve().then(() => d.runner.runNightly());
  const brief = d.briefs.generateEvening();
  d.jobs.record(JOB_EVENING, d.now(), "ok", null);
  // 只在有内容、且跑的是今天的晚间时刻时通知；补跑以前日期的时刻不弹，早间简报里会看到。
  const forToday = slot === undefined || slot === null || localDate(slot) === localDate(startedAt);
  if (brief.evening.length > 0 && forToday && !d.aborted?.()) d.onEvening(brief);
  return batch.status;
}
```

`src/main/schedule/scheduler.ts`：import 改为 `import { JOB_MORNING, JOB_NIGHTLY, type JobsRepo, type JobState } from "../db/jobs-repo";`（不变），把 `manual` 方法改为下面两个方法：

```ts
  /**
   * 同名任务正在跑或已排队：返回已有的 promise，不再排第二个（连点按钮不会重复运行）。
   * 轮到它时，如果排队期间调度已经跑过同一个任务（开始时间晚于按按钮的时刻），这次就不再跑：
   * 早间简报会花个人 API 的额度，解锁和“重新生成”撞在一起时只跑一次。
   */
  private manual(name: typeof JOB_NIGHTLY | typeof JOB_MORNING, fn: () => Promise<void>): Promise<void> {
    const existing = this.queuedManual.get(name) ?? this.inflight.get(name);
    if (existing) return existing;
    const requestedAt = this.d.now();
    const p: Promise<void> = this.enqueue(() => (this.ranSince(name, requestedAt) ? Promise.resolve() : fn())).finally(() => {
      if (this.queuedManual.get(name) === p) this.queuedManual.delete(name);
    });
    this.queuedManual.set(name, p);
    return p;
  }

  /** seed 记录不算“跑过”（第一次启动时只是记一下时间）。 */
  private ranSince(name: typeof JOB_NIGHTLY | typeof JOB_MORNING, at: number): boolean {
    const j = this.d.jobs.get(name);
    return j.lastRunAt !== null && j.lastRunAt > at && j.lastStatus !== "seeded";
  }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/paths.test.ts src/main/settings/settings-values.test.ts src/main/db/handoff-repos.test.ts src/main/schedule/daily-jobs.test.ts src/main/schedule/scheduler.test.ts`
Expected: PASS（包括原有的“跑完以后可以再手动跑一次”：时钟不动时 `lastRunAt` 等于按按钮的时刻，不算“之后跑过”）

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/main/paths.ts src/main/paths.test.ts src/main/index.ts src/main/settings/settings-values.ts src/main/settings/settings-values.test.ts \
  src/main/db/briefs-repo.ts src/main/db/handoff-repos.test.ts src/main/schedule/daily-jobs.ts src/main/schedule/daily-jobs.test.ts \
  src/main/schedule/scheduler.ts src/main/schedule/scheduler.test.ts
git commit -m "fix: relative BUTLER_HOME, exhaustive setting check, partial brief notices, midnight-crossing nightly, no repeat manual run after a scheduled one"
```

---

### Task 3: headless 运行与 handoff 解析的小修（计划 2 遗留）

计划 2 遗留：stderr 里随便一个 `429`（行号、端口）就被当成限流，整批停发；超时不到一秒时报“超过 0 秒”；`BUTLER_LIVE_CLAUDE=0` 也会跑真 claude 的测试；` ```butler-handoffX ` 这种信息串也被当成 handoff 块，最后一个空块会盖住前面有效的块；git 报错在非英文系统上解析不出来，而且没有长度上限。

**Files:**
- Modify: `src/shared/text.ts`、`src/shared/text.test.ts`
- Modify: `src/main/claude/headless.ts`、`src/main/claude/headless.test.ts`
- Modify: `src/main/claude/headless.live.test.ts`
- Modify: `src/main/handoff/schema.ts`、`src/main/handoff/schema.test.ts`
- Modify: `src/main/tickets/git.ts`
- Create: `src/main/tickets/git.test.ts`

**Interfaces:**
- Consumes: `isRateLimited(r, stderr)`、`runHeadless`、`extractHandoffBlock(text)`、`git(cwd, args)`、`gitErrorSummary(e)`
- Produces:
  - `formatDuration(ms: number): string`（`src/shared/text.ts`；任务 11 的超时文案也用它）
  - `gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv`（`src/main/tickets/git.ts`）
  - `GIT_SUMMARY_LIMIT = 300`

- [ ] **Step 1: 写失败测试**

`src/shared/text.test.ts` 顶部 import 加上 `formatDuration`，追加：

```ts
describe("formatDuration", () => {
  it("never says 0 seconds", () => {
    expect(formatDuration(300)).toBe("300 毫秒");
    expect(formatDuration(1499)).toBe("1 秒");
    expect(formatDuration(5 * 60 * 1000)).toBe("300 秒");
  });
});
```

`src/main/claude/headless.test.ts` 的 `it("recognises rate limiting from the status or the text", ...)` 里，最后一个 `expect` 之后加：

```ts
    // stderr 里的数字（行号、端口）不算；只有 api_error_status 或 “API Error: 429/529” 才看状态码。
    expect(isRateLimited(null, "warning: config.ts:429: deprecated option")).toBe(false);
    expect(isRateLimited({ ...base, resultText: "API Error: 529 Overloaded" }, "")).toBe(true);
```

`src/main/handoff/schema.test.ts` 的 `it("takes the last butler-handoff block", ...)` 之后追加：

```ts
  it("ignores look-alike info strings and an empty last block", () => {
    expect(extractHandoffBlock('```butler-handoffX\n{"n":1}\n```')).toBeNull();
    expect(extractHandoffBlock('```butler-handoff json\n{"n":1}\n```')).toBe('{"n":1}');
    expect(extractHandoffBlock('```butler-handoff\n{"n":1}\n```\n```butler-handoff\n\n```')).toBe('{"n":1}');
  });
```

新建 `src/main/tickets/git.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { GIT_SUMMARY_LIMIT, GitError, gitEnv, gitErrorSummary } from "./git";

describe("git helpers", () => {
  it("runs git in the C locale so error lines are always English", () => {
    expect(gitEnv({ LANG: "de_DE.UTF-8", PATH: "/bin" })).toMatchObject({ LANG: "de_DE.UTF-8", LC_ALL: "C", PATH: "/bin" });
  });

  it("caps the summary shown to the user", () => {
    const e = new GitError("git x failed", `fatal: ${"a".repeat(1000)}\n`);
    expect(gitErrorSummary(e)).toHaveLength(GIT_SUMMARY_LIMIT);
    expect(gitErrorSummary(new GitError("m", "hint: x\nerror: bad ref\n"))).toBe("bad ref");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/shared/text.test.ts src/main/claude/headless.test.ts src/main/handoff/schema.test.ts src/main/tickets/git.test.ts`
Expected: FAIL（`formatDuration`、`gitEnv`、`GIT_SUMMARY_LIMIT` 不存在；stderr 的 429 被当成限流；`butler-handoffX` 被接受）

- [ ] **Step 3: 实现**

`src/shared/text.ts` 末尾追加：

```ts
/** 给用户看的时长：不到一秒时用毫秒，免得出现“超过 0 秒”。 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${Math.round(ms / 1000)} 秒`;
}
```

`src/main/claude/headless.ts`：顶部加 `import { formatDuration } from "../../shared/text";`；把 `RATE_LIMIT_RE` 和 `isRateLimited` 改为：

```ts
const RATE_LIMIT_TEXT_RE = /rate.?limit|usage limit|quota|overloaded|too many requests/i;
const API_ERROR_STATUS_RE = /\bAPI Error:\s*(?:429|529)\b/i;

/**
 * 额度用完或被限流（启发式）。只在运行失败时调用。
 * 状态码只看 api_error_status 和 result 里的 “API Error: 429/529”：stderr 里随便一个 429（行号、端口）不算。
 */
export function isRateLimited(r: ClaudeResult | null, stderr: string): boolean {
  if (r?.apiErrorStatus === 429 || r?.apiErrorStatus === 529) return true;
  if (API_ERROR_STATUS_RE.test(r?.resultText ?? "")) return true;
  return RATE_LIMIT_TEXT_RE.test(`${r?.resultText ?? ""}\n${stderr}`);
}
```

并把 `runHeadless` 里的 `timeoutOutcome` 改为：

```ts
    const timeoutOutcome = (): HeadlessOutcome => ({ ok: false, reason: "timeout", message: `超过 ${formatDuration(timeoutMs)} 没有完成`, result: null });
```

`src/main/claude/headless.live.test.ts` 的 `describe.skipIf(!process.env.BUTLER_LIVE_CLAUDE)` 改为：

```ts
describe.skipIf(process.env.BUTLER_LIVE_CLAUDE !== "1")("runHeadless against the real claude", () => {
```

`src/main/handoff/schema.ts` 的 `HANDOFF_BLOCK_RE` 和 `extractHandoffBlock` 改为：

```ts
/** 信息串必须正好是 butler-handoff，后面只能跟空白再接别的（```butler-handoffX 不算）。 */
const HANDOFF_BLOCK_RE = /```butler-handoff(?:[ \t][^\n]*)?\n([\s\S]*?)\n?```/g;

/** 最后一个非空的 ```butler-handoff 代码块的内容；没有就是 null。 */
export function extractHandoffBlock(text: string): string | null {
  const blocks = [...text.matchAll(HANDOFF_BLOCK_RE)].map((m) => m[1].trim()).filter(Boolean);
  return blocks.length ? blocks[blocks.length - 1] : null;
}
```

`src/main/tickets/git.ts`：把 `git` 函数改为下面这样，并在文件末尾改 `gitErrorSummary`：

```ts
/** git 一律在 C locale 下跑：gitErrorSummary 按英文的 fatal: / error: 前缀解析。 */
export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, LC_ALL: "C" };
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", args, { cwd, env: gitEnv(process.env), windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new GitError(`git ${args.join(" ")} failed: ${String(stderr).trim() || err.message}`, String(stderr)));
      else done(String(stdout).trim());
    });
  });
}
```

```ts
export const GIT_SUMMARY_LIMIT = 300;

/** git 报错里给用户看的那一句：第一行 fatal:/error: 的原因，去掉前缀，最多 300 字符。 */
export function gitErrorSummary(e: GitError): string {
  const lines = e.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? e.message;
  return line.replace(/^(fatal|error):\s*/i, "").slice(0, GIT_SUMMARY_LIMIT);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/shared/text.test.ts src/main/claude/headless.test.ts src/main/handoff/schema.test.ts src/main/tickets/git.test.ts src/main/tickets/ticket-service.test.ts`
Expected: PASS

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/shared/text.ts src/shared/text.test.ts src/main/claude/headless.ts src/main/claude/headless.test.ts src/main/claude/headless.live.test.ts \
  src/main/handoff/schema.ts src/main/handoff/schema.test.ts src/main/tickets/git.ts src/main/tickets/git.test.ts
git commit -m "fix: stricter rate-limit detection, readable short timeouts, exact butler-handoff blocks, C-locale git with capped summaries"
```

---

### Task 4: 界面与组装的小修（计划 2 遗留）

计划 2 遗留的界面问题：简报切标签时先闪出另一个标签的旧内容，慢的旧请求还会盖掉新的；“打开”可能恢复一个已经被忽略的 session；简报里点到一个不存在的 ticket 会跳到空白页并留下悬空的打开请求；`"；"` 写死在组件里；设置页第一次加载失败就永远停在“加载中”；tracker 文本框失焦不保存；连点两个工作日复选框时第二次用的是旧值；“立即运行晚间 handoff”和“重新生成”跑完没有任何反馈，失败了界面也说成功；错误条被新建 ticket 对话框挡住。主进程这边：没有 ticket 的 `/handoff` 输出被悄悄丢掉；session 发现可能同时跑两遍。

按计划 1 的 Ruling R2，组件、IPC 注册和 `index.ts` 不写单元测试；纯函数有测试，其余由“手动验证”覆盖。

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/db/jobs-repo.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/src/api.ts`
- Create: `src/renderer/src/job-view.ts`、`src/renderer/src/job-view.test.ts`
- Modify: `src/renderer/src/brief-view.ts`、`src/renderer/src/brief-view.test.ts`
- Modify: `src/renderer/src/components/BriefPage.tsx`
- Modify: `src/renderer/src/components/ScheduleSettings.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/strings.ts`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `JobsRepo.get(name)`、`Scheduler.runNightlyNow()` / `runMorningNow()`、`openRequest(item, ticket)`
- Produces:
  - `JobStateView { lastRunAt: number | null; lastStatus: string | null; lastError: string | null }`（`src/shared/types.ts`）；`JobState` 改为它的别名
  - IPC：`jobsRunNightly() → JobStateView | null`、`briefsRegenerate() → JobStateView | null`（退出中返回 null）；`IpcDeps` 增加 `jobs: JobsRepo`
  - `jobResultMessage(j: JobStateView): string`（`src/renderer/src/job-view.ts`）
  - `S.listSep`、`S.ticketMissing(key)`、`S.loadFailed(m)`、`S.retry`、`S.jobOk`、`S.jobPartial`、`S.jobFailed(m)`

- [ ] **Step 1: 写失败测试**

`src/renderer/src/brief-view.test.ts` 的 `it("opens the most recent session with the prefill, ...")` 里，最后一个 `expect` 之后加：

```ts
    // 已忽略的 session 不恢复，取下一个。
    const dismissed = { ...session("s3"), dismissed: true };
    expect(openRequest(item("next_step"), ticket([dismissed, session("s2")]))?.sessionId).toBe("s2");
    expect(openRequest(item("next_step"), ticket([dismissed]))).toEqual({ ticketKey: "A-1", prefill: "继续：改 staging 配置（来自 A-1）" });
```

新建 `src/renderer/src/job-view.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { jobResultMessage } from "./job-view";

describe("jobResultMessage", () => {
  it("tells the user how a manual run ended", () => {
    expect(jobResultMessage({ lastRunAt: 1, lastStatus: "ok", lastError: null })).toBe("已完成。");
    expect(jobResultMessage({ lastRunAt: 1, lastStatus: "partial", lastError: null })).toContain("早间简报前会补跑");
    expect(jobResultMessage({ lastRunAt: 1, lastStatus: "failed", lastError: "找不到 claude 命令" })).toBe("运行失败：找不到 claude 命令");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/renderer/src/brief-view.test.ts src/renderer/src/job-view.test.ts`
Expected: FAIL（恢复了已忽略的 `s3`；`./job-view` 不存在）

- [ ] **Step 3: 共享类型、IPC 与主进程**

`src/shared/types.ts` 末尾追加：

```ts
/** 一个调度任务最近一次运行的结果（jobs 表）。手动运行的按钮用它显示结果。 */
export interface JobStateView {
  lastRunAt: number | null;
  /** ok | partial | failed | seeded */
  lastStatus: string | null;
  lastError: string | null;
}
```

`src/main/db/jobs-repo.ts`：删掉 `JobState` 接口，换成

```ts
import type { JobStateView } from "../../shared/types";

export type JobState = JobStateView;
```

（`import` 放在文件顶部，和 `import type { Db } from "./database";` 放在一起。）

`src/main/ipc/register.ts`：
- import 加上 `import { JOB_MORNING, JOB_NIGHTLY, type JobsRepo } from "../db/jobs-repo";`，并在 `../../shared/types` 的 import 里加上 `type JobStateView`。
- `IpcDeps` 里 `scheduler: Scheduler;` 之后加 `jobs: JobsRepo;`。
- `briefsRegenerate` 和 `jobsRunNightly` 两个处理器改为：

```ts
  handle(IPC.briefsRegenerate, async (): Promise<JobStateView | null> => {
    if (d.aborted()) return null;
    await d.scheduler.runMorningNow();
    d.notify();
    // 调度器把失败记在 jobs 表里而不是抛出：把结果交给界面显示。
    return d.jobs.get(JOB_MORNING);
  });
```

```ts
  handle(IPC.jobsRunNightly, async (): Promise<JobStateView | null> => {
    if (d.aborted()) return null;
    await d.scheduler.runNightlyNow();
    d.notify();
    return d.jobs.get(JOB_NIGHTLY);
  });
```

`src/main/index.ts`：
1. `registerIpc({ ... })` 的参数里，`scheduler,` 之后加 `jobs,`。
2. Stop 之后采集 `/handoff` 的那段 `.then(...)` 改为：

```ts
        void captureCommandHandoff({ sessions, tickets, ingest }, stop).then(
          (r) => {
            if (r?.stored) notify();
            // session 没有归属 ticket、输出里的 ticket 号也不存在：记一笔，免得用户以为采集坏了。
            else if (r && r.reason === "no_ticket") logger(`/handoff output in session ${stop.sessionId} names no known ticket; not stored`);
          },
          (e: unknown) => logger("capture /handoff failed", e),
        );
```

3. `runDiscovery` 改为不会同时跑两遍（运行中再被触发就在结束后再跑一次）：

```ts
  const discoverOnce = async () => {
    try {
      const found = await scanClaudeProjects(paths.claudeProjects, Date.now() - UNCLAIMED_WINDOW_MS);
      syncDiscovered(found, sessions, Date.now());
      // 只有扫描真的找到了某个待补全 session 的 transcript，才记为本次运行已扫描过。
      for (const f of found) if (discoveryPending.delete(f.id)) discoveryRequested.add(f.id);
      notify();
    } catch (e) {
      logger("discovery failed", e);
    }
  };
  let discovering = false;
  let discoverAgain = false;
  /** 同一时间只有一次扫描；扫描中又被触发（hook、定时器）就在结束后再扫一次。 */
  const runDiscovery = async (): Promise<void> => {
    if (discovering) {
      discoverAgain = true;
      return;
    }
    discovering = true;
    try {
      do {
        discoverAgain = false;
        await discoverOnce();
      } while (discoverAgain);
    } finally {
      discovering = false;
    }
  };
```

`discoveryRequested` 和 `discoveryPending` 两个 `Set` 的声明保持在原来的位置即可：闭包在调用时才读取它们，而第一次调用 `runDiscovery` 在它们声明之后。

`src/renderer/src/api.ts`：`../../shared/types` 的 import 加上 `JobStateView`，两个方法改为：

```ts
  regenerateBrief: () => call<JobStateView | null>(IPC.briefsRegenerate),
```

```ts
  runNightly: () => call<JobStateView | null>(IPC.jobsRunNightly),
```

- [ ] **Step 4: 渲染进程**

新建 `src/renderer/src/job-view.ts`：

```ts
import type { JobStateView } from "../../shared/types";
import { S } from "./strings";

/** 手动运行（晚间 handoff、重新生成简报）结束后给用户看的一句话。 */
export function jobResultMessage(j: JobStateView): string {
  if (j.lastStatus === "partial") return S.jobPartial;
  if (j.lastStatus === "failed") return S.jobFailed(j.lastError ?? "");
  return S.jobOk;
}
```

`src/renderer/src/brief-view.ts` 的 `openRequest` 里，`const recent = ticket.sessions[0];` 改为：

```ts
  // 已忽略的 session 不恢复（ticket.sessions 已按最近活动排序）。
  const recent = ticket.sessions.find((s) => !s.dismissed);
```

`src/renderer/src/strings.ts` 的 `S` 里（`close: "关闭",` 之后）加：

```ts
  listSep: "；",
  ticketMissing: (key: string) => `找不到 ticket ${key}（可能已经归档）。`,
  loadFailed: (m: string) => `读取失败：${m}`,
  retry: "重试",
  jobOk: "已完成。",
  jobPartial: "部分 ticket 没有完成（失败或被限流），早间简报前会补跑。",
  jobFailed: (m: string) => `运行失败：${m}`,
```

`src/renderer/src/components/BriefPage.tsx` 整个文件改为：

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { Brief, BriefItem, BriefKind, BriefView } from "../../../shared/brief";
import type { OpenSessionRequest, TicketView } from "../../../shared/types";
import { api } from "../api";
import { groupItems, itemActions, itemTitle, openRequest, type ItemAction } from "../brief-view";
import { reportError } from "../errors";
import { jobResultMessage } from "../job-view";
import { S } from "../strings";

interface Props {
  /** 从系统通知进来时要显示的标签。 */
  initialKind?: BriefKind;
  tickets: TicketView[];
  onOpenTicket: (key: string, req?: OpenSessionRequest) => void;
  onUnclaimed: () => void;
}

const MARK = { done: "done", snooze: "snoozed", ignore: "ignored" } as const;

export function BriefPage({ initialKind, tickets, onOpenTicket, onUnclaimed }: Props) {
  const [kind, setKind] = useState<BriefKind>(initialKind ?? "morning");
  /** 记下数据属于哪个标签：切换标签时不会先闪出另一个标签的旧内容。 */
  const [loaded, setLoaded] = useState<{ kind: BriefKind; view: BriefView } | null>(null);
  const [busy, setBusy] = useState(false);
  /** 只采用最后一次请求的结果：慢的旧请求不会盖掉新的。 */
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const view = await api.briefLatest(kind);
      if (mine === seq.current) setLoaded({ kind, view });
    } catch (e) {
      if (mine === seq.current) reportError(e);
    }
  }, [kind]);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  async function act(item: BriefItem, action: ItemAction) {
    if (action === "claim") {
      onUnclaimed();
      return;
    }
    if (action === "open") {
      if (item.ticketKey) onOpenTicket(item.ticketKey, openRequest(item, tickets.find((t) => t.key === item.ticketKey)) ?? undefined);
      return;
    }
    try {
      if (item.followupId) await api.setFollowupStatus(item.followupId, MARK[action]);
      else await api.markBriefItem(item.key, MARK[action]);
    } catch (e) {
      reportError(e);
    }
  }

  async function regenerate() {
    setBusy(true);
    try {
      const job = await api.regenerateBrief();
      if (job?.lastStatus === "failed") reportError(new Error(jobResultMessage(job)));
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  const view = loaded?.kind === kind ? loaded.view : null;
  const brief = view?.brief ?? null;
  return (
    <div className="page brief">
      <header className="brief-header">
        <div className="tabs">
          <button className={kind === "morning" ? "tab active" : "tab"} onClick={() => setKind("morning")}>{S.morningBrief}</button>
          <button className={kind === "evening" ? "tab active" : "tab"} onClick={() => setKind("evening")}>{S.eveningBrief}</button>
        </div>
        {brief && <span className="muted">{brief.date}</span>}
        {view?.refreshing && <span className="muted">{S.briefRefreshing}</span>}
        {kind === "morning" && (
          <button disabled={busy || view?.refreshing === true} onClick={() => void regenerate()}>{S.regenerate}</button>
        )}
      </header>
      {!view ? (
        <p className="muted">{S.loading}</p>
      ) : !brief ? (
        <p className="empty">{kind === "morning" ? S.noBrief : S.noEvening}</p>
      ) : kind === "morning" ? (
        <MorningBody brief={brief} onAct={(i, a) => void act(i, a)} onOpenTicket={(key) => onOpenTicket(key)} />
      ) : (
        <EveningBody brief={brief} onOpenTicket={(key) => onOpenTicket(key)} />
      )}
    </div>
  );
}

function Notices({ brief }: { brief: Brief }) {
  const { degraded, trackerUnavailable } = brief.notices;
  return (
    <>
      {degraded.length > 0 && <p className="notice-line">{S.noticeDegraded(degraded)}</p>}
      {trackerUnavailable.length > 0 && <p className="notice-line">{S.noticeTracker(trackerUnavailable)}</p>}
    </>
  );
}

function DoneList({ items }: { items: string[] }) {
  return (
    <ul className="day-list">
      {items.map((d, n) => (
        <li key={n}>{d}</li>
      ))}
    </ul>
  );
}

function MorningBody({ brief, onAct, onOpenTicket }: { brief: Brief; onAct: (i: BriefItem, a: ItemAction) => void; onOpenTicket: (key: string) => void }) {
  const groups = groupItems(brief.items);
  return (
    <>
      {brief.narrativeStatus === "ok" && brief.narrative && (
        <section className="narrative">
          <h3>{S.todayFocus}</h3>
          <p>{brief.narrative}</p>
        </section>
      )}
      <Notices brief={brief} />
      {groups.length === 0 && <p className="empty">{S.briefEmpty}</p>}
      {groups.map((g) => (
        <section key={g.section} className="brief-section">
          <h3>{S.briefSections[g.section]}</h3>
          {g.items.map((i) => (
            <div key={i.key} className="brief-item">
              {i.ticketKey && <button className="chip" onClick={() => onOpenTicket(i.ticketKey!)}>{i.ticketKey}</button>}
              <span className="text">{itemTitle(i)}</span>
              <span className="actions">
                {itemActions(i).map((a) => (
                  <button key={a} className={a === "open" || a === "claim" ? "primary" : ""} onClick={() => onAct(i, a)}>
                    {S.itemActions[a]}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
      {brief.previousDay && (
        <section className="brief-section">
          <h3>{S.previousDay(brief.previousDay.date)}</h3>
          {brief.previousDay.entries.length === 0 && <p className="muted">{S.previousDayEmpty}</p>}
          {brief.previousDay.entries.map((e) => (
            <div key={e.ticketKey}>
              <button className="chip" onClick={() => onOpenTicket(e.ticketKey)}>{e.ticketKey}</button>
              <DoneList items={e.done} />
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function EveningBody({ brief, onOpenTicket }: { brief: Brief; onOpenTicket: (key: string) => void }) {
  return (
    <>
      <Notices brief={brief} />
      {brief.evening.length === 0 && <p className="empty">{S.noEvening}</p>}
      {brief.evening.map((e) => (
        <div key={e.ticketKey} className="evening-entry">
          <button className="chip" onClick={() => onOpenTicket(e.ticketKey)}>{e.ticketKey}</button>
          {e.degraded && <span className="error"> {S.eveningDegraded}</span>}
          {e.done.length > 0 ? <DoneList items={e.done} /> : <p className="muted">{S.eveningNothingDone}</p>}
          {e.blockers.length > 0 && <p>{S.eveningBlockers}{e.blockers.join(S.listSep)}</p>}
          {e.next && <p>{S.eveningNext}{e.next}</p>}
        </div>
      ))}
    </>
  );
}
```

`src/renderer/src/App.tsx` 的 `openTicket` 改为：

```tsx
  const openTicket = (key: string, req?: OpenSessionRequest) => {
    // 简报里的 ticket 可能已经归档：不跳到空白页，也不留下悬空的打开请求。
    if (!tickets.some((t) => t.key === key)) {
      reportError(new Error(S.ticketMissing(key)));
      return;
    }
    setPendingOpen(req ?? null);
    setRoute({ page: "ticket", key });
  };
```

`src/renderer/src/components/ScheduleSettings.tsx`：
1. 第一行 import 改为 `import { useCallback, useEffect, useRef, useState } from "react";`，并加 `import { jobResultMessage } from "../job-view";`。
2. state 声明里加三行：

```tsx
  const [loadError, setLoadError] = useState<string | null>(null);
  const [daysBusy, setDaysBusy] = useState(false);
  const [nightlyMessage, setNightlyMessage] = useState<string | null>(null);
  /** 第一次加载成功之后，后续的刷新失败走全局错误条。 */
  const loadedOnce = useRef(false);
```

3. `load` 改为：

```tsx
  const load = useCallback(async () => {
    try {
      setValues(await api.settings());
      setLoadError(null);
      loadedOnce.current = true;
    } catch (e) {
      if (loadedOnce.current) reportError(e);
      else setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
```

4. `if (!values) return <p className="muted">{S.loading}</p>;` 改为：

```tsx
  if (!values)
    return loadError ? (
      <p className="error">
        {S.loadFailed(loadError)} <button onClick={() => void load()}>{S.retry}</button>
      </p>
    ) : (
      <p className="muted">{S.loading}</p>
    );
```

5. `runNightly` 改为，并在它后面加 `toggleWorkingDay`：

```tsx
  async function runNightly() {
    setNightlyBusy(true);
    setNightlyMessage(null);
    try {
      const job = await api.runNightly();
      if (job) setNightlyMessage(jobResultMessage(job));
    } catch (e) {
      reportError(e);
    } finally {
      setNightlyBusy(false);
    }
  }

  /** 保存完成（并重新读取）之前不接受下一次点击：第二次点击总是基于最新的值。 */
  async function toggleWorkingDay(day: number) {
    setDaysBusy(true);
    try {
      await save("workingDays", toggleDay(current.workingDays, day));
    } finally {
      setDaysBusy(false);
    }
  }
```

6. 工作日复选框改为：

```tsx
              <input type="checkbox" checked={hasDay(current.workingDays, day)} disabled={daysBusy} onChange={() => void toggleWorkingDay(day)} />
```

7. tracker 文本框加失焦保存：

```tsx
        <textarea rows={4} className="mono" value={value("trackerTools")} onChange={(e) => edit("trackerTools", e.target.value)} onBlur={() => saveIfEdited("trackerTools")} />
```

8. 最后的“立即运行晚间 handoff”那一块改为：

```tsx
      <div className="actions">
        <button disabled={nightlyBusy} onClick={() => void runNightly()}>{nightlyBusy ? S.nightlyRunning : S.runNightlyNow}</button>
        {nightlyMessage && <span className="muted">{nightlyMessage}</span>}
      </div>
```

`src/renderer/src/styles.css`：
- `.modal-backdrop { ... }` 那一行的花括号里末尾加 `z-index: 10;`
- `.error-banner { ... }` 那一行的花括号里末尾加 `position: relative; z-index: 20;`（错误条压在对话框遮罩上面）

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm exec vitest run src/renderer/src/brief-view.test.ts src/renderer/src/job-view.test.ts`
Expected: PASS

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/shared/types.ts src/main/db/jobs-repo.ts src/main/ipc/register.ts src/main/index.ts src/renderer/src/api.ts \
  src/renderer/src/job-view.ts src/renderer/src/job-view.test.ts src/renderer/src/brief-view.ts src/renderer/src/brief-view.test.ts \
  src/renderer/src/components/BriefPage.tsx src/renderer/src/components/ScheduleSettings.tsx src/renderer/src/App.tsx \
  src/renderer/src/strings.ts src/renderer/src/styles.css
git commit -m "fix: brief tabs never show stale data, skip dismissed sessions, manual runs report their result, settings load retry and safer saves"
```

---

### Task 5: 后台运行的项目级 MCP（按任务 1 的实测结果）

**Step 0 决定本任务走哪条路线**：读遗留清单里的 Ruling P3-R1。

- **路线 B**（B 探测里两个 server 都在）：只做 Step B1–B2。
- **路线 A**（B 探测里至少缺一个）：做 Step A1–A7，`INCLUDE_LOCAL_SCOPE` 按 Ruling 取值。

后台运行用 `--setting-sources user`，是为了不让仓库里的 `.claude/settings*.json`（仓库的人能写）给无人值守的运行加 allow 规则或 hook，所以**不能**为了找回 MCP 把 `project` / `local` 加回 `--setting-sources`。路线 A 改用 `--mcp-config` 显式挂上 MCP 配置文件：它只加载 MCP server，不加载那些设置。这是用户主动打开的开关：打开后会启动仓库 `.mcp.json` 里的 MCP server。

**Files（路线 A）:**
- Create: `src/main/claude/project-mcp.ts`、`src/main/claude/project-mcp.test.ts`
- Modify: `src/main/claude/headless.ts`、`src/main/claude/headless.test.ts`
- Modify: `src/main/claude/mcp-probe.ts`、`src/main/claude/mcp-probe.test.ts`
- Modify: `src/main/handoff/runner.ts`、`src/main/handoff/runner.test.ts`
- Modify: `src/main/db/settings-repo.ts`、`src/shared/settings.ts`、`src/main/settings/settings-values.ts`、`src/main/settings/settings-values.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/src/components/ScheduleSettings.tsx`、`src/renderer/src/strings.ts`

**Files（路线 B）:**
- Modify: `src/renderer/src/strings.ts`

**Interfaces（路线 A）:**
- Consumes: `ButlerPaths.claudeJson`、`ButlerPaths.mcp`（任务 2）、`headlessArgs`、`probeMcpTools`、`HandoffRunner`
- Produces:
  - `INCLUDE_LOCAL_SCOPE: boolean`、`projectMcpConfigs(cwd: string, p: { claudeJson: string; mcpDir: string }): string[]`（`src/main/claude/project-mcp.ts`）
  - `headlessArgs({ schema, resumeSessionId?, allowedTools, mcpConfigs? })`：`mcpConfigs` 非空时在 `--disallowedTools` 之前插入 `--mcp-config <文件...>`
  - `probeMcpTools({ ..., mcpConfigs? })`
  - `HandoffRunnerDeps.projectMcp?: (cwd: string) => string[]`；设置 `headlessProjectMcp` 为 `"1"` 时才调用
  - 可编辑设置 `headlessProjectMcp`（`"0"` / `"1"`，默认 `"0"`）

#### 路线 B

- [ ] **Step B1: 改提示文案**

`src/renderer/src/strings.ts` 的 `trackerHint` 改为：

```ts
  trackerHint: "例如 mcp__atlassian__getJiraIssue。只选读取类的工具：handoff 是只读的。后台 handoff 只读你的用户级 Claude Code 设置，但仓库 .mcp.json 和本地级的 MCP 照常加载（计划 3 实测）。",
```

- [ ] **Step B2: 检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/renderer/src/strings.ts
git commit -m "docs: tracker hint says project and local MCP servers still load for background handoffs"
```

#### 路线 A

- [ ] **Step A1: 写失败测试**

新建 `src/main/claude/project-mcp.test.ts`：

```ts
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { INCLUDE_LOCAL_SCOPE, projectMcpConfigs } from "./project-mcp";

function setup() {
  const root = tempDir("butler-mcp-");
  const repo = join(root, "repo");
  const mcpDir = join(root, "mcp");
  mkdirSync(repo);
  mkdirSync(mcpDir);
  return { root, repo, mcpDir, claudeJson: join(root, ".claude.json") };
}

describe("projectMcpConfigs", () => {
  it("returns the repo's .mcp.json when it defines servers, and nothing for a missing, empty or broken file", () => {
    const s = setup();
    const p = { claudeJson: s.claudeJson, mcpDir: s.mcpDir };
    expect(projectMcpConfigs(s.repo, p)).toEqual([]);
    writeFileSync(join(s.repo, ".mcp.json"), "{ broken");
    expect(projectMcpConfigs(s.repo, p)).toEqual([]);
    writeFileSync(join(s.repo, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    expect(projectMcpConfigs(s.repo, p)).toEqual([]);
    writeFileSync(join(s.repo, ".mcp.json"), `﻿${JSON.stringify({ mcpServers: { jira: { command: "node", args: ["x"] } } })}`);
    expect(projectMcpConfigs(s.repo, p)).toEqual([join(s.repo, ".mcp.json")]);
  });

  it.skipIf(!INCLUDE_LOCAL_SCOPE)("exports this directory's local-scope servers to a private file under the mcp dir", () => {
    const s = setup();
    const servers = { linear: { command: "node", args: ["l"], env: { TOKEN: "t" } } };
    writeFileSync(s.claudeJson, JSON.stringify({ projects: { [s.repo]: { mcpServers: servers }, "/other": { mcpServers: { x: {} } } } }));
    const [file] = projectMcpConfigs(s.repo, { claudeJson: s.claudeJson, mcpDir: s.mcpDir });
    expect(file.startsWith(s.mcpDir)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: servers });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // 写不进去（目录不存在）时跳过本地级，不抛错。
    expect(projectMcpConfigs(s.repo, { claudeJson: s.claudeJson, mcpDir: join(s.root, "missing") })).toEqual([]);
  });
});
```

`src/main/claude/headless.test.ts` 的 `describe("headlessArgs", ...)` 里追加：

```ts
  it("adds --mcp-config files before the variadic tool lists", () => {
    const args = headlessArgs({ schema: "{}", allowedTools: ["Read"], mcpConfigs: ["/r/.mcp.json", "/b/mcp/local.json"] });
    const i = args.indexOf("--mcp-config");
    expect(args.slice(i, i + 3)).toEqual(["--mcp-config", "/r/.mcp.json", "/b/mcp/local.json"]);
    expect(args[i + 3]).toBe("--disallowedTools");
    expect(headlessArgs({ schema: "{}", allowedTools: ["Read"], mcpConfigs: [] })).not.toContain("--mcp-config");
  });
```

`src/main/claude/mcp-probe.test.ts` 的 `describe("probeMcpTools", ...)` 里追加：

```ts
  it("passes extra --mcp-config files to the probe", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, `emit(${JSON.stringify(INIT)}); setTimeout(() => {}, 60000);`);
    await probeMcpTools({ claudePath: fake.path, cwd: dir, env: env(), mcpConfigs: ["/r/.mcp.json"] });
    expect(fake.calls()[0].args.slice(-2)).toEqual(["--mcp-config", "/r/.mcp.json"]);
  }, 20_000);
```

`src/main/handoff/runner.test.ts`：
1. `function setup(opts: { run?: HeadlessRun; signal?: AbortSignal } = {})` 改为 `function setup(opts: { run?: HeadlessRun; signal?: AbortSignal; projectMcp?: (cwd: string) => string[] } = {})`，并在 `new HandoffRunner({ ... })` 的参数里 `signal: opts.signal,` 之后加 `projectMcp: opts.projectMcp,`。
2. 在 `describe("HandoffRunner", ...)` 里追加：

```ts
  it("attaches project MCP configs only when the setting is on", async () => {
    const seen: string[] = [];
    const { runner, addTicket, calls, settings } = setup({
      projectMcp: (cwd) => {
        seen.push(cwd);
        return [`${cwd}/.mcp.json`];
      },
    });
    addTicket("A-1");
    await runner.runManual("A-1");
    expect(calls[0].args).not.toContain("--mcp-config");
    expect(seen).toEqual([]);
    settings.set("headlessProjectMcp", "1");
    await runner.runManual("A-1");
    expect(seen).toEqual(["/w/A-1"]);
    const args = calls[1].args;
    expect(args.slice(args.indexOf("--mcp-config"), args.indexOf("--mcp-config") + 2)).toEqual(["--mcp-config", "/w/A-1/.mcp.json"]);
  });

  it("keeps running without project MCP when building the configs throws", async () => {
    const { runner, addTicket, calls, settings } = setup({
      projectMcp: () => {
        throw new Error("EACCES");
      },
    });
    settings.set("headlessProjectMcp", "1");
    addTicket("A-1");
    expect(await runner.runManual("A-1")).toMatchObject({ status: "stored" });
    expect(calls[0].args).not.toContain("--mcp-config");
  });
```

`src/main/settings/settings-values.test.ts` 的 `it("normalizes editable values ...")` 里加：

```ts
    expect(normalizeSetting("headlessProjectMcp", "1")).toBe("1");
    expect(normalizeSetting("headlessProjectMcp", " 0 ")).toBe("0");
    expect(() => normalizeSetting("headlessProjectMcp", "yes")).toThrow(SettingError);
```

- [ ] **Step A2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/claude src/main/handoff/runner.test.ts src/main/settings/settings-values.test.ts`
Expected: FAIL（`./project-mcp` 不存在；`mcpConfigs` 未被使用；`headlessProjectMcp` 不是设置键）

- [ ] **Step A3: 实现 project-mcp 与参数**

新建 `src/main/claude/project-mcp.ts`（`INCLUDE_LOCAL_SCOPE` 按 Ruling P3-R1 取值）：

```ts
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 计划 3 任务 1 的实测（Ruling P3-R1）：--setting-sources user 下本地级（~/.claude.json 里按目录记录的）MCP 会不会丢。
 * 会丢时为 true：把它导出成 --mcp-config 文件挂回去。
 */
export const INCLUDE_LOCAL_SCOPE = true;

export interface ProjectMcpPaths {
  claudeJson: string;
  /** ~/.butler/mcp */
  mcpDir: string;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

const isServerMap = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** ~/.claude.json 里这个目录的本地级 server；Windows 上 claude 记录的路径可能是正斜杠。 */
function localServers(cwd: string, claudeJson: string): Record<string, unknown> | null {
  const projects = (readJson(claudeJson) as { projects?: unknown } | undefined)?.projects;
  if (!projects || typeof projects !== "object") return null;
  const map = projects as Record<string, { mcpServers?: unknown } | undefined>;
  for (const key of new Set([cwd, realpathOr(cwd), cwd.replace(/\\/g, "/")])) {
    const servers = map[key]?.mcpServers;
    if (isServerMap(servers)) return servers;
  }
  return null;
}

/**
 * 后台运行要额外挂上的 --mcp-config 文件：仓库的 .mcp.json，以及（INCLUDE_LOCAL_SCOPE 时）
 * ~/.claude.json 里这个目录的本地级 MCP（导出成只有自己能读的文件，里面可能有 token）。
 * 任何一步失败都跳过那一项，不抛错。
 */
export function projectMcpConfigs(cwd: string, p: ProjectMcpPaths): string[] {
  const out: string[] = [];
  const project = join(cwd, ".mcp.json");
  if (isServerMap((readJson(project) as { mcpServers?: unknown } | undefined)?.mcpServers)) out.push(project);
  if (INCLUDE_LOCAL_SCOPE) {
    const servers = localServers(cwd, p.claudeJson);
    if (servers) {
      const file = join(p.mcpDir, `local-${createHash("sha1").update(cwd).digest("hex").slice(0, 12)}.json`);
      try {
        writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
        // 文件已存在时 writeFileSync 不改权限。
        chmodSync(file, 0o600);
        out.push(file);
      } catch {
        // mcp 目录不可写：这次不挂本地级 MCP。
      }
    }
  }
  return out;
}
```

`src/main/claude/headless.ts` 的 `headlessArgs` 改为：

```ts
export function headlessArgs(o: { schema: string; resumeSessionId?: string; allowedTools: string[]; mcpConfigs?: string[] }): string[] {
  const args = ["-p", "--output-format", "json", "--json-schema", o.schema, "--no-session-persistence", "--permission-mode", "dontAsk", ...SETTING_SOURCES_ARGS];
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId, "--fork-session");
  // --mcp-config 也是可变参数：放在 --disallowedTools 之前，由下一个 flag 截断。
  if (o.mcpConfigs?.length) args.push("--mcp-config", ...o.mcpConfigs);
  args.push("--disallowedTools", ...DENIED_TOOLS, "--allowedTools", ...o.allowedTools);
  return args;
}
```

`src/main/claude/mcp-probe.ts`：`probeMcpTools` 的参数类型加上 `mcpConfigs?: string[]`，函数体开头加

```ts
    const args = o.mcpConfigs?.length ? [...PROBE_ARGS, "--mcp-config", ...o.mcpConfigs] : PROBE_ARGS;
```

并把函数里两处 `PROBE_ARGS`（`unsafeCmdArg(PROBE_ARGS, ...)` 和 `spawn(o.claudePath, PROBE_ARGS, ...)`）都换成 `args`。

- [ ] **Step A4: 设置与 runner**

`src/main/db/settings-repo.ts` 的 `SETTING_DEFAULTS` 里 `trackerTools` 之后加：

```ts
  /** 后台 handoff / 刷新 / 探测也挂上仓库 .mcp.json（和本地级）的 MCP：1 开 0 关。 */
  headlessProjectMcp: "0",
```

`src/shared/settings.ts` 的 `EDITABLE_SETTINGS` 里 `"trackerTools",` 之后加 `"headlessProjectMcp",`。

`src/main/settings/settings-values.ts` 的 `normalizeSetting` 的 `switch` 里 `case "trackerTools": { ... }` 之后加：

```ts
    case "headlessProjectMcp":
      return normalizeFlag(value);
```

（`normalizeFlag` 由任务 2 加入。）

`src/main/handoff/runner.ts`：
1. `HandoffRunnerDeps` 里 `signal?: AbortSignal;` 之前加：

```ts
  /** 设置 headlessProjectMcp 打开时调用：这个目录要额外挂的 --mcp-config 文件（计划 3 任务 5）。 */
  projectMcp?: (cwd: string) => string[];
```

2. `allowedTools()` 之后加：

```ts
  private mcpConfigs(cwd: string): string[] {
    if (this.d.settings.get("headlessProjectMcp") !== "1" || !this.d.projectMcp) return [];
    try {
      return this.d.projectMcp(cwd);
    } catch (e) {
      this.d.log?.("project MCP config failed; running without it", e);
      return [];
    }
  }
```

3. `full()` 里 `const args = headlessArgs({ ... })` 改为：

```ts
    const args = headlessArgs({ schema: HANDOFF_JSON_SCHEMA, resumeSessionId: session?.id, allowedTools: this.allowedTools(), mcpConfigs: this.mcpConfigs(cwd) });
```

4. `refresh()` 里 `const args = headlessArgs({ ... })` 改为：

```ts
    const cwd = this.d.workDir(t);
    const args = headlessArgs({ schema: REFRESH_JSON_SCHEMA, allowedTools: this.allowedTools(), mcpConfigs: this.mcpConfigs(cwd) });
    const attempt = await this.exec(key, args, prompt, cwd);
```

（删掉原来那行 `const attempt = await this.exec(key, args, prompt, this.d.workDir(t));`。）

`src/main/index.ts`：
1. import 加 `import { projectMcpConfigs } from "./claude/project-mcp";`。
2. `new HandoffRunner({ ... })` 的参数里 `signal: headlessAbort.signal,` 之前加：

```ts
    projectMcp: (cwd) => projectMcpConfigs(cwd, { claudeJson: paths.claudeJson, mcpDir: paths.mcp }),
```

3. `detectTrackerTools` 里 `return probeMcpTools({ ... })` 改为：

```ts
    const cwd = first ? ticketService.workDir(first) : homedir();
    return probeMcpTools({
      claudePath: path,
      cwd,
      env: headlessEnv(process.env, { pathValue, runId: randomUUID() }),
      signal: headlessAbort.signal,
      mcpConfigs: settings.get("headlessProjectMcp") === "1" ? projectMcpConfigs(cwd, { claudeJson: paths.claudeJson, mcpDir: paths.mcp }) : [],
    });
```

- [ ] **Step A5: 设置页开关与提示**

`src/renderer/src/strings.ts`：`trackerHint` 改为下面两条，并加 `headlessProjectMcp`：

```ts
  trackerHint: "例如 mcp__atlassian__getJiraIssue。只选读取类的工具：handoff 是只读的。",
  trackerHintSources: "后台 handoff 只读你的用户级 Claude Code 设置，所以默认不加载仓库 .mcp.json 和本地级的 MCP。tracker 配在那里时，打开下面的开关。",
  headlessProjectMcp: "后台 handoff 也加载仓库 .mcp.json 和本地级的 MCP（会启动这些 MCP server；仓库里的 allow 规则和 hook 仍然不生效）",
```

`src/renderer/src/components/ScheduleSettings.tsx` 里，`<p className="muted">{S.trackerHint}</p>` 之后加：

```tsx
        <p className="muted">{S.trackerHintSources}</p>
        <label className="inline">
          <input type="checkbox" checked={current.headlessProjectMcp === "1"} onChange={(e) => void save("headlessProjectMcp", e.target.checked ? "1" : "0")} />
          {S.headlessProjectMcp}
        </label>
```

- [ ] **Step A6: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/claude src/main/handoff/runner.test.ts src/main/settings/settings-values.test.ts`
Expected: PASS（`INCLUDE_LOCAL_SCOPE` 为 false 时本地级用例显示 skipped）

- [ ] **Step A7: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/main/claude/project-mcp.ts src/main/claude/project-mcp.test.ts src/main/claude/headless.ts src/main/claude/headless.test.ts \
  src/main/claude/mcp-probe.ts src/main/claude/mcp-probe.test.ts src/main/handoff/runner.ts src/main/handoff/runner.test.ts \
  src/main/db/settings-repo.ts src/shared/settings.ts src/main/settings/settings-values.ts src/main/settings/settings-values.test.ts \
  src/main/index.ts src/renderer/src/components/ScheduleSettings.tsx src/renderer/src/strings.ts
git commit -m "feat: opt-in project and local MCP servers for background handoffs via --mcp-config"
```

---
### Task 6: 出口 ESLint 规则（唯一出口的强制检查）

设计文档 7.1：除 PrivacyGateway 之外，任何模块都不能发网络请求。本任务把它写成 ESLint 规则，`src/main/gateway/**` 是唯一的例外；再加一个测试，用 ESLint 自己的 API 证明规则真的生效。只检查配置文件里“有这条规则”是不够的，所以测试直接拿一段违规代码去 lint。`pnpm lint` 和 `pnpm test` 都是 CI 的一部分，所以两边都会挡住违规。

**Files:**
- Modify: `eslint.config.mjs`
- Create: `src/main/egress-lint.test.ts`

**Interfaces:**
- Consumes: 现有的 `eslint.config.mjs`（`@eslint/js` + `typescript-eslint`）
- Produces: 出口规则（`no-restricted-imports`、`no-restricted-globals`、`no-restricted-properties`、`no-restricted-syntax`），作用于全部 `.ts/.tsx/.js/.mjs/.cjs`，在 `src/main/gateway/**` 关闭。后面所有任务的联网代码都只能放进 `src/main/gateway/`。

- [ ] **Step 1: 写失败测试**

新建 `src/main/egress-lint.test.ts`：

```ts
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const EGRESS_RULES = ["no-restricted-imports", "no-restricted-globals", "no-restricted-properties", "no-restricted-syntax"];

/** 每一行都是一种出网方式（第 6、10 行除外）。 */
const PROBE = [
  'import http from "node:http";',
  'import { request } from "https";',
  'import { net } from "electron";',
  'import OpenAI from "openai";',
  'import { fetch as undiciFetch } from "undici";',
  "export async function leak(): Promise<unknown> {",
  '  await fetch("https://example.com");',
  '  await globalThis.fetch("https://example.com");',
  '  await import("node:net");',
  "  return [http, request, net, OpenAI, undiciFetch];",
  "}",
].join("\n");

async function egressMessages(filePath: string) {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(PROBE, { filePath });
  return result.messages.filter((m) => m.ruleId !== null && EGRESS_RULES.includes(m.ruleId));
}

describe("egress lint rule (design 7.1: PrivacyGateway is the only exit)", () => {
  it("rejects every network API outside the gateway, in main, renderer, shared and hook code", async () => {
    for (const file of ["src/main/brief/egress-probe.ts", "src/renderer/src/egress-probe.tsx", "src/shared/egress-probe.ts", "hook/egress-probe.ts"]) {
      const messages = await egressMessages(file);
      expect(new Set(messages.map((m) => m.line)), file).toEqual(new Set([1, 2, 3, 4, 5, 7, 8, 9]));
      expect(messages.every((m) => m.severity === 2), file).toBe(true);
    }
  }, 60_000);

  it("allows them inside src/main/gateway/", async () => {
    expect(await egressMessages("src/main/gateway/egress-probe.ts")).toEqual([]);
  }, 60_000);

  it("is in the config every source file gets, so `pnpm lint` enforces it", async () => {
    const eslint = new ESLint({ cwd: root });
    for (const file of ["src/main/index.ts", "src/renderer/src/App.tsx"]) {
      const config = (await eslint.calculateConfigForFile(file)) as { rules?: Record<string, unknown> };
      for (const rule of EGRESS_RULES) {
        const entry = config.rules?.[rule];
        const severity = Array.isArray(entry) ? entry[0] : entry;
        expect([2, "error"], `${file} ${rule}`).toContain(severity);
      }
    }
  }, 60_000);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/egress-lint.test.ts`
Expected: FAIL（第一个用例收到的行号集合是空的；第三个用例里规则不存在）

- [ ] **Step 3: 实现规则**

`eslint.config.mjs` 改为：

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * 设计文档 7.1：个人 LLM API 的网络请求只能从 PrivacyGateway（src/main/gateway/）发出。
 * 其他文件不能用浏览器 / Node 的网络 API，也不能 import 网络模块、HTTP 客户端、LLM SDK 或 Electron 的 net。
 * src/main/egress-lint.test.ts 用一段违规代码验证这些规则真的生效。
 */
const EGRESS_DIR = "src/main/gateway/**";
const EGRESS_MESSAGE = "网络请求只能在 src/main/gateway/ 里发（设计文档 7.1：PrivacyGateway 是唯一出口）。";
const NETWORK_BUILTINS = ["http", "https", "http2", "net", "tls", "dgram", "dns"];
const NETWORK_PACKAGES = [
  "undici", "node-fetch", "cross-fetch", "isomorphic-fetch", "axios", "got", "ky", "superagent", "request", "needle", "ws",
  "openai", "@anthropic-ai/sdk", "@google/generative-ai", "@google/genai", "@mistralai/mistralai", "cohere-ai", "groq-sdk", "ollama", "ai",
];
const NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport"];
/** 动态 import / require 的模块名（esquery 的正则里不能有 /）。 */
const DYNAMIC_MODULES = `/^(node:)?(${NETWORK_BUILTINS.join("|")}|undici|axios|got|openai|ws)$/`;

const egressRules = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        ...NETWORK_BUILTINS.flatMap((m) => [m, `node:${m}`]).map((name) => ({ name, message: EGRESS_MESSAGE })),
        ...NETWORK_PACKAGES.map((name) => ({ name, message: EGRESS_MESSAGE })),
        { name: "electron", importNames: ["net", "netLog"], message: EGRESS_MESSAGE },
      ],
      patterns: [{ group: ["@anthropic-ai/*", "@ai-sdk/*", "@langchain/*", "langchain", "langchain/*", "openai/*", "undici/*"], message: EGRESS_MESSAGE }],
    },
  ],
  "no-restricted-globals": ["error", ...NETWORK_GLOBALS.map((name) => ({ name, message: EGRESS_MESSAGE }))],
  "no-restricted-properties": [
    "error",
    ...["globalThis", "window", "self", "global"].flatMap((object) => NETWORK_GLOBALS.map((property) => ({ object, property, message: EGRESS_MESSAGE }))),
    { object: "navigator", property: "sendBeacon", message: EGRESS_MESSAGE },
  ],
  "no-restricted-syntax": [
    "error",
    { selector: `ImportExpression[source.value=${DYNAMIC_MODULES}]`, message: EGRESS_MESSAGE },
    { selector: `CallExpression[callee.name="require"][arguments.0.value=${DYNAMIC_MODULES}]`, message: EGRESS_MESSAGE },
  ],
};

export default tseslint.config(
  { ignores: ["out/**", "build/**", "dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  { files: ["**/*.{ts,tsx,js,mjs,cjs}"], rules: egressRules },
  // 唯一出口：只有 gateway 目录可以联网。
  { files: [EGRESS_DIR], rules: Object.fromEntries(Object.keys(egressRules).map((rule) => [rule, "off"])) },
);
```

- [ ] **Step 4: 运行测试，确认通过；现有代码没有违规**

Run: `pnpm exec vitest run src/main/egress-lint.test.ts && pnpm lint`
Expected: PASS；`pnpm lint` 没有任何报错（现有代码不联网）

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm test`
Expected: 全部通过

```bash
git add eslint.config.mjs src/main/egress-lint.test.ts
git commit -m "feat: lint rule makes src/main/gateway the only place allowed to use the network"
```

---

### Task 7: 迁移 3：审计、敏感词和密钥三张表

设计文档 3.2 节的 `llm_audit`、`sensitive_terms`，加上存加密 key 的 `secrets`。`llm_audit` 比设计文档多两列：`status`（这一行处于 pending / sent / failed / blocked / budget / declined 哪个阶段）和 `error`。拒发和超预算的行 `payload_sent` 为空：它们没有发出任何东西，被拦下的内容（可能就是那段密钥）也不应该落盘。

**Files:**
- Create: `src/shared/llm.ts`
- Modify: `src/main/db/migrations.ts`
- Create: `src/main/db/audit-repo.ts`、`src/main/db/terms-repo.ts`、`src/main/db/secrets-repo.ts`
- Create: `src/main/db/llm-repos.test.ts`

**Interfaces:**
- Consumes: `Db`、`withTransaction`（`src/main/db/database.ts`）
- Produces（`src/shared/llm.ts`）:
  - `PRIVACY_LEVELS`、`PrivacyLevel`；`TERM_CATEGORIES`、`TermCategory`、`SensitiveTerm { term; category }`
  - `AUDIT_STATUSES`、`AuditStatus`；`SCAN_RULES`、`ScanRule`、`ScanHit { rule; sample }`
  - `AuditEntry`、`AuditPage { entries; hasMore; monthCostUsd; budgetUsd }`
  - `KeyState { keySaved; keyMasked; keyUnreadable; encryptionAvailable }`、`LlmStatus extends KeyState { configured; priceKnown; monthCostUsd; budgetUsd }`
- Produces（仓库）:
  - `AuditRepo`：`insert(a: NewAudit): number`、`finish(id, f: AuditFinish): void`、`list(limit = 50, beforeId?: number): AuditEntry[]`（新的在前）、`costSince(ms): number`、`prune(beforeMs): number`；`AUDIT_TEXT_LIMIT = 200_000`
  - `TermsRepo`：`list(): SensitiveTerm[]`、`replaceAll(terms: readonly SensitiveTerm[]): void`
  - `SecretsRepo`：`get(name): Uint8Array | null`、`set(name, value: Uint8Array, at: number): void`、`delete(name): void`

- [ ] **Step 1: 写失败测试**

新建 `src/main/db/llm-repos.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { PrivacyLevel } from "../../shared/llm";
import { memDb } from "../test-utils";
import { AUDIT_TEXT_LIMIT, AuditRepo } from "./audit-repo";
import { SecretsRepo } from "./secrets-repo";
import { TermsRepo } from "./terms-repo";

const base = { provider: "api.example.com", model: "m", level: "metadata" as PrivacyLevel };

describe("migration 3", () => {
  it("creates the audit, sensitive term and secret tables", () => {
    const db = memDb();
    for (const t of ["llm_audit", "sensitive_terms", "secrets"]) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t), t).toBeTruthy();
    }
  });
});

describe("AuditRepo", () => {
  it("records the request before sending and fills in the result afterwards", () => {
    const audit = new AuditRepo(memDb());
    const id = audit.insert({ ...base, ts: 10, status: "pending", payloadSent: '{"a":1}' });
    audit.finish(id, { status: "sent", response: "{}", tokensIn: 100, tokensOut: 20, costUsd: 0.0002 });
    expect(audit.list()).toEqual([
      { id, ts: 10, ...base, status: "sent", payloadSent: '{"a":1}', response: "{}", tokensIn: 100, tokensOut: 20, costUsd: 0.0002, blockedReason: null, error: null },
    ]);
  });

  it("keeps no payload for a blocked request and stores the masked hits", () => {
    const audit = new AuditRepo(memDb());
    audit.insert({ ...base, ts: 1, status: "blocked", payloadSent: null, blockedReason: [{ rule: "url", sample: "htt…(23)" }] });
    expect(audit.list()[0]).toMatchObject({ status: "blocked", payloadSent: null, blockedReason: [{ rule: "url", sample: "htt…(23)" }] });
  });

  it("replaces the payload when the final request differs from the first attempt", () => {
    const audit = new AuditRepo(memDb());
    const id = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: '{"max_tokens":1}' });
    audit.finish(id, { status: "sent", payloadSent: '{"max_completion_tokens":1}' });
    expect(audit.list()[0].payloadSent).toBe('{"max_completion_tokens":1}');
    audit.finish(id, { status: "failed", error: "x" });
    expect(audit.list()[0].payloadSent).toBe('{"max_completion_tokens":1}');
  });

  it("sums the cost since a time, pages newest first and prunes old rows", () => {
    const audit = new AuditRepo(memDb());
    const a = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: "a" });
    audit.finish(a, { status: "sent", costUsd: 1 });
    const b = audit.insert({ ...base, ts: 100, status: "pending", payloadSent: "b" });
    audit.finish(b, { status: "sent", costUsd: 0.5 });
    const c = audit.insert({ ...base, ts: 200, status: "budget", payloadSent: null, error: "超过预算" });
    expect(audit.costSince(50)).toBe(0.5);
    expect(audit.costSince(0)).toBe(1.5);
    expect(audit.list(2).map((e) => e.id)).toEqual([c, b]);
    expect(audit.list(2, b).map((e) => e.id)).toEqual([a]);
    expect(audit.prune(150)).toBe(2);
    expect(audit.list().map((e) => e.id)).toEqual([c]);
  });

  it("rejects an unknown level or status and caps oversized text", () => {
    const audit = new AuditRepo(memDb());
    expect(() => audit.insert({ ...base, level: "bogus" as PrivacyLevel, ts: 1, status: "pending", payloadSent: null })).toThrow();
    const id = audit.insert({ ...base, ts: 1, status: "pending", payloadSent: null });
    audit.finish(id, { status: "sent", response: "x".repeat(AUDIT_TEXT_LIMIT + 10) });
    expect(audit.list()[0].response).toHaveLength(AUDIT_TEXT_LIMIT);
  });
});

describe("TermsRepo", () => {
  it("replaces the whole list and treats terms case-insensitively", () => {
    const terms = new TermsRepo(memDb());
    terms.replaceAll([{ term: "张三", category: "person" }, { term: "Project Falcon", category: "term" }, { term: "project falcon", category: "term" }]);
    expect(terms.list()).toEqual([{ term: "张三", category: "person" }, { term: "Project Falcon", category: "term" }]);
    terms.replaceAll([]);
    expect(terms.list()).toEqual([]);
  });
});

describe("SecretsRepo", () => {
  it("stores bytes as they are", () => {
    const secrets = new SecretsRepo(memDb());
    expect(secrets.get("k")).toBeNull();
    secrets.set("k", new Uint8Array([0, 1, 255]), 1);
    secrets.set("k", new Uint8Array([9, 8]), 2);
    expect([...secrets.get("k")!]).toEqual([9, 8]);
    secrets.delete("k");
    expect(secrets.get("k")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/db/llm-repos.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 共享类型**

新建 `src/shared/llm.ts`：

```ts
/** 个人 LLM API（设计文档第 7 节）的共享类型。 */

export const PRIVACY_LEVELS = ["off", "metadata", "redacted", "full"] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

export const TERM_CATEGORIES = ["person", "term"] as const;
export type TermCategory = (typeof TERM_CATEGORIES)[number];
export interface SensitiveTerm {
  term: string;
  /** person：人名；term：项目代号、客户名等其他敏感词。 */
  category: TermCategory;
}

/** pending：已写审计、还没发完；sent：发出去了（不管响应能不能用）；failed：发送失败；blocked：扫描命中被拒发；budget：超预算或没有价格，没发；declined：用户拒绝了发送前确认。 */
export const AUDIT_STATUSES = ["pending", "sent", "failed", "blocked", "budget", "declined"] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const SCAN_RULES = ["secret", "url", "domain", "ip", "email", "path", "ticket", "known"] as const;
export type ScanRule = (typeof SCAN_RULES)[number];
export interface ScanHit {
  rule: ScanRule;
  /** 打码后的样本：前 3 个字符 + 长度。 */
  sample: string;
}

export interface AuditEntry {
  id: number;
  ts: number;
  /** base URL 的 host。 */
  provider: string;
  model: string;
  level: PrivacyLevel;
  status: AuditStatus;
  /** 原样发出的请求体；没有发出（拒发、超预算）时为 null。 */
  payloadSent: string | null;
  /** 服务商原样返回的响应体（占位符没有还原）。 */
  response: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  blockedReason: ScanHit[] | null;
  error: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  hasMore: boolean;
  monthCostUsd: number;
  budgetUsd: number;
}

export interface KeyState {
  keySaved: boolean;
  /** 打码后的 key，例如 ••••3f9a。完整的 key 永远不会到渲染进程。 */
  keyMasked: string | null;
  /** 保存过但现在解不开（钥匙串被重置、换了电脑）：需要重新输入。 */
  keyUnreadable: boolean;
  /** 系统的加密存储可用（macOS 钥匙串 / Windows DPAPI）。 */
  encryptionAvailable: boolean;
}

export interface LlmStatus extends KeyState {
  /** 档位不是 off，base URL 和模型都填了，远程服务还有可用的 key。 */
  configured: boolean;
  /** 当前模型在价格表里有价格。没有时不会调用。 */
  priceKnown: boolean;
  monthCostUsd: number;
  budgetUsd: number;
}
```

- [ ] **Step 4: 迁移与仓库**

`src/main/db/migrations.ts` 的 `MIGRATIONS` 数组末尾（第 2 条的反引号字符串之后）追加第 3 条：

```ts
  `
  CREATE TABLE llm_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('off', 'metadata', 'redacted', 'full')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'blocked', 'budget', 'declined')),
    payload_sent TEXT,
    response TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL,
    blocked_reason TEXT,
    error TEXT
  );
  CREATE INDEX llm_audit_ts ON llm_audit(ts);
  CREATE TABLE sensitive_terms (
    term TEXT PRIMARY KEY COLLATE NOCASE,
    category TEXT NOT NULL CHECK (category IN ('person', 'term'))
  );
  CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    value BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
```

新建 `src/main/db/audit-repo.ts`：

```ts
import type { AuditEntry, AuditStatus, PrivacyLevel, ScanHit } from "../../shared/llm";
import type { Db } from "./database";

/** 审计里每段文本的上限：响应异常大时也不会把数据库撑爆。 */
export const AUDIT_TEXT_LIMIT = 200_000;

interface AuditRow {
  id: number;
  ts: number;
  provider: string;
  model: string;
  level: string;
  status: string;
  payload_sent: string | null;
  response: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  blocked_reason: string | null;
  error: string | null;
}

const cap = (s: string | null | undefined): string | null => (s == null ? null : s.length > AUDIT_TEXT_LIMIT ? s.slice(0, AUDIT_TEXT_LIMIT) : s);

function parseHits(text: string | null): ScanHit[] | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? (v as ScanHit[]) : null;
  } catch {
    return null;
  }
}

function toEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    ts: r.ts,
    provider: r.provider,
    model: r.model,
    level: r.level as PrivacyLevel,
    status: r.status as AuditStatus,
    payloadSent: r.payload_sent,
    response: r.response,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costUsd: r.cost_usd,
    blockedReason: parseHits(r.blocked_reason),
    error: r.error,
  };
}

export interface NewAudit {
  ts: number;
  provider: string;
  model: string;
  level: PrivacyLevel;
  status: AuditStatus;
  /** 原样的请求体；拒发 / 超预算时为 null（什么都没发，被拦下的内容也不落盘）。 */
  payloadSent: string | null;
  blockedReason?: ScanHit[] | null;
  error?: string | null;
}

export interface AuditFinish {
  status: "sent" | "failed" | "declined";
  /** 最终发出的请求体和第一次不同时（换了 token 参数名重试）传入。 */
  payloadSent?: string;
  response?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  error?: string | null;
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  insert(a: NewAudit): number {
    const r = this.db
      .prepare(
        `INSERT INTO llm_audit (ts, provider, model, level, status, payload_sent, blocked_reason, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.ts, a.provider, a.model, a.level, a.status, cap(a.payloadSent), a.blockedReason ? JSON.stringify(a.blockedReason) : null, cap(a.error));
    return Number(r.lastInsertRowid);
  }

  finish(id: number, f: AuditFinish): void {
    this.db
      .prepare(
        `UPDATE llm_audit SET status = ?, payload_sent = COALESCE(?, payload_sent), response = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, error = ?
         WHERE id = ?`,
      )
      .run(f.status, cap(f.payloadSent), cap(f.response), f.tokensIn ?? null, f.tokensOut ?? null, f.costUsd ?? null, cap(f.error), id);
  }

  /** 新的在前；beforeId 用来翻页。 */
  list(limit = 50, beforeId?: number): AuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM llm_audit WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`)
      .all(beforeId ?? null, beforeId ?? null, limit) as unknown as AuditRow[];
    return rows.map(toEntry);
  }

  costSince(ms: number): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM llm_audit WHERE ts >= ?`).get(ms) as { c: number };
    return r.c;
  }

  /** 删掉 beforeMs 之前的记录（保留期，设计文档 7.7）。 */
  prune(beforeMs: number): number {
    return Number(this.db.prepare(`DELETE FROM llm_audit WHERE ts < ?`).run(beforeMs).changes);
  }
}
```

新建 `src/main/db/terms-repo.ts`：

```ts
import type { SensitiveTerm, TermCategory } from "../../shared/llm";
import { withTransaction, type Db } from "./database";

export class TermsRepo {
  constructor(private readonly db: Db) {}

  list(): SensitiveTerm[] {
    const rows = this.db.prepare(`SELECT term, category FROM sensitive_terms ORDER BY category, term`).all() as unknown as { term: string; category: string }[];
    return rows.map((r) => ({ term: r.term, category: r.category as TermCategory }));
  }

  /** 整表替换（设置页一次保存全部）。调用方先用 normalizeTerms 规范化；只差大小写的重复项保留第一个。 */
  replaceAll(terms: readonly SensitiveTerm[]): void {
    withTransaction(this.db, () => {
      this.db.exec(`DELETE FROM sensitive_terms`);
      const ins = this.db.prepare(`INSERT OR IGNORE INTO sensitive_terms (term, category) VALUES (?, ?)`);
      for (const t of terms) ins.run(t.term, t.category);
    });
  }
}
```

新建 `src/main/db/secrets-repo.ts`：

```ts
import type { Db } from "./database";

/** 已经加密过的字节（safeStorage 的输出）。这个仓库本身不做加密，也不认识明文。 */
export class SecretsRepo {
  constructor(private readonly db: Db) {}

  get(name: string): Uint8Array | null {
    const r = this.db.prepare(`SELECT value FROM secrets WHERE name = ?`).get(name) as { value: Uint8Array } | undefined;
    return r ? new Uint8Array(r.value) : null;
  }

  set(name: string, value: Uint8Array, at: number): void {
    this.db
      .prepare(`INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(name, value, at);
  }

  delete(name: string): void {
    this.db.prepare(`DELETE FROM secrets WHERE name = ?`).run(name);
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/db`
Expected: PASS（`repos.test.ts` 和 `handoff-repos.test.ts` 里按 `MIGRATIONS.length` 断言版本号的用例照样通过，现在是 3）

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/shared/llm.ts src/main/db/migrations.ts src/main/db/audit-repo.ts src/main/db/terms-repo.ts src/main/db/secrets-repo.ts src/main/db/llm-repos.test.ts
git commit -m "feat: migration 3 with the LLM audit log, sensitive terms and encrypted secrets tables"
```

---

### Task 8: 个人 API 设置、价格表与预算

设置页要能改的 7 个值（档位、base URL、模型、月度预算、价格表、发送前确认、审计保留天数）、它们的校验，以及预算计算。读取设置时一律往保守的方向回退：档位读到坏值当作 `off`，价格表读到坏值当作空表（空表意味着任何模型都没有价格，不会调用），预算读到坏值当作 0。

价格表默认是 `* 15 75`：任何模型都按很贵的价格算（每百万 token 输入 15 美元、输出 75 美元），宁可少调用也不超支。用户按自己的服务商改，本机的 Ollama 可以写 `* 0 0`。

**Files:**
- Modify: `src/main/db/settings-repo.ts`
- Modify: `src/shared/settings.ts`
- Modify: `src/main/settings/settings-values.ts`、`src/main/settings/settings-values.test.ts`
- Create: `src/main/gateway/budget.ts`、`src/main/gateway/budget.test.ts`

**Interfaces:**
- Consumes: `SettingError`、`normalizeFlag`、`parseDays`（任务 2 / 计划 2）、`PRIVACY_LEVELS`、`TERM_CATEGORIES`（任务 7）
- Produces（`src/main/settings/settings-values.ts`）:
  - 设置键 `llmLevel`、`llmBaseUrl`、`llmModel`、`llmMonthlyBudgetUsd`、`llmPrices`、`llmConfirm`、`auditRetentionDays`（全部可编辑）
  - `isLoopbackHost(hostname: string): boolean`、`normalizeBaseUrl(v: string): string`
  - `PriceRule { pattern: string; inputPerMTok: number; outputPerMTok: number }`、`parsePriceTable(v: string): PriceRule[]`（不合法时抛 `SettingError`）、`priceFor(rules: readonly PriceRule[], model: string): PriceRule | null`
  - `LlmConfig { level; baseUrl; model; budgetUsd; prices; confirm; retentionDays }`、`llmConfig(s: SettingsRepo): LlmConfig`
  - `TERMS_LIMIT = 500`、`normalizeTerms(input: unknown): SensitiveTerm[]`
- Produces（`src/main/gateway/budget.ts`）:
  - `monthStart(now: number): number`（本地时间当月 1 日 0 点）
  - `estimateTokens(text: string): number`（保守：CJK 每字 1 个，其余每 3 个字符 1 个）
  - `costUsd(price: PriceRule, tokensIn: number, tokensOut: number): number`
  - `BudgetDecision = { ok: true; price: PriceRule; estimateUsd: number } | { ok: false; reason: "no_price" | "over_budget"; message: string }`
  - `checkBudget(o: { prices; model; budgetUsd; spentUsd; inputText; maxOutputTokens }): BudgetDecision`

- [ ] **Step 1: 写失败测试**

`src/main/settings/settings-values.test.ts`：把 `./settings-values` 的 import 改为也引入 `isLoopbackHost, llmConfig, normalizeBaseUrl, normalizeTerms, parsePriceTable, priceFor, TERMS_LIMIT`，文件末尾追加：

```ts
describe("personal API settings", () => {
  it("accepts https base URLs, or http only for this machine, and trims the chat path", () => {
    expect(normalizeBaseUrl(" https://api.deepseek.com/v1/ ")).toBe("https://api.deepseek.com/v1");
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1/chat/completions")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeBaseUrl("http://[::1]:9/v1")).toBe("http://[::1]:9/v1");
    expect(normalizeBaseUrl("")).toBe("");
    for (const bad of ["http://api.example.com/v1", "https://u:p@api.example.com", "https://api.example.com/v1?key=1", "ftp://x", "not a url"]) {
      expect(() => normalizeBaseUrl(bad), bad).toThrow(SettingError);
    }
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("localhost.evil.com")).toBe(false);
  });

  it("parses the price table and matches models with * globs, first match wins", () => {
    const rules = parsePriceTable("# 注释\ndeepseek-* 0.27 1.1\n\ngpt-4.1 2 8\n* 15 75\n");
    expect(rules).toEqual([
      { pattern: "deepseek-*", inputPerMTok: 0.27, outputPerMTok: 1.1 },
      { pattern: "gpt-4.1", inputPerMTok: 2, outputPerMTok: 8 },
      { pattern: "*", inputPerMTok: 15, outputPerMTok: 75 },
    ]);
    expect(priceFor(rules, "DeepSeek-Chat")?.inputPerMTok).toBe(0.27);
    expect(priceFor(rules, "gpt-4.1")?.inputPerMTok).toBe(2);
    expect(priceFor(rules, "gpt-421")?.pattern).toBe("*");
    expect(priceFor(rules.slice(0, 2), "llama3")).toBeNull();
    for (const bad of ["gpt 1", "gpt one 2", "gpt 1 2 3", "gpt -1 2"]) expect(() => parsePriceTable(bad), bad).toThrow(SettingError);
  });

  it("normalizes and validates the personal API settings", () => {
    expect(normalizeSetting("llmLevel", " redacted ")).toBe("redacted");
    expect(() => normalizeSetting("llmLevel", "secret")).toThrow(SettingError);
    expect(normalizeSetting("llmModel", " deepseek-chat ")).toBe("deepseek-chat");
    expect(normalizeSetting("llmModel", "")).toBe("");
    expect(() => normalizeSetting("llmModel", "deep seek")).toThrow(SettingError);
    expect(normalizeSetting("llmMonthlyBudgetUsd", "2.50")).toBe("2.5");
    expect(() => normalizeSetting("llmMonthlyBudgetUsd", "-1")).toThrow(SettingError);
    expect(normalizeSetting("llmPrices", "# x\ngpt-4o-mini  0.15   0.6")).toBe("gpt-4o-mini 0.15 0.6");
    expect(normalizeSetting("llmPrices", "")).toBe("");
    expect(normalizeSetting("llmConfirm", "1")).toBe("1");
    expect(normalizeSetting("auditRetentionDays", "30")).toBe("30");
    expect(() => normalizeSetting("auditRetentionDays", "0")).toThrow(SettingError);
    expect(normalizeSetting("llmBaseUrl", "https://api.deepseek.com/v1/")).toBe("https://api.deepseek.com/v1");
  });

  it("reads the config with safe fallbacks for corrupt stored values", () => {
    const s = new SettingsRepo(memDb());
    expect(llmConfig(s)).toEqual({
      level: "metadata", baseUrl: "", model: "", budgetUsd: 1,
      prices: [{ pattern: "*", inputPerMTok: 15, outputPerMTok: 75 }], confirm: false, retentionDays: 90,
    });
    s.set("llmLevel", "everything");
    s.set("llmBaseUrl", "http://api.example.com");
    s.set("llmPrices", "garbage");
    s.set("llmMonthlyBudgetUsd", "lots");
    s.set("auditRetentionDays", "0");
    expect(llmConfig(s)).toMatchObject({ level: "off", baseUrl: "", prices: [], budgetUsd: 0, retentionDays: 90 });
  });

  it("normalizes the sensitive term list", () => {
    expect(
      normalizeTerms([
        { term: " 张三 ", category: "person" },
        { term: "Ｐｒｏｊｅｃｔ  Falcon", category: "term" },
        { term: "project falcon", category: "term" },
        { term: "  ", category: "term" },
      ]),
    ).toEqual([{ term: "张三", category: "person" }, { term: "Project Falcon", category: "term" }]);
    expect(() => normalizeTerms([{ term: "王", category: "person" }])).toThrow(SettingError);
    expect(() => normalizeTerms([{ term: "x".repeat(101), category: "term" }])).toThrow(SettingError);
    expect(() => normalizeTerms([{ term: "ab", category: "boss" }])).toThrow(SettingError);
    expect(() => normalizeTerms("张三")).toThrow(SettingError);
    expect(() => normalizeTerms(Array.from({ length: TERMS_LIMIT + 1 }, (_, i) => ({ term: `词${i}号`, category: "term" })))).toThrow(SettingError);
  });
});
```

新建 `src/main/gateway/budget.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { checkBudget, costUsd, estimateTokens, monthStart } from "./budget";

const price = { pattern: "*", inputPerMTok: 2, outputPerMTok: 8 };

describe("budget", () => {
  it("starts the month at local midnight on the 1st, across year ends", () => {
    expect(monthStart(new Date(2026, 9, 21, 9, 30).getTime())).toBe(new Date(2026, 9, 1).getTime());
    expect(monthStart(new Date(2027, 0, 1, 0, 0).getTime())).toBe(new Date(2027, 0, 1).getTime());
    expect(monthStart(new Date(2026, 11, 31, 23, 59).getTime())).toBe(new Date(2026, 11, 1).getTime());
  });

  it("estimates tokens conservatively for Chinese and ASCII", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("今天ab c")).toBe(2 + 2);
    expect(estimateTokens("abcdef")).toBe(2);
  });

  it("prices usage per million tokens", () => {
    expect(costUsd(price, 1_000_000, 500_000)).toBe(6);
    expect(costUsd(price, 120, 40)).toBeCloseTo(0.00056, 10);
  });

  it("refuses when the model has no price or the estimate would cross the budget", () => {
    const base = { prices: [price], model: "m", budgetUsd: 1, spentUsd: 0, inputText: "x".repeat(300), maxOutputTokens: 800 };
    expect(checkBudget(base)).toMatchObject({ ok: true, price, estimateUsd: (100 * 2 + 800 * 8) / 1_000_000 });
    expect(checkBudget({ ...base, prices: [] })).toMatchObject({ ok: false, reason: "no_price" });
    expect(checkBudget({ ...base, spentUsd: 0.999 })).toMatchObject({ ok: false, reason: "over_budget" });
    // 免费的本机模型：预算为 0 也能用。
    expect(checkBudget({ ...base, prices: [{ pattern: "*", inputPerMTok: 0, outputPerMTok: 0 }], budgetUsd: 0 })).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/settings/settings-values.test.ts src/main/gateway/budget.test.ts`
Expected: FAIL（函数和设置键不存在）

- [ ] **Step 3: 默认值与可编辑键**

`src/main/db/settings-repo.ts` 的 `SETTING_DEFAULTS` 末尾（`refreshPrompt` 之后）加：

```ts
  /** 个人 API 的隐私档位：off | metadata | redacted | full（设计文档 7.3，默认 metadata）。 */
  llmLevel: "metadata",
  /** OpenAI 兼容接口的 base URL，例如 https://api.deepseek.com/v1。空表示没有配置（等同 off）。 */
  llmBaseUrl: "",
  llmModel: "",
  /** 每月预算（美元）。 */
  llmMonthlyBudgetUsd: "1",
  /**
   * 价格表：每行“模型（可用 * 通配） 输入价 输出价”，单位是美元 / 百万 token，从上往下第一条匹配的生效。
   * 默认把任何模型都按很贵的价格算：宁可少调用，也不超支。
   */
  llmPrices: "* 15 75",
  /** 发送前确认：1 开 0 关。 */
  llmConfirm: "0",
  /** 审计记录保留天数（设计文档 7.7，默认 90）。 */
  auditRetentionDays: "90",
```

`src/shared/settings.ts` 的 `EDITABLE_SETTINGS` 末尾（`"refreshPrompt",` 之后）加：

```ts
  "llmLevel",
  "llmBaseUrl",
  "llmModel",
  "llmMonthlyBudgetUsd",
  "llmPrices",
  "llmConfirm",
  "auditRetentionDays",
```

- [ ] **Step 4: 校验、解析与读取**

`src/main/settings/settings-values.ts`：
1. 顶部 import 加上：

```ts
import { PRIVACY_LEVELS, TERM_CATEGORIES, type PrivacyLevel, type SensitiveTerm, type TermCategory } from "../../shared/llm";
```

2. 在 `normalizeSetting` 之前加：

```ts
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** URL.hostname 是不是本机（Ollama 之类的本地服务可以用 http、可以不配 key）。 */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** OpenAI 兼容接口的 base URL：https（本机可以 http），不带账号、查询串和 #；去掉末尾的 / 和 /chat/completions。 */
export function normalizeBaseUrl(v: string): string {
  const t = v.trim();
  if (!t) return "";
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new SettingError("base URL 格式不对，例如 https://api.deepseek.com/v1");
  }
  if (u.username || u.password) throw new SettingError("base URL 里不能带用户名或密码");
  if (u.search || u.hash) throw new SettingError("base URL 不能带 ? 或 # 部分");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    throw new SettingError("base URL 必须是 https://（本机服务如 Ollama 可以用 http://localhost）");
  }
  const path = u.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

export interface PriceRule {
  /** 模型名，* 匹配任意字符，不区分大小写。 */
  pattern: string;
  /** 美元 / 百万 token。 */
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICE_NUM = /^\d{1,6}(\.\d{1,6})?$/;
const PRICE_MODEL = /^[A-Za-z0-9._:/@*+-]{1,200}$/;

/** 每行“模型 输入价 输出价”；空行和 # 开头的行忽略。格式不对时抛 SettingError（指出第几行）。 */
export function parsePriceTable(v: string): PriceRule[] {
  const rules: PriceRule[] = [];
  v.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(/\s+/);
    if (parts.length !== 3 || !PRICE_MODEL.test(parts[0]) || !PRICE_NUM.test(parts[1]) || !PRICE_NUM.test(parts[2])) {
      throw new SettingError(`价格表第 ${i + 1} 行格式不对，应为“模型 输入价 输出价”（美元 / 百万 token），例如 deepseek-chat 0.27 1.1`);
    }
    rules.push({ pattern: parts[0], inputPerMTok: Number(parts[1]), outputPerMTok: Number(parts[2]) });
  });
  return rules;
}

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");

/** 从上往下第一条匹配的价格；没有匹配时为 null（不会调用）。 */
export function priceFor(rules: readonly PriceRule[], model: string): PriceRule | null {
  return rules.find((r) => globToRegExp(r.pattern).test(model)) ?? null;
}

export const TERMS_LIMIT = 500;

/** 设置页提交的敏感词表：NFKC、压缩空白、去掉空项和只差大小写的重复项；太短、太长、太多或格式不对时抛 SettingError。 */
export function normalizeTerms(input: unknown): SensitiveTerm[] {
  if (!Array.isArray(input)) throw new SettingError("敏感词表格式不对");
  const out: SensitiveTerm[] = [];
  const seen = new Set<string>();
  for (const x of input) {
    const o = x as { term?: unknown; category?: unknown } | null;
    if (!o || typeof o.term !== "string" || !(TERM_CATEGORIES as readonly string[]).includes(String(o.category))) {
      throw new SettingError("敏感词表格式不对");
    }
    const term = o.term.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!term) continue;
    if ([...term].length < 2) throw new SettingError(`敏感词至少两个字：${term}`);
    if (term.length > 100) throw new SettingError(`敏感词太长（上限 100 字）：${term.slice(0, 20)}…`);
    const k = term.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ term, category: o.category as TermCategory });
  }
  if (out.length > TERMS_LIMIT) throw new SettingError(`敏感词最多 ${TERMS_LIMIT} 个`);
  return out;
}
```

3. `normalizeSetting` 的 `switch` 里，`default:` 之前加：

```ts
    case "llmLevel": {
      const t = value.trim();
      if (!(PRIVACY_LEVELS as readonly string[]).includes(t)) throw new SettingError("隐私档位只能是 off、metadata、redacted、full");
      return t;
    }
    case "llmBaseUrl":
      return normalizeBaseUrl(value);
    case "llmModel": {
      const t = value.trim();
      // eslint-disable-next-line no-control-regex
      if (t && !/^[^\s\u0000-\u001f\u007f]{1,200}$/.test(t)) throw new SettingError("模型名不能有空格，最长 200 字，例如 deepseek-chat");
      return t;
    }
    case "llmMonthlyBudgetUsd": {
      const t = value.trim();
      if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) throw new SettingError("预算是美元金额，例如 1 或 2.50");
      return String(Number(t));
    }
    case "llmPrices":
      return parsePriceTable(value).map((r) => `${r.pattern} ${r.inputPerMTok} ${r.outputPerMTok}`).join("\n");
    case "llmConfirm":
      return normalizeFlag(value);
    case "auditRetentionDays": {
      const t = value.trim();
      if (!/^\d{1,4}$/.test(t) || Number(t) < 1 || Number(t) > 3650) throw new SettingError("保留天数是 1–3650 的整数");
      return String(Number(t));
    }
```

4. 文件末尾加：

```ts
export interface LlmConfig {
  level: PrivacyLevel;
  /** 规范化后的 base URL；没配置或存储的值不合法时为 ""。 */
  baseUrl: string;
  model: string;
  budgetUsd: number;
  prices: PriceRule[];
  confirm: boolean;
  retentionDays: number;
}

/** 读取时一律往保守方向回退：档位坏了当作 off，价格表坏了当作空（不会调用），预算坏了当作 0。 */
export function llmConfig(s: SettingsRepo): LlmConfig {
  const level = s.get("llmLevel");
  let baseUrl = "";
  try {
    baseUrl = normalizeBaseUrl(s.get("llmBaseUrl"));
  } catch {
    baseUrl = "";
  }
  let prices: PriceRule[] = [];
  try {
    prices = parsePriceTable(s.get("llmPrices"));
  } catch {
    prices = [];
  }
  const budget = Number(s.get("llmMonthlyBudgetUsd"));
  return {
    level: (PRIVACY_LEVELS as readonly string[]).includes(level) ? (level as PrivacyLevel) : "off",
    baseUrl,
    model: s.get("llmModel").trim(),
    budgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : 0,
    prices,
    confirm: s.get("llmConfirm") === "1",
    retentionDays: parseDays(s.get("auditRetentionDays"), 90) || 90,
  };
}
```

- [ ] **Step 5: 预算**

新建 `src/main/gateway/budget.ts`：

```ts
import { priceFor, type PriceRule } from "../settings/settings-values";

/** 本地时间当月 1 日 0 点：月度预算从这里开始算。 */
export function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/** 保守估算：CJK 每字 1 个 token，其余每 3 个字符 1 个。只用于发送前的预算检查和响应缺 usage 时的记账。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3);
}

export function costUsd(price: PriceRule, tokensIn: number, tokensOut: number): number {
  return (tokensIn * price.inputPerMTok + tokensOut * price.outputPerMTok) / 1_000_000;
}

export type BudgetDecision =
  | { ok: true; price: PriceRule; estimateUsd: number }
  | { ok: false; reason: "no_price" | "over_budget"; message: string };

/** 发送前检查：模型必须有价格；本月已花 + 这次的估算（输入估算 + 输出上限）不能超过预算。 */
export function checkBudget(o: {
  prices: readonly PriceRule[];
  model: string;
  budgetUsd: number;
  spentUsd: number;
  inputText: string;
  maxOutputTokens: number;
}): BudgetDecision {
  const price = priceFor(o.prices, o.model);
  if (!price) return { ok: false, reason: "no_price", message: `价格表里没有模型 ${o.model} 的价格，不会调用` };
  const estimateUsd = costUsd(price, estimateTokens(o.inputText), o.maxOutputTokens);
  if (o.spentUsd + estimateUsd > o.budgetUsd) {
    return {
      ok: false,
      reason: "over_budget",
      message: `本月已花 $${o.spentUsd.toFixed(4)}，这次预计 $${estimateUsd.toFixed(4)}，会超过预算 $${o.budgetUsd}`,
    };
  }
  return { ok: true, price, estimateUsd };
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/settings/settings-values.test.ts src/main/gateway/budget.test.ts`
Expected: PASS

- [ ] **Step 7: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过（设置页的 `settingsGet` 会多返回 7 个键，界面在任务 17 才用到它们）

```bash
git add src/main/db/settings-repo.ts src/shared/settings.ts src/main/settings/settings-values.ts src/main/settings/settings-values.test.ts \
  src/main/gateway/budget.ts src/main/gateway/budget.test.ts
git commit -m "feat: personal API settings with a price table, safe fallbacks and the monthly budget check"
```

---

### Task 9: 假名化与按档位的字段投影

管道的前两步（设计文档 7.2–7.4）：先按档位只挑白名单里的字段，再把 ticket 号、仓库名、分支名、人名和敏感词换成占位符。占位符形如 `[[T_k3f9]]`：一个字母表示种类（T ticket、R 仓库、B 分支、P 人名、S 其他敏感词），后面 4 个随机字符。映射表**每次请求重新随机生成**，只在内存里，服务商没法把两次请求里的同一个 ticket 关联起来。ticket 在出站 JSON 里的顺序也每次打乱，免得位置泄露身份。

替换的规则：
- 先做 NFKC 规范化（全角 `ＰＲＯＪ－１２` 变成 `PROJ-12`），再不区分大小写地匹配。
- 子串匹配，不要求词边界：中文没有空格，`修好PROJ-12的bug` 也要替换。宁可多替换，也不漏。
- 长的值优先（`PROJ-123` 不会被当成 `PROJ-12` 加一个 `3`；分支 `feature/PROJ-12-login` 整个是一个占位符）。
- 少于 2 个字符的值不进字典（一个字母的仓库名会把正文替换得面目全非）。

还原：响应里本次请求的占位符换回原值；出现未知的占位符、大小写被改过的占位符、只剩一层括号的残片或孤立的 `[[` / `]]`，**那一句整句丢弃**（设计文档 7.4）。

**Files:**
- Create: `src/main/gateway/types.ts`
- Create: `src/main/gateway/pseudonym.ts`、`src/main/gateway/pseudonym.test.ts`
- Create: `src/main/gateway/projection.ts`、`src/main/gateway/projection.test.ts`
- Create: `src/main/gateway/testing.ts`

**Interfaces:**
- Consumes: `BriefRule`、`BriefSection`（`src/shared/brief.ts`）、`Handoff`（`src/shared/handoff.ts`）、`FollowupKind`、`FollowupTrigger`、`TicketStatus`（`src/shared/types.ts`）、`PrivacyLevel`（任务 7）
- Produces（`src/main/gateway/types.ts`）:
  - `Rng = (n: number) => number`（返回 `[0, n)` 的整数）
  - `NarrativeFollowup { kind; trigger; description; overdueDays: number | null }`
  - `NarrativeTicket { key; status; pr: { state; review } | null; daysInStatus; idleDays; doneLastDay; nextSteps: string[]; blockers: string[]; followups: NarrativeFollowup[] }`
  - `NarrativeItem { section; rule; ticketKey: string | null; days: number | null; count: number | null }`
  - `KnownValues { tickets: string[]; repos: string[]; branches: string[] }`
  - `NarrativeSource { date: string; tickets: NarrativeTicket[]; items: NarrativeItem[]; known: KnownValues }`
  - `OutboundFollowup`、`OutboundTicket`、`OutboundItem`、`OutboundPayload { date; tickets; items }`
- Produces（`src/main/gateway/pseudonym.ts`）:
  - `PlaceholderKind = "T" | "R" | "B" | "P" | "S"`、`PLACEHOLDER_RE`（全局正则）、`defaultRng: Rng`、`normalizeText(s): string`
  - `Dictionary { tickets; repos; branches; people; terms }`（都是 `readonly string[]`）
  - `class Pseudonymizer`：`constructor(dict: Dictionary, rng?: Rng)`、`token(kind, raw): string`、`apply(text): string`、`get mapping(): ReadonlyMap<string, string>`、`originals(): string[]`
  - `restore(text: string, mapping: ReadonlyMap<string, string>): { text: string; dropped: number }`
- Produces（`src/main/gateway/projection.ts`）:
  - `TEXT_LIMIT = 120`、`LIST_LIMIT = 3`、`truncateOutside(text, limit): string`
  - `project(src: NarrativeSource, level: Exclude<PrivacyLevel, "off">, p: Pseudonymizer, rng: Rng): OutboundPayload`
- Produces（`src/main/gateway/testing.ts`）: `seededRng(seed: number): Rng`（只给测试用）

- [ ] **Step 1: 写失败测试**

新建 `src/main/gateway/pseudonym.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { normalizeText, PLACEHOLDER_RE, Pseudonymizer, restore } from "./pseudonym";
import { seededRng } from "./testing";

const dict = {
  tickets: ["PROJ-12", "PROJ-123"],
  repos: ["acme-billing"],
  branches: ["feature/PROJ-12-login"],
  people: ["张三", "Alice Zhang"],
  terms: ["天穹计划"],
};

describe("Pseudonymizer", () => {
  it("replaces every spelling of a known value", () => {
    const p = new Pseudonymizer(dict, seededRng(1));
    const text = "修好PROJ-12的bug，proj-123 等ＰＲＯＪ－１２合并；分支 feature/PROJ-12-login 在 acme-billing 仓库；找张三和alice zhang确认天穹计划。";
    const out = p.apply(text);
    for (const v of ["PROJ-12", "PROJ-123", "acme-billing", "feature/PROJ-12-login", "张三", "Alice Zhang", "天穹计划"]) {
      expect(out.toLowerCase()).not.toContain(v.toLowerCase());
    }
    expect(out).not.toContain("ＰＲＯＪ");
    // PROJ-12（两种写法）、PROJ-123、分支、仓库、两个人名、一个敏感词：7 个不同的占位符。
    expect(new Set(out.match(PLACEHOLDER_RE)).size).toBe(7);
    expect(restore(out, p.mapping)).toEqual({
      text: normalizeText(text).replace("proj-123", "PROJ-123").replace("alice zhang", "Alice Zhang"),
      dropped: 0,
    });
  });

  it("draws fresh random placeholders for every request", () => {
    const a = new Pseudonymizer(dict);
    const b = new Pseudonymizer(dict);
    expect(a.token("T", "PROJ-12")).toMatch(/^\[\[T_[a-z0-9]{4}\]\]$/);
    expect(a.token("T", "PROJ-12")).not.toBe(b.token("T", "PROJ-12"));
    // 同一次请求里同一个值永远是同一个占位符，不分大小写。
    expect(a.token("T", "proj-12")).toBe(a.token("T", "PROJ-12"));
  });

  it("skips one-character values and still hands out ids for values outside the dictionary", () => {
    const p = new Pseudonymizer({ tickets: [], repos: ["a"], branches: [], people: [], terms: [] }, seededRng(2));
    expect(p.apply("a b c")).toBe("a b c");
    const t = p.token("T", "NEW-1");
    expect(p.mapping.get(t)).toBe("NEW-1");
    expect(p.originals()).toEqual(["NEW-1"]);
  });

  it("restore drops sentences with unknown or mangled placeholders", () => {
    const p = new Pseudonymizer(dict, seededRng(3));
    const t = p.token("T", "PROJ-12");
    const upper = t.toUpperCase();
    const single = t.slice(1, -1);
    const r = restore(`先合并 ${t} 的 PR。再看 [[T_0000]] 的阻塞。然后 ${upper} 收尾！最后 ${single} 部署？还有 [[S_ab 的事。`, p.mapping);
    expect(r).toEqual({ text: "先合并 PROJ-12 的 PR。", dropped: 4 });
  });
});
```

新建 `src/main/gateway/projection.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { LIST_LIMIT, project, TEXT_LIMIT, truncateOutside } from "./projection";
import { Pseudonymizer } from "./pseudonym";
import { seededRng } from "./testing";
import type { NarrativeSource } from "./types";

const source = (): NarrativeSource => ({
  date: "2026-10-21",
  tickets: [
    {
      key: "PROJ-12", status: "active", pr: null, daysInStatus: 1, idleDays: 0, doneLastDay: 2,
      nextSteps: ["修好 PROJ-12 的登录", "第二步", "第三步", "第四步"], blockers: ["等张三回复"],
      followups: [{ kind: "config", trigger: "after_merge", description: "改 acme-billing 的 staging 配置", overdueDays: null }],
    },
    {
      key: "PROJ-123", status: "in_review", pr: { state: "open", review: "approved" }, daysInStatus: 3, idleDays: 1, doneLastDay: 0,
      nextSteps: [], blockers: [], followups: [],
    },
  ],
  items: [
    { section: "today", rule: "next_step", ticketKey: "PROJ-12", days: null, count: null },
    { section: "first", rule: "pr_approved", ticketKey: "PROJ-123", days: null, count: null },
    { section: "watch", rule: "unclaimed", ticketKey: null, days: null, count: 2 },
  ],
  known: { tickets: ["PROJ-12", "PROJ-123"], repos: ["acme-billing"], branches: ["feature/PROJ-12-login"] },
});
const pseudonymizer = (src: NarrativeSource, seed: number) => new Pseudonymizer({ ...src.known, people: ["张三"], terms: [] }, seededRng(seed));

describe("project", () => {
  it("metadata sends only placeholder ids, enums, counts and days", () => {
    const src = source();
    const p = pseudonymizer(src, 4);
    const out = project(src, "metadata", p, seededRng(5));
    const json = JSON.stringify(out);
    for (const v of ["PROJ-12", "PROJ-123", "acme-billing", "张三", "登录", "staging"]) expect(json).not.toContain(v);
    expect(out.tickets.every((t) => !("next_steps" in t) && !("blockers" in t) && t.followups.every((f) => !("description" in f)))).toBe(true);
    expect(out.tickets.map((t) => t.id).sort()).toEqual([p.token("T", "PROJ-12"), p.token("T", "PROJ-123")].sort());
    expect(out.tickets.find((t) => t.id === p.token("T", "PROJ-123"))).toMatchObject({
      status: "in_review", pr: { state: "open", review: "approved" }, days_in_status: 3, idle_days: 1, done_last_day: 0,
    });
    expect(out.items.map((i) => i.section)).toEqual(["first", "today", "watch"]);
    expect(out.items[2]).toEqual({ section: "watch", rule: "unclaimed", ticket: null, days: null, count: 2 });
  });

  it("redacted adds pseudonymized, capped next steps, blockers and followup descriptions", () => {
    const src = source();
    const p = pseudonymizer(src, 6);
    const out = project(src, "redacted", p, seededRng(7));
    const t = out.tickets.find((x) => x.id === p.token("T", "PROJ-12"))!;
    expect(t.next_steps).toEqual([`修好 ${p.token("T", "PROJ-12")} 的登录`, "第二步", "第三步"]);
    expect(t.next_steps).toHaveLength(LIST_LIMIT);
    expect(t.blockers).toEqual([`等${p.token("P", "张三")}回复`]);
    expect(t.followups[0].description).toBe(`改 ${p.token("R", "acme-billing")} 的 staging 配置`);
    const long = project({ ...src, tickets: [{ ...src.tickets[0], nextSteps: ["长".repeat(500)] }] }, "redacted", p, seededRng(7));
    expect([...long.tickets[0].next_steps![0]]).toHaveLength(TEXT_LIMIT + 1);
  });

  it("full sends real keys and text with no placeholders", () => {
    const src = source();
    const out = project(src, "full", pseudonymizer(src, 8), seededRng(9));
    expect(out.tickets.map((t) => t.id).sort()).toEqual(["PROJ-12", "PROJ-123"]);
    expect(JSON.stringify(out)).not.toContain("[[");
    expect(out.tickets.find((t) => t.id === "PROJ-12")?.blockers).toEqual(["等张三回复"]);
  });

  it("shuffles tickets per request so the position does not identify a ticket", () => {
    const base = source();
    const src = { ...base, tickets: Array.from({ length: 8 }, (_, i) => ({ ...base.tickets[1], key: `K-${i}` })) };
    const orders = new Set<string>();
    for (let seed = 1; seed <= 6; seed++) orders.add(project(src, "full", pseudonymizer(src, seed), seededRng(seed)).tickets.map((t) => t.id).join(","));
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("truncateOutside", () => {
  it("truncates without cutting a placeholder in half", () => {
    expect(truncateOutside("abcdef", 10)).toBe("abcdef");
    expect(truncateOutside("ab [[T_abcd]] cd", 6)).toBe("ab…");
    expect(truncateOutside("一二三四五六七八", 4)).toBe("一二三四…");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/gateway`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 类型与测试用随机数**

新建 `src/main/gateway/types.ts`：

```ts
import type { BriefRule, BriefSection } from "../../shared/brief";
import type { Handoff } from "../../shared/handoff";
import type { FollowupKind, FollowupTrigger, TicketStatus } from "../../shared/types";

/** 返回 [0, n) 的随机整数。生产环境用 crypto.randomInt；测试用可复现的 seededRng。 */
export type Rng = (n: number) => number;

type Pr = NonNullable<Handoff["pr"]>;

export interface NarrativeFollowup {
  kind: FollowupKind;
  trigger: FollowupTrigger;
  description: string;
  /** on_date 已到期时逾期的天数（0 表示今天到期）；其余为 null。 */
  overdueDays: number | null;
}

/** 生成“今日重点”需要的、关于一个 ticket 的全部信息（还没有经过任何隐私处理）。 */
export interface NarrativeTicket {
  key: string;
  status: TicketStatus;
  pr: { state: Pr["state"]; review: Pr["review"] } | null;
  daysInStatus: number;
  idleDays: number;
  /** 上个工作日完成的事项数。 */
  doneLastDay: number;
  nextSteps: string[];
  blockers: string[];
  followups: NarrativeFollowup[];
}

export interface NarrativeItem {
  section: BriefSection;
  rule: BriefRule;
  ticketKey: string | null;
  days: number | null;
  count: number | null;
}

/** 数据库里所有可能出现在自由文本里的标识：用来做假名化字典。人名和敏感词由 gateway 从敏感词表补上。 */
export interface KnownValues {
  tickets: string[];
  repos: string[];
  branches: string[];
}

export interface NarrativeSource {
  date: string;
  tickets: NarrativeTicket[];
  items: NarrativeItem[];
  known: KnownValues;
}

/** 下面是真正发给服务商的 JSON（字段名就是出站的样子）。 */
export interface OutboundFollowup {
  kind: FollowupKind;
  trigger: FollowupTrigger;
  overdue_days: number | null;
  description?: string;
}

export interface OutboundTicket {
  /** metadata / redacted：占位符；full：真实 ticket 号。 */
  id: string;
  status: TicketStatus;
  pr: { state: Pr["state"]; review: Pr["review"] } | null;
  days_in_status: number;
  idle_days: number;
  done_last_day: number;
  followups: OutboundFollowup[];
  next_steps?: string[];
  blockers?: string[];
}

export interface OutboundItem {
  section: BriefSection;
  rule: BriefRule;
  ticket: string | null;
  days: number | null;
  count: number | null;
}

export interface OutboundPayload {
  date: string;
  tickets: OutboundTicket[];
  items: OutboundItem[];
}
```

新建 `src/main/gateway/testing.ts`：

```ts
/**
 * 只给测试用的工具（不会被生产代码 import，所以不会打进主进程包）。
 * 放在 gateway 目录里：后面的假服务器要用 node:http，只有这里允许。
 */
import type { Rng } from "./types";

/** 可复现的随机数（mulberry32）。 */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
```

- [ ] **Step 4: 假名化**

新建 `src/main/gateway/pseudonym.ts`：

```ts
import { randomInt } from "node:crypto";
import type { Rng } from "./types";

/** T ticket、R 仓库、B 分支、P 人名、S 其他敏感词。 */
export type PlaceholderKind = "T" | "R" | "B" | "P" | "S";

/** 本次请求合法的占位符形状（全局正则，配合 match / replace 使用）。 */
export const PLACEHOLDER_RE = /\[\[([TRBPS])_([a-z0-9]{4})\]\]/g;
/** 占位符被改坏后留下的痕迹：孤立的 [[ / ]]，或者没有双括号的 T_xxxx。 */
const MANGLED_RE = /\[\[|\]\]|\b[TRBPS]_[A-Za-z0-9]{4}\b/;
/** 去掉易混的 l、o、0、1。 */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const MAX_TRIES = 1000;

export const defaultRng: Rng = (n) => randomInt(n);

/** NFKC：全角字母数字、兼容字符变成普通形式，替换和扫描都在这之后做。 */
export const normalizeText = (s: string): string => s.normalize("NFKC");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface Dictionary {
  tickets: readonly string[];
  repos: readonly string[];
  branches: readonly string[];
  people: readonly string[];
  terms: readonly string[];
}

/**
 * 一次请求的假名化：构造时为字典里每个值随机分配占位符，映射只在这个对象里，用完即弃。
 * 同一个值（不分大小写、NFKC 之后）在本次请求里总是同一个占位符。
 */
export class Pseudonymizer {
  /** 小写的原值 → 占位符。 */
  private readonly toToken = new Map<string, string>();
  /** 占位符 → 原值。 */
  private readonly toOriginal = new Map<string, string>();
  private readonly re: RegExp | null;

  constructor(dict: Dictionary, private readonly rng: Rng = defaultRng) {
    const groups: [PlaceholderKind, readonly string[]][] = [
      ["T", dict.tickets], ["B", dict.branches], ["R", dict.repos], ["P", dict.people], ["S", dict.terms],
    ];
    for (const [kind, values] of groups) for (const v of values) this.register(kind, v);
    // 长的优先：PROJ-123 不会被拆成 PROJ-12 + 3，分支名整体替换。
    const originals = [...this.toToken.keys()].sort((a, b) => b.length - a.length);
    this.re = originals.length ? new RegExp(originals.map(escapeRe).join("|"), "giu") : null;
  }

  private register(kind: PlaceholderKind, raw: string): string | null {
    const v = normalizeText(raw).trim();
    if ([...v].length < 2) return null;
    const k = v.toLowerCase();
    const existing = this.toToken.get(k);
    if (existing) return existing;
    const token = this.newToken(kind);
    this.toToken.set(k, token);
    this.toOriginal.set(token, v);
    return token;
  }

  private newToken(kind: PlaceholderKind): string {
    for (let i = 0; i < MAX_TRIES; i++) {
      let id = "";
      for (let j = 0; j < 4; j++) id += ALPHABET[this.rng(ALPHABET.length)];
      const token = `[[${kind}_${id}]]`;
      if (!this.toOriginal.has(token)) return token;
    }
    throw new Error("无法生成不重复的占位符（随机数源有问题）");
  }

  /** 这个值的占位符；不在字典里的值（比如字典之外的 ticket id）现场分配。 */
  token(kind: PlaceholderKind, raw: string): string {
    const v = normalizeText(raw).trim();
    return this.toToken.get(v.toLowerCase()) ?? this.register(kind, v) ?? this.forceToken(kind, v);
  }

  /** 少于 2 个字符的值也要一个占位符（只在 token() 显式要求时）。 */
  private forceToken(kind: PlaceholderKind, v: string): string {
    const token = this.newToken(kind);
    this.toToken.set(v.toLowerCase(), token);
    this.toOriginal.set(token, v);
    return token;
  }

  /** 把文本里所有字典值换成占位符（NFKC 之后、不分大小写、子串匹配）。 */
  apply(text: string): string {
    const t = normalizeText(text);
    if (!this.re) return t;
    // 正则的大小写折叠和 toLowerCase 偶尔不一致（少数 Unicode 字符）：查不到时也要替换，当作新的敏感词。
    return t.replace(this.re, (m) => this.toToken.get(m.toLowerCase()) ?? this.forceToken("S", m));
  }

  get mapping(): ReadonlyMap<string, string> {
    return this.toOriginal;
  }

  /** 本次请求的全部原值：扫描器据此检查有没有漏网的。 */
  originals(): string[] {
    return [...this.toOriginal.values()];
  }
}

/**
 * 把响应里的占位符换回原值。按句（。！？!?；; 和换行）检查：
 * 含未知占位符或被改坏的占位符的句子整句丢弃（设计文档 7.4）。
 */
export function restore(text: string, mapping: ReadonlyMap<string, string>): { text: string; dropped: number } {
  let dropped = 0;
  const kept = text.split(/(?<=[。！？!?；;\n])/).filter((sentence) => {
    const tokens = sentence.match(PLACEHOLDER_RE) ?? [];
    const bad = tokens.some((t) => !mapping.has(t)) || MANGLED_RE.test(sentence.replace(PLACEHOLDER_RE, " "));
    if (bad) dropped++;
    return !bad;
  });
  return { text: kept.join("").replace(PLACEHOLDER_RE, (t) => mapping.get(t) ?? t).trim(), dropped };
}
```

- [ ] **Step 5: 字段投影**

新建 `src/main/gateway/projection.ts`：

```ts
import type { BriefSection } from "../../shared/brief";
import type { PrivacyLevel } from "../../shared/llm";
import { normalizeText, type Pseudonymizer } from "./pseudonym";
import type { NarrativeSource, OutboundItem, OutboundPayload, OutboundTicket, Rng } from "./types";

/** redacted / full 档位下每段短文本的长度上限（字符）。 */
export const TEXT_LIMIT = 120;
/** next_steps / blockers 每个 ticket 最多发几条。 */
export const LIST_LIMIT = 3;

const SECTION_ORDER: Record<BriefSection, number> = { first: 0, today: 1, watch: 2 };

/** 截断但不切进占位符：切点落在 [[...]] 里面时退到它前面。超长时末尾加 “…”。 */
export function truncateOutside(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  let cut = chars.slice(0, limit).join("");
  const open = cut.lastIndexOf("[[");
  if (open >= 0 && cut.indexOf("]]", open) < 0) cut = cut.slice(0, open);
  return `${cut.trimEnd()}…`;
}

function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 按档位的字段白名单（设计文档 7.3）：
 * - metadata：占位符 id、状态和 PR 枚举、followup 的 kind / trigger、计数和天数；
 * - redacted：再加假名化后的 next_steps、blockers、followup 描述（每条最多 TEXT_LIMIT 字，每类最多 LIST_LIMIT 条）；
 * - full：同 redacted 的字段，但不做假名化。
 * ticket 的顺序每次打乱；条目按 区块 → 规则 → 占位符 排序，不按真实 ticket 号排。
 */
export function project(src: NarrativeSource, level: Exclude<PrivacyLevel, "off">, p: Pseudonymizer, rng: Rng): OutboundPayload {
  const pseudo = level !== "full";
  const withText = level !== "metadata";
  const id = (key: string) => (pseudo ? p.token("T", key) : key);
  const text = (s: string) => truncateOutside(pseudo ? p.apply(s) : normalizeText(s), TEXT_LIMIT);

  const tickets = shuffle(src.tickets, rng).map(
    (t): OutboundTicket => ({
      id: id(t.key),
      status: t.status,
      pr: t.pr ? { state: t.pr.state, review: t.pr.review } : null,
      days_in_status: t.daysInStatus,
      idle_days: t.idleDays,
      done_last_day: t.doneLastDay,
      followups: t.followups.map((f) => ({
        kind: f.kind,
        trigger: f.trigger,
        overdue_days: f.overdueDays,
        ...(withText ? { description: text(f.description) } : {}),
      })),
      ...(withText
        ? { next_steps: t.nextSteps.slice(0, LIST_LIMIT).map(text), blockers: t.blockers.slice(0, LIST_LIMIT).map(text) }
        : {}),
    }),
  );

  const items = src.items
    .map((i): OutboundItem => ({ section: i.section, rule: i.rule, ticket: i.ticketKey === null ? null : id(i.ticketKey), days: i.days, count: i.count }))
    .sort(
      (a, b) =>
        SECTION_ORDER[a.section] - SECTION_ORDER[b.section] || a.rule.localeCompare(b.rule) || (a.ticket ?? "").localeCompare(b.ticket ?? ""),
    );

  return { date: src.date, tickets, items };
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/gateway`
Expected: PASS

- [ ] **Step 7: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/main/gateway/types.ts src/main/gateway/pseudonym.ts src/main/gateway/pseudonym.test.ts \
  src/main/gateway/projection.ts src/main/gateway/projection.test.ts src/main/gateway/testing.ts
git commit -m "feat: per-request random pseudonyms and level-based field projection for the privacy gateway"
```

---

### Task 10: 敏感信息扫描器与样本回归测试

设计文档 7.5：对出站内容做正则扫描，命中任何一条就整次拒发。规则：API key / token 的形状、URL、内网和常见公网域名、IPv4 / IPv6、邮箱、文件路径（POSIX、`~/`、`./`、Windows 盘符、UNC、带常见扩展名的相对路径）、没被替换掉的 ticket 号（用设置里的 `ticketPattern`），以及假名化之后仍然出现的字典原值（`known`，纵深防御）。扫描前先 NFKC，占位符换成空格（它们本身不算命中）。

ticket 号规则会误伤 `UTF-8`、`ISO-8601`、`SHA-256` 这类写法，所以有一个前缀白名单。`full` 档位本来就发真实 ticket 号，调用方传 `ticketPattern: null`、`originals: []`，只跳过这两条，其余规则照样生效。

样本回归测试分两组：应拒发（每条都标明应命中的规则）和不应误伤，两组都包含中文语境。

**Files:**
- Create: `src/main/gateway/scanner.ts`
- Create: `src/main/gateway/scanner.test.ts`

**Interfaces:**
- Consumes: `normalizeText`、`PLACEHOLDER_RE`（任务 9）、`ScanHit`、`ScanRule`（任务 7）
- Produces:
  - `DEFAULT_TICKET_PATTERN = "[A-Z][A-Z0-9]+-\\d+"`
  - `ScanOptions { ticketPattern: string | null; originals: readonly string[] }`
  - `maskSample(s: string): string`（前 3 个字符 + `…(长度)`）
  - `scanOutbound(texts: readonly string[], o: ScanOptions): ScanHit[]`（每条规则最多一条命中；空数组表示可以发）

- [ ] **Step 1: 写失败测试**

新建 `src/main/gateway/scanner.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { ScanRule } from "../../shared/llm";
import { DEFAULT_TICKET_PATTERN, maskSample, scanOutbound } from "./scanner";

const opts = { ticketPattern: DEFAULT_TICKET_PATTERN, originals: [] as string[] };
const rules = (text: string, o = opts) => scanOutbound([text], o).map((h) => h.rule);

/** 应拒发：[应命中的规则, 文本]。 */
const SHOULD_BLOCK: [ScanRule, string][] = [
  ["secret", "把 sk-proj-abcdEFGH1234567890xyz 填到配置里"],
  ["secret", "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
  ["secret", "AKIAIOSFODNN7EXAMPLE 是测试账号"],
  ["secret", "数据库密码：hunter2024"],
  ["secret", "-----BEGIN RSA PRIVATE KEY-----"],
  ["secret", "jwt 是 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
  ["secret", "回滚到 3f786850e387550fdab836ed7e6dc881de23001b"],
  ["secret", "api_key=AbCdEf123456"],
  ["secret", "xoxb-1234567890-abcdefghij 是 slack 的"],
  ["url", "详见 https://jira.example.com/browse/X"],
  ["url", "文档在www.example.org上"],
  ["domain", "连到db01.corp看日志"],
  ["domain", "部署到 api.mycompany.com"],
  ["ip", "服务器 10.12.0.7 挂了"],
  ["ip", "fe80:0:0:0:200:f8ff:fe21:67cf"],
  ["email", "找zhang.san@example.com确认"],
  ["path", "改一下 /etc/nginx/nginx.conf"],
  ["path", "日志在 ~/logs/app.log"],
  ["path", "C:\\Users\\zhang\\repo 下面"],
  ["path", "\\\\fileserver\\share\\doc"],
  ["path", "看src/main/gateway/scanner.ts第3行"],
  ["ticket", "顺便修一下 PROJ-1234"],
  ["ticket", "和ABC-9一起上线"],
];

/** 不应误伤。 */
const SHOULD_PASS = [
  "等 review，预计周三合并",
  "PR #123 已经批准，可以合并了",
  "版本 v2.1.306 修复了 UTF-8 编码问题",
  "按 ISO-8601 格式输出日期 2026-10-21",
  "SHA-256 校验通过",
  "16:00 跑晚间 handoff，耗时 12:30:45",
  "A/B 测试和前端/后端联调",
  "完成率 85%，还剩 3 个子任务",
  "第 3/4 步完成",
  "改 staging 配置，打开 feature flag",
  "README.md 和 config.yaml 要同步",
  "Node.js 和 Next.js 升级",
  "用 1.5 倍超时重试",
  "token 用量 1200",
  "下周一 9 点和产品开会，讨论退款流程",
  "[[T_ab12]] 的 PR 等 [[P_x7k2]] review，[[R_9fqz]] 的 [[B_m3n4]] 要 rebase",
];

describe("scanOutbound corpus", () => {
  it.each(SHOULD_BLOCK)("blocks %s: %s", (rule, text) => {
    expect(rules(text)).toContain(rule);
  });

  it.each(SHOULD_PASS)("does not flag: %s", (text) => {
    expect(rules(text)).toEqual([]);
  });
});

describe("scanOutbound options", () => {
  it("finds a dictionary value that survived pseudonymization, ignoring case", () => {
    expect(rules("请 acme 的同事确认", { ...opts, originals: ["张三", "ACME"] })).toEqual(["known"]);
  });

  it("skips the ticket rule when the pattern is null (full level) and falls back to the default for an invalid pattern", () => {
    expect(rules("顺便修一下 PROJ-1234", { ...opts, ticketPattern: null })).toEqual([]);
    expect(rules("顺便修一下 PROJ-1234", { ...opts, ticketPattern: "[" })).toEqual(["ticket"]);
    expect(rules("fix proj#12", { ...opts, ticketPattern: "[a-z]+#\\d+" })).toEqual(["ticket"]);
  });

  it("normalizes full-width text before scanning and reports each rule once, masked", () => {
    expect(rules("顺便修一下ＰＲＯＪ－１２")).toEqual(["ticket"]);
    const hits = scanOutbound(["https://a.example.com 和 https://b.example.com"], opts);
    expect(hits.filter((h) => h.rule === "url")).toEqual([{ rule: "url", sample: "htt…(21)" }]);
    expect(maskSample("密码很长很长")).toBe("密码很…(6)");
  });

  it("scans every text it is given", () => {
    expect(scanOutbound(["没问题", "也没问题", "发邮件到 a@b.io"], opts).map((h) => h.rule)).toEqual(["email", "domain"]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/gateway/scanner.test.ts`
Expected: FAIL（`./scanner` 不存在）

- [ ] **Step 3: 实现**

新建 `src/main/gateway/scanner.ts`：

```ts
import type { ScanHit, ScanRule } from "../../shared/llm";
import { normalizeText, PLACEHOLDER_RE } from "./pseudonym";

export const DEFAULT_TICKET_PATTERN = "[A-Z][A-Z0-9]+-\\d+";
/** 长得像 ticket 号、其实是标准或算法名的写法。 */
const NOT_TICKETS = /^(?:UTF|ISO|SHA|AES|RSA|HTTP|TLS|SSL|ES|ECMA|RFC|CVE|IEEE|GB|COVID|MD|IPV|WCAG|PEP|JSR)-\d+$/i;

interface Rule {
  rule: ScanRule;
  re: RegExp;
}

/** 都是全局正则（matchAll 需要）。路径规则带前导边界字符，命中样本会 trim。 */
const RULES: Rule[] = [
  { rule: "secret", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: "secret", re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g },
  { rule: "secret", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { rule: "secret", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { rule: "secret", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "secret", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "secret", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { rule: "secret", re: /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\s*[:=]\s*\S{6,}/gi },
  { rule: "secret", re: /(?:密码|口令|密钥|令牌)\s*[:：=]\s*\S{4,}/g },
  { rule: "secret", re: /\b[A-Fa-f0-9]{32,}\b/g },
  // 40 位以上、同时有数字和大小写字母、没有空白的串（base64 / 随机 token）。
  { rule: "secret", re: /\b(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{40,}={0,2}/g },
  { rule: "url", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>）)]+/gi },
  { rule: "url", re: /\bwww\.[a-z0-9-]+\.[a-z]{2,}/gi },
  { rule: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { rule: "ip", re: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g },
  { rule: "ip", re: /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi },
  { rule: "domain", re: /\b(?:[a-z0-9-]+\.)+(?:internal|corp|local|lan|intranet|intra|private|localdomain)\b/gi },
  { rule: "domain", re: /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|cn|ai|cloud|info|biz)\b/gi },
  { rule: "path", re: /(?:^|[\s"'`(（=:：])(?:~|\.{1,2})?\/(?:[\w.@-]+\/)+[\w.@-]*/g },
  { rule: "path", re: /(?:^|[\s"'`(（=:：])(?:~|\.{1,2})\/[\w.@-]+/g },
  { rule: "path", re: /\b[A-Za-z]:\\[^\s"'<>|]+/g },
  { rule: "path", re: /\\\\[\w.-]+\\[^\s"'<>|]+/g },
  {
    rule: "path",
    re: /\b(?:[\w.-]+\/)+[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|rs|php|cs|cpp|cc|c|h|hpp|swift|scala|sql|sh|ps1|ya?ml|json|toml|ini|env|md|html|css|scss|vue|svelte|xml|gradle|proto|tf)\b/gi,
  },
];

export interface ScanOptions {
  /** 设置里的 ticket 号正则；null 表示不查（full 档位本来就发真实 ticket 号）。 */
  ticketPattern: string | null;
  /** 本次请求字典里的原值：假名化之后还出现就是漏网了（full 档位传空）。 */
  originals: readonly string[];
}

/** 打码样本：前 3 个字符 + 长度。审计页靠它定位问题，又不把敏感内容原样存下来。 */
export function maskSample(s: string): string {
  const chars = [...s];
  return `${chars.slice(0, 3).join("")}…(${chars.length})`;
}

function ticketRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "g");
  } catch {
    return new RegExp(DEFAULT_TICKET_PATTERN, "g");
  }
}

/** 扫描全部出站文本。返回的命中按规则去重；空数组表示可以发。 */
export function scanOutbound(texts: readonly string[], o: ScanOptions): ScanHit[] {
  const hits: ScanHit[] = [];
  const seen = new Set<ScanRule>();
  const add = (rule: ScanRule, sample: string) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    hits.push({ rule, sample: maskSample(sample) });
  };
  const ticketRe = o.ticketPattern === null ? null : ticketRegExp(o.ticketPattern);
  const originals = o.originals.map((v) => v.toLowerCase());
  for (const raw of texts) {
    // 占位符本身不算命中；换成空格，免得两边的字粘成一个词。
    const text = normalizeText(raw).replace(PLACEHOLDER_RE, " ");
    for (const r of RULES) {
      const m = text.match(r.re);
      if (m) add(r.rule, m[0].trim());
    }
    if (ticketRe) {
      for (const m of text.matchAll(ticketRe)) {
        if (!NOT_TICKETS.test(m[0])) {
          add("ticket", m[0]);
          break;
        }
      }
    }
    const lower = text.toLowerCase();
    const leaked = originals.find((v) => lower.includes(v));
    if (leaked !== undefined) add("known", leaked);
  }
  return hits;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/gateway/scanner.test.ts`
Expected: PASS。如果某条“不应误伤”的样本被拦下，或某条“应拒发”没被拦下，改对应的正则，**不要**删样本或改样本的意思；改完重跑整个文件，确认两组都通过。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/main/gateway/scanner.ts src/main/gateway/scanner.test.ts
git commit -m "feat: outbound sensitive-info scanner with a should-block / should-pass corpus"
```

---

### Task 11: OpenAI 兼容客户端与本地假服务器

设计文档 7.6：统一走 OpenAI 兼容的 `POST {baseUrl}/chat/completions`。这是全仓库唯一真正发网络请求的地方。要求：

- 请求头只有 `content-type`、`accept`，有 key 时加 `authorization: Bearer <key>`；本机服务可以不带 key。
- 不跟随重定向（`redirect: "error"`）：一次 302 不能把带着 key 的请求转到别的地方。
- 超时默认 60 秒（`AbortSignal.timeout`），可以叠加外部的取消信号（退出 app）。
- 响应最多读 1,000,000 个字符，超出就报错。
- 报错信息里出现 key 或 `Bearer xxx` 时替换成 `***`（有的服务商会把请求头原样回显）。
- 有的模型（例如 OpenAI 的推理模型）不认 `max_tokens`、要求 `max_completion_tokens`：遇到 400 且报错里提到 `max_completion_tokens` 时，换参数名重试一次（被拒的请求没有生成，不计费）。
- 只解析 `choices[0].message.content`（字符串，或 `[{ text }]` 片段数组）和 `usage.prompt_tokens` / `completion_tokens`。

测试在进程内用 `node:http` 起一个假的 OpenAI 兼容服务器（`127.0.0.1`，端口 0），永远不访问真实服务商。

**Files:**
- Create: `src/main/gateway/provider.ts`
- Create: `src/main/gateway/provider.test.ts`
- Modify: `src/main/gateway/testing.ts`

**Interfaces:**
- Consumes: `formatDuration`（任务 3）
- Produces（`src/main/gateway/provider.ts`）:
  - `ChatMessage { role: "system" | "user"; content: string }`
  - `ChatRequest { baseUrl; apiKey: string | null; model; messages: ChatMessage[]; maxTokens: number; timeoutMs?: number; signal?: AbortSignal }`
  - `ChatResponse { content: string; tokensIn: number | null; tokensOut: number | null; raw: string; sentBody: string }`
  - `ProviderErrorKind = "http" | "timeout" | "network" | "bad_response" | "aborted"`；`class ProviderError extends Error { kind; status: number | null }`
  - `ChatCall = (req: ChatRequest) => Promise<ChatResponse>`；`chatCompletion: ChatCall`
  - `chatUrl(baseUrl): string`、`chatBody(req, tokenParam = "max_tokens"): string`、`scrub(text, secret): string`
  - `PROVIDER_TIMEOUT_MS = 60_000`、`RESPONSE_LIMIT = 1_000_000`
- Produces（`src/main/gateway/testing.ts`）:
  - `FakeRequest { method; url; headers; body }`、`FakeReply { status?; headers?; body?; raw?; delayMs? }`、`FakeHandler = (req, n) => FakeReply`
  - `FakeProvider { baseUrl; requests: FakeRequest[]; handle(fn): void; close(): Promise<void> }`
  - `chatReply(content, usage?): FakeReply`、`startFakeProvider(): Promise<FakeProvider>`（默认回复 `{"focus":["OK"]}`）

- [ ] **Step 1: 测试工具：假服务器**

`src/main/gateway/testing.ts`：在文件顶部（`import type { Rng } ...` 旁边）加

```ts
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
```

并在文件末尾追加：

```ts
export interface FakeRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** 以 JSON 返回；给了 raw 时原样返回 raw。 */
  body?: unknown;
  raw?: string;
  /** 延迟多久再回复（测超时）。 */
  delayMs?: number;
}

export type FakeHandler = (req: FakeRequest, n: number) => FakeReply;

export interface FakeProvider {
  /** 形如 http://127.0.0.1:<port>/v1，可以直接填进 llmBaseUrl。 */
  baseUrl: string;
  requests: FakeRequest[];
  handle(fn: FakeHandler): void;
  close(): Promise<void>;
}

/** 一个成功的 chat.completion 响应。usage 为 null 时不带 usage 字段。 */
export function chatReply(
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number } | null = { prompt_tokens: 120, completion_tokens: 40 },
): FakeReply {
  return {
    body: {
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      ...(usage ? { usage } : {}),
    },
  };
}

/** 进程内的假 OpenAI 兼容服务器，只监听 127.0.0.1。记录收到的每个请求，按 handle() 给的函数回复。 */
export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: FakeRequest[] = [];
  let handler: FakeHandler = () => chatReply('{"focus":["OK"]}');
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const r: FakeRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(r);
      const reply = handler(r, requests.length);
      const send = () => {
        if (res.destroyed || res.headersSent) return;
        res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
        res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs).unref();
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    handle: (fn) => {
      handler = fn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 2: 写失败测试**

新建 `src/main/gateway/provider.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { chatBody, chatCompletion, ProviderError, RESPONSE_LIMIT, scrub, type ChatRequest } from "./provider";
import { chatReply, startFakeProvider, type FakeProvider } from "./testing";

const KEY = "sk-test-0123456789abcdef";
const open: FakeProvider[] = [];
async function provider(): Promise<FakeProvider> {
  const p = await startFakeProvider();
  open.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((p) => p.close()));
});

const req = (baseUrl: string, over: Partial<ChatRequest> = {}): ChatRequest => ({
  baseUrl, apiKey: KEY, model: "fake-model", maxTokens: 800,
  messages: [{ role: "system", content: "你是助理" }, { role: "user", content: '{"a":1}' }],
  ...over,
});

describe("chatCompletion against a local fake server", () => {
  it("posts an OpenAI-compatible request and reads the content and usage", async () => {
    const p = await provider();
    p.handle(() => chatReply('{"focus":["先合并"]}', { prompt_tokens: 321, completion_tokens: 12 }));
    const r = await chatCompletion(req(p.baseUrl));
    expect(r).toMatchObject({ content: '{"focus":["先合并"]}', tokensIn: 321, tokensOut: 12 });
    const [got] = p.requests;
    expect(got.method).toBe("POST");
    expect(got.url).toBe("/v1/chat/completions");
    expect(got.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(got.body)).toEqual({ model: "fake-model", messages: req(p.baseUrl).messages, max_tokens: 800, stream: false });
    expect(r.sentBody).toBe(got.body);
    expect(got.body).not.toContain(KEY);
  });

  it("sends no authorization header without a key and accepts content parts and missing usage", async () => {
    const p = await provider();
    p.handle(() => ({ body: { choices: [{ message: { content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] } }] } }));
    const r = await chatCompletion(req(p.baseUrl, { apiKey: null }));
    expect(p.requests[0].headers.authorization).toBeUndefined();
    expect(r).toMatchObject({ content: "甲乙", tokensIn: null, tokensOut: null });
  });

  it("reports HTTP errors without leaking the key a provider echoes back", async () => {
    const p = await provider();
    p.handle((r) => ({ status: 401, body: { error: `bad key: ${r.headers.authorization}` } }));
    const err = await chatCompletion(req(p.baseUrl)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "http", status: 401 });
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).toContain("***");
  });

  it("rejects a 200 that is not a chat completion", async () => {
    const p = await provider();
    p.handle(() => ({ raw: "<html>login</html>", headers: { "content-type": "text/html" } }));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "bad_response" });
    p.handle(() => ({ body: { choices: [] } }));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("times out and can be cancelled", async () => {
    const p = await provider();
    p.handle(() => ({ ...chatReply("x"), delayMs: 3000 }));
    await expect(chatCompletion(req(p.baseUrl, { timeoutMs: 200 }))).rejects.toMatchObject({ kind: "timeout", message: "超过 200 毫秒没有响应" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(chatCompletion(req(p.baseUrl, { signal: ac.signal }))).rejects.toMatchObject({ kind: "aborted" });
  });

  it("never follows a redirect, so the key cannot be forwarded", async () => {
    const p = await provider();
    const other = await provider();
    p.handle(() => ({ status: 302, headers: { location: `${other.baseUrl}/chat/completions` } }));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "network" });
    expect(other.requests).toHaveLength(0);
  });

  it("retries once with max_completion_tokens when the model rejects max_tokens", async () => {
    const p = await provider();
    p.handle((_r, n) =>
      n === 1
        ? { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } }
        : chatReply("ok"),
    );
    const r = await chatCompletion(req(p.baseUrl));
    expect(p.requests).toHaveLength(2);
    expect(JSON.parse(p.requests[1].body)).toMatchObject({ max_completion_tokens: 800 });
    expect(JSON.parse(p.requests[1].body).max_tokens).toBeUndefined();
    expect(r.sentBody).toBe(p.requests[1].body);
  });

  it("refuses an oversized response", async () => {
    const p = await provider();
    p.handle(() => ({ raw: "x".repeat(RESPONSE_LIMIT + 10) }));
    await expect(chatCompletion(req(p.baseUrl))).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("provider helpers", () => {
  it("builds the body and scrubs secrets", () => {
    expect(JSON.parse(chatBody({ model: "m", messages: [], maxTokens: 5 }, "max_completion_tokens"))).toEqual({ model: "m", messages: [], max_completion_tokens: 5, stream: false });
    expect(scrub(`header was Bearer ${KEY} and ${KEY}`, KEY)).toBe("header was Bearer *** and ***");
    expect(scrub("Authorization: Bearer abc.def", null)).toBe("Authorization: Bearer ***");
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/gateway/provider.test.ts`
Expected: FAIL（`./provider` 不存在）

- [ ] **Step 4: 实现**

新建 `src/main/gateway/provider.ts`：

```ts
import { formatDuration } from "../../shared/text";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatRequest {
  /** 规范化后的 base URL（normalizeBaseUrl），例如 https://api.deepseek.com/v1。 */
  baseUrl: string;
  /** 本机服务可以为 null。 */
  apiKey: string | null;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  tokensIn: number | null;
  tokensOut: number | null;
  /** 原样的响应体（写审计用）。 */
  raw: string;
  /** 实际发出的请求体（换参数名重试时是第二次的）。 */
  sentBody: string;
}

export type ProviderErrorKind = "http" | "timeout" | "network" | "bad_response" | "aborted";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export type ChatCall = (req: ChatRequest) => Promise<ChatResponse>;

export const PROVIDER_TIMEOUT_MS = 60_000;
export const RESPONSE_LIMIT = 1_000_000;
type TokenParam = "max_tokens" | "max_completion_tokens";

export function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** 请求体就是审计里的“原样发出的内容”：key 在请求头里，永远不在请求体里。 */
export function chatBody(req: Pick<ChatRequest, "model" | "messages" | "maxTokens">, tokenParam: TokenParam = "max_tokens"): string {
  return JSON.stringify({ model: req.model, messages: req.messages, [tokenParam]: req.maxTokens, stream: false });
}

/** 去掉报错信息里的 key 和任何 Bearer 凭证（有的服务商把请求头原样回显）。 */
export function scrub(text: string, secret: string | null): string {
  const t = secret && secret.length >= 4 ? text.split(secret).join("***") : text;
  return t.replace(/Bearer\s+(?!\*\*\*)\S+/gi, "Bearer ***");
}

async function readCapped(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError("bad_response", `响应超过 ${limit} 个字符`);
    }
  }
  return out + decoder.decode();
}

function contentOf(v: unknown): string | null {
  const c = (v as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const text = c.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
    return text || null;
  }
  return null;
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

async function attempt(req: ChatRequest, body: string): Promise<{ status: number; text: string }> {
  const timeoutMs = req.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`;
  try {
    const res = await fetch(chatUrl(req.baseUrl), { method: "POST", headers, body, signal, redirect: "error" });
    return { status: res.status, text: await readCapped(res, RESPONSE_LIMIT) };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (req.signal?.aborted) throw new ProviderError("aborted", "已取消");
    if (timeout.aborted) throw new ProviderError("timeout", `超过 ${formatDuration(timeoutMs)} 没有响应`);
    const cause = e instanceof Error ? `${e.message}${e.cause instanceof Error ? `：${e.cause.message}` : ""}` : String(e);
    throw new ProviderError("network", scrub(cause, req.apiKey));
  }
}

/** POST {baseUrl}/chat/completions。所有失败都抛 ProviderError，信息里不会有 key。 */
export const chatCompletion: ChatCall = async (req) => {
  let body = chatBody(req, "max_tokens");
  let r = await attempt(req, body);
  // 有的模型只认 max_completion_tokens：400 且报错里提到它时换参数名重试一次（被拒的请求没有生成，不计费）。
  if (r.status === 400 && r.text.includes("max_completion_tokens")) {
    body = chatBody(req, "max_completion_tokens");
    r = await attempt(req, body);
  }
  if (r.status < 200 || r.status >= 300) {
    throw new ProviderError("http", `HTTP ${r.status}：${scrub(r.text, req.apiKey).slice(0, 300)}`, r.status);
  }
  let v: unknown;
  try {
    v = JSON.parse(r.text);
  } catch {
    throw new ProviderError("bad_response", "响应不是 JSON");
  }
  const content = contentOf(v);
  if (content === null) throw new ProviderError("bad_response", "响应里没有 choices[0].message.content");
  const usage = (v as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  return { content, tokensIn: count(usage?.prompt_tokens), tokensOut: count(usage?.completion_tokens), raw: r.text, sentBody: body };
};
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/gateway/provider.test.ts`
Expected: PASS（全程只连 127.0.0.1）

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过（`pnpm lint` 不会报 `provider.ts` 和 `testing.ts`：它们在 gateway 目录里）

```bash
git add src/main/gateway/provider.ts src/main/gateway/provider.test.ts src/main/gateway/testing.ts
git commit -m "feat: OpenAI-compatible client with no redirects, capped responses, scrubbed errors, tested against a local fake server"
```

---
### Task 12: key 的加密保存，以及 StateCore 的 key 约束

设计文档 7.6：API key 用 Electron `safeStorage` 加密（macOS 钥匙串、Windows DPAPI）。`KeyStore` 只把密文写进 `secrets` 表；解密只在主进程里、只给 gateway 用；界面只能拿到 `state()`：有没有保存、打码后的形式（`••••` + 末 4 位）、是不是解不开了、系统加密能不能用。系统加密不可用时拒绝保存，不会退回明文。

设计文档 8.5：StateCore 的 `consolidate` 和自动蒸馏会把原始事件发给 `MODEL_API_KEY` 对应的服务商，所以只有档位为 `full` 时才能把 key 交给它。StateCore 的接线在计划 4，本任务先把这条约束做成一个有测试的函数 `statecoreEnv`，计划 4 必须用它生成 StateCore 的环境变量。它还会去掉用户 shell 里已有的 `MODEL_*` / `FEATURE_LLM`，免得它们被继承下去。

**Files:**
- Create: `src/main/gateway/key-store.ts`、`src/main/gateway/key-store.test.ts`
- Create: `src/main/gateway/safe-storage.ts`
- Create: `src/main/gateway/statecore-env.ts`、`src/main/gateway/statecore-env.test.ts`
- Modify: `src/main/gateway/testing.ts`

**Interfaces:**
- Consumes: `SecretsRepo`（任务 7）、`KeyState`、`PrivacyLevel`（任务 7）、`SettingError`
- Produces:
  - `SecretBox { available(): boolean; encrypt(plain: string): Uint8Array; decrypt(data: Uint8Array): string }`
  - `API_KEY_SECRET = "llm_api_key"`、`maskKey(key: string): string`
  - `class KeyStore`：`constructor({ secrets, box, now, log? })`、`save(key: string): KeyState`（格式不对或加密不可用时抛 `SettingError`）、`clear(): KeyState`、`saved(): boolean`（不碰系统钥匙串）、`get(): string | null`（只给 gateway）、`state(): KeyState`
  - `electronSecretBox: SecretBox`（`src/main/gateway/safe-storage.ts`）
  - `statecoreEnv(base: NodeJS.ProcessEnv, level: PrivacyLevel, apiKey: string | null): Record<string, string>`
  - 测试用 `fakeSecretBox(o?: { available?: boolean; broken?: boolean })`，返回值另有 `setAvailable(v)`、`setBroken(v)`

- [ ] **Step 1: 测试工具：假加密盒**

`src/main/gateway/testing.ts`：import 区加 `import type { SecretBox } from "./key-store";`，文件末尾追加：

```ts
export type FakeSecretBox = SecretBox & { setAvailable(v: boolean): void; setBroken(v: boolean): void };

/** 可逆的假加密（逐字节异或），用来证明落盘的不是明文；可以模拟“加密不可用”和“解不开”。 */
export function fakeSecretBox(o: { available?: boolean; broken?: boolean } = {}): FakeSecretBox {
  let available = o.available ?? true;
  let broken = o.broken ?? false;
  const xor = (b: Uint8Array) => b.map((x) => x ^ 0x5a);
  return {
    available: () => available,
    encrypt: (plain) => xor(new TextEncoder().encode(plain)),
    decrypt: (data) => {
      if (broken) throw new Error("decrypt failed");
      return new TextDecoder().decode(xor(data));
    },
    setAvailable: (v) => {
      available = v;
    },
    setBroken: (v) => {
      broken = v;
    },
  };
}
```

- [ ] **Step 2: 写失败测试**

新建 `src/main/gateway/key-store.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { SecretsRepo } from "../db/secrets-repo";
import { SettingError } from "../settings/settings-values";
import { memDb } from "../test-utils";
import { API_KEY_SECRET, KeyStore, maskKey } from "./key-store";
import { fakeSecretBox } from "./testing";

const KEY = "sk-live-abcdefghijklmnop1234";

function setup() {
  const secrets = new SecretsRepo(memDb());
  const box = fakeSecretBox();
  const logs: string[] = [];
  const keys = new KeyStore({ secrets, box, now: () => 1, log: (m) => logs.push(m) });
  return { secrets, box, keys, logs };
}

describe("KeyStore", () => {
  it("stores only ciphertext and exposes a masked form", () => {
    const { secrets, keys } = setup();
    expect(keys.saved()).toBe(false);
    expect(keys.state()).toEqual({ keySaved: false, keyMasked: null, keyUnreadable: false, encryptionAvailable: true });
    expect(keys.save(`  ${KEY}\n`)).toEqual({ keySaved: true, keyMasked: "••••1234", keyUnreadable: false, encryptionAvailable: true });
    expect(Buffer.from(secrets.get(API_KEY_SECRET)!).toString("latin1")).not.toContain("sk-live");
    expect(keys.get()).toBe(KEY);
    expect(keys.saved()).toBe(true);
    expect(JSON.stringify(keys.state())).not.toContain(KEY.slice(0, -4));
  });

  it("refuses malformed keys and refuses to save when system encryption is unavailable", () => {
    const { keys, box, secrets } = setup();
    for (const bad of ["short", "sk live with spaces 1234", `sk-${"x".repeat(600)}`, "sk-abc\ndefghij"]) {
      expect(() => keys.save(bad), bad).toThrow(SettingError);
    }
    box.setAvailable(false);
    expect(() => keys.save(KEY)).toThrow(SettingError);
    expect(secrets.get(API_KEY_SECRET)).toBeNull();
    expect(keys.state().encryptionAvailable).toBe(false);
  });

  it("reports a key that can no longer be decrypted, without logging it, and can clear it", () => {
    const { keys, box, logs } = setup();
    keys.save(KEY);
    box.setBroken(true);
    expect(keys.get()).toBeNull();
    expect(keys.state()).toEqual({ keySaved: true, keyMasked: null, keyUnreadable: true, encryptionAvailable: true });
    expect(logs.join("\n")).not.toContain("sk-live");
    expect(keys.clear()).toMatchObject({ keySaved: false, keyUnreadable: false });
  });

  it("masks short keys entirely", () => {
    expect(maskKey("abcdefgh")).toBe("••••");
    expect(maskKey("abcdefghijkl")).toBe("••••ijkl");
  });
});
```

新建 `src/main/gateway/statecore-env.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { statecoreEnv } from "./statecore-env";

describe("statecoreEnv (design 8.5)", () => {
  const base = { PATH: "/bin", HOME: "/h", MODEL_API_KEY: "inherited", MODEL_BASE_URL: "https://x", FEATURE_LLM: "true", UNSET: undefined };

  it("never gives StateCore a personal key below the full level, and strips inherited model settings", () => {
    for (const level of ["off", "metadata", "redacted"] as const) {
      expect(statecoreEnv(base, level, "sk-mine"), level).toEqual({ PATH: "/bin", HOME: "/h" });
    }
  });

  it("hands over the key only at the full level", () => {
    expect(statecoreEnv(base, "full", "sk-mine")).toEqual({ PATH: "/bin", HOME: "/h", FEATURE_LLM: "true", MODEL_API_KEY: "sk-mine" });
    expect(statecoreEnv(base, "full", null)).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/gateway/key-store.test.ts src/main/gateway/statecore-env.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

新建 `src/main/gateway/key-store.ts`：

```ts
import type { KeyState } from "../../shared/llm";
import type { SecretsRepo } from "../db/secrets-repo";
import { SettingError } from "../settings/settings-values";

export const API_KEY_SECRET = "llm_api_key";

/** 系统加密存储。生产环境是 Electron safeStorage（safe-storage.ts），测试用 fakeSecretBox。 */
export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(data: Uint8Array): string;
}

/** 界面上显示的 key：•••• + 末 4 位；太短的 key 全部打码。 */
export function maskKey(key: string): string {
  return key.length >= 12 ? `••••${key.slice(-4)}` : "••••";
}

export interface KeyStoreDeps {
  secrets: SecretsRepo;
  box: SecretBox;
  now: () => number;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * 个人 API key：只以密文落盘。解密只在主进程里、只给 gateway 用（get）；
 * IPC 只能返回 state()，完整的 key 保存之后永远不回到渲染进程。
 */
export class KeyStore {
  constructor(private readonly d: KeyStoreDeps) {}

  save(key: string): KeyState {
    const k = key.trim();
    // eslint-disable-next-line no-control-regex
    if (k.length < 8 || k.length > 512 || /[\s\u0000-\u001f\u007f]/.test(k)) {
      throw new SettingError("API key 格式不对：8–512 个字符，不能有空格或换行");
    }
    if (!this.d.box.available()) throw new SettingError("系统的加密存储不可用，Butler 不会以明文保存 key");
    this.d.secrets.set(API_KEY_SECRET, this.d.box.encrypt(k), this.d.now());
    return this.state();
  }

  clear(): KeyState {
    this.d.secrets.delete(API_KEY_SECRET);
    return this.state();
  }

  /** 有没有保存过 key。只查数据库，不碰系统钥匙串（没配置时 gateway 不会去访问钥匙串）。 */
  saved(): boolean {
    return this.d.secrets.get(API_KEY_SECRET) !== null;
  }

  /** 只给 gateway 用。没有保存、或者解不开（钥匙串被重置、换了电脑）时为 null。 */
  get(): string | null {
    const data = this.d.secrets.get(API_KEY_SECRET);
    if (!data) return null;
    try {
      return this.d.box.decrypt(data);
    } catch {
      // 不记录错误对象：有的实现会把密文或明文片段带进 message。
      this.d.log?.("saved API key cannot be decrypted; it needs to be entered again");
      return null;
    }
  }

  state(): KeyState {
    const saved = this.saved();
    const key = saved ? this.get() : null;
    return { keySaved: saved, keyMasked: key ? maskKey(key) : null, keyUnreadable: saved && key === null, encryptionAvailable: this.d.box.available() };
  }
}
```

新建 `src/main/gateway/safe-storage.ts`：

```ts
import { safeStorage } from "electron";
import type { SecretBox } from "./key-store";

/** Electron safeStorage：macOS 用钥匙串，Windows 用 DPAPI。只能在 app ready 之后使用。 */
export const electronSecretBox: SecretBox = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => new Uint8Array(safeStorage.encryptString(plain)),
  decrypt: (data) => safeStorage.decryptString(Buffer.from(data)),
};
```

新建 `src/main/gateway/statecore-env.ts`：

```ts
import type { PrivacyLevel } from "../../shared/llm";

/**
 * 设计文档 8.5：StateCore 的 consolidate / 自动蒸馏会把原始事件发给 MODEL_API_KEY 对应的服务商，
 * 所以只有 full 档位才给它 key 并打开 FEATURE_LLM；其他档位连从用户环境继承来的 MODEL_* / FEATURE_LLM 也去掉。
 * 计划 4 接入 StateCore 时，它的环境变量必须由这个函数生成。
 */
export function statecoreEnv(base: NodeJS.ProcessEnv, level: PrivacyLevel, apiKey: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k === "FEATURE_LLM" || k.startsWith("MODEL_")) continue;
    env[k] = v;
  }
  if (level === "full" && apiKey) {
    env.FEATURE_LLM = "true";
    env.MODEL_API_KEY = apiKey;
  }
  return env;
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/gateway/key-store.test.ts src/main/gateway/statecore-env.test.ts`
Expected: PASS

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/main/gateway/key-store.ts src/main/gateway/key-store.test.ts src/main/gateway/safe-storage.ts \
  src/main/gateway/statecore-env.ts src/main/gateway/statecore-env.test.ts src/main/gateway/testing.ts
git commit -m "feat: encrypted API key store with a masked view, and the full-level-only StateCore key rule"
```

---

### Task 13: PrivacyGateway 管道

把前面的部件按设计文档 7.2 的顺序串起来：

```
读配置 → [档位 off / 未配置 → off] → 取 key → 字典（ticket、仓库、分支 + 敏感词表里的人名和敏感词）
→ 字段投影 + 假名化 → 组装消息和请求体 → 预算检查 → 敏感信息扫描 → 写审计（pending，原样请求体）
→ [发送前确认] → 发送 → 记账（token、费用、原样响应）→ 解析 {"focus": [...]} → 还原占位符、丢弃坏句 → 结果
```

- 超预算或没有价格 → `budget`（审计记一条 `budget`，不带请求体）。设计文档 7.6 说超出后“视为 off”，所以预算检查放在扫描之前。
- 扫描命中 → `blocked`（审计记一条 `blocked`，只有打码的命中样本，不带请求体）。形状规则（密钥、URL、域名、IP、邮箱、路径）查出站 JSON 的所有字符串；“未替换的 ticket 号”和“漏网的字典原值”只查自由文本。系统提示是固定文本，由 `narrative.test.ts` 保证它本身能通过扫描。
- 拒绝确认 → `off`；确认对话框出错或 app 正在退出 → `failed`。两种情况审计都记 `declined`。
- 发送失败 → `failed`（审计 `failed`，错误信息已去掉 key）。
- 发出去了但响应不能用（不是约定的 JSON、句子全被丢弃）→ `failed`，但审计照样记 `sent` 和费用：钱已经花了。
- 每次调用前按保留天数清理旧审计。
- 所有调用串行执行：两次请求不会同时通过预算检查。`narrate()` 永远不抛错。

**Files:**
- Create: `src/main/gateway/narrative.ts`、`src/main/gateway/narrative.test.ts`
- Create: `src/main/gateway/gateway.ts`、`src/main/gateway/gateway.test.ts`
- Modify: `src/main/gateway/testing.ts`

**Interfaces:**
- Consumes: 任务 7–12 的全部部件：`AuditRepo`、`TermsRepo`、`SettingsRepo`、`llmConfig`、`isLoopbackHost`、`checkBudget`、`costUsd`、`estimateTokens`、`monthStart`、`KeyStore`、`project`、`Pseudonymizer`、`restore`、`defaultRng`、`scanOutbound`、`chatBody`、`chatCompletion`、`chatUrl`、`scrub`、`ChatCall`、`ChatMessage`、`NarrativeSource`、`OutboundPayload`、`Rng`
- Produces（`src/main/gateway/narrative.ts`）:
  - `NARRATIVE_MAX_TOKENS = 800`、`NARRATIVE_SYSTEM_PROMPT: string`
  - `narrativeMessages(payload: OutboundPayload): ChatMessage[]`
  - `parseNarrative(content: string): string[] | null`
- Produces（`src/main/gateway/gateway.ts`）:
  - `GatewayDeps { settings; audit; terms; keys: Pick<KeyStore, "get" | "saved">; chat?: ChatCall; now; rng?: Rng; confirm: (outbound: string) => Promise<boolean>; log? }`
  - `NarrativeResult { status: NarrativeStatus; narrative: string | null; auditId: number | null }`
  - `class PrivacyGateway { constructor(d: GatewayDeps); narrate(src: NarrativeSource, signal?: AbortSignal): Promise<NarrativeResult> }`
  - `collectStrings(v: unknown): string[]`、`freeTexts(p: OutboundPayload): string[]`、`confirmText(url, model, messages): string`
- Produces（`src/main/gateway/testing.ts`）: `HARNESS_NOW`、`GatewayHarness`、`gatewayHarness(o?: { level?: PrivacyLevel; rng?: Rng }): Promise<GatewayHarness>`、`sampleSource(): NarrativeSource`

- [ ] **Step 1: 测试工具：gateway 夹具**

`src/main/gateway/testing.ts`：import 区加上

```ts
import type { PrivacyLevel } from "../../shared/llm";
import { AuditRepo } from "../db/audit-repo";
import { SecretsRepo } from "../db/secrets-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TermsRepo } from "../db/terms-repo";
import { memDb } from "../test-utils";
import { PrivacyGateway } from "./gateway";
```

并把已有的两行 import 合并改写：`import type { SecretBox } from "./key-store";` 改为 `import { KeyStore, type SecretBox } from "./key-store";`，`import type { Rng } from "./types";` 改为 `import type { NarrativeSource, Rng } from "./types";`。文件末尾追加：

```ts
/** 夹具里的“现在”：2026-10-21（周三）09:00。 */
export const HARNESS_NOW = new Date(2026, 9, 21, 9).getTime();

export interface GatewayHarness {
  gateway: PrivacyGateway;
  provider: FakeProvider;
  settings: SettingsRepo;
  audit: AuditRepo;
  terms: TermsRepo;
  keys: KeyStore;
  box: FakeSecretBox;
  /** 每次发送前确认收到的文本。 */
  confirms: string[];
  logs: string[];
  setNow(ms: number): void;
  setConfirm(fn: (text: string) => Promise<boolean>): void;
  /** 假服务器收到的所有请求体。 */
  bodies(): string[];
  close(): Promise<void>;
}

/** 一个连着本地假服务器、用内存数据库的 PrivacyGateway：档位默认 metadata，价格 * 1 2，月预算 5 美元，不需要 key（本机地址）。 */
export async function gatewayHarness(o: { level?: PrivacyLevel; rng?: Rng } = {}): Promise<GatewayHarness> {
  const db = memDb();
  const settings = new SettingsRepo(db);
  const audit = new AuditRepo(db);
  const terms = new TermsRepo(db);
  const box = fakeSecretBox();
  const logs: string[] = [];
  const keys = new KeyStore({ secrets: new SecretsRepo(db), box, now: () => 1, log: (m) => logs.push(m) });
  const provider = await startFakeProvider();
  settings.set("llmLevel", o.level ?? "metadata");
  settings.set("llmBaseUrl", provider.baseUrl);
  settings.set("llmModel", "fake-model");
  settings.set("llmPrices", "* 1 2");
  settings.set("llmMonthlyBudgetUsd", "5");
  let now = HARNESS_NOW;
  let confirm: (text: string) => Promise<boolean> = async () => true;
  const confirms: string[] = [];
  const gateway = new PrivacyGateway({
    settings, audit, terms, keys, now: () => now, rng: o.rng,
    confirm: (text) => {
      confirms.push(text);
      return confirm(text);
    },
    log: (m, e) => logs.push(e === undefined ? m : `${m} ${e instanceof Error ? e.message : String(e)}`),
  });
  return {
    gateway, provider, settings, audit, terms, keys, box, confirms, logs,
    setNow: (ms) => {
      now = ms;
    },
    setConfirm: (fn) => {
      confirm = fn;
    },
    bodies: () => provider.requests.map((r) => r.body),
    close: () => provider.close(),
  };
}

/** 典型的简报数据：PROJ-12（进行中，带自由文本）和 PROJ-123（等 review，PR 已批准），仓库 acme-billing，分支 feature/PROJ-12-login。 */
export function sampleSource(): NarrativeSource {
  return {
    date: "2026-10-21",
    tickets: [
      {
        key: "PROJ-12", status: "active", pr: null, daysInStatus: 1, idleDays: 0, doneLastDay: 2,
        nextSteps: ["修好 PROJ-12 的登录"], blockers: [],
        followups: [{ kind: "config", trigger: "after_merge", description: "改 acme-billing 的 staging 配置", overdueDays: null }],
      },
      {
        key: "PROJ-123", status: "in_review", pr: { state: "open", review: "approved" }, daysInStatus: 3, idleDays: 1, doneLastDay: 0,
        nextSteps: [], blockers: [], followups: [],
      },
    ],
    items: [
      { section: "first", rule: "pr_approved", ticketKey: "PROJ-123", days: null, count: null },
      { section: "today", rule: "next_step", ticketKey: "PROJ-12", days: null, count: null },
    ],
    known: { tickets: ["PROJ-12", "PROJ-123"], repos: ["acme-billing"], branches: ["feature/PROJ-12-login"] },
  };
}
```

- [ ] **Step 2: 写失败测试**

新建 `src/main/gateway/narrative.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { NARRATIVE_SYSTEM_PROMPT, narrativeMessages, parseNarrative } from "./narrative";
import { DEFAULT_TICKET_PATTERN, scanOutbound } from "./scanner";

describe("narrative prompt and reply", () => {
  it("sends the fixed system prompt and the payload as JSON, and the prompt itself passes the scanner", () => {
    const payload = { date: "2026-10-21", tickets: [], items: [] };
    expect(narrativeMessages(payload)).toEqual([
      { role: "system", content: NARRATIVE_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ]);
    expect(scanOutbound([NARRATIVE_SYSTEM_PROMPT], { ticketPattern: DEFAULT_TICKET_PATTERN, originals: [] })).toEqual([]);
  });

  it("parses the focus list leniently and rejects anything else", () => {
    expect(parseNarrative('{"focus":["先合并 PR。","再处理阻塞。"]}')).toEqual(["先合并 PR。", "再处理阻塞。"]);
    expect(parseNarrative('```json\n{"focus": [" 先合并 "]}\n```')).toEqual(["先合并"]);
    expect(parseNarrative('好的，今日重点如下：{"focus":["一"]}')).toEqual(["一"]);
    for (const bad of ["今天先合并 PR。", '{"focus":[]}', '{"focus":"一"}', `{"focus":${JSON.stringify(Array(7).fill("x"))}}`, "{broken"]) {
      expect(parseNarrative(bad), bad).toBeNull();
    }
  });
});
```

新建 `src/main/gateway/gateway.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { chatReply, gatewayHarness, HARNESS_NOW, sampleSource, type GatewayHarness } from "./testing";
import type { OutboundPayload } from "./types";

let h: GatewayHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const payloadOf = (body: string) => JSON.parse((JSON.parse(body) as { messages: { content: string }[] }).messages[1].content) as OutboundPayload;
const row = (ts: number) => ({ ts, provider: "x", model: "m", level: "metadata" as const, status: "pending" as const, payloadSent: null });

describe("PrivacyGateway", () => {
  it("does nothing when the level is off or the provider is not configured", async () => {
    h = await gatewayHarness();
    h.settings.set("llmLevel", "off");
    expect(await h.gateway.narrate(sampleSource())).toEqual({ status: "off", narrative: null, auditId: null });
    h.settings.set("llmLevel", "metadata");
    h.settings.set("llmModel", "");
    expect((await h.gateway.narrate(sampleSource())).status).toBe("off");
    h.settings.set("llmModel", "fake-model");
    // 远程服务没有 key：当作没配置，不发。
    h.settings.set("llmBaseUrl", "https://api.example.com/v1");
    expect((await h.gateway.narrate(sampleSource())).status).toBe("off");
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()).toEqual([]);
  });

  it("sends placeholders only, restores the reply and records the call", async () => {
    h = await gatewayHarness({ level: "metadata" });
    h.provider.handle((r) => {
      const id = payloadOf(r.body).tickets.find((t) => t.status === "in_review")!.id;
      return chatReply(JSON.stringify({ focus: [`先合并 ${id} 的 PR。`, "然后处理今天的下一步。"] }), { prompt_tokens: 1000, completion_tokens: 100 });
    });
    const r = await h.gateway.narrate(sampleSource());
    expect(r).toMatchObject({ status: "ok", narrative: "先合并 PROJ-123 的 PR。\n然后处理今天的下一步。" });
    const [body] = h.bodies();
    for (const v of ["PROJ-12", "acme-billing", "feature/PROJ-12-login", "登录", "staging"]) expect(body).not.toContain(v);
    const [entry] = h.audit.list();
    expect(entry).toMatchObject({
      id: r.auditId, status: "sent", level: "metadata", provider: new URL(h.provider.baseUrl).host, model: "fake-model",
      payloadSent: body, tokensIn: 1000, tokensOut: 100, error: null,
    });
    expect(entry.costUsd).toBeCloseTo((1000 * 1 + 100 * 2) / 1e6, 12);
    expect(entry.response).toContain("先合并 [[T_");
  });

  it("drops a sentence with an invented placeholder, and fails when nothing usable is left", async () => {
    h = await gatewayHarness();
    h.provider.handle(() => chatReply('{"focus":["先看 [[T_0000]] 的阻塞。","今天没有别的事。"]}'));
    expect(await h.gateway.narrate(sampleSource())).toMatchObject({ status: "ok", narrative: "今天没有别的事。" });
    h.provider.handle(() => chatReply('{"focus":["先看 [[T_0000]] 的阻塞。"]}'));
    expect((await h.gateway.narrate(sampleSource())).status).toBe("failed");
    expect(h.audit.list()[0]).toMatchObject({ status: "sent", error: "响应里没有可用的句子" });
  });

  it("blocks the whole request when the outbound text contains sensitive info, and keeps it off disk", async () => {
    h = await gatewayHarness({ level: "redacted" });
    const src = sampleSource();
    src.tickets[0].nextSteps = ["看一下 https://wiki.internal.example.com/x"];
    const r = await h.gateway.narrate(src);
    expect(r.status).toBe("blocked");
    expect(h.provider.requests).toHaveLength(0);
    const [entry] = h.audit.list();
    expect(entry).toMatchObject({ id: r.auditId, status: "blocked", payloadSent: null });
    expect(entry.blockedReason?.map((x) => x.rule)).toContain("url");
    expect(JSON.stringify(entry)).not.toContain("wiki.internal");
  });

  it("blocks an unknown ticket key in free text, but not at the full level where real keys are intended", async () => {
    h = await gatewayHarness({ level: "redacted" });
    const src = sampleSource();
    src.tickets[0].blockers = ["等 OTHER-77 合并"];
    expect((await h.gateway.narrate(src)).status).toBe("blocked");
    h.settings.set("llmLevel", "full");
    expect((await h.gateway.narrate(src)).status).toBe("ok");
    expect(h.bodies()[0]).toContain("OTHER-77");
    expect(h.bodies()[0]).toContain("PROJ-12");
  });

  it("does not mistake enum values or dates for leaked names", async () => {
    h = await gatewayHarness({ level: "redacted" });
    const src = sampleSource();
    // 仓库名恰好和枚举值（status active、followup kind config）相同。
    src.known.repos = ["acme-billing", "config", "active"];
    expect((await h.gateway.narrate(src)).status).toBe("ok");
  });

  it("refuses over budget or without a price, before anything is sent; last month does not count", async () => {
    h = await gatewayHarness();
    h.settings.set("llmPrices", "");
    expect(await h.gateway.narrate(sampleSource())).toMatchObject({ status: "budget" });
    expect(h.audit.list()[0].error).toContain("价格");
    h.settings.set("llmPrices", "* 1 2");
    const last = h.audit.insert(row(new Date(2026, 8, 30).getTime()));
    h.audit.finish(last, { status: "sent", costUsd: 100 });
    expect((await h.gateway.narrate(sampleSource())).status).toBe("ok");
    const early = h.audit.insert(row(new Date(2026, 9, 2).getTime()));
    h.audit.finish(early, { status: "sent", costUsd: 4.999 });
    expect((await h.gateway.narrate(sampleSource())).status).toBe("budget");
    expect(h.provider.requests).toHaveLength(1);
    expect(h.audit.list()[0]).toMatchObject({ status: "budget", payloadSent: null });
    expect(h.audit.list()[0].error).toContain("预算");
  });

  it("serialises requests so the budget sees the first request's cost", async () => {
    h = await gatewayHarness();
    h.settings.set("llmPrices", "* 1000 1000");
    h.settings.set("llmMonthlyBudgetUsd", "10");
    h.provider.handle(() => chatReply('{"focus":["OK"]}', { prompt_tokens: 1_000_000, completion_tokens: 0 }));
    const [a, b] = await Promise.all([h.gateway.narrate(sampleSource()), h.gateway.narrate(sampleSource())]);
    expect([a.status, b.status]).toEqual(["ok", "budget"]);
    expect(h.provider.requests).toHaveLength(1);
  });

  it("asks before sending and sends nothing when declined", async () => {
    h = await gatewayHarness();
    h.settings.set("llmConfirm", "1");
    h.setConfirm(async () => false);
    expect(await h.gateway.narrate(sampleSource())).toMatchObject({ status: "off" });
    expect(h.provider.requests).toHaveLength(0);
    expect(h.audit.list()[0]).toMatchObject({ status: "declined" });
    expect(h.confirms[0]).toContain(`POST ${h.provider.baseUrl}/chat/completions`);
    expect(h.confirms[0]).toContain("[[T_");
    expect(h.confirms[0]).not.toContain("PROJ-12");
    h.setConfirm(async () => {
      throw new Error("dialog crashed");
    });
    expect((await h.gateway.narrate(sampleSource())).status).toBe("failed");
    h.setConfirm(async () => true);
    expect((await h.gateway.narrate(sampleSource())).status).toBe("ok");
    expect(h.provider.requests).toHaveLength(1);
  });

  it("never writes the key into the audit or the log, even when the provider echoes it", async () => {
    h = await gatewayHarness();
    h.keys.save("sk-secret-0123456789abcdef");
    h.provider.handle((r) => ({ status: 500, body: { error: `upstream rejected ${String(r.headers.authorization)}` } }));
    expect((await h.gateway.narrate(sampleSource())).status).toBe("failed");
    expect(h.provider.requests[0].headers.authorization).toBe("Bearer sk-secret-0123456789abcdef");
    expect(JSON.stringify(h.audit.list()) + h.logs.join("\n")).not.toContain("sk-secret");
    expect(h.audit.list()[0]).toMatchObject({ status: "failed" });
    expect(h.audit.list()[0].error).toContain("HTTP 500");
  });

  it("fails without sending when the saved key cannot be decrypted", async () => {
    h = await gatewayHarness();
    h.keys.save("sk-secret-0123456789abcdef");
    h.box.setBroken(true);
    expect((await h.gateway.narrate(sampleSource())).status).toBe("failed");
    expect(h.provider.requests).toHaveLength(0);
  });

  it("fails on a reply that is not the agreed JSON but still records what it cost", async () => {
    h = await gatewayHarness();
    h.provider.handle(() => chatReply("今天先合并 PR。"));
    expect((await h.gateway.narrate(sampleSource())).status).toBe("failed");
    expect(h.audit.list()[0]).toMatchObject({ status: "sent", error: "响应不符合格式", tokensIn: 120, tokensOut: 40 });
  });

  it("fails when the app is quitting, without sending", async () => {
    h = await gatewayHarness();
    const ac = new AbortController();
    ac.abort();
    expect((await h.gateway.narrate(sampleSource(), ac.signal)).status).toBe("failed");
    expect(h.provider.requests).toHaveLength(0);
  });

  it("prunes audit rows past the retention period", async () => {
    h = await gatewayHarness();
    h.audit.insert({ ts: HARNESS_NOW - 91 * 86_400_000, provider: "x", model: "m", level: "metadata", status: "blocked", payloadSent: null });
    await h.gateway.narrate(sampleSource());
    expect(h.audit.list()).toHaveLength(1);
    expect(h.audit.list()[0].ts).toBe(HARNESS_NOW);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/gateway/narrative.test.ts src/main/gateway/gateway.test.ts`
Expected: FAIL（`./narrative`、`./gateway` 不存在）

- [ ] **Step 4: “今日重点”的 prompt 与响应**

新建 `src/main/gateway/narrative.ts`：

```ts
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
```

- [ ] **Step 5: PrivacyGateway**

新建 `src/main/gateway/gateway.ts`：

```ts
import type { NarrativeStatus } from "../../shared/brief";
import type { ScanHit } from "../../shared/llm";
import type { AuditRepo } from "../db/audit-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TermsRepo } from "../db/terms-repo";
import { isLoopbackHost, llmConfig } from "../settings/settings-values";
import { checkBudget, costUsd, estimateTokens, monthStart } from "./budget";
import type { KeyStore } from "./key-store";
import { NARRATIVE_MAX_TOKENS, narrativeMessages, parseNarrative } from "./narrative";
import { project } from "./projection";
import { chatBody, chatCompletion, chatUrl, scrub, type ChatCall, type ChatMessage, type ChatResponse } from "./provider";
import { defaultRng, Pseudonymizer, restore } from "./pseudonym";
import { scanOutbound } from "./scanner";
import type { NarrativeSource, OutboundPayload, Rng } from "./types";

const DAY_MS = 86_400_000;

export interface GatewayDeps {
  settings: SettingsRepo;
  audit: AuditRepo;
  terms: TermsRepo;
  /** 没保存 key 时 gateway 不会访问系统钥匙串（get / saved 都只在有密文时才解密）。 */
  keys: Pick<KeyStore, "get" | "saved">;
  /** 默认是真正的 chatCompletion；测试也用它（连本地假服务器）。 */
  chat?: ChatCall;
  now: () => number;
  rng?: Rng;
  /** 发送前确认：展示完整的出站内容，返回是否同意。 */
  confirm: (outbound: string) => Promise<boolean>;
  log?: (msg: string, err?: unknown) => void;
}

export interface NarrativeResult {
  status: NarrativeStatus;
  narrative: string | null;
  /** 这次调用写的审计行；没有写（off）时为 null。 */
  auditId: number | null;
}

const result = (status: NarrativeStatus, auditId: number | null = null, narrative: string | null = null): NarrativeResult => ({ status, narrative, auditId });

/** 出站 JSON 里的所有字符串值（扫描用）。 */
export function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out);
  return out;
}

/** 出站 JSON 里的自由文本（next_steps、blockers、followup 描述）；metadata 档位没有。 */
export function freeTexts(p: OutboundPayload): string[] {
  return p.tickets.flatMap((t) => [...(t.next_steps ?? []), ...(t.blockers ?? []), ...t.followups.map((f) => f.description ?? "")]).filter(Boolean);
}

const uniqueHits = (hits: ScanHit[]): ScanHit[] => hits.filter((h, i) => hits.findIndex((x) => x.rule === h.rule) === i);

/** 发送前确认对话框里的内容：请求地址、模型和每条消息的原文（用户消息排版成多行 JSON）。 */
export function confirmText(url: string, model: string, messages: ChatMessage[]): string {
  const parts = messages.map((m) => {
    let content = m.content;
    if (m.role === "user") {
      try {
        content = JSON.stringify(JSON.parse(m.content), null, 2);
      } catch {
        // 不是 JSON 就原样展示。
      }
    }
    return `[${m.role}]\n${content}`;
  });
  return [`POST ${url}`, `model: ${model}`, ...parts].join("\n\n");
}

/**
 * 个人 LLM API 的唯一出口（设计文档第 7 节）。只用于早间简报的“今日重点”。
 * 串行执行：两次请求不会同时通过预算检查。narrate() 永远不抛错。
 */
export class PrivacyGateway {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: GatewayDeps) {}

  narrate(src: NarrativeSource, signal?: AbortSignal): Promise<NarrativeResult> {
    const run = this.chain.then(() => this.run(src, signal)).catch((e: unknown): NarrativeResult => {
      this.d.log?.("narrative failed", e);
      return result("failed");
    });
    this.chain = run;
    return run;
  }

  private async run(src: NarrativeSource, signal?: AbortSignal): Promise<NarrativeResult> {
    const cfg = llmConfig(this.d.settings);
    const now = this.d.now();
    this.d.audit.prune(now - cfg.retentionDays * DAY_MS);
    if (cfg.level === "off" || !cfg.baseUrl || !cfg.model) return result("off");
    if (signal?.aborted) return result("failed");

    const url = new URL(cfg.baseUrl);
    const apiKey = this.d.keys.get();
    if (apiKey === null && this.d.keys.saved()) {
      this.d.log?.("narrative skipped: the saved API key cannot be decrypted");
      return result("failed");
    }
    // 远程服务没有 key：当作没有配置。本机服务（Ollama 等）可以不要 key。
    if (apiKey === null && !isLoopbackHost(url.hostname)) return result("off");

    // 1. 字段投影 + 假名化（字典每次请求重新随机生成，只在内存里）。
    const rng = this.d.rng ?? defaultRng;
    const terms = this.d.terms.list();
    const pseudo = new Pseudonymizer(
      {
        ...src.known,
        people: terms.filter((t) => t.category === "person").map((t) => t.term),
        terms: terms.filter((t) => t.category === "term").map((t) => t.term),
      },
      rng,
    );
    const payload = project(src, cfg.level, pseudo, rng);
    const messages = narrativeMessages(payload);
    const body = chatBody({ model: cfg.model, messages, maxTokens: NARRATIVE_MAX_TOKENS });
    const inputText = messages.map((m) => m.content).join("\n");
    const base = { ts: now, provider: url.host, model: cfg.model, level: cfg.level };

    // 2. 预算：超出“视为 off”（设计文档 7.6），什么都不发。
    const budget = checkBudget({
      prices: cfg.prices, model: cfg.model, budgetUsd: cfg.budgetUsd,
      spentUsd: this.d.audit.costSince(monthStart(now)), inputText, maxOutputTokens: NARRATIVE_MAX_TOKENS,
    });
    if (!budget.ok) return result("budget", this.d.audit.insert({ ...base, status: "budget", payloadSent: null, error: budget.message }));

    // 3. 敏感信息扫描：命中就整次拒发；被拦下的内容不落盘。
    //    所有字符串查“形状”规则（密钥、URL、域名、IP、邮箱、路径）；ticket 号和字典原值只在自由文本里查：
    //    枚举和日期里不会有它们，而仓库恰好叫 config、active 这类名字时，查枚举会误拦每一次请求。
    //    full 档位本来就发真实 ticket 号和原文，这两条跳过。
    const masked = cfg.level !== "full";
    const hits = uniqueHits([
      ...scanOutbound(collectStrings(payload), { ticketPattern: null, originals: [] }),
      ...scanOutbound(freeTexts(payload), {
        ticketPattern: masked ? this.d.settings.get("ticketPattern") : null,
        originals: masked ? pseudo.originals() : [],
      }),
    ]);
    if (hits.length > 0) return result("blocked", this.d.audit.insert({ ...base, status: "blocked", payloadSent: null, blockedReason: hits }));

    // 4. 写审计（原样的请求体），再按设置请用户确认。
    const auditId = this.d.audit.insert({ ...base, status: "pending", payloadSent: body });
    if (cfg.confirm) {
      let ok: boolean;
      try {
        ok = await this.d.confirm(confirmText(chatUrl(cfg.baseUrl), cfg.model, messages));
      } catch (e) {
        this.d.log?.("confirm dialog failed", e);
        this.d.audit.finish(auditId, { status: "declined", error: "发送前确认出错" });
        return result("failed", auditId);
      }
      if (!ok) {
        this.d.audit.finish(auditId, { status: "declined" });
        return result("off", auditId);
      }
    }
    if (signal?.aborted) {
      this.d.audit.finish(auditId, { status: "declined", error: "app 正在退出" });
      return result("failed", auditId);
    }

    // 5. 发送。
    let res: ChatResponse;
    try {
      res = await (this.d.chat ?? chatCompletion)({ baseUrl: cfg.baseUrl, apiKey, model: cfg.model, messages, maxTokens: NARRATIVE_MAX_TOKENS, signal });
    } catch (e) {
      const message = scrub(e instanceof Error ? e.message : String(e), apiKey);
      this.d.audit.finish(auditId, { status: "failed", error: message });
      this.d.log?.(`narrative request failed: ${message}`);
      return result("failed", auditId);
    }

    // 6. 记账、校验、还原。
    const tokensIn = res.tokensIn ?? estimateTokens(inputText);
    const tokensOut = res.tokensOut ?? estimateTokens(res.content);
    const focus = parseNarrative(res.content);
    const lines = (focus ?? []).map((f) => restore(f, pseudo.mapping).text).filter((l) => l.length > 0);
    this.d.audit.finish(auditId, {
      status: "sent",
      payloadSent: res.sentBody,
      response: res.raw,
      tokensIn,
      tokensOut,
      costUsd: costUsd(budget.price, tokensIn, tokensOut),
      error: focus === null ? "响应不符合格式" : lines.length === 0 ? "响应里没有可用的句子" : null,
    });
    if (lines.length === 0) return result("failed", auditId);
    return result("ok", auditId, lines.join("\n"));
  }
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/gateway`
Expected: PASS（全程只连 127.0.0.1）

- [ ] **Step 7: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/main/gateway/narrative.ts src/main/gateway/narrative.test.ts src/main/gateway/gateway.ts src/main/gateway/gateway.test.ts src/main/gateway/testing.ts
git commit -m "feat: PrivacyGateway pipeline with budget, scan-and-block, audit, confirm-before-send and placeholder restore"
```

---

### Task 14: 隐私不变量测试（发布阻断项）

设计文档 11 节：随机生成 ticket 号、仓库名、分支名、人名和敏感词，跑完整条管道（真正经过 `PrivacyGateway`、HTTP 客户端和本地假服务器），断言服务商收到的出站内容里不出现任何一个原始值。自由文本用中文模板，原值和中文粘在一起，并且混入大小写变化和全角写法。另外断言：同一个 ticket 在两次请求里的占位符不同；自由文本里有未知 ticket 号、URL 或密钥时，在会发自由文本的档位上整次拒发、什么都没发出去。

检查范围是请求体里除系统提示以外的全部内容。系统提示是固定文本，不含任何用户数据（测试同时断言它确实就是 `NARRATIVE_SYSTEM_PROMPT`），把它排除在外，可以避免随机生成的值碰巧和提示里的字重合。

这个测试失败时，**不要**放宽断言或换种子：它说明有原值漏了出去，必须修管道（通常是 `Pseudonymizer` 或 `project`）。

**Files:**
- Create: `src/main/gateway/privacy-invariant.test.ts`

**Interfaces:**
- Consumes: `gatewayHarness`、`chatReply`、`seededRng`、`sampleSource`（`src/main/gateway/testing.ts`）、`NARRATIVE_SYSTEM_PROMPT`、`NarrativeSource`、`OutboundPayload`、`Rng`
- Produces: 无（只有测试）

- [ ] **Step 1: 写测试**

新建 `src/main/gateway/privacy-invariant.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import type { PrivacyLevel } from "../../shared/llm";
import { NARRATIVE_SYSTEM_PROMPT } from "./narrative";
import { chatReply, gatewayHarness, sampleSource, seededRng, type FakeRequest, type GatewayHarness } from "./testing";
import type { NarrativeSource, OutboundPayload, Rng } from "./types";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const SURNAMES = ["王", "李", "张", "刘", "陈", "杨", "黄", "赵", "吴", "周"];
const GIVEN = ["晓", "明", "婷", "伟", "芳", "磊", "静", "军", "敏", "超", "霞", "斌", "琳", "浩"];
const CODENAMES = ["天穹", "赤霄", "青鸾", "玄武", "白泽", "朱雀"];
const LATIN = ["Alice", "Bob", "Carol", "Dmitri", "Erin", "Farah"];
const STATUSES = ["active", "in_review", "blocked", "merged_pending_followup"] as const;

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[rng(xs.length)];
const word = (rng: Rng, n: number, letters = LOWER) => Array.from({ length: n }, () => letters[rng(letters.length)]).join("");
const digits = (rng: Rng, n: number) => Array.from({ length: n }, () => String(rng(10))).join("");
/** ASCII → 全角（NFKC 会变回来）。 */
const fullWidth = (s: string) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

interface World {
  tickets: string[];
  repos: string[];
  branches: string[];
  people: string[];
  terms: string[];
}

function world(rng: Rng): World {
  const tickets = new Set<string>();
  const want = 3 + rng(3);
  while (tickets.size < want) tickets.add(`${word(rng, 2 + rng(3), UPPER)}-${1 + rng(9)}${digits(rng, rng(4))}`);
  const keys = [...tickets];
  return {
    tickets: keys,
    repos: [`${word(rng, 4)}-${word(rng, 5)}${digits(rng, 2)}`, `${word(rng, 6)}${digits(rng, 3)}`],
    branches: keys.map((k) => `feature/${k}-${word(rng, 5)}`),
    people: [`${pick(rng, SURNAMES)}${pick(rng, GIVEN)}${pick(rng, GIVEN)}`, `${pick(rng, LATIN)} ${word(rng, 1, UPPER)}${word(rng, 5)}`],
    terms: [`${pick(rng, CODENAMES)}${pick(rng, GIVEN)}计划`, `Project ${word(rng, 1, UPPER)}${word(rng, 6)}`],
  };
}

/** 中文自由文本模板：原值和中文粘在一起，夹杂小写、大写和全角写法。 */
const TEMPLATES: ((w: World, r: Rng) => string)[] = [
  (w, r) => `修好${pick(r, w.tickets)}的登录问题，然后通知${pick(r, w.people)}`,
  (w, r) => `等${pick(r, w.people)}review ${pick(r, w.tickets).toLowerCase()} 的 PR`,
  (w, r) => `把 ${pick(r, w.branches)} rebase 到 main，再部署${pick(r, w.repos)}`,
  (w, r) => `${pick(r, w.terms)}需要${fullWidth(pick(r, w.tickets))}先合并`,
  (w, r) => `和${pick(r, w.people).toUpperCase()}确认${pick(r, w.repos).toUpperCase()}的配置`,
  (w, r) => `${pick(r, w.terms).toLowerCase()} 的灰度开关，见${pick(r, w.branches)}`,
];

function source(w: World, rng: Rng): NarrativeSource {
  const text = () => pick(rng, TEMPLATES)(w, rng);
  return {
    date: "2026-10-21",
    tickets: w.tickets.map((key, i) => ({
      key,
      status: pick(rng, STATUSES),
      pr: i % 2 ? { state: "open", review: "approved" } : null,
      daysInStatus: rng(10),
      idleDays: rng(10),
      doneLastDay: rng(4),
      nextSteps: [text(), text()],
      blockers: [text()],
      followups: [{ kind: "config", trigger: "after_merge", description: text(), overdueDays: null }],
    })),
    items: w.tickets.map((key) => ({ section: "today", rule: "next_step", ticketKey: key, days: null, count: null })),
    known: { tickets: w.tickets, repos: w.repos, branches: w.branches },
  };
}

/** 请求体里除系统提示以外的全部内容（NFKC + 小写，和原值比较时也同样处理）。 */
function outboundWithoutSystemPrompt(body: string): string {
  const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] } & Record<string, unknown>;
  const system = parsed.messages.filter((m) => m.role === "system");
  expect(system.map((m) => m.content)).toEqual([NARRATIVE_SYSTEM_PROMPT]);
  const rest = { ...parsed, messages: parsed.messages.filter((m) => m.role !== "system") };
  return JSON.stringify(rest).normalize("NFKC").toLowerCase();
}

function leaked(body: string, w: World): string[] {
  const out = outboundWithoutSystemPrompt(body);
  return [...w.tickets, ...w.repos, ...w.branches, ...w.people, ...w.terms].filter((v) => out.includes(v.normalize("NFKC").toLowerCase()));
}

/** 服务商原样引用第一个 ticket 的占位符：用来确认本地能还原。 */
function echoFirstTicket(r: FakeRequest) {
  const payload = JSON.parse((JSON.parse(r.body) as { messages: { content: string }[] }).messages[1].content) as OutboundPayload;
  return chatReply(JSON.stringify({ focus: [`先处理 ${payload.tickets[0].id} 的事。`] }));
}

let h: GatewayHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("privacy invariant (release blocker, design §11)", () => {
  for (const level of ["metadata", "redacted"] as const satisfies readonly PrivacyLevel[]) {
    it(`no original ticket key, repo, branch, person or sensitive term leaves the machine at the ${level} level`, async () => {
      for (let seed = 1; seed <= 40; seed++) {
        const rng = seededRng(seed * 7919);
        const w = world(rng);
        h = await gatewayHarness({ level, rng: seededRng(seed) });
        h.terms.replaceAll([...w.people.map((term) => ({ term, category: "person" as const })), ...w.terms.map((term) => ({ term, category: "term" as const }))]);
        h.provider.handle(echoFirstTicket);
        const r = await h.gateway.narrate(source(w, rng));
        expect(r.status, `seed ${seed}`).toBe("ok");
        expect(h.bodies(), `seed ${seed}`).toHaveLength(1);
        expect(leaked(h.bodies()[0], w), `seed ${seed}`).toEqual([]);
        // 本地还原：narrative 里是真实的 ticket 号。
        expect(w.tickets.some((t) => r.narrative?.includes(t)), `seed ${seed}`).toBe(true);
        await h.close();
        h = null;
      }
    }, 120_000);
  }

  it("gives the same ticket a different placeholder in every request", async () => {
    h = await gatewayHarness();
    await h.gateway.narrate(sampleSource());
    await h.gateway.narrate(sampleSource());
    const ids = h.bodies().map((b) =>
      (JSON.parse((JSON.parse(b) as { messages: { content: string }[] }).messages[1].content) as OutboundPayload).tickets.map((t) => t.id),
    );
    expect(ids).toHaveLength(2);
    expect(ids[0].filter((id) => ids[1].includes(id))).toEqual([]);
  });

  it("an unknown ticket key, a URL or a secret in free text blocks the request where free text is sent, and nothing leaves", async () => {
    const cases: [PrivacyLevel, string, string][] = [
      ["redacted", "等 ZZTOP-9 合并", "blocked"],
      ["redacted", "部署前问一下 ops@example.com", "blocked"],
      ["redacted", "token=AbCdEf123456", "blocked"],
      ["full", "token=AbCdEf123456", "blocked"],
      ["full", "看 https://wiki.corp/x", "blocked"],
      // metadata 不发自由文本：同样的内容根本不会出现在请求里。
      ["metadata", "token=AbCdEf123456", "ok"],
    ];
    for (const [level, text, expected] of cases) {
      h = await gatewayHarness({ level });
      const src = sampleSource();
      src.tickets[0].nextSteps = [text];
      expect((await h.gateway.narrate(src)).status, `${level}: ${text}`).toBe(expected);
      for (const body of h.bodies()) expect(body, `${level}: ${text}`).not.toContain(text);
      if (expected === "blocked") expect(h.bodies(), `${level}: ${text}`).toHaveLength(0);
      await h.close();
      h = null;
    }
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `pnpm exec vitest run src/main/gateway/privacy-invariant.test.ts`
Expected: PASS。

如果某个种子失败：断言消息里有种子号和漏出的原值。用 `seededRng(种子 * 7919)` 复现那组数据，修 `pseudonym.ts` / `projection.ts`，再跑全部种子。**不要**放宽断言、跳过种子或改模板绕过。

- [ ] **Step 3: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/main/gateway/privacy-invariant.test.ts
git commit -m "test: randomized privacy invariant over the whole gateway pipeline (release blocker)"
```

---

### Task 15: 早间简报接入“今日重点”

设计文档 6.2 节第 3 步。早间任务照常先生成简报并入库（刷新前一次、刷新后一次），**最后**再对最终的那份简报调用 gateway，把结果写回同一行的 `narrative` / `narrative_status`。刷新失败时也会对第一份简报补“今日重点”，然后照常把刷新的错误抛给调度器。任何失败只改 `narrativeStatus`（设计文档第 10 节最后一行），简报其余内容不受影响。晚间小结不调用个人 API。

`BriefService.narrativeSource(brief)` 从数据库组装 gateway 的输入：简报里每个 ticket 的状态、PR 枚举、天数、next_steps / blockers、当前生效的 followups，以及假名化字典要用的全部标识：**所有** ticket 号（含已归档的，正文里可能提到）、仓库目录名、分支名（含 session 记录的 git 分支）、PR 链接里的 owner 和仓库名。

**Files:**
- Modify: `src/shared/brief.ts`（注释）
- Modify: `src/main/db/briefs-repo.ts`、`src/main/db/handoff-repos.test.ts`
- Modify: `src/main/brief/brief-service.ts`、`src/main/brief/brief-service.test.ts`
- Create: `src/main/brief/narrate.ts`、`src/main/brief/narrate.test.ts`
- Modify: `src/main/schedule/daily-jobs.ts`、`src/main/schedule/daily-jobs.test.ts`

**Interfaces:**
- Consumes: `NarrativeSource`、`NarrativeTicket`（任务 9）、`NarrativeResult`（任务 13）、`followupActive`（`src/main/brief/engine.ts`）、`daysBetween`、`dayStart`、`localDate`（`src/main/schedule/calendar.ts`）
- Produces:
  - `BriefsRepo.setNarrative(id: number, narrative: string | null, status: NarrativeStatus): void`
  - `prPathParts(url: string): string[]`、`BriefService.narrativeSource(brief: Brief): NarrativeSource`（`src/main/brief/brief-service.ts`）
  - `NarrateDeps { narrate: (src, signal?) => Promise<NarrativeResult>; briefs: Pick<BriefsRepo, "setNarrative">; source: (brief: Brief) => NarrativeSource; signal?; log? }`、`narrateBrief(d, brief): Promise<NarrativeStatus>`（永远不抛错）
  - `DailyJobDeps.narrate?: (brief: Brief) => Promise<unknown>`

- [ ] **Step 1: 写失败测试**

`src/main/db/handoff-repos.test.ts` 的 `describe("BriefsRepo / MarksRepo / JobsRepo / SettingsRepo", ...)` 里追加：

```ts
  it("writes the narrative back onto an existing brief", () => {
    const briefs = new BriefsRepo(memDb());
    const b = briefs.insert({ kind: "morning", date: "2026-10-21", createdAt: 1, content: EMPTY_BRIEF_CONTENT, narrative: null, narrativeStatus: "off" });
    briefs.setNarrative(b.id, "先合并 PR。", "ok");
    expect(briefs.latest("morning")).toMatchObject({ id: b.id, narrative: "先合并 PR。", narrativeStatus: "ok" });
    briefs.setNarrative(b.id, null, "blocked");
    expect(briefs.latest("morning")).toMatchObject({ narrative: null, narrativeStatus: "blocked" });
  });
```

（文件顶部加 `import { EMPTY_BRIEF_CONTENT } from "../../shared/brief";`。）

`src/main/brief/brief-service.test.ts`：
1. `./brief-service` 的 import 改为 `import { BriefService, prPathParts } from "./brief-service";`。
2. `setup()` 的返回值里加上 `sessions,`。
3. 文件末尾追加：

```ts
describe("BriefService.narrativeSource", () => {
  it("collects what the narrative needs and every identifier that could appear in free text", () => {
    const s = setup();
    s.addTicket("A-1");
    s.sessions.insertIfAbsent({ id: "s-other", ticketKey: "A-1", cwd: "/w", origin: "discovered", gitBranch: "hotfix/a1-crash", createdAt: at(1) });
    s.tickets.insert({
      key: "OLD-9", title: null, repoPath: "/repos/legacy-app", workMode: "branch", worktreePath: null, branch: "feature/OLD-9",
      status: "done", statusManual: null, createdAt: at(1), archivedAt: at(2),
    });
    s.handoff("A-1", {
      done_today: ["做了 A"], next_steps: ["写测试"], blockers: ["等评审"],
      pr: { number: 7, url: "https://github.com/acme/billing-svc/pull/7", state: "open", review: "approved" },
      followups: [{ id: null, kind: "flag", description: "开开关", trigger: "on_date", due_date: "2026-10-19", done: false }],
    });
    const brief = s.service.generateMorning();
    const src = s.service.narrativeSource(brief);
    expect(src.date).toBe("2026-10-21");
    expect(src.tickets).toHaveLength(1);
    expect(src.tickets[0]).toMatchObject({
      key: "A-1", status: "in_review", pr: { state: "open", review: "approved" }, doneLastDay: 1,
      nextSteps: ["写测试"], blockers: ["等评审"],
      followups: [{ kind: "flag", trigger: "on_date", description: "开开关", overdueDays: 2 }],
    });
    expect(src.items.map((i) => [i.rule, i.ticketKey])).toEqual(brief.items.map((i) => [i.rule, i.ticketKey]));
    expect([...src.known.tickets].sort()).toEqual(["A-1", "OLD-9"]);
    expect(src.known.repos).toEqual(expect.arrayContaining(["legacy-app", "acme", "billing-svc"]));
    expect(src.known.branches).toEqual(expect.arrayContaining(["b", "feature/OLD-9", "hotfix/a1-crash"]));
  });
});

describe("prPathParts", () => {
  it("takes the owner and repository from common PR links", () => {
    expect(prPathParts("https://github.com/acme/billing-svc/pull/7")).toEqual(["acme", "billing-svc"]);
    expect(prPathParts("https://gitlab.example.com/group/sub/app/-/merge_requests/3")).toEqual(["group", "sub", "app"]);
    expect(prPathParts("https://bitbucket.example.com/projects/PAY/repos/ledger/pull-requests/9")).toEqual(["PAY", "ledger"]);
    expect(prPathParts("not a url")).toEqual([]);
  });
});
```

新建 `src/main/brief/narrate.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { EMPTY_BRIEF_CONTENT, type Brief, type NarrativeStatus } from "../../shared/brief";
import type { NarrativeSource } from "../gateway/types";
import { narrateBrief, type NarrateDeps } from "./narrate";

const brief = (kind: Brief["kind"] = "morning"): Brief => ({
  id: 5, kind, date: "2026-10-21", createdAt: 1, ...EMPTY_BRIEF_CONTENT, narrative: null, narrativeStatus: "off",
});
const SOURCE: NarrativeSource = { date: "2026-10-21", tickets: [], items: [], known: { tickets: [], repos: [], branches: [] } };

function deps(over: Partial<NarrateDeps> = {}) {
  const written: [number, string | null, NarrativeStatus][] = [];
  const d: NarrateDeps = {
    narrate: async () => ({ status: "ok", narrative: "先合并 PR。", auditId: 1 }),
    briefs: { setNarrative: (id, n, s) => void written.push([id, n, s]) },
    source: () => SOURCE,
    ...over,
  };
  return { d, written };
}

describe("narrateBrief", () => {
  it("writes the narrative onto the morning brief", async () => {
    const { d, written } = deps();
    expect(await narrateBrief(d, brief())).toBe("ok");
    expect(written).toEqual([[5, "先合并 PR。", "ok"]]);
  });

  it("records the reason and no text when the gateway did not produce one", async () => {
    const { d, written } = deps({ narrate: async () => ({ status: "blocked", narrative: null, auditId: 2 }) });
    expect(await narrateBrief(d, brief())).toBe("blocked");
    expect(written).toEqual([[5, null, "blocked"]]);
  });

  it("never throws: a failing source, gateway or write leaves the brief marked failed", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const a = deps({ source: boom });
    expect(await narrateBrief(a.d, brief())).toBe("failed");
    expect(a.written).toEqual([[5, null, "failed"]]);
    const b = deps({ narrate: async () => Promise.reject(new Error("boom")) });
    expect(await narrateBrief(b.d, brief())).toBe("failed");
    const c = deps({ briefs: { setNarrative: boom } });
    expect(await narrateBrief(c.d, brief())).toBe("failed");
  });

  it("leaves an evening summary alone", async () => {
    const { d, written } = deps();
    expect(await narrateBrief(d, brief("evening"))).toBe("off");
    expect(written).toEqual([]);
  });
});
```

`src/main/schedule/daily-jobs.test.ts` 的 `describe("daily jobs", ...)` 里追加：

```ts
  it("morning: narrates the final brief once, after the refresh", async () => {
    const r = deps();
    let id = 0;
    const narrated: number[] = [];
    r.d.briefs = {
      ...r.d.briefs,
      generateMorning: () => {
        r.calls.push("morning");
        return { ...brief("morning"), id: ++id };
      },
    };
    r.d.narrate = async (b) => {
      r.calls.push("narrate");
      narrated.push(b.id);
    };
    await morningJob(r.d);
    expect(r.calls).toEqual(["morning", "refreshing=true", "refresh", "morning", "refreshing=false", "narrate"]);
    expect(narrated).toEqual([2]);
  });

  it("morning: still narrates the first brief when the refresh fails, and does not narrate once the app is quitting", async () => {
    const failing = deps();
    failing.d.runner = { ...failing.d.runner, refreshForBrief: async () => Promise.reject(new Error("boom")) };
    failing.d.narrate = async () => void failing.calls.push("narrate");
    await expect(morningJob(failing.d)).rejects.toThrow("boom");
    expect(failing.calls).toEqual(["morning", "refreshing=true", "refreshing=false", "narrate"]);
    const quitting = deps({ aborted: () => true });
    quitting.d.narrate = async () => void quitting.calls.push("narrate");
    await morningJob(quitting.d);
    expect(quitting.calls).not.toContain("narrate");
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/main/db/handoff-repos.test.ts src/main/brief src/main/schedule/daily-jobs.test.ts`
Expected: FAIL（`setNarrative`、`narrativeSource`、`prPathParts`、`./narrate`、`narrate` 依赖都不存在）

- [ ] **Step 3: 实现**

`src/shared/brief.ts`：`Brief.narrative` 上面的注释改为：

```ts
  /** 早间简报的“今日重点”（计划 3，个人 LLM API）。简报先入库，之后由 narrateBrief 补上；晚间小结永远是 null / "off"。 */
```

`src/main/db/briefs-repo.ts` 的 `BriefsRepo` 里加：

```ts
  /** 早间简报入库之后，把“今日重点”写回同一行。 */
  setNarrative(id: number, narrative: string | null, status: NarrativeStatus): void {
    this.db.prepare(`UPDATE briefs SET narrative = ?, narrative_status = ? WHERE id = ?`).run(narrative, status, id);
  }
```

`src/main/brief/brief-service.ts`：
1. import 改为：

```ts
import { basename } from "node:path";
import type { Brief, BriefKind, ItemMark } from "../../shared/brief";
import { effectiveStatus } from "../../shared/types";
import type { BriefsRepo } from "../db/briefs-repo";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { MarksRepo } from "../db/marks-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { NarrativeSource, NarrativeTicket } from "../gateway/types";
import { addDays, daysBetween, dayStart, localDate, previousWorkingDay } from "../schedule/calendar";
import { scheduleConfig, thresholds } from "../settings/settings-values";
import { buildEveningBrief, buildMorningBrief, followupActive, type TicketSnapshot } from "./engine";
```

2. 在 `BriefServiceDeps` 之前加：

```ts
/** PR 链接路径前面那几段：owner / group 和仓库名，它们可能出现在自由文本里，要进假名化字典。 */
const PR_PATH_STOP = new Set(["pull", "pulls", "-", "merge_requests", "pull-requests"]);
const PR_PATH_SKIP = new Set(["projects", "repos", "users", "scm"]);

export function prPathParts(url: string): string[] {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return [];
  }
  const stop = segments.findIndex((s) => PR_PATH_STOP.has(s));
  return (stop >= 0 ? segments.slice(0, stop) : segments.slice(0, 2)).filter((s) => !PR_PATH_SKIP.has(s));
}
```

3. `BriefService` 里（`latest` 之前）加：

```ts
  /**
   * “今日重点”的原始输入（还没有经过任何隐私处理，交给 PrivacyGateway）。
   * known 是假名化字典：所有 ticket 号（含已归档的）、仓库目录名、分支名、PR 链接里的 owner / 仓库名。
   */
  narrativeSource(brief: Brief): NarrativeSource {
    const now = this.d.now();
    const today = localDate(now);
    const followups = this.d.followups.listActiveTickets().filter((f) => followupActive(f, today));
    const doneLastDay = new Map((brief.previousDay?.entries ?? []).map((e) => [e.ticketKey, e.done.length]));
    const all = this.d.tickets.list({ includeArchived: true });
    const repos = new Set<string>();
    const branches = new Set<string>();
    for (const t of all) {
      repos.add(basename(t.repoPath));
      branches.add(t.branch);
      for (const s of this.d.sessions.listByTicket(t.key)) if (s.gitBranch) branches.add(s.gitBranch);
    }
    const tickets = this.snapshot().map((t): NarrativeTicket => {
      const p = t.latest?.payload ?? null;
      if (p?.pr?.url) for (const part of prPathParts(p.pr.url)) repos.add(part);
      return {
        key: t.key,
        status: t.status,
        pr: p?.pr ? { state: p.pr.state, review: p.pr.review } : null,
        daysInStatus: daysBetween(t.statusSince, now),
        idleDays: daysBetween(t.lastActivityAt, now),
        doneLastDay: doneLastDay.get(t.key) ?? 0,
        nextSteps: p?.next_steps ?? [],
        blockers: p?.blockers ?? [],
        followups: followups
          .filter((f) => f.ticketKey === t.key)
          .map((f) => ({
            kind: f.kind,
            trigger: f.trigger,
            description: f.description,
            overdueDays: f.trigger === "on_date" && f.dueDate !== null && f.dueDate <= today ? daysBetween(dayStart(f.dueDate), now) : null,
          })),
      };
    });
    return {
      date: brief.date,
      tickets,
      items: brief.items.map((i) => ({ section: i.section, rule: i.rule, ticketKey: i.ticketKey, days: i.days, count: i.count })),
      known: { tickets: all.map((t) => t.key), repos: [...repos], branches: [...branches] },
    };
  }
```

4. `generateMorning` 里那行注释 `// 计划 3 在这里接 PrivacyGateway 生成“今日重点”；计划 2 永远是 off。` 改为 `// “今日重点”由早间任务在最终的简报入库之后补上（narrateBrief）。`

新建 `src/main/brief/narrate.ts`：

```ts
import type { Brief, NarrativeStatus } from "../../shared/brief";
import type { BriefsRepo } from "../db/briefs-repo";
import type { NarrativeResult } from "../gateway/gateway";
import type { NarrativeSource } from "../gateway/types";

export interface NarrateDeps {
  narrate: (src: NarrativeSource, signal?: AbortSignal) => Promise<NarrativeResult>;
  briefs: Pick<BriefsRepo, "setNarrative">;
  source: (brief: Brief) => NarrativeSource;
  signal?: AbortSignal;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * 早间简报的“今日重点”：尽力而为（设计文档 6.2 / 第 10 节）。
 * 简报已经入库；这里只把结果写回 narrative / narrative_status。任何失败都记成 failed，永远不抛错。
 */
export async function narrateBrief(d: NarrateDeps, brief: Brief): Promise<NarrativeStatus> {
  if (brief.kind !== "morning") return brief.narrativeStatus;
  let r: NarrativeResult;
  try {
    r = await d.narrate(d.source(brief), d.signal);
  } catch (e) {
    d.log?.("narrative failed", e);
    r = { status: "failed", narrative: null, auditId: null };
  }
  try {
    d.briefs.setNarrative(brief.id, r.status === "ok" ? r.narrative : null, r.status);
  } catch (e) {
    d.log?.("saving the narrative failed", e);
    return "failed";
  }
  return r.status;
}
```

`src/main/schedule/daily-jobs.ts`：
1. `DailyJobDeps` 里 `aborted?: () => boolean;` 之前加：

```ts
  /** 早间：最终的简报入库之后补“今日重点”（narrateBrief，永远不抛错）。没有配置时不传。 */
  narrate?: (brief: Brief) => Promise<unknown>;
```

2. `morningJob` 改为：

```ts
/**
 * 早间：先用现有数据出一版（界面马上有内容），工作日再刷新 PR / tracker 状态后原地更新；
 * 最后对最终的那一版补“今日重点”。刷新失败也会给第一版补上，然后照常把错误交给调度器。
 */
export async function morningJob(d: DailyJobDeps): Promise<void> {
  let brief = d.briefs.generateMorning();
  try {
    if (d.isWorkingDay()) {
      d.setRefreshing(true);
      try {
        const r = await Promise.resolve().then(() => d.runner.refreshForBrief());
        if (r.outcomes.length > 0) brief = d.briefs.generateMorning();
      } finally {
        d.setRefreshing(false);
      }
    }
  } finally {
    if (d.narrate && !d.aborted?.()) await d.narrate(brief);
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm exec vitest run src/main/db/handoff-repos.test.ts src/main/brief src/main/schedule/daily-jobs.test.ts`
Expected: PASS（原有的早间任务用例没有传 `narrate`，调用顺序不变）

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/shared/brief.ts src/main/db/briefs-repo.ts src/main/db/handoff-repos.test.ts src/main/brief/brief-service.ts src/main/brief/brief-service.test.ts \
  src/main/brief/narrate.ts src/main/brief/narrate.test.ts src/main/schedule/daily-jobs.ts src/main/schedule/daily-jobs.test.ts
git commit -m "feat: morning brief gets its today's-focus narrative through the gateway after it is stored"
```

---
### Task 16: 主进程组装与 IPC

把 gateway 接进主进程：创建 `KeyStore`（Electron `safeStorage`）、`PrivacyGateway`（发送前确认用系统对话框）、早间任务的 `narrate`；启动时按保留天数清理一次审计；新增 6 个 IPC 通道；`BriefView` 多一个 `narrating`，界面据此显示“正在生成今日重点”。

**API key 的路径只有一条**：渲染进程通过 `llmKeySave(key)` 交给主进程，主进程加密存库后只返回 `LlmStatus`（打码形式）。没有任何通道会返回 key 本身。

发送前确认的对话框会把窗口带到前台，最多等 5 分钟（`AbortSignal.timeout`），超时视为拒绝。早间任务在调度器里串行执行，对话框一直开着会挡住后面的任务，所以要有这个上限。

按计划 1 的 Ruling R2，`register.ts` 和 `index.ts` 不写单元测试；`llmStatus` 是纯函数，有测试；任务 19 做隔离启动。

**Files:**
- Modify: `src/shared/ipc.ts`、`src/shared/ipc.test.ts`
- Modify: `src/shared/brief.ts`
- Create: `src/main/gateway/status.ts`、`src/main/gateway/status.test.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/strings.ts`
- Modify: `src/renderer/src/api.ts`

**Interfaces:**
- Consumes: 任务 7–15 的全部部件
- Produces:
  - IPC（全部是 invoke）：`llmStatus() → LlmStatus`、`llmKeySave(key: string) → LlmStatus`、`llmKeyClear() → LlmStatus`、`termsList() → SensitiveTerm[]`、`termsSave(terms) → SensitiveTerm[]`、`auditList(beforeId?: number) → AuditPage`
  - `BriefView.narrating: boolean`
  - `llmStatus(d: { settings; keys: Pick<KeyStore, "state">; audit: Pick<AuditRepo, "costSince">; now }): LlmStatus`（`src/main/gateway/status.ts`）
  - `AUDIT_PAGE_SIZE = 50`（`src/main/ipc/register.ts`）
  - 渲染进程 `api`：`llmStatus()`、`saveApiKey(key)`、`clearApiKey()`、`terms()`、`saveTerms(terms)`、`audit(beforeId?)`
  - `N.confirmTitle`、`N.confirmMessage`、`N.confirmSend`、`N.confirmCancel`

- [ ] **Step 1: 写失败测试**

`src/shared/ipc.test.ts` 的 `describe("IPC whitelist", ...)` 里追加：

```ts
  it("exposes the personal API channels as invoke-only", () => {
    for (const c of [IPC.llmStatus, IPC.llmKeySave, IPC.llmKeyClear, IPC.termsList, IPC.termsSave, IPC.auditList]) {
      expect(INVOKE_CHANNELS).toContain(c);
      expect(EVENT_CHANNELS).not.toContain(c);
    }
  });
```

新建 `src/main/gateway/status.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { AuditRepo } from "../db/audit-repo";
import { SecretsRepo } from "../db/secrets-repo";
import { SettingsRepo } from "../db/settings-repo";
import { memDb } from "../test-utils";
import { KeyStore } from "./key-store";
import { llmStatus } from "./status";
import { fakeSecretBox } from "./testing";

describe("llmStatus", () => {
  it("is configured only with a level, a URL, a model and, for a remote service, a readable key", () => {
    const db = memDb();
    const settings = new SettingsRepo(db);
    const audit = new AuditRepo(db);
    const box = fakeSecretBox();
    const keys = new KeyStore({ secrets: new SecretsRepo(db), box, now: () => 1 });
    const status = () => llmStatus({ settings, keys, audit, now: () => new Date(2026, 9, 21, 9).getTime() });

    expect(status()).toEqual({
      keySaved: false, keyMasked: null, keyUnreadable: false, encryptionAvailable: true,
      configured: false, priceKnown: false, monthCostUsd: 0, budgetUsd: 1,
    });
    settings.set("llmBaseUrl", "https://api.deepseek.com/v1");
    settings.set("llmModel", "deepseek-chat");
    expect(status()).toMatchObject({ configured: false, priceKnown: true });
    keys.save("sk-0123456789abcdef");
    expect(status()).toMatchObject({ configured: true, keyMasked: "••••cdef" });
    box.setBroken(true);
    expect(status()).toMatchObject({ configured: false, keyUnreadable: true });
    settings.set("llmBaseUrl", "http://localhost:11434/v1");
    expect(status().configured).toBe(true);
    settings.set("llmLevel", "off");
    expect(status().configured).toBe(false);
    settings.set("llmPrices", "gpt-* 1 1");
    expect(status().priceKnown).toBe(false);
    const id = audit.insert({ ts: new Date(2026, 9, 2).getTime(), provider: "x", model: "m", level: "metadata", status: "pending", payloadSent: null });
    audit.finish(id, { status: "sent", costUsd: 0.25 });
    expect(status().monthCostUsd).toBe(0.25);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/shared/ipc.test.ts src/main/gateway/status.test.ts`
Expected: FAIL（通道和 `./status` 不存在）

- [ ] **Step 3: 共享契约与 llmStatus**

`src/shared/ipc.ts`：`IPC` 里 `appNavigate` 之前加

```ts
  llmStatus: "llm:status",
  llmKeySave: "llm:keySave",
  llmKeyClear: "llm:keyClear",
  termsList: "terms:list",
  termsSave: "terms:save",
  auditList: "audit:list",
```

`INVOKE_CHANNELS` 末尾（`IPC.settingsDetectTrackerTools,` 之后）加一行：

```ts
  IPC.llmStatus, IPC.llmKeySave, IPC.llmKeyClear, IPC.termsList, IPC.termsSave, IPC.auditList,
```

`src/shared/brief.ts` 的 `BriefView` 里 `refreshing: boolean;` 之后加：

```ts
  /** 正在生成“今日重点”（个人 API 请求进行中）。 */
  narrating: boolean;
```

新建 `src/main/gateway/status.ts`：

```ts
import type { LlmStatus } from "../../shared/llm";
import type { AuditRepo } from "../db/audit-repo";
import type { SettingsRepo } from "../db/settings-repo";
import { isLoopbackHost, llmConfig, priceFor } from "../settings/settings-values";
import { monthStart } from "./budget";
import type { KeyStore } from "./key-store";

/** 设置页顶部的状态：key 的打码形式、是否配置完、模型有没有价格、本月花费。不含 key 本身。 */
export function llmStatus(d: { settings: SettingsRepo; keys: Pick<KeyStore, "state">; audit: Pick<AuditRepo, "costSince">; now: () => number }): LlmStatus {
  const cfg = llmConfig(d.settings);
  const key = d.keys.state();
  const local = cfg.baseUrl !== "" && isLoopbackHost(new URL(cfg.baseUrl).hostname);
  return {
    ...key,
    configured: cfg.level !== "off" && cfg.baseUrl !== "" && cfg.model !== "" && (local || (key.keySaved && !key.keyUnreadable)),
    priceKnown: cfg.model !== "" && priceFor(cfg.prices, cfg.model) !== null,
    monthCostUsd: d.audit.costSince(monthStart(d.now())),
    budgetUsd: cfg.budgetUsd,
  };
}
```

`src/main/strings.ts` 的 `N` 里加：

```ts
  confirmTitle: "Butler：发送前确认",
  confirmMessage: "要把下面的内容发给你的个人 LLM 服务商，用来生成“今日重点”吗？",
  confirmSend: "发送",
  confirmCancel: "不发送",
```

- [ ] **Step 4: IPC 处理器**

`src/main/ipc/register.ts`：
1. import 加上：

```ts
import type { AuditPage, LlmStatus, SensitiveTerm } from "../../shared/llm";
import type { AuditRepo } from "../db/audit-repo";
import type { TermsRepo } from "../db/terms-repo";
import { monthStart } from "../gateway/budget";
import type { KeyStore } from "../gateway/key-store";
```

并把 `import { normalizeSetting, SettingError } from "../settings/settings-values";` 改为 `import { llmConfig, normalizeSetting, normalizeTerms, SettingError } from "../settings/settings-values";`。

2. `IpcDeps` 里 `jobs: JobsRepo;` 之后加：

```ts
  keys: KeyStore;
  terms: TermsRepo;
  audit: AuditRepo;
  llmStatus: () => LlmStatus;
  /** 正在生成“今日重点”。 */
  briefNarrating: () => boolean;
```

3. `registerIpc` 之前加 `export const AUDIT_PAGE_SIZE = 50;`。

4. `briefsLatest` 处理器改为：

```ts
  handle(IPC.briefsLatest, (kind: BriefKind): BriefView => ({
    brief: d.briefService.latest(kind === "evening" ? "evening" : "morning"),
    refreshing: d.briefRefreshing(),
    narrating: d.briefNarrating(),
  }));
```

5. 函数末尾（`settingsDetectTrackerTools` 之后）加：

```ts
  // 个人 API：key 只进不出，界面只拿到打码后的 LlmStatus。
  handle(IPC.llmStatus, () => d.llmStatus());
  handle(IPC.llmKeySave, (key: unknown): LlmStatus => {
    if (typeof key !== "string") throw new SettingError("API key 格式不对");
    d.keys.save(key);
    d.notify();
    return d.llmStatus();
  });
  handle(IPC.llmKeyClear, (): LlmStatus => {
    d.keys.clear();
    d.notify();
    return d.llmStatus();
  });
  handle(IPC.termsList, (): SensitiveTerm[] => d.terms.list());
  handle(IPC.termsSave, (terms: unknown): SensitiveTerm[] => {
    d.terms.replaceAll(normalizeTerms(terms));
    d.notify();
    return d.terms.list();
  });
  handle(IPC.auditList, (beforeId: unknown): AuditPage => {
    const before = typeof beforeId === "number" && Number.isInteger(beforeId) ? beforeId : undefined;
    const rows = d.audit.list(AUDIT_PAGE_SIZE + 1, before);
    return {
      entries: rows.slice(0, AUDIT_PAGE_SIZE),
      hasMore: rows.length > AUDIT_PAGE_SIZE,
      monthCostUsd: d.audit.costSince(monthStart(d.now())),
      budgetUsd: llmConfig(d.settings).budgetUsd,
    };
  });
```

- [ ] **Step 5: 主进程组装**

`src/main/index.ts`：
1. import 加上：

```ts
import { narrateBrief } from "./brief/narrate";
import { AuditRepo } from "./db/audit-repo";
import { SecretsRepo } from "./db/secrets-repo";
import { TermsRepo } from "./db/terms-repo";
import { PrivacyGateway } from "./gateway/gateway";
import { KeyStore } from "./gateway/key-store";
import { electronSecretBox } from "./gateway/safe-storage";
import { llmStatus } from "./gateway/status";
```

并把 `import { scheduleConfig } from "./settings/settings-values";` 改为 `import { llmConfig, scheduleConfig } from "./settings/settings-values";`。

2. 模块顶部常量区（`ACTIVE_IDLE_SECONDS` 之后）加：

```ts
/** 发送前确认最多等这么久，超时视为拒绝：早间任务串行执行，对话框一直开着会挡住后面的任务。 */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const DAY_MS = 86_400_000;
```

3. `showEveningNotification` 之后加：

```ts
/** 发送前确认（设计文档 7.6）：把窗口带到前台，展示完整的出站内容。没有窗口时不发。 */
async function confirmSend(outbound: string): Promise<boolean> {
  const w = win;
  if (!w) return false;
  showWindow();
  const r = await dialog.showMessageBox(w, {
    type: "question",
    buttons: [N.confirmSend, N.confirmCancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: N.confirmTitle,
    message: N.confirmMessage,
    detail: outbound,
    signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS),
  });
  return r.response === 0;
}
```

4. `bootstrap()` 里：
   - 把 `new BriefService({ ... briefs: new BriefsRepo(db), ... })` 里的 `new BriefsRepo(db)` 提出来：在它之前加 `const briefs = new BriefsRepo(db);`，参数里改成 `briefs,`。
   - `briefService` 之后加：

```ts
  const audit = new AuditRepo(db);
  const terms = new TermsRepo(db);
  const keys = new KeyStore({ secrets: new SecretsRepo(db), box: electronSecretBox, now: Date.now, log: logger });
  const gateway = new PrivacyGateway({ settings, audit, terms, keys, now: Date.now, confirm: confirmSend, log: logger });
  // 启动时按保留天数清理一次审计（之后每次调用前也会清理）。
  audit.prune(Date.now() - llmConfig(settings).retentionDays * DAY_MS);
  let briefNarrating = false;
```

   - `dailyDeps` 里 `aborted: () => headlessAbort.signal.aborted,` 之后加：

```ts
    narrate: async (brief) => {
      briefNarrating = true;
      notify();
      try {
        await narrateBrief(
          {
            narrate: (src, signal) => gateway.narrate(src, signal),
            briefs,
            source: (b) => briefService.narrativeSource(b),
            signal: headlessAbort.signal,
            log: logger,
          },
          brief,
        );
      } finally {
        briefNarrating = false;
        notify();
      }
    },
```

   - `registerIpc({ ... })` 的参数里 `jobs,` 之后加：

```ts
    keys, terms, audit,
    llmStatus: () => llmStatus({ settings, keys, audit, now: Date.now }),
    briefNarrating: () => briefNarrating,
```

`src/renderer/src/api.ts`：import 加 `import type { AuditPage, LlmStatus, SensitiveTerm } from "../../shared/llm";`，`api` 里 `detectTrackerTools` 之后加：

```ts
  llmStatus: () => call<LlmStatus>(IPC.llmStatus),
  /** key 只发这一次；之后界面只能拿到打码形式。 */
  saveApiKey: (key: string) => call<LlmStatus>(IPC.llmKeySave, key),
  clearApiKey: () => call<LlmStatus>(IPC.llmKeyClear),
  terms: () => call<SensitiveTerm[]>(IPC.termsList),
  saveTerms: (terms: SensitiveTerm[]) => call<SensitiveTerm[]>(IPC.termsSave, terms),
  audit: (beforeId?: number) => call<AuditPage>(IPC.auditList, beforeId),
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm exec vitest run src/shared/ipc.test.ts src/main/gateway/status.test.ts`
Expected: PASS

- [ ] **Step 7: 全量检查、构建并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: 全部通过；`pnpm lint` 没有出口规则的报错（`index.ts` 只 import gateway 模块，不直接联网）

```bash
git add src/shared/ipc.ts src/shared/ipc.test.ts src/shared/brief.ts src/main/gateway/status.ts src/main/gateway/status.test.ts \
  src/main/ipc/register.ts src/main/index.ts src/main/strings.ts src/renderer/src/api.ts
git commit -m "feat: wire the privacy gateway, key store and narrative into the main process with IPC"
```

---

### Task 17: 设置页：隐私与个人 API

设置页新增一节：隐私档位（四选一，带说明）、服务地址、模型、API key（密码框，保存后清空，只显示打码形式，可清除）、每月预算、价格表、审计保留天数、发送前确认、敏感词表（人名 / 其他，一行一个）。顶部按状态给出提示：没配置完、key 解不开、加密不可用、当前模型没有价格、本月预算已用完、完整档位的风险。

按计划 1 的 Ruling R2，组件不写单元测试；表单小工具（`privacy-form.ts`）有测试。

**Files:**
- Create: `src/renderer/src/privacy-form.ts`、`src/renderer/src/privacy-form.test.ts`
- Create: `src/renderer/src/components/PrivacySettings.tsx`
- Modify: `src/renderer/src/components/SettingsPage.tsx`
- Modify: `src/renderer/src/strings.ts`

**Interfaces:**
- Consumes: `api.settings` / `setSetting` / `llmStatus` / `saveApiKey` / `clearApiKey` / `terms` / `saveTerms`（任务 16）、`PRIVACY_LEVELS`、`LlmStatus`、`SensitiveTerm`
- Produces:
  - `termsText(terms, category): string`、`parseTermsText(people: string, others: string): SensitiveTerm[]`、`formatUsd(n: number): string`、`llmWarnings(s: LlmStatus, level: PrivacyLevel): string[]`（`src/renderer/src/privacy-form.ts`）
  - `S.privacy*`、`S.llm*`、`S.apiKey*`、`S.terms*`、`S.monthSpend(spent, budget)` 等文案

- [ ] **Step 1: 写失败测试**

新建 `src/renderer/src/privacy-form.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { LlmStatus } from "../../shared/llm";
import { formatUsd, llmWarnings, parseTermsText, termsText } from "./privacy-form";

const ok: LlmStatus = {
  keySaved: true, keyMasked: "••••cdef", keyUnreadable: false, encryptionAvailable: true,
  configured: true, priceKnown: true, monthCostUsd: 0.12, budgetUsd: 1,
};

describe("privacy form helpers", () => {
  it("turns the term list into two textareas and back", () => {
    const terms = [{ term: "张三", category: "person" as const }, { term: "天穹计划", category: "term" as const }, { term: "Alice", category: "person" as const }];
    expect(termsText(terms, "person")).toBe("张三\nAlice");
    expect(termsText(terms, "term")).toBe("天穹计划");
    expect(parseTermsText(" 张三 \n\nAlice\r\n", "天穹计划\n")).toEqual(terms.slice(0, 1).concat(terms[2], terms[1]));
  });

  it("formats small amounts with enough precision", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0023)).toBe("$0.0023");
    expect(formatUsd(1.5)).toBe("$1.50");
  });

  it("warns about whatever keeps the narrative from being generated", () => {
    expect(llmWarnings(ok, "metadata")).toEqual([]);
    expect(llmWarnings(ok, "off")).toEqual(["个人 API 已关闭：简报里不会有“今日重点”。"]);
    expect(llmWarnings({ ...ok, configured: false }, "metadata")).toEqual(["还没有配置完：需要服务地址、模型，远程服务还需要 API key。"]);
    expect(llmWarnings({ ...ok, priceKnown: false }, "metadata")).toEqual(["价格表里没有当前模型的价格：不会调用。"]);
    expect(llmWarnings({ ...ok, keyUnreadable: true, configured: false }, "redacted")[0]).toContain("无法解密");
    expect(llmWarnings({ ...ok, monthCostUsd: 1 }, "metadata")[0]).toContain("预算");
    expect(llmWarnings({ ...ok, monthCostUsd: 0, budgetUsd: 0 }, "metadata")).toEqual([]);
    expect(llmWarnings(ok, "full")[0]).toContain("真实的 ticket 号");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/renderer/src/privacy-form.test.ts`
Expected: FAIL（`./privacy-form` 不存在）

- [ ] **Step 3: 文案**

`src/renderer/src/strings.ts`：顶部 import 加 `import type { PrivacyLevel } from "../../shared/llm";`，`S` 末尾加：

```ts
  privacy: "隐私与个人 API",
  privacyIntro: "个人 LLM API 只用来写早间简报的“今日重点”。所有出站内容都先按档位挑字段，把 ticket 号、仓库、分支、人名和敏感词换成每次随机的占位符，再扫描敏感信息（命中就整次不发），并记进审计页。不配置时其他功能照常可用。",
  privacyLevel: "隐私档位",
  privacyLevels: { off: "关闭", metadata: "仅元数据（默认）", redacted: "脱敏文本", full: "完整" } as Record<PrivacyLevel, string>,
  privacyLevelHelp: {
    off: "不调用个人 API。",
    metadata: "只发占位符、状态、PR 和 follow-up 的类型、数量和天数，不发任何原文。",
    redacted: "再加上下一步、阻塞和 follow-up 描述的短文本，其中的 ticket 号、仓库、分支、人名和敏感词换成占位符。",
    full: "不做替换，发送真实的 ticket 号和原文；敏感信息扫描仍然生效。",
  } as Record<PrivacyLevel, string>,
  llmFields: {
    llmBaseUrl: "服务地址（OpenAI 兼容接口的 base URL）",
    llmModel: "模型",
    llmMonthlyBudgetUsd: "每月预算（美元）",
    auditRetentionDays: "审计保留天数",
    llmPrices: "价格表（美元 / 百万 token）",
  } as Record<string, string>,
  llmPlaceholders: {
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmModel: "deepseek-chat",
    llmMonthlyBudgetUsd: "1",
    auditRetentionDays: "90",
  } as Record<string, string>,
  llmPricesHint: "每行“模型 输入价 输出价”，模型名可以用 * 通配，从上往下第一条匹配的生效。默认的 * 15 75 把任何模型都按很贵的价格算，请按你的服务商修改；本机模型可以写 * 0 0。找不到价格的模型不会被调用。",
  apiKey: "API key",
  apiKeyNone: "未保存",
  apiKeyUnreadable: "已保存但无法解密，请重新输入",
  apiKeyPlaceholder: "粘贴新的 key",
  apiKeyHint: "key 用系统钥匙串（macOS）或 DPAPI（Windows）加密保存，之后界面上只显示末 4 位。本机服务（localhost）可以不填。",
  clearKey: "清除",
  monthSpend: (spent: string, budget: string) => `本月已花 ${spent} / 预算 ${budget}`,
  llmConfirm: "每次发送前弹窗确认（展示完整的出站内容）",
  sensitiveTerms: "敏感词表",
  termsPeople: "人名（一行一个）",
  termsOthers: "其他敏感词：项目代号、客户名等（一行一个）",
  termsHint: "这些词在发送前会被换成占位符，回来以后再换回去。ticket 号、仓库名和分支名会自动处理，不用写在这里。每个至少两个字。",
  termsSaved: "已保存。",
  llmOff: "个人 API 已关闭：简报里不会有“今日重点”。",
  llmNoEncryption: "系统的加密存储不可用：无法保存 API key。",
  llmKeyUnreadable: "保存的 API key 无法解密（钥匙串被重置或换了电脑），请重新输入。",
  llmNotConfigured: "还没有配置完：需要服务地址、模型，远程服务还需要 API key。",
  llmNoPrice: "价格表里没有当前模型的价格：不会调用。",
  llmOverBudget: (spent: string, budget: string) => `本月已花 ${spent}，达到预算 ${budget}：本月不再调用。`,
  llmFullWarning: "完整档位会把真实的 ticket 号和原文发给服务商，只靠敏感信息扫描兜底。",
```

- [ ] **Step 4: 表单小工具**

新建 `src/renderer/src/privacy-form.ts`：

```ts
import type { LlmStatus, PrivacyLevel, SensitiveTerm, TermCategory } from "../../shared/llm";
import { S } from "./strings";

/** 敏感词表 → 文本框内容（一行一个）。 */
export function termsText(terms: readonly SensitiveTerm[], category: TermCategory): string {
  return terms.filter((t) => t.category === category).map((t) => t.term).join("\n");
}

/** 两个文本框 → 敏感词表（去空行；其余规范化在主进程 normalizeTerms 里做）。 */
export function parseTermsText(people: string, others: string): SensitiveTerm[] {
  const lines = (v: string) => v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return [
    ...lines(people).map((term) => ({ term, category: "person" as const })),
    ...lines(others).map((term) => ({ term, category: "term" as const })),
  ];
}

/** 美元金额：不到 1 美分时多显示两位，免得“$0.00”看起来像没花钱。 */
export function formatUsd(n: number): string {
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** 设置页顶部的提示：哪些原因会让“今日重点”出不来，以及完整档位的风险。 */
export function llmWarnings(s: LlmStatus, level: PrivacyLevel): string[] {
  if (level === "off") return [S.llmOff];
  const out: string[] = [];
  if (!s.encryptionAvailable) out.push(S.llmNoEncryption);
  if (s.keyUnreadable) out.push(S.llmKeyUnreadable);
  if (!s.configured) out.push(S.llmNotConfigured);
  else if (!s.priceKnown) out.push(S.llmNoPrice);
  if (s.configured && s.budgetUsd > 0 && s.monthCostUsd >= s.budgetUsd) out.push(S.llmOverBudget(formatUsd(s.monthCostUsd), formatUsd(s.budgetUsd)));
  if (level === "full") out.push(S.llmFullWarning);
  return out;
}
```

- [ ] **Step 5: 组件**

新建 `src/renderer/src/components/PrivacySettings.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import { PRIVACY_LEVELS, type LlmStatus, type PrivacyLevel } from "../../../shared/llm";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { formatUsd, llmWarnings, parseTermsText, termsText } from "../privacy-form";
import { S } from "../strings";

const TEXT_FIELDS = ["llmBaseUrl", "llmModel", "llmMonthlyBudgetUsd", "auditRetentionDays"] as const;

export function PrivacySettings() {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  const [terms, setTerms] = useState<{ people: string; others: string } | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [termsMessage, setTermsMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, s, t] = await Promise.all([api.settings(), api.llmStatus(), api.terms()]);
      setValues(v);
      setStatus(s);
      // 敏感词只在第一次加载时填进文本框：之后的刷新不覆盖用户正在编辑的内容。
      setTerms((cur) => cur ?? { people: termsText(t, "person"), others: termsText(t, "term") });
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  if (!values || !status || !terms) return <p className="muted">{S.loading}</p>;
  const current = values;
  const currentStatus = status;
  const currentTerms = terms;
  const level = current.llmLevel as PrivacyLevel;
  const value = (k: EditableSettingKey): string => draft[k] ?? current[k];
  const edit = (k: EditableSettingKey, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const clearDraft = (k: EditableSettingKey) =>
    setDraft((d) => {
      const next = { ...d };
      delete next[k];
      return next;
    });

  /** 校验失败（invalid_setting）的 message 显示在表单里；其他失败走全局错误条。 */
  function writeFailed(e: unknown) {
    if (e instanceof ButlerError && e.code === "invalid_setting") setError(e.message);
    else reportError(e);
  }

  async function save(k: EditableSettingKey, v: string = value(k)) {
    setError(null);
    try {
      await api.setSetting(k, v);
      clearDraft(k);
      await load();
    } catch (e) {
      writeFailed(e);
    }
  }

  const saveIfEdited = (k: EditableSettingKey) => {
    if (draft[k] !== undefined && draft[k] !== current[k]) void save(k);
    else clearDraft(k);
  };

  async function saveKey() {
    setError(null);
    try {
      setStatus(await api.saveApiKey(keyInput));
      setKeyInput("");
    } catch (e) {
      writeFailed(e);
    }
  }

  async function clearKey() {
    try {
      setStatus(await api.clearApiKey());
    } catch (e) {
      reportError(e);
    }
  }

  async function saveTerms() {
    setError(null);
    setTermsMessage(null);
    try {
      const saved = await api.saveTerms(parseTermsText(currentTerms.people, currentTerms.others));
      setTerms({ people: termsText(saved, "person"), others: termsText(saved, "term") });
      setTermsMessage(S.termsSaved);
    } catch (e) {
      writeFailed(e);
    }
  }

  return (
    <section className="settings-section">
      <h2>{S.privacy}</h2>
      <p className="muted">{S.privacyIntro}</p>
      {llmWarnings(currentStatus, level).map((w) => (
        <p key={w} className="notice-line">{w}</p>
      ))}
      {error && <p className="error">{error}</p>}

      <div className="field">
        {S.privacyLevel}
        {PRIVACY_LEVELS.map((l) => (
          <label key={l} className="inline">
            <input type="radio" name="llmLevel" checked={level === l} onChange={() => void save("llmLevel", l)} />
            <strong>{S.privacyLevels[l]}</strong>
            <span className="muted">{S.privacyLevelHelp[l]}</span>
          </label>
        ))}
      </div>

      {TEXT_FIELDS.map((k) => (
        <label key={k} className="field">
          {S.llmFields[k]}
          <input value={value(k)} placeholder={S.llmPlaceholders[k]} onChange={(e) => edit(k, e.target.value)} onBlur={() => saveIfEdited(k)} />
        </label>
      ))}

      <div className="field">
        {S.apiKey}
        <div className="row">
          <span className="muted">{currentStatus.keySaved ? (currentStatus.keyMasked ?? S.apiKeyUnreadable) : S.apiKeyNone}</span>
          <input type="password" autoComplete="off" spellCheck={false} value={keyInput} placeholder={S.apiKeyPlaceholder} onChange={(e) => setKeyInput(e.target.value)} />
          <button disabled={!keyInput.trim() || !currentStatus.encryptionAvailable} onClick={() => void saveKey()}>{S.save}</button>
          {currentStatus.keySaved && <button onClick={() => void clearKey()}>{S.clearKey}</button>}
        </div>
        <p className="muted">{S.apiKeyHint}</p>
      </div>

      <div className="field">
        {S.llmFields.llmPrices}
        <textarea rows={4} className="mono" value={value("llmPrices")} onChange={(e) => edit("llmPrices", e.target.value)} onBlur={() => saveIfEdited("llmPrices")} />
        <p className="muted">{S.llmPricesHint}</p>
      </div>
      <p className="muted">{S.monthSpend(formatUsd(currentStatus.monthCostUsd), formatUsd(currentStatus.budgetUsd))}</p>

      <label className="inline">
        <input type="checkbox" checked={current.llmConfirm === "1"} onChange={(e) => void save("llmConfirm", e.target.checked ? "1" : "0")} />
        {S.llmConfirm}
      </label>

      <div className="field">
        {S.sensitiveTerms}
        <div className="row">
          <label className="field">
            {S.termsPeople}
            <textarea rows={5} value={currentTerms.people} onChange={(e) => setTerms({ ...currentTerms, people: e.target.value })} />
          </label>
          <label className="field">
            {S.termsOthers}
            <textarea rows={5} value={currentTerms.others} onChange={(e) => setTerms({ ...currentTerms, others: e.target.value })} />
          </label>
        </div>
        <p className="muted">{S.termsHint}</p>
        <div className="actions">
          <button onClick={() => void saveTerms()}>{S.save}</button>
          {termsMessage && <span className="muted">{termsMessage}</span>}
        </div>
      </div>
    </section>
  );
}
```

`src/renderer/src/components/SettingsPage.tsx`：import 加 `import { PrivacySettings } from "./PrivacySettings";`，`<ScheduleSettings />` 之后加 `<PrivacySettings />`。

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm exec vitest run src/renderer/src/privacy-form.test.ts`
Expected: PASS

- [ ] **Step 7: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/renderer/src/privacy-form.ts src/renderer/src/privacy-form.test.ts src/renderer/src/components/PrivacySettings.tsx \
  src/renderer/src/components/SettingsPage.tsx src/renderer/src/strings.ts
git commit -m "feat: privacy and personal API settings with masked key, price table, budget and sensitive terms"
```

---

### Task 18: 审计页与简报里的“今日重点”

审计页（设计文档 7.7）：本月花费 / 预算；每次调用一行（时间、服务商、模型、档位、状态、token、费用），展开后看拒发原因、错误、原样发出的请求体（排版成多行，消息里的 JSON 也展开）和原样的响应；可以往下翻页。侧栏新增“审计”入口。

简报页：“今日重点”按行显示成列表；生成中、被拦截、超预算、失败时显示一句说明，失败和拦截提示去审计页看原因。

**Files:**
- Create: `src/renderer/src/audit-view.ts`、`src/renderer/src/audit-view.test.ts`
- Create: `src/renderer/src/components/AuditPage.tsx`
- Modify: `src/renderer/src/brief-view.ts`、`src/renderer/src/brief-view.test.ts`
- Modify: `src/renderer/src/components/BriefPage.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/strings.ts`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `api.audit(beforeId?)`（任务 16）、`BriefView.narrating`、`formatUsd`（任务 17）
- Produces:
  - `auditStatusLabel(s)`、`blockedText(hits)`、`auditSummary(e)`、`prettyBody(text)`、`prettyJson(text)`（`src/renderer/src/audit-view.ts`）
  - `narrativeLines(b: Brief): string[]`、`narrativeNote(b: Brief, narrating: boolean): string | null`（`src/renderer/src/brief-view.ts`）
  - `Route` 增加 `{ page: "audit" }`

- [ ] **Step 1: 写失败测试**

新建 `src/renderer/src/audit-view.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../../shared/llm";
import { auditStatusLabel, auditSummary, blockedText, prettyBody, prettyJson } from "./audit-view";

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1, ts: 1, provider: "api.deepseek.com", model: "deepseek-chat", level: "metadata", status: "sent",
  payloadSent: null, response: null, tokensIn: 120, tokensOut: 40, costUsd: 0.0023, blockedReason: null, error: null, ...over,
});

describe("audit view helpers", () => {
  it("labels every status", () => {
    for (const s of ["pending", "sent", "failed", "blocked", "budget", "declined"] as const) expect(auditStatusLabel(s).length).toBeGreaterThan(0);
  });

  it("summarises an entry and explains a block", () => {
    expect(auditSummary(entry())).toBe("仅元数据（默认） · 已发送 · 120 / 40 token · $0.0023");
    expect(auditSummary(entry({ status: "blocked", tokensIn: null, tokensOut: null, costUsd: null }))).toBe("仅元数据（默认） · 已拦截");
    expect(blockedText([{ rule: "url", sample: "htt…(23)" }, { rule: "secret", sample: "sk-…(40)" }])).toBe("网址（htt…(23)）；密钥或令牌（sk-…(40)）");
    expect(blockedText(null)).toBe("");
  });

  it("pretty-prints the request body including the JSON inside messages, and leaves non-JSON alone", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "system", content: "提示" }, { role: "user", content: '{"date":"2026-10-21"}' }] });
    const out = prettyBody(body);
    expect(out).toContain('"date": "2026-10-21"');
    expect(out).toContain('"content": "提示"');
    expect(prettyBody("not json")).toBe("not json");
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson(null)).toBe("");
  });
});
```

`src/renderer/src/brief-view.test.ts`：import 加上 `narrativeLines, narrativeNote`，以及 `import { EMPTY_BRIEF_CONTENT, type Brief } from "../../shared/brief";`（`BriefItem, BriefRule` 的 import 保持），文件末尾追加：

```ts
describe("today's focus", () => {
  const brief = (over: Partial<Brief>): Brief => ({
    id: 1, kind: "morning", date: "2026-10-21", createdAt: 1, ...EMPTY_BRIEF_CONTENT, narrative: null, narrativeStatus: "off", ...over,
  });

  it("shows the narrative lines only when it succeeded", () => {
    expect(narrativeLines(brief({ narrativeStatus: "ok", narrative: "先合并 PR。\n\n 再处理阻塞。 " }))).toEqual(["先合并 PR。", "再处理阻塞。"]);
    expect(narrativeLines(brief({ narrativeStatus: "failed", narrative: "旧的" }))).toEqual([]);
  });

  it("explains why there is no narrative", () => {
    expect(narrativeNote(brief({}), true)).toBe("正在生成今日重点…");
    expect(narrativeNote(brief({ narrativeStatus: "blocked" }), false)).toContain("敏感信息");
    expect(narrativeNote(brief({ narrativeStatus: "budget" }), false)).toContain("预算");
    expect(narrativeNote(brief({ narrativeStatus: "failed" }), false)).toContain("失败");
    expect(narrativeNote(brief({ narrativeStatus: "off" }), false)).toBeNull();
    expect(narrativeNote(brief({ narrativeStatus: "ok", narrative: "x" }), false)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run src/renderer/src/audit-view.test.ts src/renderer/src/brief-view.test.ts`
Expected: FAIL（`./audit-view`、`narrativeLines`、`narrativeNote` 不存在）

- [ ] **Step 3: 文案**

`src/renderer/src/strings.ts` 的 `S` 末尾加：

```ts
  audit: "审计",
  auditIntro: "每次调用个人 LLM API 的记录：原样发出的内容、响应、token 数和费用；被拦截或超预算的请求只记原因，没有发出任何内容。",
  auditEmpty: "还没有调用记录。",
  auditStatus: { pending: "未完成", sent: "已发送", failed: "发送失败", blocked: "已拦截", budget: "超预算", declined: "已拒绝" } as Record<string, string>,
  auditTokens: (i: number, o: number) => `${i} / ${o} token`,
  scanRule: {
    secret: "密钥或令牌", url: "网址", domain: "域名", ip: "IP 地址", email: "邮箱", path: "文件路径", ticket: "未替换的 ticket 号", known: "未替换的原值",
  } as Record<string, string>,
  auditBlocked: (why: string) => `拦截原因：${why}`,
  auditPayload: "发出的内容",
  auditNothingSent: "（没有发出任何内容）",
  auditResponse: "响应",
  loadMore: "更早的记录",
  narrativePending: "正在生成今日重点…",
  narrativeBlocked: "今日重点没有发送：出站内容里有敏感信息（详见审计页）。",
  narrativeBudget: "今日重点没有生成：本月预算已用完，或当前模型在价格表里没有价格。",
  narrativeFailed: "今日重点生成失败（详见审计页）。",
```

- [ ] **Step 4: 小工具**

新建 `src/renderer/src/audit-view.ts`：

```ts
import type { AuditEntry, AuditStatus, ScanHit } from "../../shared/llm";
import { formatUsd } from "./privacy-form";
import { S } from "./strings";

export function auditStatusLabel(s: AuditStatus): string {
  return S.auditStatus[s] ?? s;
}

/** 拦截原因：规则名（打码样本）。 */
export function blockedText(hits: ScanHit[] | null): string {
  return (hits ?? []).map((h) => `${S.scanRule[h.rule] ?? h.rule}（${h.sample}）`).join(S.listSep);
}

/** 列表里每一行的摘要：档位 · 状态 · token · 费用。 */
export function auditSummary(e: AuditEntry): string {
  const parts = [S.privacyLevels[e.level], auditStatusLabel(e.status)];
  if (e.tokensIn !== null || e.tokensOut !== null) parts.push(S.auditTokens(e.tokensIn ?? 0, e.tokensOut ?? 0));
  if (e.costUsd !== null) parts.push(formatUsd(e.costUsd));
  return parts.join(" · ");
}

export function prettyJson(text: string | null): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 请求体排版成多行；消息里的 JSON 字符串（出站数据）也展开，方便逐字段核对。内容不变，只是换了排版。 */
export function prettyBody(text: string): string {
  try {
    const body = JSON.parse(text) as { messages?: { role: string; content: unknown }[] };
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map((m) => {
        if (typeof m.content !== "string") return m;
        try {
          return { ...m, content: JSON.parse(m.content) as unknown };
        } catch {
          return m;
        }
      });
    }
    return JSON.stringify(body, null, 2);
  } catch {
    return text;
  }
}
```

`src/renderer/src/brief-view.ts`：顶部 import 改为 `import type { Brief, BriefItem, BriefSection } from "../../shared/brief";`，文件末尾追加：

```ts
/** “今日重点”的每一行（只有生成成功时才有）。 */
export function narrativeLines(b: Brief): string[] {
  if (b.narrativeStatus !== "ok" || !b.narrative) return [];
  return b.narrative.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** 没有“今日重点”时的说明；没配置（off）时不打扰用户。 */
export function narrativeNote(b: Brief, narrating: boolean): string | null {
  if (narrating) return S.narrativePending;
  switch (b.narrativeStatus) {
    case "blocked":
      return S.narrativeBlocked;
    case "budget":
      return S.narrativeBudget;
    case "failed":
      return S.narrativeFailed;
    default:
      return null;
  }
}
```

- [ ] **Step 5: 组件**

`src/renderer/src/components/BriefPage.tsx`：
1. `../brief-view` 的 import 加上 `narrativeLines, narrativeNote`。
2. `<MorningBody brief={brief} ... />` 改为传入 `narrating={view.narrating}`：

```tsx
        <MorningBody brief={brief} narrating={view.narrating} onAct={(i, a) => void act(i, a)} onOpenTicket={(key) => onOpenTicket(key)} />
```

3. `MorningBody` 的签名和开头的 narrative 那一段改为：

```tsx
function MorningBody({ brief, narrating, onAct, onOpenTicket }: { brief: Brief; narrating: boolean; onAct: (i: BriefItem, a: ItemAction) => void; onOpenTicket: (key: string) => void }) {
  const groups = groupItems(brief.items);
  const lines = narrativeLines(brief);
  const note = narrativeNote(brief, narrating);
  return (
    <>
      {(lines.length > 0 || note) && (
        <section className="narrative">
          <h3>{S.todayFocus}</h3>
          {lines.length > 0 && (
            <ul className="day-list">
              {lines.map((l, n) => (
                <li key={n}>{l}</li>
              ))}
            </ul>
          )}
          {note && <p className="muted">{note}</p>}
        </section>
      )}
```

（删掉原来的 `{brief.narrativeStatus === "ok" && brief.narrative && ( ... )}` 那一段；`<Notices brief={brief} />` 及之后不变。）

新建 `src/renderer/src/components/AuditPage.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, AuditPage as AuditPageData } from "../../../shared/llm";
import { api } from "../api";
import { auditSummary, blockedText, prettyBody, prettyJson } from "../audit-view";
import { reportError } from "../errors";
import { formatUsd } from "../privacy-form";
import { S } from "../strings";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function AuditPage() {
  const [page, setPage] = useState<AuditPageData | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await api.audit();
      setPage(p);
      setEntries(p.entries);
      setHasMore(p.hasMore);
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  async function more() {
    const last = entries[entries.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const p = await api.audit(last.id);
      setEntries((cur) => [...cur, ...p.entries]);
      setHasMore(p.hasMore);
    } catch (e) {
      reportError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  if (!page) return <p className="empty">{S.loading}</p>;
  return (
    <div className="page">
      <h2>{S.audit}</h2>
      <p className="muted">{S.auditIntro}</p>
      <p>{S.monthSpend(formatUsd(page.monthCostUsd), formatUsd(page.budgetUsd))}</p>
      {entries.length === 0 && <p className="empty">{S.auditEmpty}</p>}
      {entries.map((e) => (
        <details key={e.id} className="audit-entry">
          <summary>
            <strong>{formatTime(e.ts)}</strong>
            <span>{e.provider} · {e.model}</span>
            <span className="muted">{auditSummary(e)}</span>
          </summary>
          {e.blockedReason && <p className="error">{S.auditBlocked(blockedText(e.blockedReason))}</p>}
          {e.error && <p className="error">{e.error}</p>}
          <h4>{S.auditPayload}</h4>
          <pre className="raw">{e.payloadSent ? prettyBody(e.payloadSent) : S.auditNothingSent}</pre>
          {e.response && (
            <>
              <h4>{S.auditResponse}</h4>
              <pre className="raw">{prettyJson(e.response)}</pre>
            </>
          )}
        </details>
      ))}
      {hasMore && (
        <button disabled={loadingMore} onClick={() => void more()}>{S.loadMore}</button>
      )}
    </div>
  );
}
```

`src/renderer/src/App.tsx`：
1. `Route` 改为：

```tsx
export type Route =
  | { page: "home"; kind?: BriefKind }
  | { page: "ticket"; key: string }
  | { page: "unclaimed" }
  | { page: "settings" }
  | { page: "audit" };
```

2. import 加 `import { AuditPage } from "./components/AuditPage";`，`{route.page === "settings" && <SettingsPage />}` 之后加 `{route.page === "audit" && <AuditPage />}`。

`src/renderer/src/components/Sidebar.tsx`：“设置”按钮之前加：

```tsx
      <button className={cls("nav", route.page === "audit")} onClick={() => onNavigate({ page: "audit" })}>{S.audit}</button>
```

`src/renderer/src/styles.css` 末尾加：

```css
.audit-entry { border-bottom: 1px solid var(--border); padding: 6px 0; }
.audit-entry summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.audit-entry h4 { margin: 8px 0 4px; }
.narrative ul { margin: 6px 0 0; }
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm exec vitest run src/renderer/src/audit-view.test.ts src/renderer/src/brief-view.test.ts`
Expected: PASS

- [ ] **Step 7: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

```bash
git add src/renderer/src/audit-view.ts src/renderer/src/audit-view.test.ts src/renderer/src/components/AuditPage.tsx \
  src/renderer/src/brief-view.ts src/renderer/src/brief-view.test.ts src/renderer/src/components/BriefPage.tsx \
  src/renderer/src/components/Sidebar.tsx src/renderer/src/App.tsx src/renderer/src/strings.ts src/renderer/src/styles.css
git commit -m "feat: audit page and today's-focus display with reasons when it is missing"
```

---

### Task 19: 全量检查、隔离启动（经本地假服务器的端到端）与遗留清单

不调用任何真实的 LLM 服务商。隔离启动分两次：第一次让 Butler 建库；然后起一个只监听 `127.0.0.1` 的假 OpenAI 兼容服务器，把临时库里的服务地址指向它（`metadata` 档位、价格 `* 0 0`）、加一个带下一步的 ticket，并让早间简报重新到期；第二次启动时早间任务会经过真正的 Electron 主进程、PrivacyGateway 和 `fetch` 把“今日重点”请求发给假服务器。这一步也顺带证明：没有保存 key 时 gateway 不会去碰系统钥匙串，ticket 号、仓库名和原文都没有出现在请求里。

**Files:**
- Modify: `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md`

- [ ] **Step 1: 全量自动检查**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm exec electron out/main/index.js --smoke`
Expected: 全部通过；`headless.live.test.ts` 显示 skipped；冒烟输出 `sqlite-ok 1` 和 `pty-ok`。

再确认 gateway 之外没有任何联网代码（ESLint 规则已经保证，这里是人工复核）：

Run: `grep -rnE "\bfetch\(|from \"(node:)?(http|https|net|tls|undici)\"" src hook scripts | grep -v -e "^src/main/gateway/" -e "^src/main/egress-lint.test.ts:" || echo "no egress outside the gateway"`

（`egress-lint.test.ts` 里的是故意写的违规样本字符串。）
Expected: `no egress outside the gateway`

- [ ] **Step 2: 隔离启动，端到端经过本地假服务器**

整段在一次 Bash 调用里执行（本地时间 05:00 之前早间简报不会到期，换个时间再验）：

```bash
set -u
T="$(mktemp -d)"
launch() {
  BUTLER_HOME="$T" node -e '
const { spawn } = require("node:child_process");
const c = spawn(require("electron"), ["out/main/index.js"], { env: process.env, stdio: "inherit" });
setTimeout(() => c.kill("SIGTERM"), 25000);
c.on("exit", (code, signal) => console.log("electron exited", code, signal));
'
}
# 1. 第一次启动：建库、seed 调度、生成一份没有“今日重点”的早间简报。
launch
# 2. 本地假服务器：只监听 127.0.0.1，记录请求，回复里原样引用第一个 ticket 的占位符。
cat > "$T/fake.cjs" <<'JS'
const http = require("node:http");
const fs = require("node:fs");
const [log, portFile] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fs.appendFileSync(log, JSON.stringify({ url: req.url, auth: req.headers.authorization || null, body }) + "\n");
    const payload = JSON.parse(JSON.parse(body).messages[1].content);
    const id = payload.tickets[0] ? payload.tickets[0].id : "今天";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ focus: [`先看 ${id} 的下一步。`] }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  });
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
JS
node "$T/fake.cjs" "$T/requests.jsonl" "$T/port" &
FAKE=$!
trap 'kill $FAKE 2>/dev/null' EXIT
for i in 1 2 3 4 5 6 7 8 9 10; do [ -s "$T/port" ] && break; sleep 0.5; done
# 3. 配置临时库：服务地址指向假服务器、免费价格；加一个带下一步的 ticket；让早间简报重新到期。
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
set.run("llmBaseUrl", `http://127.0.0.1:${process.argv[2]}/v1`);
set.run("llmModel", "fake-model");
set.run("llmPrices", "* 0 0");
const now = Date.now();
db.prepare("INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  .run("DEMO-42", null, "/tmp/secret-repo", "branch", null, "feature/DEMO-42", "active", now);
const payload = { ticket: "DEMO-42", status: "active", done_today: [], next_steps: ["修好 DEMO-42 的登录"], blockers: [], pr: null, jira: null, followups: [], decisions: [], learnings: [], open_questions: [] };
db.prepare("INSERT INTO handoffs (ticket_key, session_id, trigger, created_at, payload, degraded, raw_text) VALUES (?, NULL, ?, ?, ?, 0, NULL)")
  .run("DEMO-42", "manual", now, JSON.stringify(payload));
db.prepare("DELETE FROM jobs WHERE name = ?").run("morning_brief");
' "$T/app.db" "$(cat "$T/port")"
# 4. 第二次启动：早间简报 → 今日重点（经 gateway 发给本地假服务器）。
launch
# 5. 检查结果。
node -e '
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
console.log(db.prepare("PRAGMA user_version").get());
console.log(db.prepare("SELECT kind, narrative_status, narrative FROM briefs ORDER BY id DESC LIMIT 1").get());
console.log(db.prepare("SELECT status, level, model, tokens_in, tokens_out, cost_usd, blocked_reason FROM llm_audit").all());
console.log("secrets rows:", db.prepare("SELECT COUNT(*) AS n FROM secrets").get().n);
const reqs = fs.existsSync(process.argv[2]) ? fs.readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
console.log("requests:", reqs.length, "urls:", reqs.map((r) => r.url), "auth:", reqs.map((r) => r.auth));
console.log("leaks:", ["DEMO-42", "secret-repo", "feature/DEMO-42", "登录"].filter((v) => reqs.some((r) => r.body.includes(v))));
' "$T/app.db" "$T/requests.jsonl"
grep -E "uncaughtException|unhandledRejection|failed" "$T/logs/main.log" || echo "no errors logged"
```

Expected：
- 两次都打印 `electron exited`。
- `user_version` 为 3。
- 最新一份简报：`kind: 'morning'`、`narrative_status: 'ok'`、`narrative: '先看 DEMO-42 的下一步。'`（占位符在本地还原成了真实 ticket 号）。
- `llm_audit` 一行：`status: 'sent'`、`level: 'metadata'`、`model: 'fake-model'`、`tokens_in: 100`、`tokens_out: 20`、`cost_usd: 0`、`blocked_reason: null`。
- `secrets rows: 0`；`requests: 1`，`urls: [ '/v1/chat/completions' ]`，`auth: [ null ]`（本机服务，不带 key）。
- `leaks: []`：请求里没有 ticket 号、仓库名、分支名和原文。
- 日志里没有错误（打印 `no errors logged`）。

任何一项不符合：先看 `$T/logs/main.log` 里 `narrative` 开头的行，按 superpowers:systematic-debugging 排查，不要改检查条件。

- [ ] **Step 3: 更新遗留清单**

在 `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md` 末尾（任务 1 追加的 “# Plan 3 follow-ups” 之下）追加：

```markdown
## Resolved in plan 3
- Plan 2 parked: `--setting-sources user` vs project / local MCP — live check in a real git repo cwd (Task 1, Ruling P3-R1); opt-in `headlessProjectMcp` via `--mcp-config` or hint-only, per the ruling (Task 5)
- Plan 2 parked: REQUIRED_FLAGS lacks --setting-sources → added, older claude gets a health warning (Task 1)
- Plan 2 parked: manual runMorningNow queued behind a scheduled catch-up runs again → skipped when the job already ran after the click (Task 2; now matters because each morning brief may cost personal API money)
- Plan 2 Task 1 minor: git() lacks LC_ALL=C; summary not length-capped (Task 3)
- Plan 2 Task 4 minor: HANDOFF_BLOCK_RE accepts butler-handoffX; empty last block shadows an earlier valid one (Task 3)
- Plan 2 Task 5 minor: normalizeSetting has no default case; parseContent does not normalise partial notices (Task 2)
- Plan 2 Task 7 minor: rate-limit regex matches a stray 429 in stderr; "0 秒" timeout message; live skipIf treats "0" as enabled (Task 3)
- Plan 2 Task 12 minor: nightly run crossing local midnight treated as a catch-up (Task 2)
- Plan 2 Task 13 minor: job failures reply ok to the renderer (IPC now returns the job state); relative BUTLER_HOME crashes; no-ticket /handoff captures dropped silently (now logged) (Tasks 2, 4)
- Plan 2 Task 14 minor: tab switch flashes the other kind / stale load overwrite; openRequest may pick a dismissed session; pendingOpen left dangling for a missing ticket; "；" literal (Task 4)
- Plan 2 Task 15 minor: no nightly feedback; working-day toggle stale base; settings stuck on 加载中; tracker textarea no blur-save (Task 4)
- Plan 1 Task 11 minor: error banner behind the NewTicketDialog modal; settings no retry (Task 4)
- Plan 1 Task 12 minor: discovery runs not overlap-guarded (Task 4)

## Still open after plan 3
- Windows and packaging items from both lists (rename EPERM/EBUSY, hook shell, killTree orphan gap, cmd.exe quoting with --mcp-config, notification AUMID, SEA size and build Node, CI) → plan 4
- Renderer CSP (plan 4, with the packaged build); personal API requests use Node's fetch, which ignores the system proxy → revisit in plan 4 if users need a proxy
- StateCore wiring must build its env with `statecoreEnv()` (src/main/gateway/statecore-env.ts) → plan 4
- Low-impact minors not taken (tombstones in memory, INSERT OR IGNORE hiding CHECK violations, ROLLBACK TO masking the original error, dangling symlinks, mid-turn isMeta capture miss, server-name skip false negative, unclaimed item key changes daily, 30-minute DST test, grapheme clusters at the prefill limit) → revisit with E2E in plan 4
- Nested `claude --resume/-c` re-links (accepted per plan 1 F2)
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md
git commit -m "docs: record plan 2 follow-ups resolved by plan 3 and what stays open"
```

---

## 手动验证

由用户在合并后、用真实的 Butler 和自己的个人 API key 执行（自动化测试和执行者都没有调用过真实服务商）。准备：任何 OpenAI 兼容服务的 key（DeepSeek、OpenRouter 等），或本机的 Ollama。任何一项不符合就停下来，按 superpowers:systematic-debugging 排查。

1. **默认状态**：设置页“隐私与个人 API”：档位是“仅元数据（默认）”，顶部提示“还没有配置完”；简报页没有“今日重点”；侧栏“审计”页显示“还没有调用记录”。
2. **保存 key**：填服务地址、模型，粘贴 key 点“保存” → 输入框清空，显示 `••••` + 末 4 位；重启 Butler 后仍然是打码形式。`strings ~/.butler/app.db | grep -c "<key 的前 8 位>"` 输出 0；`grep -c "<key 的前 8 位>" ~/.butler/logs/main.log` 输出 0。
3. **价格表**：按你的服务商改价格表（例如 `deepseek-chat 0.27 1.1`）；把模型名改成表里没有、也不匹配 `*` 的名字时（先删掉 `* 15 75` 那行），顶部提示“不会调用”。改回。
4. **仅元数据**：简报页点“重新生成” → 顶部短暂显示“正在生成今日重点…”，随后出现 2–4 条；审计页最新一条“已发送”，展开“发出的内容”：只有 `[[T_xxxx]]` 这类占位符和状态、天数，没有任何 ticket 号、仓库名、人名或原文；token 和费用有值，“本月已花”增加。
5. **每次随机**：再点一次“重新生成” → 审计里两次请求中，同一个 ticket 的占位符不一样。
6. **脱敏文本 + 敏感词**：把一位同事的名字加进“人名”并保存；让某个 ticket 的下一步提到他（例如在那个 session 里 `/handoff`）；档位切到“脱敏文本”，重新生成 → 审计请求里出现 next_steps，但名字、ticket 号、仓库名都是占位符；简报里的“今日重点”显示真名。
7. **拦截**：让某个 ticket 的下一步里出现一个网址（例如 `/handoff` 时让它写上“看 https://wiki.example.com/x”），在“脱敏文本”档位重新生成 → 简报显示“今日重点没有发送：出站内容里有敏感信息”；审计一条“已拦截”，只有规则名和打码样本，“发出的内容”为“（没有发出任何内容）”；服务商后台的用量记录里没有这次请求。
8. **预算**：预算改成 `0.0001` → 重新生成 → 简报显示“本月预算已用完…”；审计一条“超预算”，没有请求内容。改回。
9. **发送前确认**：勾选“每次发送前弹窗确认” → 重新生成 → 弹窗显示完整的出站内容（地址、模型、每条消息）；点“不发送” → 没有今日重点，审计一条“已拒绝”；再试一次点“发送” → 正常生成。取消勾选。
10. **关闭**：档位选“关闭” → 重新生成 → 没有今日重点，审计没有新记录，简报其余部分照常。
11. **清除 key**：点“清除” → 显示“未保存”，顶部提示“还没有配置完”。
12. **完整档位**：选“完整” → 顶部出现风险提示；重新生成后审计里能看到真实 ticket 号（这是预期行为），但第 7 项的网址照样被拦截。测完改回“仅元数据”。
13. **能力检查**：设置页“缺少的参数”一项不出现（当前 claude 支持 `--setting-sources`）。
14. **项目级 MCP（只有任务 5 走路线 A 时）**：tracker 配在仓库 `.mcp.json` 时，打开“后台 handoff 也加载仓库 .mcp.json…”开关 → “从 Claude Code 检测”能列出那些工具；“立即 handoff”成功且 Jira 信息有值。
15. **小修**：简报“早间 / 晚间”来回切换不闪出另一边的内容；从简报“打开”不会恢复已忽略的 session；“立即运行晚间 handoff”结束后显示“已完成。”或补跑提示；快速连点两个工作日复选框，两个都生效；打开“新建 ticket”对话框时触发一个错误，错误条显示在遮罩上面。
16. **Windows（如有条件）**：保存 key（DPAPI）后重启仍能使用；第 4 项照样成功。
17. **代理环境（如有）**：如果你的网络需要代理才能访问服务商，个人 API 请求会失败（Butler 用 Node 的 fetch，不走系统代理）→ 简报显示“今日重点生成失败”，审计里有网络错误，其他功能照常。

---

## 附录：与设计文档的差异（本计划有意为之）

1. `llm_audit` 多了 `status`（pending / sent / failed / blocked / budget / declined）和 `error` 两列。被拦截和超预算的行不存请求体：它们没有发出任何东西，被拦下的内容（可能正是一段密钥）也不应该落盘；拦截原因只记规则名和打码样本。
2. 加密后的 key 存在新表 `secrets` 里（设计文档只说用 `safeStorage` 加密，没说放在哪）。
3. 人名来自敏感词表的“人名”类：handoff schema 里没有人名字段（设计文档 7.4 说的“来自 PR 和 tracker 字段”目前无从获取）。另外把 PR 链接里的 owner / 仓库名加进假名化字典。
4. `full` 档位的扫描跳过“未替换的 ticket 号”和“未替换的原值”两条规则（这一档本来就发真实值），其余规则照样生效。
5. 模型在价格表里找不到价格时不调用，`narrative_status` 记为 `budget`。默认价格表 `* 15 75` 故意按很贵的价格算，用户按自己的服务商改。
6. 预算检查在敏感信息扫描之前：设计文档 7.6 说超出预算后“视为 off”，那就连管道都不跑。
7. 用户拒绝发送前确认时 `narrative_status` 记为 `off`（设计文档的状态枚举里没有“拒绝”），审计里是 `declined`；确认对话框出错、超时以外的异常或 app 正在退出记为 `failed`。确认对话框最多等 5 分钟，超时视为拒绝。
8. “今日重点”只用于早间简报。简报先入库，“今日重点”之后再写回同一行，简报从不等待个人 API。
9. 模型的回答约定为 JSON `{"focus": [...]}` 并用 zod 校验（设计文档 7.2 的“schema 校验”）；还原时按句检查，含未知或被改坏的占位符的句子整句丢弃。
10. 服务商只接受 `https://`（本机地址可以 `http://`）；请求不跟随重定向；`max_tokens` 被拒时换成 `max_completion_tokens` 重试一次。用 Node 自带的 `fetch`，不走系统代理。
11. 8.5 节的约束在本计划里只做成 `statecoreEnv()` 和它的测试，StateCore 的接线在计划 4。
12. 计划 2 遗留的 MCP 来源问题（任务 1 / 5）：如果需要找回项目级 / 本地级 MCP，用 `--mcp-config` 显式挂载，而不是把 `project` / `local` 加回 `--setting-sources`，那样会把仓库里的 allow 规则和 hook 也带进无人值守的后台运行。
13. 少于 2 个字符的值不进假名化字典，敏感词也至少两个字。
14. 设置页没有“测试连接”按钮：第一次“重新生成”和审计页已经能看到结果。
