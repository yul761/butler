import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "../test-utils";
import { pushBranch, refTips, revParse } from "./git-stack";

describe("refTips (BTL-275)", () => {
  it("reads several refs in one git call, same answers as revParse: exact names only, missing refs absent, tags peeled", async () => {
    const repo = makeRepo();
    const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
    g("branch", "a");
    g("branch", "ab");
    g("-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "-m", "t", "v1");
    const refs = ["refs/heads/main", "refs/heads/a", "refs/heads/gone", "refs/tags/v1", "refs/heads/a*"];
    const tips = await refTips(repo, refs);
    for (const r of refs) expect(tips.get(r) ?? null, r).toBe(await revParse(repo, r));
    expect([...tips.keys()].sort()).toEqual(["refs/heads/a", "refs/heads/main", "refs/tags/v1"]);
    expect((await refTips(repo, [])).size).toBe(0);
  });
});

describe("pushBranch (BTL-278)", () => {
  it("pushes the commit it is given, not what the branch points at; the first push sets the upstream, a leased one leaves it", async () => {
    const repo = makeRepo();
    const remote = join(tempDir(), "r.git");
    const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", "--bare", remote]);
    g("remote", "add", "origin", remote);
    g("checkout", "-q", "-b", "b");
    const checked = g("rev-parse", "HEAD");
    writeFileSync(join(repo, "x.txt"), "later\n");
    g("add", ".");
    g("commit", "-q", "-m", "later");
    await pushBranch(repo, "origin", "b", null, checked);
    const rp = (r: string) => execFileSync("git", ["rev-parse", r], { cwd: remote, encoding: "utf8" }).trim();
    expect(rp("refs/heads/b")).toBe(checked);
    expect(g("config", "--get", "branch.b.remote")).toBe("origin");
    expect(g("config", "--get", "branch.b.merge")).toBe("refs/heads/b");
    // 有 lease：推给定的提交，lease 不对就不推；不改上游
    g("config", "branch.b.remote", "elsewhere");
    const later = g("rev-parse", "HEAD");
    await expect(pushBranch(repo, "origin", "b", later, later)).rejects.toThrow();
    expect(rp("refs/heads/b")).toBe(checked);
    await pushBranch(repo, "origin", "b", checked, later);
    expect(rp("refs/heads/b")).toBe(later);
    expect(g("config", "--get", "branch.b.remote")).toBe("elsewhere");
  });
});
