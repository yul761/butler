import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import { memDb } from "../test-utils";
import { fillBranchFromCwd, outsideSessionsOn } from "./outside-sessions";

describe("outsideSessionsOn (BTL-244)", () => {
  it("is off by default and follows the setting", () => {
    const settings = new SettingsRepo(memDb());
    expect(outsideSessionsOn(settings)).toBe(false);
    settings.set("showOutsideSessions", "1");
    expect(outsideSessionsOn(settings)).toBe(true);
    settings.set("showOutsideSessions", "0");
    expect(outsideSessionsOn(settings)).toBe(false);
  });
});

describe("fillBranchFromCwd (BTL-244)", () => {
  const base = { id: "s1", cwd: "/w/repo", gitBranch: null as string | null, origin: "butler" as const, dismissed: false };
  const run = async (s: Partial<typeof base>, branch: () => Promise<string> = async () => "feature/x", tried = new Set<string>()) => {
    const filled: Array<[string, string]> = [];
    const asked: string[] = [];
    await fillBranchFromCwd({ ...base, ...s }, {
      tried,
      currentBranch: (cwd) => (asked.push(cwd), branch()),
      fill: (id, b) => filled.push([id, b]),
    });
    return { filled, asked, tried };
  };

  it("reads the branch of a Butler session's directory once", async () => {
    const tried = new Set<string>();
    expect((await run({}, undefined, tried)).filled).toEqual([["s1", "feature/x"]]);
    expect((await run({}, undefined, tried)).asked).toEqual([]);
  });

  it("leaves sessions that have a branch, no directory, are outside Butler or dismissed", async () => {
    for (const s of [{ gitBranch: "main" }, { cwd: "" }, { origin: "discovered" as never }, { dismissed: true }]) {
      const r = await run(s);
      expect(r.asked).toEqual([]);
      expect(r.filled).toEqual([]);
    }
  });

  it("stores nothing for a detached HEAD or a directory that is not a repo", async () => {
    expect((await run({}, async () => "HEAD")).filled).toEqual([]);
    const r = await run({}, async () => {
      throw new Error("not a git repository");
    });
    expect(r.filled).toEqual([]);
    expect(r.tried.has("s1")).toBe(true);
  });
});
