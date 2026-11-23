# BTL-253 更新提示（addendum）

日期：2026-11-21。范围：Shipherd 每天最多一次经用户自己的 `gh` 查 GitHub 上有没有新版本，有就提示，不下载、不安装。

## 不做的

- 不加 `electron-updater`，不用 Electron 的 `autoUpdater`。Ruling P5-R4 和守着它的 `src/main/packaging.test.ts`、`src/main/egress-lint.test.ts` 不动。
- Shipherd 自己不发 HTTP 请求。查询就是 `gh api repos/<SHIPHERD_REPO>/releases/latest`，走 `src/main/tickets/gh.ts` 里已有的 `ghBinary()` / `runGhDetail()`。
- 不下载安装包，不比较安装包校验和。只打开 release 页，由用户自己下载。

## 决定

1. **仓库名只写一处**：`src/shared/shipherd-repo.ts` 导出 `SHIPHERD_REPO = "yul761/shipherd"`，以及 release 页和 issue 页的链接拼法。BTL-254 的「发送反馈」也用它。
2. **版本比较**（`src/shared/update.ts`）：按 SemVer 2.0 的优先级比较 `X.Y.Z[-pre][+build]`，前面的 `v` 去掉，build 元数据不参与比较。新版本的条件：release 不是 draft、不是 prerelease、tag 本身也没有预发布后缀，而且比当前版本高。当前版本是预发布（`4.1.0-rc.1`）时，同号的正式版 `4.1.0` 算新版本。解析不了的版本号一律当成「没有新版本」。
3. **节流**：自动检查的时间记在设置 `updateLastCheckAt`（毫秒）。启动时等 git 和 gh 的路径按登录 shell 的 PATH 解析好、gh 探测完，再看距离上次是否满 24 小时。之后每小时看一次，满 24 小时才真查。失败也算查过一次（「每天最多一次」是对 GitHub 的请求次数说的），第二天再试。手动检查不看节流，查完也更新 `updateLastCheckAt`。
4. **失败静默**：自动检查失败（没装 gh、没登录、离线、限流、仓库没有 release、返回的不是预期的 JSON）只写一行日志，不弹窗、不显示提示条。没装 gh（`ghAvailable()` 为假）时连进程都不启动，也不记审计。手动检查给出原因：`no_gh`、`not_logged_in`、`offline`、`rate_limited`、`no_release`、`bad_response`、`failed`（其他），按 gh 的 stderr 和退出情况分。
5. **开关**：`updateCheckEnabled`，默认 `1`，放在 **设置 → 基本**（标题「通用」）。这是「新行为默认关」的一个明确例外：它只读、不在 GitHub 上留下任何东西，计划 BTL-250 第 2 条定了默认开。`settings-defaults-3.test.ts` 里单独钉住它是 `1`，CONTRIBUTING 两份写明这个例外。关掉以后不再自动查，提示条也收起；「检查更新」菜单和按钮照样能用。
6. **状态**：最近一次查到的 release（版本、链接、发布时间、release notes，notes 最多 20000 字）存在设置 `updateLatest`（JSON），重启后 24 小时内不用再查也能显示提示条。「跳过这个版本」存在 `updateSkippedVersion`；跳过以后只有更高的版本才再提示。关闭按钮只在这次运行里收起这一版，下次启动还会提示。
7. **界面**：
   - 顶部提示条（`UpdateBanner`，在 `main` 里最上面，错误提示条下面）：「X.Y.Z 可用」、可折叠的 release notes（默认收起，按原文显示，不渲染 Markdown）、「下载」（在浏览器里打开 release 页）、「跳过这个版本」、关闭。
   - 新的设置 tab「关于」（`SETTINGS_TABS` 末尾的 `about`，和 BTL-254 约定，组件 `AboutSettings.tsx`）：当前版本、上次检查时间、「检查更新」按钮和结果（已是最新 / 有新版本 / 查不了：原因）。BTL-254 在它的 `.actions` 里放「发送反馈」。
   - 应用菜单：Shipherd 原来只有托盘菜单，用的是 Electron 的默认应用菜单。新增 `src/main/app-menu.ts`，菜单是系统标准的几项（macOS 的应用菜单、编辑、显示、窗口，用 role）加「帮助」。「帮助 → 检查更新…」在主进程里查一次，然后通过事件 `app:menu`（参数 `"checkUpdates"`）让界面打开 **设置 → 关于** 显示结果。BTL-254 的「发送反馈…」也走这个事件。切换语言时重建菜单。
8. **打开 release 页**：IPC `update:openRelease` 不收链接，只打开缓存里那条 release 的 `html_url`，并且要求它是 `https://github.com/<SHIPHERD_REPO>/releases/` 开头；否则打开 `https://github.com/<SHIPHERD_REPO>/releases/latest`。
9. **审计**：每次真的启动了 gh 的查询都记进审计表 `external_action_audit`，种类 `update_check`。它不是「对外动作」（没有 `external*` 开关、不经过 `ExternalActions.attempt`），所以 `EXTERNAL_ACTIONS` 不变；`src/shared/external.ts` 新增 `AUDIT_KINDS = [...EXTERNAL_ACTIONS, "update_check"]`，审计页按它列出。结果：查到了是 `done`（摘要写最新版本和是否比当前新），失败是 `failed`（错误写原因）。目标列是 `repos/<SHIPHERD_REPO>/releases/latest`。没有新的迁移。
10. **e2e**：假 gh 支持 `api repos/yul761/shipherd/releases/latest`：fixture 的 `release` 是对象就原样输出，没有就像真 gh 一样报 `HTTP 404` 退出 1。全新安装的 `defaults.spec.ts` 改成审计页里只有 `update_check` 这一种记录。新加 `e2e/update.spec.ts`：提示条出现、展开 notes、「跳过这个版本」后收起且重启不再出现，以及「关于」里的手动检查结果。Windows 上假 gh 不可用，这个 spec 只在 macOS 跑（和其他用假 gh 的 spec 一样）。

## README

README 不归这个 ticket 改（BTL-252 改）。「隐私」段需要的一句话写进 epic 记忆 `[readme:253]`。
