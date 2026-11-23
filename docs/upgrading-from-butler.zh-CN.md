# 从 Butler 升级

[English](upgrading-from-butler.md) | **简体中文**

<!-- Butler 是 Shipherd 改名前的名字，这一页写给从它升级的人。 -->
Shipherd 以前叫 Butler。退出 Butler，装上 Shipherd；第一次打开之前，把正在运行的 `claude` 也都退出（Shipherd 第一次启动时会改 Claude Code 的设置和 `~/.claude.json`，正在运行的 `claude` 可能把改动覆盖掉）。什么都不会丢：

- 第一次启动时，Shipherd 把 `~/.butler` 搬到 `~/.shipherd`，旧位置留一个指向新目录的链接（Windows 上是目录联接；建不了链接就留一个说明文件）。数据库、记忆、日志和设置都跟着过来；worktree 在 `~/.butler` 下的 session，它们的 Claude Code 对话记录也一起搬。如果你设过 `BUTLER_HOME`，在你设 `SHIPHERD_HOME` 之前它仍然有效。
- `~/.claude/settings.json` 里 Butler 的 hook 换成 Shipherd 的（你自己的 hook 不动），`/handoff` 命令也会更新。升级时正在跑的 session 照常上报。
- 从 Butler 导出的文件（配置、备份）可以直接导入。
- Butler 还开着时，Shipherd 会提示你先退出它，然后自己退出：两个不能同时运行。
- **macOS：**把 Butler 从"应用程序"里拖出去。macOS 把 Shipherd 当成一个新 app，你给过 Butler 的权限（通知等）要重新授予一次。保存过的通知 webhook 地址换名后读不出来，设置里会提示你重新填写。
- **Windows：**Shipherd 装在 Butler 旁边，不会覆盖它。安装程序检测到 Butler 时会提示你卸载；当时跳过的话，之后在 设置 → 应用 → Butler → 卸载。卸载 Butler 不会删你的数据。

回到 [README](../README.zh-CN.md)。
