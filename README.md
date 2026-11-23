# Shipherd

**Talk to one coordinator. It runs your Claude Code sessions and only pings you when it's your turn.**

![Describe an epic to its coordinator; it splits the work into features and tickets, each ticket gets its own session and worktree, cards show up on Your turn, you merge the PR and the next ticket starts](docs/media/demo.gif)

**Download:** [macOS (Apple silicon)](https://github.com/yul761/shipherd/releases/latest) · [Windows](https://github.com/yul761/shipherd/releases/latest) · MIT · [shipherd.statecore.io](https://shipherd.statecore.io) · **English** | [简体中文](README.zh-CN.md)

- **Hand over a body of work, not a prompt.** Describe an epic to its coordinator. It splits the work into tickets and gives each ticket its own session and git worktree. The coordinator works through them in order, and Shipherd checks every merge before it happens: when two branches conflict, the first to merge goes ahead and the other ticket is told to rebase.
- **Answer in one place.** Whenever a session needs you, a card shows up on the **Your turn** page: a question, a permission prompt, a PR ready to merge. A session that has stopped moving gets a card too, with its likely cause.
- **Sessions share memory.** A convention one session saves to the epic's memory, such as an API contract, is sent to the epic's other running sessions. A long session is handed off, cleared and picks up from memory where it left off.

**Local-first.** Shipherd has no model or API key of its own: its background work runs through your own `claude`, and it sends no telemetry. Your data leaves your machine only through your own `claude`, `git` and `gh`, plus a notification webhook if you set one up. Even the once-a-day update check goes through `gh` and only tells you; it never downloads or installs anything.

## Quick start

1. Install Claude Code and log in once: run `claude` in a terminal. Then download Shipherd, install it and open it (the first launch needs one extra click, see [Install](#install)). The **Welcome to Shipherd** wizard checks Claude Code and installs Shipherd's hooks.
2. On the **All work** page, click **+ New epic**, give it a name and pick its repos.
3. On the epic's **Control** tab, click **+ Coordinator session** and describe the work. The coordinator creates the tickets and starts a session in each one. You answer on **Your turn** and merge the PRs it says are ready.

[How it works](docs/how-it-works.md) · [Compared with running sessions side by side](docs/compare.md) · [Configuration](docs/configuration.md)

## Requirements

- macOS on Apple silicon, or Windows 10/11 x64. Intel Macs can [build from source](CONTRIBUTING.md).
- Claude Code installed and logged in: `claude --version` must work in a terminal.
- Optional: the GitHub CLI (`gh`), logged in with `gh auth login`. Sessions work without it, but PR, CI and review features don't.
- Optional: a tracker MCP server (Jira, Linear, GitLab, …) set up in Claude Code, so handoffs can read ticket status.
- Git on `PATH`. On Windows, install **Git for Windows**: Claude Code runs hooks through Git Bash, and Shipherd won't run git if it can't find `git.exe`.

## Install

Download the latest release from the [Releases page](https://github.com/yul761/shipherd/releases/latest):

- macOS: `Shipherd-x.y.z-arm64.dmg` (or `Shipherd-x.y.z-arm64-mac.zip`), about 170 MB
- Windows: `Shipherd-Setup-x.y.z.exe`, about 140 MB

Installed, the macOS app takes about 455 MB. About 140 MB of that is `shipherd-hook`, the program Claude Code runs for each hook; installing the hooks copies it to `~/.shipherd/bin`.

On macOS, open the `.dmg` and drag Shipherd into Applications. The macOS build is signed with Developer ID and notarized by Apple, so it opens with a double-click.

The Windows installer is not code-signed yet (see [Code signing](docs/how-it-works.md#code-signing)), so its first launch needs one extra step.

### Windows (SmartScreen)

1. Run `Shipherd-Setup-x.y.z.exe`. If Edge warns about the download, choose **Keep** in the download's **…** menu.
2. SmartScreen says "Windows protected your PC". Click **More info → Run anyway**.
3. Pick "only for me" (no admin rights needed).

If Windows 11 **Smart App Control** is on, it blocks unsigned apps with no way around it, so Shipherd can't be installed while it is on. Check Microsoft's documentation before you turn it off.

To upgrade, download the new version and install it over the old one. Your data in `~/.shipherd` is kept. What changed in each version is in the [release notes](https://github.com/yul761/shipherd/releases).

### Upgrading from Butler

<!-- Butler is Shipherd's former name; this section is for people upgrading from it. -->
Shipherd used to be called Butler. Quit Butler, install Shipherd, and before you open it for the first time also quit every running `claude` (on first launch Shipherd updates Claude Code's settings and `~/.claude.json`, which a running `claude` may overwrite). Nothing is lost:

- On first launch Shipherd moves `~/.butler` to `~/.shipherd` and leaves a link at the old place (a directory junction on Windows; a note file if no link can be made). The database, memory, logs and settings come along, and the Claude Code transcripts of sessions whose worktrees were under `~/.butler` are moved with them. If you set `BUTLER_HOME`, it is still honoured until you set `SHIPHERD_HOME`.
- Butler's hooks in `~/.claude/settings.json` are replaced by Shipherd's (your own hooks are kept), and the `/handoff` command is updated. Sessions that were running during the upgrade keep reporting.
- Files exported from Butler (configuration, backups) import as they are.
- If Butler is still running, Shipherd says so and quits: the two can't run at the same time.
- **macOS:** drag Butler out of Applications. macOS treats Shipherd as a new app, so grant it again any permission you gave Butler (notifications and the like). A saved notification webhook address can't be read under the new name; Settings asks you to enter it again.
- **Windows:** Shipherd installs next to Butler, not over it. The installer detects Butler and offers to uninstall it; if you skip that, uninstall it later in Settings → Apps → Butler → Uninstall. Uninstalling Butler keeps your data.

## First run

Before you open Shipherd, install Claude Code and log in once: run `claude` in a terminal and follow the login steps. The GitHub CLI (`gh`) is optional; see [Requirements](#requirements).

The **Welcome to Shipherd** wizard has two steps:

1. **Check Claude Code.** Shipherd finds `claude` on your login shell's `PATH`, then in the usual install locations (`~/.local/bin`, `~/.claude/local`; on Windows `%USERPROFILE%\.local\bin` and `%APPDATA%\npm`), or you give it the absolute path. It also checks that `claude --help` lists the flags Shipherd relies on; you can't continue without a working `claude`. It tells you when `claude` doesn't look logged in yet, and whether `gh` is installed and logged in; neither stops you.
2. **Install the hooks and the /handoff command.** Click **Install and continue**. Shipherd merges four hooks and a `/handoff` command into your user-level Claude Code settings, keeps your own hooks and saves a backup first. Without them, **Your turn** and status don't work. The hooks only drop small JSON files into the `inbox` folder of Shipherd's data folder (`~/.shipherd` unless you set `SHIPHERD_HOME`); they never touch the network and always exit 0. **Settings → Health check → Uninstall** removes them.

Then **All set** and **Get started** take you to the home page. Start with an epic as in [Quick start](#quick-start), or with a single ticket: create a ticket, add a repository to it (Claude works there) and click **Start the first session** on its overview. When the session stops to wait for you, it shows up on **Your turn**.

Two things are set up later in Settings, not in the wizard: your tracker's read-only MCP tools (Jira, Linear, GitLab, …) under **Settings → Advanced → Schedule & status**, and the [permission profile](docs/configuration.md#permission-profile) under **Settings → Advanced → Interruptions & notifications**. You can run the wizard again from **Settings → Basics**.

Don't also install StateCore's own Claude Code capture plugin: Shipherd already gives its sessions StateCore memory, and with both, memory is recorded twice.

Every setting is described in [docs/configuration.md](docs/configuration.md), including how to adapt Shipherd to your tracker and conventions.

## Uninstall

1. **Settings → Health check → Uninstall** removes Shipherd's hooks and `/handoff` command from Claude Code.
2. Delete the app: drag it out of Applications on macOS, or use Settings → Apps → Shipherd → Uninstall on Windows.
3. To remove your data too, delete `~/.shipherd` and Electron's profile folder (`~/Library/Application Support/shipherd` on macOS, `%APPDATA%\shipherd` on Windows). On macOS, if you saved a webhook address, also delete the "shipherd Safe Storage" item in Keychain Access. If you upgraded from Butler, the profile folder keeps its old name `butler`, and you can also delete the `~/.butler` link or note.

## Feedback

Found a bug or have an idea? **Help → Send Feedback…** (or the button under **Settings → About**) opens a filled-in GitHub issue in your browser; you submit it yourself, and Shipherd sends nothing on its own. Diagnostics are optional, redacted, and shown to you before they're saved to your Downloads folder for you to drag into the issue. Questions go to [Discussions](https://github.com/yul761/shipherd/discussions).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
