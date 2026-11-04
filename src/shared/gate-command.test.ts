import { describe, expect, it } from "vitest";
import { classifyGateCommand } from "./gate-command";

describe("classifyGateCommand", () => {
  it("recognises gh pr merge", () => {
    expect(classifyGateCommand("gh pr merge 12 --squash")).toEqual({ kind: "pr_merge", dir: null, pr: "12" });
    expect(classifyGateCommand("gh pr merge --auto --squash")).toEqual({ kind: "pr_merge", dir: null, pr: null });
    expect(classifyGateCommand("cd /w/backend && gh pr merge https://github.com/a/b/pull/7")).toEqual({
      kind: "pr_merge",
      dir: "/w/backend",
      pr: "https://github.com/a/b/pull/7",
    });
  });
  it("recognises git merge, with -C and env prefixes", () => {
    expect(classifyGateCommand("git -C ../frontend merge feat/x --no-ff")).toEqual({ kind: "local_merge", dir: "../frontend", source: "feat/x" });
    expect(classifyGateCommand("FOO=1 git merge dms-2")).toEqual({ kind: "local_merge", dir: null, source: "dms-2" });
    expect(classifyGateCommand("pnpm test && git merge x")).toEqual({ kind: "local_merge", dir: null, source: "x" });
  });
  it("recognises git push with a remote branch", () => {
    expect(classifyGateCommand("git push origin HEAD:main")).toEqual({ kind: "push", dir: null, target: "main" });
    expect(classifyGateCommand("git push origin main")).toEqual({ kind: "push", dir: null, target: "main" });
    expect(classifyGateCommand("git push -u origin dms-1")).toEqual({ kind: "push", dir: null, target: "dms-1" });
  });
  it("recognises branch switches", () => {
    expect(classifyGateCommand("git checkout -b dms-3")).toEqual({ kind: "switch", dir: null, branch: "dms-3", create: true });
    expect(classifyGateCommand("git switch dms-1")).toEqual({ kind: "switch", dir: null, branch: "dms-1", create: false });
    expect(classifyGateCommand("git switch -c dms-4")).toEqual({ kind: "switch", dir: null, branch: "dms-4", create: true });
  });
  it("returns the first reviewed segment and applies cd to later segments", () => {
    expect(classifyGateCommand("cd /w && git status; git merge a || git merge b")).toEqual({ kind: "local_merge", dir: "/w", source: "a" });
  });
  it("treats backslash-newline as whitespace", () => {
    expect(classifyGateCommand("git push origin \\\n HEAD:main")).toEqual({ kind: "push", dir: null, target: "main" });
    expect(classifyGateCommand("git merge \\\n feat/x")).toEqual({ kind: "local_merge", dir: null, source: "feat/x" });
    expect(classifyGateCommand("gh pr merge \\\n 12")).toEqual({ kind: "pr_merge", dir: null, pr: "12" });
    expect(classifyGateCommand("git -C d \\\n merge x")).toEqual({ kind: "local_merge", dir: "d", source: "x" });
  });
  it("ignores everything else", () => {
    for (const c of [
      "git status", "git push", "git merge --abort", "git merge --continue",
      "git checkout -- src/a.ts", "git checkout .", "git checkout HEAD~1 -- a.ts",
      "gh pr view 12", "gh pr create", "echo 'git merge x'", "git log --merges", "",
    ])
      expect(classifyGateCommand(c), c).toBeNull();
  });
});
