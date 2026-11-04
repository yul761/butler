import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { prInfo } from "./gh";

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

/** PATH 最前面放一个假的 gh。 */
function fakeGh(script: string): string {
  const dir = tempDir();
  writeFileSync(join(dir, "gh"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
  return dir;
}

describe.skipIf(process.platform === "win32")("prInfo", () => {
  it("parses gh's JSON and passes the pr argument", async () => {
    const dir = fakeGh(
      `echo "$@" > "$(dirname "$0")/args.txt"\ncat <<'JSON'\n{"number":7,"url":"https://x/pull/7","headRefName":"feat","baseRefName":"main","state":"OPEN","autoMergeRequest":{"enabledAt":"x"}}\nJSON`,
    );
    expect(await prInfo(dir, "7", 5000)).toEqual({ number: 7, url: "https://x/pull/7", head: "feat", base: "main", state: "OPEN", autoMerge: true });
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe("pr view 7 --json number,url,headRefName,baseRefName,state,autoMergeRequest");
  });

  it("autoMerge is false when autoMergeRequest is null", async () => {
    const dir = fakeGh(`echo '{"number":1,"url":"u","headRefName":"h","baseRefName":"b","state":"MERGED","autoMergeRequest":null}'`);
    expect((await prInfo(dir, null, 5000))?.autoMerge).toBe(false);
  });

  it("returns null when gh fails, prints junk, is missing, or times out", async () => {
    const dir = fakeGh("exit 1");
    expect(await prInfo(dir, null, 5000)).toBeNull();
    fakeGh("echo not json");
    expect(await prInfo(dir, null, 5000)).toBeNull();
    fakeGh("sleep 5");
    const t = Date.now();
    expect(await prInfo(dir, null, 200)).toBeNull();
    expect(Date.now() - t).toBeLessThan(3000);
    process.env.PATH = tempDir();
    expect(await prInfo(dir, null, 5000)).toBeNull();
  });
});
