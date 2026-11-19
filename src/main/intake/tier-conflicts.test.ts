import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INTAKE_POLICY_DEFAULTS } from "../../shared/intake";
import { git } from "../tickets/git";
import { makeRepo } from "../test-utils";
import { activeInRepo, changedPaths, pathsOverlap, predictConflicts } from "./conflicts";
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

describe("activeInRepo", () => {
  const repo = (repoPath: string, worktreePath: string | null = null) => ({ repoPath, worktreePath });
  const tickets = [
    { key: "A-1", repos: [repo("/w/shop", "/wt/a1")] },
    { key: "A-2", repos: [repo("/w/other", "/wt/a2")] },
    { key: "A-3", repos: [repo("/w/shop/", "/wt/a3")] },
    { key: "A-4", repos: [repo("/W/Shop")] },
    { key: "A-5", repos: [repo("/w/other"), repo("/w/shop", "/wt/a5")] },
  ];
  it("lists tickets in the repo that have an open terminal or hold the merge gate, with what their worktree changed", async () => {
    const asked: string[] = [];
    const out = await activeInRepo("/w/shop", {
      tickets: () => tickets,
      openTerminalCount: (key) => (key === "A-1" || key === "A-2" || key === "A-5" ? 1 : 0),
      heldTickets: () => ["A-3", null],
      workDir: (r) => r.worktreePath ?? r.repoPath,
      changedPaths: async (cwd) => {
        asked.push(cwd);
        return [`${cwd.slice(4)}.ts`];
      },
      samePath: (a, b) => a.replace(/\/+$/, "") === b.replace(/\/+$/, ""),
    });
    // A-2 is in another repo, A-4 has nothing running; A-5 is matched on its second repo.
    expect(out).toEqual([
      { key: "A-1", paths: ["a1.ts"] },
      { key: "A-3", paths: ["a3.ts"] },
      { key: "A-5", paths: ["a5.ts"] },
    ]);
    expect(asked).toEqual(["/wt/a1", "/wt/a3", "/wt/a5"]);
  });

  it("is empty when nothing runs in the repo, without asking git", async () => {
    let gitCalls = 0;
    const out = await activeInRepo("/w/shop", {
      tickets: () => tickets,
      openTerminalCount: () => 0,
      heldTickets: () => [],
      workDir: (r) => r.repoPath,
      changedPaths: async () => (gitCalls++, []),
      samePath: (a, b) => a === b,
    });
    expect(out).toEqual([]);
    expect(gitCalls).toBe(0);
  });
});
