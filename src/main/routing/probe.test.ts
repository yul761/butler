import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HeadlessOutcome, HeadlessRequest } from "../claude/headless";
import { SessionsRepo } from "../db/sessions-repo";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import { memDb } from "../test-utils";
import { probeWithHeadless, readClaudeSettingsModel } from "./probe";

function deps(out: HeadlessOutcome, seen: HeadlessRequest[]): HeadlessExecDeps {
  return {
    run: async (req) => {
      seen.push(req);
      return out;
    },
    ready: async () => undefined, claude: () => ({ path: "/c", pathValue: "" }), baseEnv: {}, sessions: new SessionsRepo(memDb()), now: () => 1, newRunId: () => "r",
  };
}

describe("model probe", () => {
  it("passes exactly that model and no tools", async () => {
    const seen: HeadlessRequest[] = [];
    const ok = await probeWithHeadless(deps({ ok: true, result: { sessionId: null, isError: false, subtype: "success", resultText: "", structured: { ok: true }, permissionDenials: [], apiErrorStatus: null, costUsd: 0, usage: null, model: null, durationMs: null } }, seen), "corp-x", "/tmp");
    expect(ok).toEqual({ ok: true });
    const a = seen[0]!.args;
    expect(a.slice(0, 3)).toEqual(["-p", "--model", "corp-x"]);
  });

  it("maps a model_unavailable failure", async () => {
    const r = await probeWithHeadless(deps({ ok: false, reason: "model_unavailable", message: "There's an issue with the selected model", stderr: "", result: null, limit: { kind: "model_unavailable", resetsAt: null, message: "m" } }, []), "ghost", "/tmp");
    expect(r).toMatchObject({ ok: false, hit: { kind: "model_unavailable" } });
  });

  it("reads the model from Claude settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    writeFileSync(join(dir, "s.json"), JSON.stringify({ model: "opus" }));
    expect(await readClaudeSettingsModel(join(dir, "s.json"))).toBe("opus");
    expect(await readClaudeSettingsModel(join(dir, "missing.json"))).toBeNull();
  });
});
