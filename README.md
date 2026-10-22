# Butler

A desktop "work butler" for people who run several [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions at once, one per ticket.
macOS (Apple silicon) and Windows (x64). MIT licensed. Your data stays on your machine.

> 中文简介：Butler 用一个桌面应用管理“每个 ticket 一个 Claude Code session”的工作方式：每晚自动为有进展的 ticket 生成交接（handoff），早上一打开就是简报，点一下就回到对应的 session；记忆由本地的 StateCore 管理。界面是中文的。

The UI is in Chinese. This README quotes UI labels as they appear in the app, with an English gloss, for example **设置 (Settings)**.

## What it does

- **Tickets first.** Each ticket has its worktree or branch, its Claude Code sessions (embedded terminals), its PR state and its after-merge follow-ups. Sessions you started outside Butler in the last 7 days show up under **未认领 session (unclaimed sessions)** so you can attach them to a ticket.
- **Nightly handoffs.** At a time you choose, Butler asks your own logged-in `claude` to write a structured handoff for every ticket that had activity. These runs are read-only: file reads, `gh pr view` / `gh pr checks`, `git log` / `git status` and the tracker MCP tools you picked. Inside a session you can also type `/handoff`.
- **Morning brief.** **🔴 先做 (do first)** lists approved PRs, requested changes, after-merge follow-ups and due items. **🟡 今天 (today)** and **⚪ 留意 (watch)** follow, then what you did on the previous working day. **打开 (Open)** resumes the right session with a prompt already typed in.
- **Memory.** Progress, decisions, open follow-ups and cross-ticket learnings go into a local [StateCore](https://github.com/yul761/StateCore) store. Every session Butler starts can `recall` them. The ticket page has a **记忆 (Memory)** tab that shows each entry's history.
- **Optional personal LLM summary.** **今日重点 (today's focus)** is a short paragraph from an OpenAI-compatible API that you pay for. It goes through a privacy gateway with field allow-listing, per-request pseudonyms, a scanner that refuses to send anything that looks like a secret, URL, host, IP, email or file path, an audit page with the exact bytes sent, a monthly budget and optional confirm-before-send. Nothing is sent until you configure a provider. The default level sends metadata only. (Memory distillation at the full level is not scanned; see [StateCore memory](#statecore-memory).)

## What Butler does not touch

- **Your Claude Code configuration.** Butler changes it only when you click the hook install, either in the first-run wizard or with **设置 → 环境检查 → 安装 / 修复 (Settings → Environment check → Install / repair)**. That adds four hooks to your user-level `settings.json` and a `/handoff` command. Your other hooks and commands are kept. Memory is never registered with `claude mcp add`. Instead, Butler passes `--mcp-config` on the command line of each session it starts.
- **Your tracker and code host.** Butler has no Jira, GitHub or Claude login of its own. Jira (or Linear, GitLab, …) is read only by your company's Claude Code through its own MCP servers. PRs are read by `claude` with your `gh`.
- **The network.** The only network code in Butler is the privacy gateway for the optional personal API. A lint rule enforces this.

## Requirements

- macOS on Apple silicon, or Windows 10/11 x64. Intel Macs can [build from source](CONTRIBUTING.md).
- Claude Code installed and logged in. `claude --version` must work in a terminal.
- Git on `PATH`. On Windows, install **Git for Windows**: Claude Code runs hooks through Git Bash, and Butler won't run git at all if it can't find `git.exe` on `PATH`.
- Optional: a tracker MCP server (Jira, Linear, GitLab, …) set up in Claude Code, so handoffs can read ticket status.

## Install

Download the latest release from this repository's Releases page:

- macOS: `Butler-x.y.z-arm64.dmg` (or the `-mac.zip`)
- Windows: `Butler Setup x.y.z.exe`

Each installer is about 175 MB. Most of that is `butler-hook`, the program Claude Code runs for each hook. It is a Node single executable (SEA) with Node 26.3.0 built in, about 143 MB on its own. Installing the hooks copies it to `~/.butler/bin`.

The builds are **not code-signed**, so your OS will warn you the first time.

### macOS (Gatekeeper)

The app is ad-hoc signed but not notarized, and macOS builds are arm64 only.

1. Open the `.dmg` and drag Butler into Applications.
2. Open Butler. macOS refuses: it says Apple cannot verify the app, or that the developer cannot be verified.
3. Allow it in one of these ways:
   - **System Settings → Privacy & Security**, scroll down to the message about Butler, click **Open Anyway** and confirm.
   - On macOS 14 and earlier, you can instead right-click (Control-click) Butler in Applications, choose **Open**, then **Open** again.
   - Or remove the quarantine flag in Terminal:

     ```sh
     xattr -dr com.apple.quarantine /Applications/Butler.app
     ```

Repeat this after every new download.

### Windows (SmartScreen)

The NSIS installer is unsigned.

1. Run `Butler Setup x.y.z.exe`.
2. SmartScreen says "Windows protected your PC". Click **More info → Run anyway**.
3. Pick "only for me" (no admin rights needed) and an install folder.

There is no auto-update. To upgrade, download the new version and install it over the old one. Your data in `~/.butler` is kept.

## First run

A short wizard, **欢迎使用 Butler (Welcome to Butler)**, walks you through these steps:

1. **检查 Claude Code (Check Claude Code).** Butler finds `claude` on your login shell's `PATH`, or you give it the absolute path. It also checks that `claude --help` lists the flags Butler relies on. You can't continue without a working `claude`.
2. **安装 hook 和 /handoff 命令 (Install hooks and the /handoff command).** Butler merges four hooks (`SessionStart`, `Stop`, `UserPromptSubmit`, `SessionEnd`) into your user-level Claude Code `settings.json`, keeping your existing hooks. The first time, it saves a copy of the file as `settings.json.butler-backup`. It also writes `commands/handoff.md`. The hooks only drop small JSON files into `~/.butler/inbox`. They never touch the network and always exit 0. To remove them, use **设置 → 环境检查 → 卸载 (Settings → Environment check → Uninstall)**.
3. **tracker 的 MCP 工具 (Tracker MCP tools).** Butler lists the MCP tools your Claude Code exposes, and you pick the read-only ones handoffs may call.
4. **隐私档位与个人 API (Privacy level and personal API).** Optional.

You can run the wizard again from Settings. [docs/configuration.md](docs/configuration.md) covers every setting, including how to adapt Butler to another company's tracker and conventions.

## Where your data lives

| Path | What |
|------|------|
| `~/.butler/app.db` | Tickets, sessions, handoffs, follow-ups, briefs, settings, the sensitive-terms list, the LLM audit log, and the encrypted API key (SQLite) |
| `~/.butler/statecore/statecore.db` | StateCore memory |
| `~/.butler/inbox/` | Hook reports waiting to be processed (`inbox/bad/` keeps unreadable ones) |
| `~/.butler/bin/butler-hook` | The hook program Claude Code runs (`butler-hook.exe` on Windows) |
| `~/.butler/mcp/tickets/<ticket>.json` | The memory `--mcp-config` file, rewritten each time a session for that ticket is opened |
| `~/.butler/mcp/project-*.json`, `local-*.json` | Copies of your MCP server entries for unattended runs, written only when **后台 handoff 也加载本地级的 MCP…** (`headlessProjectMcp`) is on (private files: they can contain tokens) |
| `~/.butler/logs/main.log` | Logs |

On Windows `~` is `%USERPROFILE%`. Set `BUTLER_HOME` to use another folder. Butler also honours `CLAUDE_CONFIG_DIR` for the Claude Code configuration it reads and the hooks it installs.

Apart from the hook install, Butler only reads Claude Code's files: `settings.json` (hook status, plugin check), `~/.claude.json` (your MCP servers) and the session transcripts under `~/.claude/projects` (unclaimed sessions, handoffs).

Your personal API key is encrypted with the OS keychain (macOS Keychain / Windows DPAPI). After you save it, the UI only ever shows the last 4 characters.

## StateCore memory

Butler embeds StateCore. Each session Butler starts gets two keyless MCP servers. `butler-memory` holds this ticket's memory and `butler-workspace` holds learnings shared across tickets.

**Do not also install StateCore's own Claude Code capture plugin.** Butler already provides StateCore memory in the sessions it starts, and with both installed memory is recorded twice. Settings warns you if it finds the plugin.

- **No model key reaches StateCore.** The memory servers that Claude Code starts get no model API key: Butler strips model variables from their environment. Butler's own writes (handoffs, decisions, follow-ups, learnings) are deterministic and need no model.
- **Distillation at 完整 (full) only.** When the privacy level is **完整 (full)** and confirm-before-send is off, Butler distils the raw notes Claude saved with `consolidate: true`. This runs in the background once a night, after the nightly handoffs, using your personal API. **These raw events are sent without the sensitive-info scan.** The scan covers only the 今日重点 (today's focus) path. Each distillation call is still recorded on the audit page as **StateCore 记忆蒸馏 (StateCore distillation)** and counts against your monthly budget.
- **Memory fills up.** StateCore keeps at most 30 notes per scope (one scope per ticket), and forgotten notes keep their slots. Butler never evicts its own entries to make room, so a long-lived ticket stops gaining new entries once its 30 slots are used, even at the full level. Nightly distillation skips ticket scopes with fewer than 6 free slots. See [docs/configuration.md](docs/configuration.md#how-memory-works).

## Privacy model in one paragraph

Company work goes only through your company's `claude`. By default, your personal API sees placeholders, status enums, counts and day numbers. It sees no ticket ids, repo names, people or code. The **脱敏文本 (redacted)** level adds short pseudonymized texts. **完整 (full)** sends real text. At every level, the 今日重点 (today's focus) request is scanned and refused if it contains secrets, URLs, host names, IPs, emails or file paths. Butler replaces ticket ids, repo and branch names, PR authors, ticket titles and the names in your sensitive-terms list with placeholders. It can't replace a colleague's name that isn't in that list, and the scanner does not recognise names. Every call, and every refused call, is on the **审计 (Audit)** page. Full-level StateCore distillation is the one path without a scan (see above).

## Known issues

- Unsigned builds (see above). macOS builds are Apple silicon only.
- No auto-update.
- The app uses the default Electron icon.
- The personal API is called with Node's `fetch`, which does not use the system proxy settings.
- **Windows, npm-installed Claude Code.** Butler starts the npm/pnpm `claude.cmd` shim's target directly, without `cmd.exe`: either the native `claude.exe` or `node <script>`. If Claude Code was installed with `--ignore-scripts`, or its native optional package is missing, `bin\claude.exe` is only a small placeholder file. Sessions then fail to start, and npm's "native binary not installed" message never appears. Fix it by reinstalling Claude Code without `--ignore-scripts`.

## Uninstall

1. **设置 → 环境检查 → 卸载 (Settings → Environment check → Uninstall)** removes Butler's hooks and `/handoff` command from Claude Code.
2. Delete the app. On macOS, drag Butler out of Applications. On Windows, go to Settings → Apps → Butler → Uninstall.
3. To also remove your data, delete `~/.butler`.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
