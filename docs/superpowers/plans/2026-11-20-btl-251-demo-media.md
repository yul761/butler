# BTL-251 plan：演示素材录制

设计见 `docs/superpowers/specs/2026-11-20-btl-251-demo-media-design.md`。能单测的部分先写测试（TDD）；录制脚本本身用真跑一遍、看产出的帧来验证。

1. **假 claude 的剧本模式**
   - `FAKE_CLAUDE_SCRIPT`：banner 换掉开场两行；规则 `{ when, reply?, then? }`，输入里含 `when` 就触发；
   - `then` 的步骤延时喂回输入，不算用户消息、不跑 UserPromptSubmit、不再匹配规则；
   - 不设这个变量时行为不变；
   - 测试：`e2e/demo/demo.test.ts` 起一个假 claude，看 banner、回话、步骤只执行一次、transcript 里只有一条用户消息。
2. **演示数据**
   - `e2e/demo/demo-data.ts`：Fernleaf「离线模式」，中英两份，`fakeClaudeScript(d)` 生成剧本；
   - 测试：两种语言的 ticket、仓库一致；每条规则只被它该收的消息触发（带信箱头、CI 消息、合并通知、回答）；不含真实名字。
3. **帧时长和拼接**
   - `capture.ts` 的 `frameDurations`、`concatList`；
   - 测试：间隔截断、hold、最后一帧重复、路径里的单引号。
4. **录制脚本**
   - `record.demo.ts` + `playwright.demo.config.ts`，`pnpm demo:record` / `demo:record:only`；
   - 场景：讲 epic → 拆 feature 和 ticket → 三个 session 开工 → 轮到你回答 → 打开 PR → 已合并；
   - 中途截三张静态图；
   - 验证：跑两遍中英文，逐帧看拼图，GIF 小于 5 MB。
5. **顺手修的 bug**：「just now ago」/「刚刚前」，`home-view.test.ts` 先红后绿。
6. **文档**
   - `docs/demo-media.md` + `.zh-CN.md`，加进 `docs.test.ts` 的 `DOC_PAIRS`；
   - CONTRIBUTING 两份的脚本表加 `pnpm demo:record`。
7. **检查**：`pnpm typecheck && pnpm lint && pnpm test`，`pnpm e2e`（改了假 claude 和 renderer）。
