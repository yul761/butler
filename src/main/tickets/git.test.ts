import { describe, expect, it } from "vitest";
import { GIT_SUMMARY_LIMIT, GitError, gitEnv, gitErrorSummary } from "./git";

describe("git helpers", () => {
  it("runs git in the C locale so error lines are always English", () => {
    expect(gitEnv({ LANG: "de_DE.UTF-8", PATH: "/bin" })).toMatchObject({ LANG: "de_DE.UTF-8", LC_ALL: "C", PATH: "/bin" });
  });

  it("caps the summary shown to the user", () => {
    const e = new GitError("git x failed", `fatal: ${"a".repeat(1000)}\n`);
    expect(gitErrorSummary(e)).toHaveLength(GIT_SUMMARY_LIMIT);
    expect(gitErrorSummary(new GitError("m", "hint: x\nerror: bad ref\n"))).toBe("bad ref");
  });
});
