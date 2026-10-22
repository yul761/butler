import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { applyGitResolution, resetGitBinary, setGitBinary } from "../util/git-path";
import { git, GIT_SUMMARY_LIMIT, GitError, gitEnv, gitErrorSummary } from "./git";

describe("git helpers", () => {
  it("only switches git messages to English and keeps the user's locale for everything else", () => {
    const env = gitEnv({ LANG: "de_DE.UTF-8", LANGUAGE: "de", PATH: "/bin" });
    expect(env.LC_MESSAGES).toBe("C");
    expect(env.LC_ALL).toBeUndefined();
    expect(env.LANGUAGE).toBeUndefined();
    expect(env.LANG).toBe("de_DE.UTF-8");
    expect(env.PATH).toBe("/bin");
  });

  it("leaves a user's own LC_ALL alone", () => {
    expect(gitEnv({ LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8" })).toMatchObject({ LC_ALL: "fr_FR.UTF-8", LC_MESSAGES: "C", LANG: "fr_FR.UTF-8" });
  });

  it("caps the summary shown to the user", () => {
    const e = new GitError("git x failed", `fatal: ${"a".repeat(1000)}\n`);
    expect(gitErrorSummary(e)).toHaveLength(GIT_SUMMARY_LIMIT);
    expect(gitErrorSummary(new GitError("m", "hint: x\nerror: bad ref\n"))).toBe("bad ref");
  });
});

describe("git invocation", () => {
  it.skipIf(process.platform === "win32")("runs the resolved git with fsmonitor disabled", async () => {
    const dir = tempDir();
    const log = join(dir, "args.txt");
    const fake = join(dir, "git");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\necho ok\n`);
    chmodSync(fake, 0o755);
    setGitBinary(fake);
    try {
      expect(await git(dir, ["status", "--porcelain"])).toBe("ok");
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["-c", "core.fsmonitor=false", "status", "--porcelain"]);
    } finally {
      resetGitBinary();
    }
  });
});

describe("git invocation without git", () => {
  it("rejects with a clear error instead of spawning a bare git (win32 policy)", async () => {
    applyGitResolution(null, "win32", () => undefined);
    try {
      await expect(git(tempDir(), ["status"])).rejects.toThrow("git not found; install Git for Windows or set PATH");
    } finally {
      resetGitBinary();
    }
  });
});
