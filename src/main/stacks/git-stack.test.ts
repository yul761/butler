import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeRepo } from "../test-utils";
import { refTips, revParse } from "./git-stack";

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
