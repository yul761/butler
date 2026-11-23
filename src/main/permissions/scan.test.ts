import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanTranscripts } from "./scan";

const NOW = Date.UTC(2026, 10, 18);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shipherd-scan-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
/** 一次工具调用和它的结果（两行）。 */
function call(cwd: string, session: string, name: string, input: Record<string, unknown>, result: { error?: boolean; text?: string } = {}): string[] {
  const id = `toolu_${++seq}`;
  return [
    JSON.stringify({ type: "assistant", cwd, sessionId: session, message: { content: [{ type: "tool_use", id, name, input }] } }),
    JSON.stringify({ type: "user", cwd, sessionId: session, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: result.error ?? false, content: result.text ?? "ok" }] } }),
  ];
}

function transcript(project: string, session: string, lines: string[], ageDays = 1): void {
  mkdirSync(join(dir, project), { recursive: true });
  const p = join(dir, project, `${session}.jsonl`);
  writeFileSync(p, `${lines.join("\n")}\n`);
  const t = (NOW - ageDays * 86_400_000) / 1000;
  utimesSync(p, t, t);
}

const slugOf = (cwd: string) => (cwd.startsWith("/w/app") ? "acme/app" : cwd.startsWith("/w/lib") ? "acme/lib" : null);
const bash = (command: string) => ({ command });

describe("scanTranscripts", () => {
  it("offers read-only rules that ran at least 3 times across 2 sessions, per repository", async () => {
    transcript("-w-app", "s1", [...call("/w/app", "s1", "Bash", bash("gh pr view 1")), ...call("/w/app", "s1", "Bash", bash("gh pr view 2"))]);
    transcript("-w-app-wt", "s2", [...call("/w/app-wt", "s2", "Bash", bash("gh pr view 3")), ...call("/w/app", "s2", "Bash", bash("git push"))]);
    transcript("-w-lib", "s3", [...call("/w/lib", "s3", "Bash", bash("gh pr view 4")), ...call("/w/lib", "s3", "Bash", bash("gh pr view 5")), ...call("/w/lib", "s3", "Bash", bash("gh pr view 6"))]);
    const got = await scanTranscripts({ projectsDir: dir, slugOf, now: NOW });
    expect(got).toEqual([{ slug: "acme/app", rule: "Bash(gh pr view:*)", runs: 3, sessions: 2, example: "gh pr view 1" }]);
  });

  it("never counts writes, failed runs, or anything the user rejected in that repository", async () => {
    const lines = (s: string) => [
      ...call("/w/app", s, "Bash", bash("git push")),
      ...call("/w/app", s, "Bash", bash("gh issue list"), { error: true, text: "boom" }),
      ...call("/w/app", s, "Bash", bash("gh run list")),
      ...call("/w/app", s, "mcp__tracker__get_issue", { key: "X-1" }),
      ...call("/w/app", s, "mcp__tracker__create_issue", {}),
    ];
    transcript("-w-app", "a", [...lines("a"), ...call("/w/app", "a", "Bash", bash("gh run list"))]);
    transcript("-w-app", "b", [...lines("b"), ...call("/w/app", "b", "Bash", bash("gh run list"), { error: true, text: "The user doesn't want to proceed with this tool use." })]);
    const got = await scanTranscripts({ projectsDir: dir, slugOf, now: NOW, minRuns: 2 });
    expect(got.map((c) => c.rule)).toEqual(["mcp__tracker__get_issue"]);
  });

  it("skips old transcripts, oversized files, unknown repositories and broken lines", async () => {
    const three = (s: string, cwd = "/w/app") => [...call(cwd, s, "Bash", bash("gh pr list")), ...call(cwd, s, "Bash", bash("gh pr list"))];
    transcript("-old", "o1", three("o1"), 40);
    transcript("-old", "o2", three("o2"), 40);
    transcript("-x", "x1", three("x1", "/elsewhere"));
    transcript("-x", "x2", ["{not json", ...three("x2", "/elsewhere")]);
    expect(await scanTranscripts({ projectsDir: dir, slugOf, now: NOW })).toEqual([]);
    transcript("-big", "b1", three("b1"));
    transcript("-big", "b2", three("b2"));
    expect(await scanTranscripts({ projectsDir: dir, slugOf, now: NOW, maxBytes: 10 })).toEqual([]);
    expect((await scanTranscripts({ projectsDir: dir, slugOf, now: NOW })).map((c) => c.runs)).toEqual([4]);
  });

  it("returns nothing when the projects directory does not exist", async () => {
    expect(await scanTranscripts({ projectsDir: join(dir, "missing"), slugOf, now: NOW })).toEqual([]);
  });
});
