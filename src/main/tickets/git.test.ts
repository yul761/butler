import { describe, expect, it } from "vitest";
import { GIT_SUMMARY_LIMIT, GitError, gitEnv, gitErrorSummary } from "./git";

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
