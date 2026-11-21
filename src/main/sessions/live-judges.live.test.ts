import { describe, expect, it } from "vitest";
import { runHeadless } from "../claude/headless";
import { locateClaude, readLoginShellPath } from "../claude/locate";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import { setLang } from "../i18n";
import { tempDir } from "../test-utils";
import { judgeNeedsYou } from "./needs-you";

/**
 * 只在 BUTLER_LIVE_CLAUDE=1 时运行：真的调用本机已登录的 claude（会花一点公司额度）。
 * 验证无头调用在真实 CLI 上能拿到符合 schema 的结构化结果：needs-you 判断（Haiku）。
 */
describe.skipIf(process.env.BUTLER_LIVE_CLAUDE !== "1")("headless judges against the real claude", () => {
  async function deps(): Promise<HeadlessExecDeps> {
    const pathValue = await readLoginShellPath(process.platform, process.env);
    const claudePath = locateClaude({ override: "", pathValue, platform: process.platform });
    expect(claudePath).not.toBeNull();
    return {
      run: runHeadless,
      ready: async () => undefined,
      claude: () => ({ path: claudePath, pathValue }),
      // BUTLER_HOME 指向临时目录：用户级 butler-hook 的上报只会落进临时 inbox。
      baseEnv: { ...process.env, BUTLER_HOME: tempDir("butler-home-") },
      sessions: { recordHeadless: () => undefined } as never,
      now: () => Date.now(),
      newRunId: () => "live-judges",
      log: (m, e) => console.log("[live log]", m, e ?? ""),
    };
  }

  it("needs-you judge tells a question from a status report", async () => {
    const d = await deps();
    const cwd = tempDir("butler-cwd-");
    try {
      const ask = await judgeNeedsYou(d, "要把它拆成两个 PR 吗？", cwd);
      const done = await judgeNeedsYou(d, "已经推上去了，CI 在跑。", cwd);
      setLang("en");
      const askEn = await judgeNeedsYou(d, "Both approaches work. Should I go with Postgres or SQLite for the cache?", cwd);
      console.log("[live verdicts]", JSON.stringify({ ask, done, askEn }));
      expect(ask?.needsYou).toBe(true);
      expect(ask?.reason.length).toBeGreaterThan(0);
      expect(done?.needsYou).toBe(false);
      expect(askEn?.needsYou).toBe(true);
    } finally {
      setLang("zh");
    }
  }, 240_000);
});
