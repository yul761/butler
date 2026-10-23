# Butler

A desktop "work butler" for people who run several [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions at once, one per ticket.
macOS (Apple silicon) and Windows (x64). MIT licensed.

**Local-first.** Butler keeps its data in local SQLite files. Data leaves your machine only through your own `claude` and, if you configure one, a personal LLM API. That API receives only what your privacy level allows, and every call it receives is logged on an audit page.

> 中文简介：Butler 用一个桌面应用管理“每个 ticket 一个 Claude Code session”的工作方式：每晚自动为有进展的 ticket 生成交接（handoff），早上一打开就是简报，点一下就回到对应的 session；记忆由本地的 StateCore 管理。界面是中文的。

The UI is in Chinese. This README quotes UI labels as they appear in the app, with an English gloss, for example **设置 (Settings)**.

## What it does

- **Tickets first.** Each ticket has its worktree or branch, its Claude Code sessions (embedded terminals), its PR state and its after-merge follow-ups. Sessions you started outside Butler in the last 7 days show up under **未认领 session (unclaimed sessions)**, so you can attach them to a ticket. **编辑 (Edit)** changes a ticket's title, work mode or branch after it is created. Archived tickets are listed under **已归档 (Archived)**, where you can restore them. In the terminal on Windows, Ctrl+V and right-click paste, and Ctrl+C copies when text is selected.
- **Nightly handoffs.** At a time you choose, Butler asks your own logged-in `claude` to write a structured handoff for every ticket that had activity.
  - `Edit`, `Write` and `NotebookEdit` are always denied.
  - Butler allows file reads, `gh pr view`, `gh pr checks`, `git log`, `git status` and the tracker MCP tools you picked.
  - Any other permission comes from your own Claude Code settings: the user-level allow rules (the runs use `--setting-sources user`) and any managed policy settings.
  - These runs are not strictly read-only. If your settings allow, say, `Bash(npm:*)` or a write-capable MCP tool, the runs can use it too.

  Inside a session you can also type `/handoff`.
- **Morning brief.** It has three sections, then what you did on the previous working day:
  - **🔴 先做 (do first):** approved PRs, requested changes, after-merge follow-ups and due items
  - **🟡 今天 (today)**
  - **⚪ 留意 (watch)**

  **打开 (Open)** on an item resumes the right session with a prompt already typed in.
- **Memory.** Progress, decisions, open follow-ups and cross-ticket learnings go into a local [StateCore](https://github.com/yul761/StateCore) store. Every session Butler starts can `recall` them. The ticket page has a **记忆 (Memory)** tab that shows each entry's history.
- **Optional personal LLM summary.** **今日重点 (today's focus)** is a short paragraph from an OpenAI-compatible API that you pay for. It goes through a privacy gateway with:
  - a choice of privacy level, and field allow-listing for that level
  - placeholders below the full level
  - a scanner for secret-, URL-, domain-, IP-, email- and path-shaped text
  - an audit page
  - a monthly budget
  - optional confirm-before-send

  Nothing is sent until you configure a provider, and the default level sends metadata only. At the full level, Butler also uses the API for memory distillation. That path sends more and is not scanned; see [Privacy model](#privacy-model).

## What Butler does not touch

- **Your Claude Code configuration.** Butler changes it only when you click the hook install, either in the first-run wizard or with **设置 → 环境检查 → 安装 / 修复 (Settings → Environment check → Install / repair)**. That adds four hooks to your user-level `settings.json` and a `/handoff` command. Your other hooks and commands are kept. Memory is never registered with `claude mcp add`. Instead, Butler passes `--mcp-config` on the command line of each session it starts.
- **Your tracker and code host.** Butler has no Jira, GitHub or Claude login of its own. Jira, Linear, GitLab or any other tracker is read only by your company's Claude Code, through its own MCP servers. PRs are read by `claude` with your `gh`.
- **The network.** The only network code in Butler is the privacy gateway for the optional personal API. A lint rule enforces this.

## Requirements

- macOS on Apple silicon, or Windows 10/11 x64. Intel Macs can [build from source](CONTRIBUTING.md).
- Claude Code installed and logged in. `claude --version` must work in a terminal.
- Git on `PATH`. On Windows, install **Git for Windows**: Claude Code runs hooks through Git Bash, and Butler won't run git at all if it can't find `git.exe` on `PATH`.
- Optional: a tracker MCP server (Jira, Linear, GitLab, …) set up in Claude Code, so handoffs can read ticket status.

## Install

Download the latest release from this repository's Releases page:

- macOS: `Butler-x.y.z-arm64.dmg` (or `Butler-x.y.z-arm64-mac.zip`)
- Windows: `Butler-Setup-x.y.z.exe`

Sizes, measured on a local macOS 1.0.0 build (the Windows installer has not been measured):

- **The dmg** is about 175 MB.
- **The installed app** is about 457 MB. About 288 MB is Electron's frameworks. About 143 MB is `butler-hook`, the program Claude Code runs for each hook. It is a Node single executable with Node 26.3.0 built in.
- **Installing the hooks** copies `butler-hook` to `~/.butler/bin`.

The builds are **not code-signed**, so your browser and OS will warn you.

### macOS (Gatekeeper)

The app is ad-hoc signed but not notarized, and macOS builds are arm64 only.

1. Open the `.dmg` and drag Butler into Applications.
2. Open Butler. macOS refuses: it says Apple cannot verify the app, or that the developer cannot be verified.
3. Allow it with either option:
   - **Option A: Open Anyway.** Open **System Settings → Privacy & Security**, scroll down to the message about Butler, click **Open Anyway** and confirm. On macOS 14 and earlier, you can instead right-click (Control-click) Butler in Applications, choose **Open**, then **Open** again.
   - **Option B: Terminal.** Remove the quarantine flag from the app and everything inside it, then open Butler normally:

     ```sh
     xattr -dr com.apple.quarantine /Applications/Butler.app
     ```

If macOS says Butler "is damaged and can't be opened", there is no **Open Anyway** button. Use option B.

Repeat this after every new download.

### Windows (SmartScreen)

The NSIS installer is unsigned.

1. Your browser may warn about the download. In Edge, open the download's **…** menu and choose **Keep**.
2. Run `Butler-Setup-x.y.z.exe`.
3. SmartScreen says "Windows protected your PC". Click **More info → Run anyway**.
4. Pick "only for me" (no admin rights needed) and an install folder.

If Windows 11 **Smart App Control** is on, it blocks unsigned apps and offers no "run anyway" option. Butler can't be installed while it is on. Check Microsoft's documentation before you turn it off.

There is no auto-update. To upgrade, download the new version and install it over the old one. Your data in `~/.butler` is kept.

## First run

A short wizard, **欢迎使用 Butler (Welcome to Butler)**, walks you through these steps:

1. **检查 Claude Code (Check Claude Code).** Butler finds `claude` on your login shell's `PATH`, or you give it the absolute path. It also checks that `claude --help` lists the flags Butler relies on. You can't continue without a working `claude`.
2. **安装 hook 和 /handoff 命令 (Install hooks and the /handoff command).** Butler merges four hooks (`SessionStart`, `Stop`, `UserPromptSubmit`, `SessionEnd`) into your user-level Claude Code `settings.json`, keeping your existing hooks.
   - The first time, it saves a copy of the file as `settings.json.butler-backup`.
   - It also writes `commands/handoff.md`.
   - The hooks only drop small JSON files into `~/.butler/inbox`. They never touch the network and always exit 0.
   - To remove them, use **设置 → 环境检查 → 卸载 (Settings → Environment check → Uninstall)**.
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
| `~/.butler/mcp/project-*.json`, `local-*.json` | Copies of your MCP server entries for unattended runs. Written only when **后台 handoff 也加载本地级的 MCP…** (`headlessProjectMcp`) is on. These are private files because they can contain tokens. |
| `~/.butler/logs/main.log` | Logs |

On Windows `~` is `%USERPROFILE%`. Set `BUTLER_HOME` to use another folder. Butler also honours `CLAUDE_CONFIG_DIR` for the Claude Code configuration it reads and the hooks it installs.

Apart from the hook install, Butler only reads Claude Code's files:

- `settings.json`: hook status, plugin check, MCP approvals
- `commands/handoff.md`: whether it is Butler's own
- `~/.claude.json`: your MCP servers and approvals
- the session transcripts under `~/.claude/projects`: unclaimed sessions and `/handoff` output
- with **后台 handoff 也加载本地级的 MCP…** (`headlessProjectMcp`) on, a repository's `.mcp.json` and `.claude/settings.local.json`, to find the servers you approved

Your personal API key is encrypted with the OS keychain (macOS Keychain / Windows DPAPI). After you save it, the UI shows at most its last 4 characters. A key shorter than 12 characters is shown only as `••••`.

Butler uses the keychain only when you save a key, and later when it needs that key to show its last 4 characters or to call your API. If you never save a key, Butler never touches the keychain.

On macOS, a dialog may ask whether Butler may use "butler Safe Storage" in your keychain (Electron names the item after the app's internal name, `butler`). Click **Always Allow**. The builds are ad-hoc signed, not signed with a Developer ID, so macOS treats every new version as a different app and asks again once after each upgrade. This can happen right at startup if a scheduled brief or handoff needs the key. Butler's window does not respond until you answer. If you click **Deny**, Butler can't read the saved key, and Settings shows it as unreadable; enter it again.

Electron also keeps its own profile folder, with Chromium's caches and the single-instance lock: `~/Library/Application Support/butler` on macOS and `%APPDATA%\butler` on Windows. When `BUTLER_HOME` is set, Butler uses `<BUTLER_HOME>/electron` instead. On Windows this folder also holds the DPAPI-protected encryption key for the saved API key, so if you delete it, enter the API key again.

## StateCore memory

Butler embeds StateCore. Each session Butler starts gets two keyless MCP servers. `butler-memory` holds this ticket's memory and `butler-workspace` holds learnings shared across tickets.

**Do not also install StateCore's own Claude Code capture plugin.** Butler already provides StateCore memory in the sessions it starts, and with both installed memory is recorded twice. Settings warns you if it finds the plugin.

- **No model key reaches StateCore.** The memory servers that Claude Code starts get no model API key: Butler strips model variables from their environment. Butler's own writes (handoffs, decisions, follow-ups, learnings) are deterministic and need no model.
- **Distillation, at 完整 (full) only.** When the privacy level is 完整 (full) and confirm-before-send is off, Butler runs StateCore's distillation through your personal API. Butler's main process makes the calls, and the key stays inside the privacy gateway. Distillation runs in the background after every nightly handoff run, including catch-up runs and **立即运行晚间 handoff (run the nightly handoff now)**. For each scope with pending events, the calls send:
  - the scope name, which for a ticket is the real ticket id (`ticket:<KEY>`)
  - the scope's recent raw events, including what Claude saved with `remember(consolidate: true)`
  - the scope's existing memory as JSON: Butler's follow-up and decision notes, Claude's own notes, and the previous summary with its next steps
  - the text of notes forgotten in that scope, so the model won't bring them back

  In the `workspace` scope, each learning is tagged with the id of the ticket it came from. **None of this is pseudonymized or scanned.** Each sent call is recorded on the audit page as **StateCore 记忆蒸馏 (StateCore distillation)** and counts against your monthly budget.
- **Memory fills up.** StateCore keeps at most 30 notes per scope (one scope per ticket), and forgotten notes keep their slots. Butler never evicts its own entries to make room, so a long-lived ticket stops gaining new entries once its 30 slots are used, even at the full level. Distillation skips ticket scopes with fewer than 6 free slots. See [docs/configuration.md](docs/configuration.md#how-memory-works).

## Privacy model

Company work goes only through your company's `claude`. What the optional personal API receives depends on the **隐私档位 (privacy level)**:

- **关闭 (off):** nothing.
- **仅元数据 (metadata, the default):** for 今日重点 (today's focus), placeholders, status and PR enums, follow-up kinds and triggers, counts and day numbers. No free text.
- **脱敏文本 (redacted):** adds short next steps, blockers and follow-up descriptions. Before sending, Butler replaces the following with placeholders that are new for every request:
  - ticket ids, including Jira subtask ids
  - repo and worktree folder names
  - branch names
  - the owner and repo names in PR links
  - ticket titles
  - the entries in your sensitive-terms list

  A colleague's name that isn't in that list is sent as is.
- **完整 (full):** real ticket ids and text, with no placeholders, so the names in your sensitive-terms list go out verbatim. This level also turns on StateCore distillation, which sends memory contents unscanned (see [StateCore memory](#statecore-memory)).

At the metadata, redacted and full levels, the 今日重点 request is scanned before it is sent. It is blocked if it contains:

- something that looks like a secret or token
- a URL
- an IP address
- an email address
- a file path
- a domain name. This means a public top-level domain from a fixed list, or an internal suffix such as `.corp` or `.internal`. Bare host names like `jenkins01`, and domains under other TLDs, are not caught.

Below the full level, a request is also blocked if it still contains a ticket id or an original value that should have been replaced. The scanner does not recognise names.

The **审计 (Audit)** page lists every call that was sent, blocked by the scanner, over budget or declined at the confirmation. Some refusals are only written to the log, for example a distillation call refused because the level changed, or a saved key that can no longer be decrypted.

## Known issues

- Unsigned builds (see above). macOS builds are Apple silicon only.
- No auto-update.
- macOS asks again for keychain access to the saved API key after every upgrade (builds are ad-hoc signed). With no key saved, there is no prompt.
- The app uses the default Electron icon.
- The personal API is called with Node's `fetch`, which does not use the system proxy settings.
- **Windows, npm-installed Claude Code.** Butler starts the npm/pnpm `claude.cmd` shim's target directly, without `cmd.exe`. The target is either the native `claude.exe` or `node <script>`.
  - If Claude Code was installed with `--ignore-scripts`, or its native optional package is missing, `bin\claude.exe` is only a small placeholder file.
  - Sessions then fail to start, and npm's "native binary not installed" message never appears.
  - To fix it, reinstall Claude Code without `--ignore-scripts`.

## Uninstall

1. **设置 → 环境检查 → 卸载 (Settings → Environment check → Uninstall)** removes Butler's hooks and `/handoff` command from Claude Code.
2. Delete the app. On macOS, drag Butler out of Applications. On Windows, go to Settings → Apps → Butler → Uninstall.
3. To also remove your data, delete `~/.butler`. Neither step removes Electron's profile folder, `~/Library/Application Support/butler` on macOS or `%APPDATA%\butler` on Windows; delete it too for a clean uninstall. On macOS, if you saved an API key, you can also delete the "butler Safe Storage" item in Keychain Access.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
