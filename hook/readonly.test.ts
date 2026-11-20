import { describe, expect, it } from "vitest";
import { readonlyDecision } from "./readonly";

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const allowed = (input: unknown) => expect(readonlyDecision(input)).toEqual({ allow: true });
const denied = (input: unknown) => {
  const d = readonlyDecision(input);
  expect(d.allow).toBe(false);
  if (!d.allow) expect(d.reason).toMatch(/read-only/i);
};

describe("readonlyDecision", () => {
  it.each(["Read", "Grep", "Glob", "TodoWrite", "ToolSearch"])("allows %s", (t) => allowed({ tool_name: t }));

  it.each(["git status", "git diff HEAD~1 -- src", "git log --oneline -5", "git show abc123:src/a.ts", "git status\t-s"])("allows Bash %s", (c) => allowed(bash(c)));

  it.each([
    "git diff --output=x.patch",
    "git log --output x",
    "git status; rm -rf x",
    "git log | sh",
    "git diff > a",
    "git log `id`",
    "git log $(id)",
    "git status\nrm x",
    "git status && ls",
    "git push",
    "git commit -m x",
    "git checkout .",
    "npm test",
    "ls",
    " git status",
  ])("denies Bash %s", (c) => denied(bash(c)));

  it("denies Bash without a string command", () => {
    denied({ tool_name: "Bash" });
    denied({ tool_name: "Bash", tool_input: { command: 3 } });
  });

  it.each(["Edit", "Write", "NotebookEdit", "Agent", "Task", "WebFetch", "WebSearch"])("denies %s", (t) => denied({ tool_name: t }));

  it.each(["mcp__butler-ticket__recall", "mcp__statecore__facts", "mcp__butler-memory__why"])("allows memory read %s", (t) => allowed({ tool_name: t }));

  it.each(["mcp__butler-ticket__remember", "mcp__butler-sessions__report", "mcp__butler-sessions__ask_user", "mcp__butler-sessions__submit_evidence", "mcp__butler-sessions__pre_review_result", "mcp__butler-sessions__progress_overview", "mcp__vercel__list_projects"])("denies %s", (t) => denied({ tool_name: t }));

  it.each(["mcp__butler-sessions__list_tickets", "mcp__butler-sessions__list_repos", "mcp__butler-sessions__session_activity"])("allows sessions read %s", (t) => allowed({ tool_name: t }));

  it.each([null, "x", {}, { tool_name: 3 }])("denies malformed input %j", (i) => denied(i));
});
