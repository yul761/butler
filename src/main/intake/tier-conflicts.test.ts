import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INTAKE_POLICY_DEFAULTS } from "../../shared/intake";
import { git } from "../tickets/git";
import { makeRepo } from "../test-utils";
import { changedPaths, pathsOverlap, predictConflicts } from "./conflicts";
import { pickTier } from "./tier";

describe("pickTier", () => {
  const p = INTAKE_POLICY_DEFAULTS;
  it("maps size, and risk only raises", () => {
    expect(pickTier("small", "low", p)).toBe("mid");
    expect(pickTier("large", "low", p)).toBe("high");
    expect(pickTier("small", "high", p)).toBe("high");
    const cheap = { ...p, tierSmall: "low" as const, tierMediumRisk: "mid" as const };
    expect(pickTier("small", "low", cheap)).toBe("low");
    expect(pickTier("small", "medium", cheap)).toBe("mid");
    expect(pickTier("large", "medium", cheap)).toBe("high");
  });
});

describe("conflict prediction", () => {
  it("overlap is the same file or a directory prefix", () => {
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src\\ui", "src/ui/Button.tsx")).toBe(true);
    expect(pathsOverlap("src/ab.ts", "src/a")).toBe(false);
    expect(pathsOverlap("Src/A.ts", "src/a.ts", true)).toBe(true);
    expect(pathsOverlap("Src/A.ts", "src/a.ts", false)).toBe(false);
    expect(pathsOverlap("", "src")).toBe(false);
  });

  it("lists the running tickets that overlap; no expected paths means no conflict", () => {
    const running = [{ key: "A-1", paths: ["src/ui/Button.tsx"] }, { key: "A-2", paths: ["docs/x.md"] }];
    expect(predictConflicts(["src/ui/"], running)).toEqual([{ key: "A-1", paths: ["src/ui/"] }]);
    expect(predictConflicts([], running)).toEqual([]);
  });

  it("reads committed, uncommitted and untracked changes against the base", async () => {
    const dir = makeRepo();
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    g("checkout", "-b", "feat");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "a\n");
    g("add", ".");
    g("commit", "-m", "a");
    writeFileSync(join(dir, "README.md"), "changed\n");
    writeFileSync(join(dir, "new.txt"), "n\n");
    expect((await changedPaths(dir, git)).sort()).toEqual(["README.md", "new.txt", "src/a.ts"]);
    expect(await changedPaths(join(dir, "nope"), git)).toEqual([]);
  });
});
