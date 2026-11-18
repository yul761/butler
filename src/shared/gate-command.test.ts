import { describe, expect, it } from "vitest";
import { classifyGateCommand, classifyPush, classifyShip } from "./gate-command";

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
    expect(classifyGateCommand("git push origin HEAD:main")).toEqual({ kind: "push", dir: null, target: "main", source: "HEAD" });
    // 没写 `src:`：推的是同名的本地分支，不管当前在哪个分支上。
    expect(classifyGateCommand("git push origin main")).toEqual({ kind: "push", dir: null, target: "main", source: "main" });
    expect(classifyGateCommand("git push -u origin dms-1")).toEqual({ kind: "push", dir: null, target: "dms-1", source: "dms-1" });
    expect(classifyGateCommand("git push origin HEAD")).toEqual({ kind: "push", dir: null, target: "HEAD", source: "HEAD" });
  });
  it("takes the source of an explicit src:dst refspec", () => {
    expect(classifyGateCommand("git push origin feat:main")).toEqual({ kind: "push", dir: null, target: "main", source: "feat" });
    expect(classifyGateCommand("git push origin +refs/heads/feat/x:refs/heads/main")).toEqual({ kind: "push", dir: null, target: "main", source: "feat/x" });
    // 删除远端分支（:main）不是合并。
    expect(classifyGateCommand("git push origin :main")).toBeNull();
  });
  it("keeps Windows backslashes in double-quoted paths, as bash does", () => {
    expect(classifyGateCommand('cd "C:\\Users\\me\\repo" && git merge feat/x')).toEqual({ kind: "local_merge", dir: "C:\\Users\\me\\repo", source: "feat/x" });
    expect(classifyGateCommand('git -C "D:\\work\\api" push origin HEAD:main')).toEqual({ kind: "push", dir: "D:\\work\\api", target: "main", source: "HEAD" });
    expect(classifyGateCommand("cd 'C:\\Users\\me' && gh pr merge 3")).toEqual({ kind: "pr_merge", dir: "C:\\Users\\me", pr: "3" });
    // 双引号里 \" \\ \$ 仍是转义。
    expect(classifyGateCommand('cd "a\\"b\\\\c\\$d" && git merge x')).toEqual({ kind: "local_merge", dir: 'a"b\\c$d', source: "x" });
    expect(classifyGateCommand("cd /c/Users/me/repo && git merge x")).toEqual({ kind: "local_merge", dir: "/c/Users/me/repo", source: "x" });
    expect(classifyGateCommand("cd C:/w/api\r\ngit merge x\r\n")).toEqual({ kind: "local_merge", dir: "C:/w/api", source: "x" });
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
    expect(classifyGateCommand("git push origin \\\n HEAD:main")).toEqual({ kind: "push", dir: null, target: "main", source: "HEAD" });
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

describe("classifyPush", () => {
  it("recognises pushes with or without a refspec", () => {
    expect(classifyPush("git push")).toEqual({ dir: null });
    expect(classifyPush("git push -u origin HEAD")).toEqual({ dir: null });
    expect(classifyPush("git push origin feature/x --force-with-lease")).toEqual({ dir: null });
    expect(classifyPush("GIT_TRACE=1 git -c core.x=1 push")).toEqual({ dir: null });
  });
  it("takes the directory from -C and cd", () => {
    expect(classifyPush("git -C ../repo push")).toEqual({ dir: "../repo" });
    expect(classifyPush("cd /work/repo && git push")).toEqual({ dir: "/work/repo" });
    expect(classifyPush("cd /work && git -C repo push")).toEqual({ dir: "/work/repo" });
  });
  it("ignores dry runs, deletes and other commands", () => {
    expect(classifyPush("git push --dry-run")).toBeNull();
    expect(classifyPush("git push -n origin x")).toBeNull();
    expect(classifyPush("git push origin --delete old")).toBeNull();
    expect(classifyPush("git push origin :old")).toBeNull();
    expect(classifyPush("git status && echo push")).toBeNull();
    expect(classifyPush("git stash push")).toBeNull();
    expect(classifyPush("echo 'git push'")).toBeNull();
  });
  it("finds the push in a later segment", () => {
    expect(classifyPush("git add -A && git commit -m 'push it' && git push")).toEqual({ dir: null });
  });
});

describe("classifyShip", () => {
  it("takes the pushed branch from the refspec's remote side; HEAD or no refspec is the current branch (null)", () => {
    expect(classifyShip("git push -u origin feat/x")).toEqual([{ kind: "push", dir: null, branch: "feat/x" }]);
    expect(classifyShip("git push origin HEAD")).toEqual([{ kind: "push", dir: null, branch: null }]);
    expect(classifyShip("git push --force-with-lease")).toEqual([{ kind: "push", dir: null, branch: null }]);
    expect(classifyShip("git push origin HEAD:refs/heads/feat/y")).toEqual([{ kind: "push", dir: null, branch: "feat/y" }]);
    expect(classifyShip("git push origin +local:feat/z")).toEqual([{ kind: "push", dir: null, branch: "feat/z" }]);
  });
  it("takes the directory from cd and -C", () => {
    expect(classifyShip("cd /wt/ws-a && git push -u origin feat/a")).toEqual([{ kind: "push", dir: "/wt/ws-a", branch: "feat/a" }]);
    expect(classifyShip("git -C ../wt push")).toEqual([{ kind: "push", dir: "../wt", branch: null }]);
    expect(classifyShip('cd "C:\\wt\\ws a" && git push')).toEqual([{ kind: "push", dir: "C:\\wt\\ws a", branch: null }]);
  });
  it("ignores redirections, unwraps $( ) and ( ) and records every refspec; tag refs are not branches", () => {
    expect(classifyShip("git push origin 2>&1")).toEqual([{ kind: "push", dir: null, branch: null }]);
    expect(classifyShip("git push origin >/dev/null 2>&1")).toEqual([{ kind: "push", dir: null, branch: null }]);
    expect(classifyShip("git push -u origin feat/x > out.log 2>&1")).toEqual([{ kind: "push", dir: null, branch: "feat/x" }]);
    expect(classifyShip("PR=$(gh pr create --fill)")).toEqual([{ kind: "pr_create", dir: null, head: null }]);
    expect(classifyShip("(cd /wt && git push)")).toEqual([{ kind: "push", dir: "/wt", branch: null }]);
    expect(classifyShip("git push origin a b")).toEqual([{ kind: "push", dir: null, branch: "a" }, { kind: "push", dir: null, branch: "b" }]);
    expect(classifyShip("git push origin refs/tags/v2")).toEqual([]);
    expect(classifyShip("echo $(git rev-parse HEAD)")).toEqual([]);
  });
  it("recognises gh pr create with or without --head, and both in one command", () => {
    expect(classifyShip("gh pr create --fill")).toEqual([{ kind: "pr_create", dir: null, head: null }]);
    expect(classifyShip("gh pr create -H owner:feat/x -t t -b body")).toEqual([{ kind: "pr_create", dir: null, head: "feat/x" }]);
    expect(classifyShip("cd /wt && git push -u origin feat/a && gh pr create --title 'x' --body \"$(cat <<'X'\nbody\nX\n)\"")).toEqual([
      { kind: "push", dir: "/wt", branch: "feat/a" },
      { kind: "pr_create", dir: "/wt", head: null },
    ]);
  });
  it("ignores dry runs, deletes, tag pushes and lookalikes", () => {
    expect(classifyShip("git push --dry-run origin x")).toEqual([]);
    expect(classifyShip("git push origin --delete old")).toEqual([]);
    expect(classifyShip("git push origin :old")).toEqual([]);
    expect(classifyShip("git push --tags")).toEqual([]);
    expect(classifyShip("git stash push")).toEqual([]);
    expect(classifyShip("gh pr view 3")).toEqual([]);
    expect(classifyShip("echo 'gh pr create'")).toEqual([]);
  });
});
