import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { parseCreatedUrl } from "./gh-stack";
import { bottomBody, dependsLine, draftBody, draftTitle, stackGraph, stripPrefix, T, withDependsLine, withoutDependsLine } from "./pr-text";

describe("stack PR text", () => {
  it("the conflict hand-off turns rerere off, distrusts an old resolution, and pushes with a lease on the full remote sha, in both languages (BTL-278)", () => {
    const sha = "a".repeat(40);
    const p = { branch: "b", files: ["b.txt"], onto: "1111111", upstream: "2222222", above: ["c"], push: true, remote: "origin", remoteSha: sha };
    for (const lang of ["zh", "en"] as const) {
      const t = T(lang).conflict(p);
      expect(t).toContain("git -c rerere.enabled=false rebase --onto 1111111 2222222");
      expect(t).toContain("using previous resolution");
      expect(t).toContain(`git push --force-with-lease=refs/heads/b:${sha} --force-if-includes origin HEAD:refs/heads/b`);
      expect(t).not.toMatch(/--force-with-lease(?!=)/);
      expect(t).toContain("git grep -nE");
      expect(t).toContain("blocked");
      expect(t).not.toMatch(/不会自动套用 rerere|never reuses a resolution rerere/);
    }
    expect(T("zh").conflict(p)).toContain("不 rebase");
    expect(T("en").conflict(p)).toContain("not to rebase");
    // 远端还没有这个分支：lease 锁「不存在」
    expect(T("en").conflict({ ...p, remoteSha: null })).toContain("--force-with-lease=refs/heads/b: --force-if-includes");
    // 强推开关关着：不给推的命令
    for (const lang of ["zh", "en"] as const) expect(T(lang).conflict({ ...p, push: false })).not.toContain("git push");
  });

  it("gives no push command when the remote has commits the branch doesn't (BTL-278)", () => {
    const p = { branch: "b", files: ["b.txt"], onto: "1111111", upstream: "2222222", above: [], push: true, remote: "origin", remoteSha: "c".repeat(40), remoteAhead: true };
    for (const lang of ["zh", "en"] as const) {
      const t = T(lang).conflict(p);
      expect(t).not.toContain("git push");
      expect(t).toContain("ccccccc");
      expect(t).toMatch(/blocked/);
      expect(t).toContain("git -c rerere.enabled=false rebase --skip");
    }
  });

  it.each(["zh", "en"] as const)("following the %s conflict text step by step reuses no recorded resolution even with rerere on globally (BTL-278)", (lang) => {
    const dir = tempDir("shipherd-rr-");
    const cfg = join(dir, "gcfg");
    writeFileSync(cfg, "[user]\n\tname = t\n\temail = t@t\n[rerere]\n\tenabled = true\n");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true" };
    const repo = join(dir, "r");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, env, encoding: "utf8" }).trim();
    const tryGit = (...a: string[]) => spawnSync("git", a, { cwd: repo, env, encoding: "utf8" });
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
    const put = (f: string, t: string) => writeFileSync(join(repo, f), t);
    put("a", "base\n"); put("b", "base\n"); git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "feat");
    put("a", "feat-a\n"); git("commit", "-qam", "fa");
    put("b", "feat-b\n"); git("commit", "-qam", "fb");
    git("checkout", "-q", "main");
    put("a", "main-a\n"); put("b", "main-b\n"); git("commit", "-qam", "m");
    const main = git("rev-parse", "HEAD");
    // 以前有人解过 feat 第二个提交在 main 上的冲突，又放弃了：rr-cache 里记着这个解法
    git("checkout", "-q", "--detach", "main");
    tryGit("cherry-pick", "feat");
    put("b", "ABANDONED\n");
    git("rerere");
    git("cherry-pick", "--abort");
    git("checkout", "-q", "feat");
    // 照着正文做：rebase 命令，解第一个冲突，再用正文给的 --continue
    const t = T(lang).conflict({ branch: "feat", files: ["a"], onto: main, upstream: base, above: [], push: false, remote: "origin", remoteSha: null });
    const cmds = [...t.matchAll(/git -c rerere\.enabled=false rebase (--onto \S+ \S+|--continue)/g)].map((m) => m[0]);
    expect(cmds).toHaveLength(2);
    const run = (cmd: string) => tryGit(...cmd.split(" ").slice(1));
    expect(run(cmds[0]!).status).not.toBe(0);
    put("a", "main-a + feat-a\n");
    git("add", "a");
    const r = run(cmds[1]!);
    // 第二个提交照样停在冲突上，旧解法没有被套用
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/using previous resolution/i);
    expect(readFileSync(join(repo, "b"), "utf8")).toMatch(/^<<<<<<< /m);
    expect(readFileSync(join(repo, "b"), "utf8")).not.toContain("ABANDONED");
    tryGit("rebase", "--abort");
  });

  it("the verify request says nothing was built, and only says push when the rewrite is already pushed (BTL-278)", () => {
    const p = { branch: "b", onto: "1".repeat(40), tip: "2".repeat(40), pushed: true };
    for (const lang of ["zh", "en"] as const) {
      const t = T(lang).verify(p);
      expect(t).toContain("2222222");
      expect(t).toMatch(/没有编译|didn't build/);
      expect(t).toMatch(/blocked/);
      expect(t).not.toMatch(/force-with-lease|push -f|--force /);
      expect(T(lang).verify({ ...p, pushed: false })).toMatch(/先不要推|don't push/);
    }
  });

  it("prefixes draft titles in both languages and strips either prefix", () => {
    expect(draftTitle(3, 6, "Add cache", "zh")).toBe("[stack 3/6 · 勿 review] Add cache");
    expect(draftTitle(3, 6, "[stack 2/6 · 勿 review] Add cache", "en")).toBe("[stack 3/6 · do not review] Add cache");
    expect(stripPrefix("[stack 1/2 · do not review] X")).toBe("X");
    expect(stripPrefix("Plain")).toBe("Plain");
  });

  it("writes the depends line first and replaces only that line", () => {
    expect(dependsLine({ prNumber: 123, branch: "a" }, "zh")).toBe("依赖 #123，暂不需要 review");
    expect(dependsLine({ prNumber: null, branch: "a" }, "en")).toBe("Depends on branch `a`; no review needed yet");
    const body = "依赖 #1，暂不需要 review\n\n<!-- shipherd:brief -->x<!-- /shipherd:brief -->";
    expect(withDependsLine(body, "依赖 #2，暂不需要 review")).toBe("依赖 #2，暂不需要 review\n\n<!-- shipherd:brief -->x<!-- /shipherd:brief -->");
    expect(withDependsLine("hello", "Depends on #2; no review needed yet")).toBe("Depends on #2; no review needed yet\n\nhello");
    expect(withoutDependsLine(body)).toBe("<!-- shipherd:brief -->x<!-- /shipherd:brief -->");
    expect(withoutDependsLine("hello")).toBe("hello");
  });

  it("draws the stack and marks the layer to review", () => {
    const g = stackGraph([
      { branch: "a", prNumber: 1, state: "merged", title: "A" },
      { branch: "b", prNumber: 2, state: "ready", title: "B" },
      { branch: "c", prNumber: null, state: "branch_only", title: null },
    ], 1, "en");
    expect(g).toBe("1. #1 A · merged\n2. **#2 B** · ready for review ← review this one now\n3. `c` · branch");
  });

  it("puts the brief before the commit list on the bottom PR", () => {
    const body = bottomBody({ k: 2, n: 4, brief: "## Brief\nok", commits: ["b one"], graph: [], current: 0, above: ["c", "d"] }, "en");
    expect(body.indexOf("## Brief")).toBeLessThan(body.indexOf("### Commits"));
    expect(body).toContain("Still above: `c` → `d`");
    expect(bottomBody({ k: 1, n: 1, brief: null, commits: [], graph: [], current: 0, above: [] }, "zh")).toContain("这是最后一层");
  });

  it("starts a draft body with the depends line", () => {
    expect(draftBody({ prNumber: 5, branch: "a" }, [], 1, "zh").split("\n")[0]).toBe("依赖 #5，暂不需要 review");
  });

  it("has the same keys in both languages", () => {
    expect(Object.keys(T("en")).sort()).toEqual(Object.keys(T("zh")).sort());
  });

  it("parses the URL gh prints after creating", () => {
    expect(parseCreatedUrl("Warning: 1 uncommitted change\nhttps://github.com/acme/app/pull/12\n")).toEqual({ number: 12, url: "https://github.com/acme/app/pull/12" });
    expect(parseCreatedUrl("https://ghe.example.com/acme/app/issues/3")).toEqual({ number: 3, url: "https://ghe.example.com/acme/app/issues/3" });
    expect(parseCreatedUrl("nope")).toBeNull();
  });
});
