import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { resetGhBinary } from "../tickets/gh";
import { fileAt, parseAnchors, prDiff, reviewCommentAnchors } from "./gh-backtest";

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
  resetGhBinary();
});

function fakeGh(script: string): string {
  const dir = tempDir();
  writeFileSync(join(dir, "gh"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
  return dir;
}

describe("parseAnchors", () => {
  it("reads REST comment lines and keeps the original commit and line", () => {
    const text = [
      JSON.stringify({ id: 5, user: { login: "rev" }, path: "a.ts", line: null, original_line: 12, original_commit_id: "abc1234" }),
      "",
      JSON.stringify({ id: 6, user: null, path: "b.ts", line: 3 }),
    ].join("\n");
    expect(parseAnchors(text)).toEqual([
      { id: 5, author: "rev", path: "a.ts", line: null, originalLine: 12, originalCommit: "abc1234" },
      { id: 6, author: "", path: "b.ts", line: 3, originalLine: null, originalCommit: null },
    ]);
    expect(parseAnchors("junk")).toBeNull();
    expect(parseAnchors(null)).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("gh calls", () => {
  it("prDiff passes the PR number and the repo", async () => {
    const dir = fakeGh(`echo "$@" > "$(dirname "$0")/args.txt"; echo "$GH_REPO" >> "$(dirname "$0")/args.txt"; echo 'diff --git a/x b/x'`);
    expect(await prDiff(dir, 7, "acme/web")).toBe("diff --git a/x b/x\n");
    expect(readFileSync(join(dir, "args.txt"), "utf8")).toBe("pr diff 7 --color never\nacme/web\n");
    fakeGh("exit 1");
    expect(await prDiff(dir, 7, null)).toBeNull();
  });

  it("reviewCommentAnchors pages through the REST comments", async () => {
    const dir = fakeGh(`echo "$@" > "$(dirname "$0")/args.txt"; echo '{"id":1,"user":{"login":"a"},"path":"x.ts","original_line":2,"original_commit_id":"abcdef0"}'`);
    expect(await reviewCommentAnchors(dir, 3, null)).toEqual([{ id: 1, author: "a", path: "x.ts", line: null, originalLine: 2, originalCommit: "abcdef0" }]);
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe("api repos/{owner}/{repo}/pulls/3/comments --paginate --jq .[]");
  });

  it("fileAt reads the local clone first and falls back to GitHub", async () => {
    const repo = tempDir();
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
    writeFileSync(join(repo, "a.ts"), "﻿line1\nline2\n");
    writeFileSync(join(repo, "bin.dat"), Buffer.from([1, 0, 2]));
    execFileSync("git", ["add", "-A"], { cwd: repo, env });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"], { cwd: repo, env });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    fakeGh("exit 1");
    expect(await fileAt(repo, null, sha, "a.ts")).toEqual({ status: "ok", content: "line1\nline2\n" });
    expect(await fileAt(repo, null, sha, "bin.dat")).toEqual({ status: "binary", content: null });
    expect(await fileAt(repo, null, sha, "nope.ts")).toEqual({ status: "missing", content: null });
    expect(await fileAt(repo, null, "not-a-sha", "a.ts")).toEqual({ status: "failed", content: null });
    const gh = fakeGh(`echo "$@" > "$(dirname "$0")/args.txt"; printf 'remote'`);
    expect(await fileAt(repo, "acme/web", "1234567890abcdef", "dir/a b.ts")).toEqual({ status: "ok", content: "remote" });
    expect(readFileSync(join(gh, "args.txt"), "utf8").trim()).toBe("api -H Accept: application/vnd.github.raw repos/{owner}/{repo}/contents/dir/a%20b.ts?ref=1234567890abcdef");
    fakeGh(`echo 'gh: Not Found (HTTP 404)' >&2; exit 1`);
    expect(await fileAt(repo, null, "1234567890abcdef", "a.ts")).toEqual({ status: "missing", content: null });
  });
});
