# 录制演示素材

[English](demo-media.md) | **简体中文**

README 开头的动图和截图是用 Playwright 驱动真实的 Shipherd 录下来的。界面改了就重录一遍，一般每次发版录一次。

## 产出什么

全部写到 `docs/media/`，浅色主题，窗口 1280×768：

| 文件 | 内容 |
| --- | --- |
| `demo.gif` | 约 30 秒：把 epic 讲给它的总控 → 总控拆成 feature 和 ticket → session 开工 → **轮到你** 上出现一个问题 → 你回答、打开可以合并的 PR，它显示为已合并 |
| `your-turn.png` | **轮到你** 页：一张提问卡片、一张可以合并的卡片 |
| `epic.png` | epic 的概况，按 feature 分块 |
| `ticket.png` | ticket 页，PR 可以合并 |

每个文件都有一份中文界面录的，扩展名前加 `.zh-CN`（`demo.zh-CN.gif`、`your-turn.zh-CN.png` 等），给 `README.zh-CN.md` 用。

## 怎么录

```sh
pnpm demo:record        # 先 build，再录中英两份
pnpm demo:record:only   # 不重新 build，直接再录
```

需要 macOS 或 Linux，`PATH` 里要有 `ffmpeg`（macOS：`brew install ffmpeg`）。Windows 不支持：录制用的假 `gh` 是个 shell 脚本。录一次大约一分半。Shipherd 的窗口在后台打开，不抢焦点。设了 `SHIPHERD_DEMO_OUT` 就写到那个目录，比如想先和已提交的对比一下。

录制不进 CI。提交之前先看一遍新文件。

## 原理

录制脚本是 `e2e/demo/record.demo.ts`，由 `playwright.demo.config.ts` 运行，它不是测试。

- **沙盒。** 和 e2e 测试一样在沙盒里启动 Shipherd：假 `claude`、假 `gh`、临时的 HOME 和数据目录，碰不到真的 `~/.shipherd` 和 `~/.claude`。仓库放在沙盒 HOME 下，页头显示成 `~/code/fernleaf-notes-features/...`。
- **演示数据。** `e2e/demo/demo-data.ts` 是一个虚构的笔记应用 Fernleaf，要做「离线模式」这个 epic：两个仓库（`web`、`sync-api`）、三个 feature、五个 ticket `FERN-101` 到 `FERN-105`、PR #42。名字全是编的。要改故事或文字就改这个文件，中英两份一起改。
- **按剧本说话的 agent。** 不跑真的 Claude。假 `claude` 按剧本说话（`FAKE_CLAUDE_SCRIPT`，由 `demo-data.ts` 的 `fakeClaudeScript` 生成）：收到的消息里含某条规则的文字就回话，还可以接着做几步，比如调用工具、跑一个很久的命令、用 `ask_user` 提问。epic 总控由录制脚本自己扮演，经 MCP 调用 `shipherd-sessions`（`create_feature`、`create_ticket`、`start_session`、`send_message`）。
- **合并。** Shipherd 没有合并按钮，合并在 GitHub 上做。录制时 **打开 PR** 什么也不打开，随后假 `gh` 报告 PR #42 已合并，Shipherd 读到它。
- **动图。** 不录屏幕视频，而是在要展示的几段里大约每 100 毫秒截一张图，中间的等待不截；再用 `ffmpeg` 按真实间隔把这些帧拼成 GIF。字幕和鼠标只在录制时画进页面。GIF 达到 5 MB 时录制会失败。

`pnpm test` 会核对剧本规则、帧时长和假 `claude` 的剧本模式（`e2e/demo/demo.test.ts`）。
