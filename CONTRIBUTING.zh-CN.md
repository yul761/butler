# 参与 Shipherd 开发

[English](CONTRIBUTING.md) | **简体中文**

感谢你来帮忙。Shipherd 是一个个人效率工具，经手的是别人的工作数据。下面有几条规则没有商量余地：隐私、Shipherd 自己不写联网代码、测试里不许调用真实的 `claude` 或 LLM。

## 工具链

- **Node.js。** 用 `.node-version` 里的版本（26.3.0）。`pnpm build:hook` 需要它：它用 `node --build-sea` 把 `shipherd-hook` 构建成 Node 单文件可执行程序，在没有这个参数的 Node 上会直接拒绝运行。测试和其余的构建需要 Node 22.13 或更新（为了 `node:sqlite`）。用 nvm 的话，运行 `nvm install 26.3.0 && nvm use 26.3.0`。nvm 不读 `.node-version`，fnm 会读（`fnm use`）。
- **pnpm。** 安装 pnpm 9.15.0，和 CI 用的版本一致（例如 `npm i -g pnpm@9.15.0`）。
- **C++ 工具链。** `pnpm install` 会为 Electron 重新编译原生模块 `node-pty`。
  - macOS：Xcode Command Line Tools（`xcode-select --install`）。
  - Windows：Visual Studio Build Tools，装上 "Desktop development with C++" 工作负载，再装 Python 3。
- **Git。** Windows 上需要 **Git for Windows**，它自带 Git Bash。Claude Code 通过 Git Bash 运行 hook，E2E 测试也通过它运行装好的 hook 命令；`PATH` 上没有 `git.exe` 时，Shipherd 根本不会运行 git。

## 准备环境

```sh
pnpm install          # 同时为 Electron 重新编译 node-pty
pnpm exec install-electron   # 下载 Electron 程序（Electron 44 没有 postinstall；记忆 MCP 的测试要在它下面跑）
pnpm build:hook       # 构建 build/hook/shipherd-hook（安装 hook 时需要）
pnpm dev              # 以热重载方式运行 Shipherd（也会构建 StateCore MCP 程序包）
```

开发时用临时的数据文件夹，这样永远不会碰到你真实的 `~/.shipherd` 或 `~/.claude`：

```sh
SHIPHERD_HOME=/tmp/shipherd-dev CLAUDE_CONFIG_DIR=/tmp/claude-dev pnpm dev
```

用全新的 `CLAUDE_CONFIG_DIR` 时，可能需要在那个文件夹下登录一次 `claude`。设置了 `SHIPHERD_HOME` 时，Shipherd 也会把 Electron 自己的配置文件夹放在 `$SHIPHERD_HOME/electron`，所以开发实例不会和装好的 Shipherd 冲突。

## 脚本

| 脚本 | 作用 |
|------|------|
| `pnpm typecheck` | 对 main、preload、shared、hook、记忆 MCP、E2E 和 renderer 做 TypeScript 检查 |
| `pnpm lint` | ESLint，包括联网规则 |
| `pnpm test` | Vitest 单元测试和集成测试（Node 22.13 或更新） |
| `pnpm build` | main、preload、renderer，以及 StateCore MCP 程序包 |
| `pnpm build:hook` | 当前平台的 `shipherd-hook` 可执行文件（需要 `.node-version` 里的 Node） |
| `pnpm e2e` | 先运行 `pnpm build` 和 `pnpm build:hook`，再跑 Playwright-for-Electron 测试 |
| `pnpm e2e:only` | 同样的测试，但不重新构建 |
| `pnpm demo:record` | 把 README 的动图和截图录到 `docs/media/`（macOS 或 Linux，需要 `ffmpeg`；见[录制演示素材](docs/demo-media.zh-CN.md)）。不进 CI |
| `pnpm dist` | 把安装包输出到 `dist/`（macOS：没有 `CSC_LINK` 或 `CSC_NAME` 时 ad-hoc 签名；Windows：不签名），只限当前平台（macOS：arm64 的 dmg 和 zip；Windows：x64 NSIS）。它只打包已经构建好的东西，所以先运行 `pnpm build && pnpm build:hook`。 |

E2E 测试是沙箱化的。每个测试都有自己的临时 `SHIPHERD_HOME`、`CLAUDE_CONFIG_DIR`、home 文件夹和临时文件夹，用的是假的 `claude`（`e2e/fake-claude`）。它们从不运行真实的 `claude`，也不读你的真实数据。

## CI 和发布

- `.github/workflows/ci.yml` 在 pull request 和推到 `main` 时，在 macOS 和 Windows 上跑 typecheck、lint、单元测试、build、`build:hook` 和 E2E 测试。推到 `main` 时还会构建安装包（macOS ad-hoc 签名，Windows 不签名），并检查打出来的 macOS app 能启动。
- `.github/workflows/release.yml` 在 `v*` tag 上运行。tag 必须和 `package.json` 里的 `version` 一致，例如 `1.0.0` 对应 `v1.0.0`。这个 workflow 会构建两个平台，并创建一个**草稿** GitHub release。维护者检查草稿后手动发布。
- 不会自动推送或发布任何东西。分支和 tag 由维护者推送。

### 给维护者的说明

- **第一次发布之后不要改 `APP_ID`（`io.statecore.shipherd`）。** 它在 `src/main/app-id.ts` 里，必须和 `electron-builder.yml` 里的 `appId` 相同，有测试会检查。Windows 把它当作通知、开始菜单快捷方式和开机自启用的 AppUserModelID。
- **图标是生成出来的。** SVG 源文件在 `build-resources/icon-src/`；`pnpm icons` 会生成 `build-resources/icon.png`（macOS）、多尺寸的 `build-resources/icon.ico`（Windows；32 px 及以下用简化的托盘图案）和 `src/main/tray-icons.ts`。生成的文件要提交。有测试会检查每个图标的背景和深色、浅色任务栏都有足够的对比度。不要把打包资源放进 `build/`：那里放的是 hook 和记忆 MCP 的构建产物。
- 签名（BTL-258、BTL-259）：有五个签名 secret 时，`release.yml` 用 Developer ID 给 macOS 安装包签名、公证并 staple。这些 secret 放在受保护的环境 `release` 里，只有 `main` 和 `v*` tag 能用，其他分支上的运行 macOS 走 ad-hoc；见[给 fork 的 macOS 安装包签名](docs/how-it-works.zh-CN.md#给-fork-的-macos-安装包签名)。没有时，macOS 安装包在 `scripts/after-pack.cjs` 里做 ad-hoc 签名（完全不签名的 arm64 app 启动不了）；走哪一种由 `scripts/mac-signing.cjs` 决定，不会两种都做。Windows 不签名。README 里说明了 Windows 用户怎么绕过 SmartScreen。

## 架构概览

- `src/main` 是 Electron 主进程：node-pty 里的 session、hook 收件箱、handoff 运行器、调度器、简报引擎、StateCore 记忆和设置。
- **没有联网代码。** Shipherd 没有自己的 LLM API（PrivacyGateway 已经在 BTL-243 去掉了）。`eslint.config.mjs` 里的出网规则对每个源文件都生效，只有三个应用文件各自放开它要的那一小块：`src/main/notify/webhook.ts`（Electron 的 `net`，发通知 webhook）、`memory-mcp/loopback-http.ts`（只有 `createServer`，共享 MCP 在 127.0.0.1 上的监听）和只给测试用的 `src/main/testing/loopback-recorder.ts`（`createServer` 和 `request`，只在 127.0.0.1 上；非测试文件不能 import `src/main/testing/` 下的任何东西）。E2E 用的假 `claude`（`e2e/fake-claude/fake-claude.cjs`）也留着 `node:http`，用来调共享 MCP，它不进安装包。`src/main/egress-lint.test.ts` 证明这些规则能抓到违规，包括这三个文件里的其他用法。
- `src/main/memory/statecore.ts`（主进程）和 `memory-mcp/entry.ts`（Claude Code 启动的 MCP server）和 `memory-mcp/hub-entry.ts`（共享 MCP 的 hub）是仅有的几处可以 import StateCore 的地方。StateCore 的进程永远拿不到模型 key：`statecoreEnv()` 会去掉模型相关的环境变量，`memory-mcp` 启动时会再清一遍，每个后端都以 `backgroundDigest: false` 运行。没有任何东西蒸馏记忆，`remember(consolidate: true)` 一直是事件。`memory-mcp/memory-tools.ts` 一字不差地留着 statecore-mcp 的工具说明，外加一份有名字的改动清单，`memory-mcp/hub-contract.test.ts` 拿真的 statecore-mcp 把两者都核对一遍。
- `src/renderer` 是 React 界面。它不能访问 Node，通过 `src/shared/ipc.ts` 里有类型的 IPC 白名单和主进程通信。
- `hook/` 是 Claude Code 运行的小程序 `shipherd-hook`。它必须总是以 0 退出，并且从不联网。

设计文档在 `docs/superpowers/specs/`，实现计划在 `docs/superpowers/plans/`。

## 规则

- **不许新加联网代码。** "就快速 fetch 一下"也不行。数据只经由用户的 `claude`、经 `gh` 做的对外动作（每种都有自己的开关，都记审计）和通知 webhook 离开电脑。
- **通知说得越少越好。** 默认一条 webhook 消息只说事件类型和数量；问题原文、评论原文、路径和仓库名从不发出去；`src/main/notify/notifier.test.ts` 检查连 ticket 号也只在打开 **带上编号** 时才出现。
- **测试从不调用真实的 LLM 服务商或真实的 `claude`，也从不读写真实的 `~/.shipherd` 或 `~/.claude`。** 用本机回环记录器（`src/main/testing/loopback-recorder.ts`）证明什么都没发出去，用假 `claude` 的辅助工具（`src/main/test-utils.ts`、`e2e/fake-claude`）和临时文件夹。
- **永远不要通过代码或测试改用户的 Claude Code 配置**，用户亲手点的 hook 安装除外。也就是说，不许 `claude mcp add`，不许 `claude config set`，诸如此类。记忆 MCP server 通过 `--mcp-config` 按 session 传入。
- **数据库迁移只能追加**（`src/main/db/migrations.ts`）。
- **新行为在用户打开之前都是关着的。**什么设置都不改的用户，看到的应该和上一个版本一样。往 GitHub 或别的外部服务写东西的，一律经过 `ExternalActions.attempt`（`src/main/external/actions.ts`），有自己的 `external*` 开关，默认关；每次尝试都记进审计日志。`src/main/db/settings-defaults-3.test.ts` 和 `e2e/defaults.spec.ts` 会检查。唯一的例外是 **检查更新**（`updateCheckEnabled`，默认开）：每天经用户自己的 `gh` 读一次 Shipherd 的最新 release，哪里都不写，没有 `gh` 就静默跳过，每次查询都记进审计日志；同一个测试钉住了它。
- **给用户看的文案**放在 `src/renderer/src/strings.ts`（中文界面）、`src/renderer/src/strings-en.ts`（英文界面）和 `src/main/strings.ts`（主进程，两种语言都在里面）。每条新文案都要两种语言都加上。
- **文档成对出现。** `README.md`、`CONTRIBUTING.md`、`docs/configuration.md`、`docs/how-it-works.md` 和 `docs/compare.md` 是英文的，每份都有一份文件名以 `.zh-CN.md` 结尾的中文版。在同一个 pull request 里两份一起改，并保持标题顺序一致。英文文档引用英文界面的标签，中文文档引用中文界面的标签，和文案表里写的完全一致。
- 依赖的版本要精确锁定。

## Pull request

保持聚焦，带上测试。`pnpm typecheck && pnpm lint && pnpm test` 必须通过。改到界面、IPC、session 或 hook 时，再跑一遍 `pnpm e2e`。
