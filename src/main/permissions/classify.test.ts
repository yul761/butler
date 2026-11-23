import { describe, expect, it } from "vitest";
import { isSafeRule, matchesRule, ruleForCommand, ruleForTool, scanRuleForCommand } from "./classify";

/** 会写东西、执行别的程序、或者绕过规则的命令：永远不能变成规则（设计 2.2）。 */
const WRITE_COMMANDS = [
  "git push", "git push origin main", "git push --force", "git commit -m x", "git commit --amend", "git add .", "git rm a.ts", "git mv a b",
  "git reset --hard", "git checkout main", "git switch -c x", "git merge main", "git rebase main", "git cherry-pick abc", "git revert abc",
  "git branch foo", "git branch -D foo", "git branch -d foo", "git branch -m a b", "git branch --delete foo", "git branch -u origin/main",
  "git tag v1", "git tag -d v1", "git tag -a v1 -m x", "git config user.name x", "git config --unset user.name", "git config --global core.pager less",
  "git stash", "git stash pop", "git stash drop", "git clean -fd", "git fetch", "git pull", "git worktree add ../x", "git worktree remove x",
  "git reflog expire --all", "git remote add x url", "git remote remove origin", "git remote set-url origin x",
  "git log --output=out.txt", "git log --output out.txt", "git diff --output=x", "git diff --ext-diff", "git show --output=x HEAD", "git grep -O foo", "git grep --open-files-in-pager foo",
  "git -c core.pager=sh log", "git -C ../other status", "git --git-dir=x log",
  "rm a", "rm -rf /", "mv a b", "cp a b", "touch a", "mkdir x", "chmod +x a", "ln -s a b", "tee out.txt", "dd if=a of=b",
  "sed -i s/a/b/ f", "sed -n 1p f", "awk '{print}' f", "perl -pi -e x f", "python -c x", "node -e x", "bash -c ls", "sh -c ls", "zsh -c ls",
  "sudo ls", "env FOO=1 ls", "xargs rm", "nohup ls", "timeout 5 rm a", "watch ls", "exec ls", "eval ls", "source x", ". x",
  "FOO=1 gh pr view", "/bin/rm a", "./script.sh", "../bin/x",
  "gh pr merge 1", "gh pr create", "gh pr close 1", "gh pr comment 1 -b x", "gh pr edit 1", "gh pr review 1", "gh pr checkout 1", "gh pr ready 1",
  "gh issue create", "gh issue comment 1", "gh issue close 1", "gh run rerun 1", "gh run cancel 1", "gh repo delete x", "gh release create v1",
  "gh api -X POST repos/a/b/issues", "gh api --method DELETE repos/a/b", "gh api repos/a/b -f title=x", "gh api repos/a/b -F x=1", "gh api graphql -f query=x",
  "gh api repos/a/b --input body.json", "gh api repos/a/b --field x=1", "gh api repos/a/b --raw-field x=1", "gh api repos/a/b -fq x",
  "sort -o out.txt in.txt", "sort --output=out in", "sort -uo out in", "sort --compress-program=sh in", "tree -o out.txt", "rg --pre sh foo", "rg --pre-glob '*.x' foo",
  "fd -x rm", "fd --exec rm", "fd -X rm", "fd --exec-batch rm", "docker -H tcp://x ps", "docker ps -H x", "docker rm x", "docker run x", "docker exec x ls",
  "kubectl delete pod x", "kubectl apply -f x", "kubectl exec x -- ls", "npm install", "npm run build", "pnpm install", "pnpm test", "pnpm run lint", "npm test",
  // 独立 review 找到的：认 diff 选项的 git 命令能 --output 写文件，ls-remote 能跑命令，长选项可以缩写。
  "git rev-list --output=x HEAD", "git shortlog --output=x HEAD", "git reflog show --output=x", "git stash show --output=x", "git stash list --output=x",
  "git rev-list --out=x HEAD", "git log --outp=x", "git diff --ext=x", "git ls-remote --upload-pack=touch", "git ls-remote -u x origin",
  "git grep --open=rm hi", "git grep --open-files=rm hi", "git cat-file --textconv HEAD:a", "git describe --dirty",
  "sort --out=x f", "sort --comp=sh f", "sort -ro x f", "fd --exec-b=rm", "fd --exe rm", "tree --fromfile x", "rg --pr=sh x",
  "kubectl get pods", "kubectl get pods --kubeconfig=x", "kubectl logs x",
  "npx something", "pnpm dlx x", "make", "make test", "cargo build", "go test ./...", "pytest", "vitest",
  // 链、重定向、替换、通配
  "git status && git push", "gh pr view 1 | sh", "gh pr view 1; rm a", "gh pr view 1 > out.txt", "gh pr view 1 >> out", "gh pr view 1 2> err",
  "gh pr view $(rm a)", "gh pr view `rm a`", "gh pr view 1 &", "gh pr list\nrm a", "gh pr view 1 < in", "gh pr view {1,2}", "gh pr view (1)",
  "gh pr list x*", "gh pr list ?", "gh pr list [ab]", "gh pr view ~/x", "gh pr view 'unclosed", "gh pr view \\; rm", "gh pr view 1 # c", "gh pr view !1",
];

/** 不安全的规则字符串（导入的、改过的）：isSafeRule 一律拒绝。 */
const HOSTILE_RULES = [
  "Bash", "Bash()", "Bash(*)", "Bash(:*)", "Bash(git:*)", "Bash(git *)", "Bash(gh:*)", "Bash(gh pr:*)", "Bash(git push:*)", "Bash(git log:*)", "Bash(git branch:*)",
  "Bash(gh api:*)", "Bash(rg:*)", "Bash(sort:*)", "Bash(docker:*)", "Bash(npm:*)", "Bash(pnpm test:*)", "Bash(rm:*)", "Bash(gh pr view 1 && rm a)",
  "Bash(gh pr view:* && rm)", "Bash(git commit -m x)", "Bash(gh pr view *.ts)", "Bash(gh pr view:*:*)", "Bash(command:gh pr view)",
  "Edit", "Edit(*)", "Write", "Write(*)", "Read(~/.ssh/**)", "WebFetch", "WebFetch(domain:*)", "NotebookEdit", "PowerShell", "Agent",
  "mcp__tracker__create_issue", "mcp__tracker__update_issue", "mcp__tracker__get_and_update", "mcp__tracker__list_then_delete", "mcp__tracker__search_and_comment",
  "mcp__tracker__*", "mcp__tracker", "mcp__github__merge_pull_request", "mcp__github__get_file_and_push", "mcp__x__run_query", "mcp__x__execute",
  "mcp__fs__search_replace", "mcp__x__get_or_generate_token", "mcp__x__show_dialog", "mcp__x__get_access_to_url", "mcp__x__list_and_install",
  "Bash(git rev-list:*)", "Bash(git shortlog:*)", "Bash(git reflog show:*)", "Bash(git stash show:*)", "Bash(git ls-remote:*)", "Bash(kubectl get:*)",
  "Bash(git cat-file:*)", "Bash(git describe:*)",
  "mcp__shipherd-sessions__open_session", "mcp__x__getAndDeleteThing", "mcp__x__fetchAndSendMail", "", " ", "bash(gh pr view:*)",
];

describe("permission classifier: the safety boundary", () => {
  it.each(WRITE_COMMANDS)("never turns a write command into a rule: %s", (cmd) => {
    expect(ruleForCommand(cmd)).toBeNull();
    expect(scanRuleForCommand(cmd)).toBeNull();
    expect(isSafeRule(`Bash(${cmd})`)).toBe(false);
  });

  it.each(HOSTILE_RULES)("rejects a hostile rule: %s", (rule) => {
    expect(isSafeRule(rule)).toBe(false);
  });

  it("whatever rule it produces passes isSafeRule, and never a write", () => {
    for (const cmd of WRITE_COMMANDS) {
      const r = ruleForCommand(cmd);
      if (r !== null) throw new Error(`write command produced ${r}`);
    }
  });
});

describe("permission classifier: read-only commands", () => {
  it("gives prefix rules for subcommands whose every argument is read-only", () => {
    expect(ruleForCommand("gh pr view 12")).toBe("Bash(gh pr view:*)");
    expect(ruleForCommand("gh pr checks 12 --watch")).toBe("Bash(gh pr checks:*)");
    expect(ruleForCommand("gh run view 99 --log-failed")).toBe("Bash(gh run view:*)");
    expect(ruleForCommand("gh issue list")).toBe("Bash(gh issue list:*)");
    expect(ruleForCommand("pnpm ls --depth 0")).toBe("Bash(pnpm ls:*)");
    expect(ruleForCommand("git rev-parse HEAD")).toBe("Bash(git rev-parse:*)");
  });

  it("gives exact rules when only some flags are safe", () => {
    expect(ruleForCommand("gh api repos/acme/app/pulls/1/comments")).toBe("Bash(gh api repos/acme/app/pulls/1/comments)");
    expect(ruleForCommand("gh api repos/acme/app --jq '.name'")).toBe("Bash(gh api repos/acme/app --jq '.name')");
    expect(ruleForCommand("git log --oneline -5")).toBe("Bash(git log --oneline -5)");
    expect(ruleForCommand("git branch -a")).toBe("Bash(git branch -a)");
    expect(ruleForCommand("git branch --list 'feat/x'")).toBe("Bash(git branch --list 'feat/x')");
    expect(ruleForCommand("git tag -l v1")).toBe("Bash(git tag -l v1)");
    expect(ruleForCommand("git config --get remote.origin.url")).toBe("Bash(git config --get remote.origin.url)");
    expect(ruleForCommand("sort -u names.txt")).toBe("Bash(sort -u names.txt)");
    expect(ruleForCommand("docker ps -a")).toBe("Bash(docker ps -a)");
    expect(ruleForCommand("git log main~3..HEAD")).toBe("Bash(git log main~3..HEAD)");
  });

  it("does not offer commands Claude Code already runs without asking", () => {
    expect(ruleForCommand("ls -la")).not.toBeNull();
    expect(scanRuleForCommand("ls -la")).toBeNull();
    expect(scanRuleForCommand("git status")).toBeNull();
    expect(scanRuleForCommand("git log --oneline")).toBeNull();
    expect(scanRuleForCommand("gh pr view 1")).toBe("Bash(gh pr view:*)");
  });

  it("accepts the rules it produces, and the space form of a prefix rule", () => {
    expect(isSafeRule("Bash(gh pr view:*)")).toBe(true);
    expect(isSafeRule("Bash(gh pr view *)")).toBe(true);
    expect(isSafeRule("Bash(git log --oneline -5)")).toBe(true);
    expect(isSafeRule("Bash(gh pr view 12)")).toBe(true);
    expect(isSafeRule("mcp__tracker__get_issue")).toBe(true);
  });

  it("accepts read-only MCP tools and refuses Shipherd's own and write tools", () => {
    expect(ruleForTool("mcp__tracker__get_issue")).toBe("mcp__tracker__get_issue");
    expect(ruleForTool("mcp__tracker__searchIssues")).toBe("mcp__tracker__searchIssues");
    expect(ruleForTool("mcp__wiki__list_pages")).toBe("mcp__wiki__list_pages");
    expect(ruleForTool("mcp__tracker__create_issue")).toBeNull();
    expect(ruleForTool("mcp__tracker__issue_get")).toBeNull();
    expect(ruleForTool("mcp__shipherd-memory__recall")).toBeNull();
    expect(ruleForTool("Bash")).toBeNull();
    expect(ruleForTool("Edit")).toBeNull();
  });
});

describe("matchesRule", () => {
  it("follows Claude Code's prefix and exact semantics", () => {
    expect(matchesRule("Bash(gh pr view:*)", { tool: "Bash", command: "gh pr view 1" })).toBe(true);
    expect(matchesRule("Bash(gh pr view:*)", { tool: "Bash", command: "gh pr view" })).toBe(true);
    expect(matchesRule("Bash(gh pr view:*)", { tool: "Bash", command: "gh pr viewx" })).toBe(false);
    expect(matchesRule("Bash(gh pr view:*)", { tool: "Bash", command: "gh pr view 1 && rm a" })).toBe(false);
    expect(matchesRule("Bash(git log -5)", { tool: "Bash", command: "git log -5" })).toBe(true);
    expect(matchesRule("Bash(git log -5)", { tool: "Bash", command: "git log -6" })).toBe(false);
    expect(matchesRule("mcp__tracker__get_issue", { tool: "mcp__tracker__get_issue" })).toBe(true);
    expect(matchesRule("mcp__tracker__get_issue", { tool: "Bash", command: "mcp__tracker__get_issue" })).toBe(false);
  });
});
