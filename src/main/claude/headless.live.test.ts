import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "../test-utils";
import { headlessArgs, READ_ONLY_TOOLS, runHeadless } from "./headless";
import { locateClaude, readLoginShellPath } from "./locate";
import { headlessEnv } from "./spawn";

/**
 * 只在 SHIPHERD_LIVE_CLAUDE=1 时运行：真的调用一次本机已登录的 claude（会花一点公司额度）。
 * 它验证 dontAsk + --json-schema 能拿到结构化结果，并且写工具被拒绝。
 */
describe.skipIf(process.env.SHIPHERD_LIVE_CLAUDE !== "1")("runHeadless against the real claude", () => {
  it("returns structured output under dontAsk and cannot write files", async () => {
    const pathValue = await readLoginShellPath(process.platform, process.env);
    const claudePath = locateClaude({ override: "", pathValue, platform: process.platform });
    expect(claudePath).not.toBeNull();
    const repo = makeRepo();
    const schema = JSON.stringify({
      type: "object",
      properties: { gitClean: { type: "boolean" }, wroteFile: { type: "boolean" } },
      required: ["gitClean", "wroteFile"],
    });
    const out = await runHeadless({
      claudePath: claudePath!,
      cwd: repo,
      args: headlessArgs({ schema, allowedTools: READ_ONLY_TOOLS }),
      prompt: "先运行 `git status`，再尝试创建文件 live.txt（内容 x）。然后回答：gitClean = 工作区是否干净，wroteFile = live.txt 现在是否存在。",
      // SHIPHERD_HOME 指向临时目录：用户级 shipherd-hook 的上报只会落进临时 inbox。
      env: { ...headlessEnv(process.env, { pathValue, runId: "live-test" }), SHIPHERD_HOME: tempDir("shipherd-home-") },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.structured).toMatchObject({ gitClean: true, wroteFile: false });
    expect(existsSync(join(repo, "live.txt"))).toBe(false);
  }, 240_000);
});
