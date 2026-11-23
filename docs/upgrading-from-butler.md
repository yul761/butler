# Upgrading from Butler

**English** | [简体中文](upgrading-from-butler.zh-CN.md)

<!-- Butler is Shipherd's former name; this page is for people upgrading from it. -->
Shipherd used to be called Butler. Quit Butler, install Shipherd, and before you open it for the first time also quit every running `claude` (on first launch Shipherd updates Claude Code's settings and `~/.claude.json`, which a running `claude` may overwrite). Nothing is lost:

- On first launch Shipherd moves `~/.butler` to `~/.shipherd` and leaves a link at the old place (a directory junction on Windows; a note file if no link can be made). The database, memory, logs and settings come along, and the Claude Code transcripts of sessions whose worktrees were under `~/.butler` are moved with them. If you set `BUTLER_HOME`, it is still honoured until you set `SHIPHERD_HOME`.
- Butler's hooks in `~/.claude/settings.json` are replaced by Shipherd's (your own hooks are kept), and the `/handoff` command is updated. Sessions that were running during the upgrade keep reporting.
- Files exported from Butler (configuration, backups) import as they are.
- If Butler is still running, Shipherd says so and quits: the two can't run at the same time.
- **macOS:** drag Butler out of Applications. macOS treats Shipherd as a new app, so grant it again any permission you gave Butler (notifications and the like). A saved notification webhook address can't be read under the new name; Settings asks you to enter it again.
- **Windows:** Shipherd installs next to Butler, not over it. The installer detects Butler and offers to uninstall it; if you skip that, uninstall it later in Settings → Apps → Butler → Uninstall. Uninstalling Butler keeps your data.

Back to the [README](../README.md).
