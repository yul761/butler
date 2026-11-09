# 参与 Butler 开发

[English](CONTRIBUTING.md) | **简体中文**

感谢你来帮忙。Butler 是一个个人效率工具，经手的是别人的工作数据。下面有几条规则没有商量余地：隐私、网关之外不许联网、测试里不许调用真实的 `claude` 或 LLM。

## 工具链

- **Node.js。** 用 `.node-version` 里的版本（26.3.0）。`pnpm build:hook` 需要它：它用 `node --build-sea` 把 `butler-hook` 构建成 Node 单文件可执行程序，在没有这个参数的 Node 上会直接拒绝运行。测试和其余的构建需要 Node 22.13 或更新（为了 `node:sqlite`）。用 nvm 的话，运行 `nvm install 26.3.0 && nvm use 26.3.0`。nvm 不读 `.node-version`，fnm 会读（`fnm use`）。
- **pnpm。** 安装 pnpm 9.15.0，和 CI 用的版本一致（例如 `npm i -g pnpm@9.15.0`）。
- **C++ 工具链。** `pnpm install` 会为 Electron 重新编译原生模块 `node-pty`。
  - macOS：Xcode Command Line Tools（`xcode-select --install`）。
  - Windows：Visual Studio Build Tools，装上 "Desktop development with C++" 工作负载，再装 Python 3。
- **Git。** Windows 上需要 **Git for Windows**，它自带 Git Bash。Claude Code 通过 Git Bash 运行 hook，E2E 测试也通过它运行装好的 hook 命令；`PATH` 上没有 `git.exe` 时，Butler 根本不会运行 git。

## 准备环境

```sh
pnpm install          # 同时为 Electron 重新编译 node-pty
pnpm build:hook       # 构建 build/hook/butler-hook（安装 hook 时需要）
pnpm dev              # 以热重载方式运行 Butler（也会构建 StateCore MCP 程序包）
```

开发时用临时的数据文件夹，这样永远不会碰到你真实的 `~/.butler` 或 `~/.claude`：

```sh
BUTLER_HOME=/tmp/butler-dev CLAUDE_CONFIG_DIR=/tmp/claude-dev pnpm dev
```

用全新的 `CLAUDE_CONFIG_DIR` 时，可能需要在那个文件夹下登录一次 `claude`。设置了 `BUTLER_HOME` 时，Butler 也会把 Electron 自己的配置文件夹放在 `$BUTLER_HOME/electron`，所以开发实例不会和装好的 Butler 冲突。

## 脚本

| 脚本 | 作用 |
|------|------|
| `pnpm typecheck` | 对 main、preload、shared、hook、记忆 MCP、E2E 和 renderer 做 TypeScript 检查 |
| `pnpm lint` | ESLint，包括联网规则 |
| `pnpm test` | Vitest 单元测试和集成测试（Node 22.13 或更新） |
| `pnpm build` | main、preload、renderer，以及 StateCore MCP 程序包 |
| `pnpm build:hook` | 当前平台的 `butler-hook` 可执行文件（需要 `.node-version` 里的 Node） |
| `pnpm e2e` | 先运行 `pnpm build` 和 `pnpm build:hook`，再跑 Playwright-for-Electron 测试 |
| `pnpm e2e:only` | 同样的测试，但不重新构建 |
| `pnpm dist` | 把未签名的安装包输出到 `dist/`，只限当前平台（macOS：arm64 的 dmg 和 zip；Windows：x64 NSIS）。它只打包已经构建好的东西，所以先运行 `pnpm build && pnpm build:hook`。 |

E2E 测试是沙箱化的。每个测试都有自己的临时 `BUTLER_HOME`、`CLAUDE_CONFIG_DIR`、home 文件夹和临时文件夹，用的是假的 `claude`（`e2e/fake-claude`）。它们从不运行真实的 `claude`，也不读你的真实数据。

## CI 和发布

- `.github/workflows/ci.yml` 在 pull request 和推到 `main` 时，在 macOS 和 Windows 上跑 typecheck、lint、单元测试、build、`build:hook` 和 E2E 测试。推到 `main` 时还会构建未签名的安装包。
- `.github/workflows/release.yml` 在 `v*` tag 上运行。tag 必须和 `package.json` 里的 `version` 一致，例如 `1.0.0` 对应 `v1.0.0`。这个 workflow 会构建两个平台，并创建一个**草稿** GitHub release。维护者检查草稿后手动发布。
- 不会自动推送或发布任何东西。分支和 tag 由维护者推送。

### 给维护者的说明

- **第一次发布之后不要改 `APP_ID`（`io.statecore.butler`）。** 它在 `src/main/app-id.ts` 里，必须和 `electron-builder.yml` 里的 `appId` 相同，有测试会检查。Windows 把它当作通知、开始菜单快捷方式和开机自启用的 AppUserModelID。
- **图标是生成出来的。** SVG 源文件在 `build-resources/icon-src/`；`pnpm icons` 会生成 `build-resources/icon.png`（macOS）、多尺寸的 `build-resources/icon.ico`（Windows；32 px 及以下用简化的托盘图案）和 `src/main/tray-icons.ts`。生成的文件要提交。有测试会检查每个图标的背景和深色、浅色任务栏都有足够的对比度。不要把打包资源放进 `build/`：那里放的是 hook 和记忆 MCP 的构建产物。
- 构建是未签名的。macOS 安装包在 `scripts/after-pack.cjs` 里做 ad-hoc 签名（完全不签名的 arm64 app 启动不了）。README 里说明了用户怎么绕过 Gatekeeper 和 SmartScreen。

## 架构概览

- `src/main` 是 Electron 主进程：node-pty 里的 session、hook 收件箱、handoff 运行器、调度器、简报引擎、StateCore 记忆和设置。
- `src/main/gateway` 是 **PrivacyGateway**，唯一允许发网络请求的代码（调用个人 LLM API）。ESLint 在 `eslint.config.mjs` 里强制这一点，`src/main/egress-lint.test.ts` 证明这些规则能抓到违规。
- `src/main/memory/statecore.ts`（主进程）和 `memory-mcp/entry.ts`（Claude Code 启动的 MCP server）是仅有的两处可以 import StateCore 的地方。StateCore 的进程永远拿不到模型 key：`statecoreEnv()` 会去掉模型相关的环境变量，`memory-mcp` 启动时会再清一遍。蒸馏只在主进程里通过 `PrivacyGateway.statecoreModel()` 运行，它会给每次调用记审计、算预算。
- `src/renderer` 是 React 界面。它不能访问 Node，通过 `src/shared/ipc.ts` 里有类型的 IPC 白名单和主进程通信。
- `hook/` 是 Claude Code 运行的小程序 `butler-hook`。它必须总是以 0 退出，并且从不联网。

设计文档在 `docs/superpowers/specs/`，实现计划在 `docs/superpowers/plans/`。

## 规则

- **`src/main/gateway` 之外不许联网。** "就快速 fetch 一下"也不行。
- **隐私不变量测试是发布的阻断项**（`src/main/gateway/privacy-invariant.test.ts`）。随机生成的 ticket 号、仓库名、人名和术语绝不能出现在发出去的内容里。
- **测试从不调用真实的 LLM 服务商或真实的 `claude`，也从不读写真实的 `~/.butler` 或 `~/.claude`。** 用进程内的假服务商（`src/main/gateway/testing.ts`）、假 `claude` 的辅助工具（`src/main/test-utils.ts`、`e2e/fake-claude`）和临时文件夹。
- **永远不要通过代码或测试改用户的 Claude Code 配置**，用户亲手点的 hook 安装除外。也就是说，不许 `claude mcp add`，不许 `claude config set`，诸如此类。记忆 MCP server 通过 `--mcp-config` 按 session 传入。
- **数据库迁移只能追加**（`src/main/db/migrations.ts`）。
- **给用户看的文案**放在 `src/renderer/src/strings.ts`（中文界面）、`src/renderer/src/strings-en.ts`（英文界面）和 `src/main/strings.ts`（主进程，两种语言都在里面）。每条新文案都要两种语言都加上。
- **文档成对出现。** `README.md`、`CONTRIBUTING.md` 和 `docs/configuration.md` 是英文的，每份都有一份文件名以 `.zh-CN.md` 结尾的中文版。在同一个 pull request 里两份一起改，并保持标题顺序一致。英文文档引用英文界面的标签，中文文档引用中文界面的标签，和文案表里写的完全一致。
- 依赖的版本要精确锁定。

## Pull request

保持聚焦，带上测试。`pnpm typecheck && pnpm lint && pnpm test` 必须通过。改到界面、IPC、session 或 hook 时，再跑一遍 `pnpm e2e`。
