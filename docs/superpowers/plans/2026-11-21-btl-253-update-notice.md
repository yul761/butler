# BTL-253 更新提示：实现计划

设计见 `docs/superpowers/specs/2026-11-21-btl-253-update-notice-design.md`。每一步先写测试，再写实现。

1. `src/shared/shipherd-repo.ts`、`src/shared/update.ts`：`SHIPHERD_REPO`、`parseVersion`、`compareVersions`、`isNewerRelease`、视图和结果的类型。单测：预发布、build 元数据、`v` 前缀、解析不了、draft / prerelease 标志。
2. `src/main/tickets/gh.ts`：`runGhDetail` 多带回 `exitCode` / `errorCode`（不改已有调用方的行为）；`src/main/update/release-source.ts`：`latestRelease()` 调 `gh api repos/<SHIPHERD_REPO>/releases/latest`，把失败按 stderr 分成几种原因。单测：每种 stderr、没有 gh、JSON 不对。
3. `src/main/update/update-checker.ts`：`UpdateChecker`（自动检查的节流、手动检查、跳过、关闭、视图、审计）。单测：首次检查、24 小时内不查、失败也算一次、开关关着不自动查、手动不看节流、跳过和关闭、审计记录、并发只跑一次。
4. 设置：`updateCheckEnabled`（可编辑，基本）、`updateLastCheckAt` / `updateLatest` / `updateSkippedVersion`（内部）。默认值测试。
5. 审计：`AUDIT_KINDS`、`ExternalAuditRepo.list`、`ExternalActions.record` 接受 `update_check`；审计页的种类名。
6. IPC：`update:state`（读）、`update:check`、`update:skip`、`update:dismiss`、`update:openRelease`；事件 `app:menu`。分类进 `NOT_TRIGGERS`，validate 加参数检查。
7. `src/main/app-menu.ts` 和 `index.ts` 的装配（菜单、启动后检查、每小时一次的定时器、退出时停）。
8. 界面：`UpdateBanner`、`AboutSettings`、基本设置里的开关、中英文字符串。渲染测试。
9. 文档：`docs/configuration.md` 两份、CONTRIBUTING 两份的例外说明；`[readme:253]` 写进 epic 记忆。
10. e2e：假 gh 的 release；`e2e/update.spec.ts`；`defaults.spec.ts` 调整。
11. `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`，opus 子代理 review，开 PR。
