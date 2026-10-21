import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRepo } from "../test-utils";
import { headlessArgs, READ_ONLY_TOOLS, runHeadless } from "./headless";
import { locateClaude, readLoginShellPath } from "./locate";
import { headlessEnv } from "./spawn";

/**
 * 只在 BUTLER_LIVE_CLAUDE=1 时运行：真的调用一次本机已登录的 claude（会花一点公司额度）。
 * 它验证 dontAsk + --json-schema 能拿到结构化结果，并且写工具被拒绝。
 */
describe.skipIf(!process.env.BUTLER_LIVE_CLAUDE)("runHeadless against the real claude", () => {
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
      env: headlessEnv(process.env, { pathValue, runId: "live-test" }),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.structured).toMatchObject({ gitClean: true, wroteFile: false });
    expect(existsSync(join(repo, "live.txt"))).toBe(false);
  }, 240_000);
});
