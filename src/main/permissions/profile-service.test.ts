import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadlessOutcome, HeadlessRequest } from "../claude/headless";
import { PermissionProfileRepo } from "../db/interrupts-repo";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import { memDb } from "../test-utils";
import { PermissionProfileService } from "./profile-service";

const NOW = Date.now();
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shipherd-profile-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function history(session: string, commands: string[], cwd = "/w/app"): void {
  mkdirSync(join(dir, "-w-app"), { recursive: true });
  const lines = commands.flatMap((command) => {
    const id = `t${++seq}`;
    return [
      JSON.stringify({ cwd, sessionId: session, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } }),
      JSON.stringify({ cwd, sessionId: session, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }),
    ];
  });
  writeFileSync(join(dir, "-w-app", `${session}.jsonl`), lines.join("\n"));
}

const usage = { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 };
const ok = (structured: unknown): HeadlessOutcome => ({
  ok: true,
  result: { sessionId: null, isError: false, subtype: null, resultText: "", structured, permissionDenials: [], apiErrorStatus: null, costUsd: null, usage, model: null, durationMs: null },
});
function exec(out: HeadlessOutcome, seen: HeadlessRequest[]): HeadlessExecDeps {
  return {
    run: async (req) => (seen.push(req), out),
    ready: async () => undefined,
    claude: () => ({ path: "/bin/claude", pathValue: "/bin" }),
    baseEnv: {},
    sessions: { recordHeadless: () => undefined } as unknown as HeadlessExecDeps["sessions"],
    now: () => 0,
    newRunId: () => "r",
  };
}

function setup(o: { exec?: HeadlessExecDeps; enabled?: string } = {}) {
  const repo = new PermissionProfileRepo(memDb());
  const markEffective = vi.fn();
  const svc = new PermissionProfileService({
    repo, projectsDir: dir, slugOf: (p) => (p.startsWith("/w/app") ? "acme/app" : p.startsWith("/w/lib") ? "acme/lib" : null), exec: o.exec,
    workDir: () => dir, setting: () => o.enabled ?? "1", now: () => NOW, markEffective, log: () => {},
  });
  return { repo, svc, markEffective };
}

describe("PermissionProfileService", () => {
  it("offers candidates from history, and confirmed rules reach sessions of that repository only", async () => {
    history("s1", ["gh pr view 1", "gh pr view 2", "gh run list"]);
    history("s2", ["gh pr view 3", "gh run list", "gh run list", "git push"]);
    const { svc, markEffective } = setup();
    const got = await svc.scan();
    expect(got.candidates.map((c) => c.rule)).toEqual(["Bash(gh pr view:*)", "Bash(gh run list:*)"]);
    svc.decide("acme/app", ["Bash(gh pr view:*)"], ["Bash(gh run list:*)"]);
    expect(markEffective).toHaveBeenCalledWith(NOW);
    expect(svc.state().candidates).toEqual([]);
    expect(svc.rulesForDirs(["/w/app-wt", "/w/lib"])).toEqual(["Bash(gh pr view:*)"]);
    expect(svc.rulesForDirs(["/w/lib", "/elsewhere"])).toEqual([]);
    expect(svc.matchFor("/w/app", { tool: "Bash", command: "gh pr view 9" })).toBe("Bash(gh pr view:*)");
    expect(svc.matchFor("/w/app", { tool: "Bash", command: "gh run list" })).toBeNull();
  });

  it("refuses to store a write rule, and drops one that got into the table anyway", () => {
    const { svc, repo } = setup();
    expect(() => svc.decide("acme/app", ["Bash(git push:*)"], [])).toThrow();
    expect(() => svc.decide("acme/app", ["Bash(gh pr view:*)", "Bash(rm -rf a)"], [])).toThrow();
    expect(() => svc.decide("not a slug", ["Bash(gh pr view:*)"], [])).toThrow();
    expect(repo.all()).toEqual([]);
    repo.set({ slug: "acme/app", rule: "Bash(git push:*)", status: "confirmed", source: "import", at: 1 });
    repo.set({ slug: "acme/app", rule: "Edit", status: "confirmed", source: "import", at: 1 });
    expect(svc.rulesForDirs(["/w/app"])).toEqual([]);
  });

  it("writes nothing into sessions while the switch is off", () => {
    const { svc, repo } = setup({ enabled: "0" });
    repo.set({ slug: "acme/app", rule: "Bash(gh pr view:*)", status: "confirmed", source: "history", at: 1 });
    expect(svc.rulesForDirs(["/w/app"])).toEqual([]);
  });

  it("lets the model explain candidates and mark caution, but never add rules", async () => {
    history("s1", ["gh pr view 1", "gh pr view 2"]);
    history("s2", ["gh pr view 3"]);
    const seen: HeadlessRequest[] = [];
    const { svc } = setup({
      exec: exec(ok({ items: [{ rule: "Bash(gh pr view:*)", why: "reads PRs", caution: true }, { rule: "Bash(git push:*)", why: "x", caution: false }] }), seen),
    });
    await svc.scan();
    const got = await svc.explain();
    expect(got.candidates).toEqual([expect.objectContaining({ rule: "Bash(gh pr view:*)", why: "reads PRs", caution: true })]);
    expect(seen[0]!.args).not.toContain("--allowedTools");
    expect(seen[0]!.prompt).toContain("Bash(gh pr view:*)");
    // 重新扫描保留解释。
    expect((await svc.scan()).candidates[0]!.why).toBe("reads PRs");
  });

  it("shows imported rules as pending until confirmed", () => {
    const { svc, repo } = setup();
    repo.set({ slug: "acme/app", rule: "Bash(gh pr list:*)", status: "pending", source: "import", at: 1 });
    expect(svc.state().pending.map((r) => r.rule)).toEqual(["Bash(gh pr list:*)"]);
    expect(svc.rulesForDirs(["/w/app"])).toEqual([]);
    svc.decide("acme/app", ["Bash(gh pr list:*)"], []);
    expect(svc.state().pending).toEqual([]);
    expect(repo.get("acme/app", "Bash(gh pr list:*)")).toMatchObject({ status: "confirmed", source: "import" });
  });
});
