import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeClaude, REQUIRED_FLAGS } from "./capabilities";

/** E2E 的假 claude（e2e/fake-claude/fake-claude.cjs）：REQUIRED_FLAGS 加了参数而它没跟上时，这里先失败，而不是 E2E 里莫名其妙地卡在向导。 */
const FAKE = join(__dirname, "..", "..", "..", "e2e", "fake-claude", "fake-claude.cjs");

const runFake = (_file: string, args: string[]) =>
  new Promise<string>((done, fail) => execFile(process.execPath, [FAKE, ...args], (err, stdout) => (err ? fail(err) : done(stdout))));

describe("the E2E fake claude", () => {
  it("passes Butler's capability probe: every REQUIRED_FLAGS entry is in its --help", async () => {
    const h = await probeClaude("claude", {}, runFake);
    expect(h.error).toBeNull();
    expect(h.version).toBe("2.1.306");
    expect(Object.keys(h.flags)).toEqual([...REQUIRED_FLAGS]);
    expect(h.missingFlags).toEqual([]);
  });
});
