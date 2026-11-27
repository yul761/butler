import { describe, expect, it } from "vitest";
import { classifyBypass, classifyGateCommand, gatePrCreate, classifyPush, classifyShip } from "./gate-command";

describe("classifyGateCommand", () => {
  it("recognises gh pr merge", () => {
    expect(classifyGateCommand("gh pr merge 12 --squash")).toEqual({ kind: "pr_merge", dir: null, pr: "12", repo: null });
    expect(classifyGateCommand("gh pr merge --auto --squash")).toEqual({ kind: "pr_merge", dir: null, pr: null, repo: null });
    expect(classifyGateCommand("cd /w/backend && gh pr merge https://github.com/a/b/pull/7")).toEqual({
      kind: "pr_merge",
      dir: "/w/backend",
      pr: "https://github.com/a/b/pull/7",
      repo: "a/b",
    });
  });
  it("takes the repository of gh pr merge from -R/--repo or the PR link (BTL-267)", () => {
    expect(classifyGateCommand("gh pr merge 868 -R org/dems --squash")).toEqual({ kind: "pr_merge", dir: null, pr: "868", repo: "org/dems" });
    expect(classifyGateCommand("gh pr merge --repo org/dems 868")).toEqual({ kind: "pr_merge", dir: null, pr: "868", repo: "org/dems" });
    expect(classifyGateCommand("gh pr merge --repo=org/dems 868")).toEqual({ kind: "pr_merge", dir: null, pr: "868", repo: "org/dems" });
    expect(classifyGateCommand("gh pr merge 5 -R ghe.corp/org/dems")).toEqual({ kind: "pr_merge", dir: null, pr: "5", repo: "ghe.corp/org/dems" });
    // -R 优先于链接。
    expect(classifyGateCommand("gh pr merge https://github.com/a/b/pull/7 -R c/d")).toMatchObject({ repo: "c/d" });
    // 连写的 -Ro/r、写在 pr 和 merge 之间的 -R、GH_REPO 环境变量。
    expect(classifyGateCommand("gh pr merge 12 -Rorg/dems")).toEqual({ kind: "pr_merge", dir: null, pr: "12", repo: "org/dems" });
    expect(classifyGateCommand("gh pr -R org/dems merge 12 --squash")).toEqual({ kind: "pr_merge", dir: null, pr: "12", repo: "org/dems" });
    expect(classifyGateCommand("gh pr --repo=org/dems merge 12")).toEqual({ kind: "pr_merge", dir: null, pr: "12", repo: "org/dems" });
    expect(classifyGateCommand("GH_REPO=org/dems gh pr merge 12")).toEqual({ kind: "pr_merge", dir: null, pr: "12", repo: "org/dems" });
    expect(classifyGateCommand("GH_REPO=org/dems gh pr merge 12 -R c/d")).toMatchObject({ repo: "c/d" });
    expect(classifyGateCommand("gh pr view 12 -R org/dems")).toBeNull();
    expect(classifyGateCommand("gh pr -R org/dems view 12")).toBeNull();
  });
  it("reads -R=o/r and the repository of a www.github.com or GHE PR link (BTL-267 review)", () => {
    expect(classifyGateCommand("gh pr merge 12 -R=org/dems")).toEqual({ kind: "pr_merge", dir: null, pr: "12", repo: "org/dems" });
    expect(classifyGateCommand("gh pr -R=org/dems merge 12")).toMatchObject({ repo: "org/dems" });
    expect(classifyGateCommand("gh pr merge https://www.github.com/a/b/pull/7")).toMatchObject({ repo: "a/b" });
    expect(classifyGateCommand("gh pr merge https://GitHub.com/a/b/pull/7")).toMatchObject({ repo: "a/b" });
    expect(classifyGateCommand("gh pr merge https://ghe.corp/a/b/pull/7")).toMatchObject({ repo: "ghe.corp/a/b" });
    expect(classifyGateCommand("gh pr merge https://ghe.corp/a/b/issues/7")).toMatchObject({ repo: null });
  });
  it("checks what follows a push of a branch to its own name (BTL-267 review)", () => {
    expect(classifyGateCommand("git push -u origin feature/x && gh pr merge 12 -R org/dems")).toEqual({ kind: "pr_merge", dir: null, pr: "12", repo: "org/dems" });
    expect(classifyGateCommand("git push origin feature/x && git push origin feature/x:main")).toEqual({ kind: "push", dir: null, target: "main", source: "feature/x" });
    // 只有它自己、或者后面没有要审核的：照旧是这个 push。
    expect(classifyGateCommand("git push -u origin feature/x")).toEqual({ kind: "push", dir: null, target: "feature/x", source: "feature/x" });
    expect(classifyGateCommand("git push -u origin feature/x && pnpm test")).toEqual({ kind: "push", dir: null, target: "feature/x", source: "feature/x" });
    // 推 HEAD 的不算推自己的分支。
    expect(classifyGateCommand("git push origin HEAD:main && gh pr merge 12")).toMatchObject({ kind: "push", target: "main" });
  });
  it("joins consecutive relative cd directories (BTL-267)", () => {
    expect(classifyGateCommand("cd /w && cd api && git merge x")).toEqual({ kind: "local_merge", dir: "/w/api", source: "x" });
    expect(classifyGateCommand("cd api && cd /abs && git merge x")).toEqual({ kind: "local_merge", dir: "/abs", source: "x" });
    expect(classifyGateCommand("cd api; cd sub; gh pr merge 3")).toMatchObject({ dir: "api/sub" });
    // `~` 开头是家目录，不拼到前一个目录后面。
    expect(classifyGateCommand("cd foo && cd ~/repo && git merge x")).toEqual({ kind: "local_merge", dir: "~/repo", source: "x" });
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
    expect(classifyGateCommand("cd 'C:\\Users\\me' && gh pr merge 3")).toEqual({ kind: "pr_merge", dir: "C:\\Users\\me", pr: "3", repo: null });
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
    expect(classifyGateCommand("gh pr merge \\\n 12")).toEqual({ kind: "pr_merge", dir: null, pr: "12", repo: null });
    expect(classifyGateCommand("git -C d \\\n merge x")).toEqual({ kind: "local_merge", dir: "d", source: "x" });
  });
  it("recognises gh pr create with --head and --draft (BTL-273)", () => {
    expect(classifyGateCommand("gh pr create --fill")).toEqual({ kind: "pr_create", dir: null, head: null, draft: false, repo: null });
    expect(classifyGateCommand(`cd repo && gh pr create -t "x" --draft -H me:feature/a`)).toEqual({ kind: "pr_create", dir: "repo", head: "feature/a", draft: true, repo: null });
    expect(classifyGateCommand("gh pr new -d --head=feature/b -R o/r")).toEqual({ kind: "pr_create", dir: null, head: "feature/b", draft: true, repo: "o/r" });
    // 标题里有 -d 不是 draft
    expect(classifyGateCommand(`gh pr create -t "-d" -b x`)).toMatchObject({ draft: false });
  });

  it("checks a merge that follows gh pr create in the same command (BTL-273)", () => {
    expect(classifyGateCommand("gh pr create --fill && gh pr merge --auto")).toMatchObject({ kind: "pr_merge" });
    expect(classifyGateCommand("git push -u origin feature/x && gh pr create --fill")).toMatchObject({ kind: "push", source: "feature/x" });
    expect(gatePrCreate("git push -u origin feature/x && gh pr create --fill")).toMatchObject({ kind: "pr_create" });
    // 推 HEAD 时主动作是推送（可能推到别的分支，要照常审）；开 PR 由 gatePrCreate 另外带上
    expect(classifyGateCommand("git push -u origin HEAD && gh pr create --fill")).toMatchObject({ kind: "push" });
    expect(gatePrCreate("git push -u origin HEAD && cd sub && gh pr create --fill -d")).toEqual({ kind: "pr_create", dir: "sub", head: null, draft: true, repo: null });
    expect(gatePrCreate("git push origin HEAD:feat")).toBeNull();
  });

  it("ignores everything else", () => {
    for (const c of [
      "git status", "git push", "git merge --abort", "git merge --continue",
      "git checkout -- src/a.ts", "git checkout .", "git checkout HEAD~1 -- a.ts",
      "gh pr view 12", "gh pr checks 12", "echo 'gh pr create'", "echo 'git merge x'", "git log --merges", "",
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

describe("classifyBypass", () => {
  const hows = (c: string) => classifyBypass(c).map((b) => b.how);

  it("recognises --no-verify and commit -n", () => {
    expect(hows("git commit --no-verify -m wip")).toEqual(["no_verify"]);
    expect(hows("git commit -nm wip")).toEqual(["no_verify"]);
    expect(hows("cd repo && git push --no-verify origin HEAD")).toEqual(["no_verify"]);
    expect(hows("git -C repo merge --no-verify main")).toEqual(["no_verify"]);
    expect(hows("git commit -m 'no verify needed'")).toEqual([]);
    expect(hows("git push -n origin main")).toEqual([]);
    // 带值的短选项后面的字母是值：-uno 是 untracked-files=no，-mn 是提交说明 "n"。
    expect(hows("git commit -uno -m x")).toEqual([]);
    expect(hows("git commit -mn")).toEqual([]);
    expect(hows("git commit -anm x")).toEqual(["no_verify"]);
  });

  it("recognises turning git hooks off", () => {
    expect(hows("git -c core.hooksPath=/dev/null commit -m x")).toEqual(["hooks_off"]);
    expect(hows("git config core.hooksPath /tmp/empty")).toEqual(["hooks_off"]);
    expect(hows("git config --get core.hooksPath")).toEqual([]);
    expect(hows("git config core.hooksPath")).toEqual([]);
    expect(hows("HUSKY=0 git commit -m x")).toEqual(["hooks_off"]);
    expect(hows("SKIP=lint git commit -m x")).toEqual(["hooks_off"]);
    expect(hows("export HUSKY=0; git commit -m x")).toEqual(["hooks_off"]);
    expect(hows("HUSKY=1 git commit -m x")).toEqual([]);
  });

  it("recognises tampering with Shipherd's checks or Claude's hook settings, not reading them", () => {
    expect(hows("rm ~/.shipherd/checks/snapshot.json")).toEqual(["tamper"]);
    expect(hows("echo '{}' > ~/.shipherd/checks/snapshot.json")).toEqual(["tamper"]);
    expect(hows("sed -i '' 's/enforce/warn/' ~/.shipherd/checks/snapshot.json")).toEqual(["tamper"]);
    expect(hows("cp /tmp/s.json .claude/settings.local.json".replace(".claude", "/x/.claude"))).toEqual(["tamper"]);
    expect(hows("SHIPHERD_HOME=/tmp/elsewhere git commit -m x")).toEqual(["tamper"]);
    expect(hows("unset SHIPHERD_SESSION")).toEqual(["tamper"]);
    expect(hows("cat ~/.shipherd/checks/snapshot.json")).toEqual([]);
    expect(hows("grep enforce ~/.shipherd/checks/snapshot.json 2>/dev/null")).toEqual([]);
    expect(hows("rm -rf node_modules")).toEqual([]);
  });

  it("reports each kind once and handles ordinary commands", () => {
    expect(hows("HUSKY=0 git commit --no-verify -m x && git push --no-verify")).toEqual(["hooks_off", "no_verify"]);
    expect(hows("pnpm test && git commit -m ok")).toEqual([]);
    expect(classifyBypass("git commit --no-verify -m x")[0].detail).toBe("git commit --no-verify");
  });
});
