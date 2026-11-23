import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAILBOX_CONTEXT_LIMIT, messageFileName } from "../src/shared/mailbox";
import { mailboxEnvelope, realMailboxDeps, runMailbox } from "./mailbox";

function box(files: { at: number; id: string; text: string }[]): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "mbx-"));
  const dir = join(root, "term-1");
  mkdirSync(dir);
  for (const f of files) writeFileSync(join(dir, messageFileName(f.at, f.id)), JSON.stringify({ id: f.id, text: f.text, intro: "Shipherd 信箱：{n} 条" }));
  return { root, dir };
}

const env = { SHIPHERD_SESSION: "term-1" };
const stdin = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read" });

describe("runMailbox", () => {
  it("claims every queued file, sends them in order as one additionalContext, and marks them done after commit", () => {
    const { root, dir } = box([{ at: 2, id: "b", text: "second" }, { at: 1, id: "a", text: "first" }]);
    const run = runMailbox(stdin, env, root);
    const out = JSON.parse(run.out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toBe("Shipherd 信箱：2 条\n\n---\n\nfirst\n\n---\n\nsecond");
    expect(readdirSync(dir).every((n) => n.includes(".taken-"))).toBe(true);
    run.commit();
    expect(readdirSync(dir).sort()).toEqual([`${messageFileName(1, "a")}.done`, `${messageFileName(2, "b")}.done`]);
    // 再来一次：没有可送的。
    expect(runMailbox(stdin, env, root).out).toBe("");
  });

  it("a sub-agent's tool call sends nothing: its additionalContext would not reach the main session", () => {
    const { root, dir } = box([{ at: 1, id: "a", text: "x" }]);
    expect(runMailbox(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read", agent_id: "agent-1", agent_type: "Explore" }), env, root).out).toBe("");
    expect(readdirSync(dir)).toEqual([messageFileName(1, "a")]);
  });

  it("touches the file when it claims it and when it marks it done, so main can tell when it was delivered", () => {
    const { root, dir } = box([{ at: 1, id: "a", text: "x" }]);
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(dir, messageFileName(1, "a")), old, old);
    const before = Date.now() - 1000;
    const run = runMailbox(stdin, env, root);
    const [taken] = readdirSync(dir);
    expect(statSync(join(dir, taken)).mtimeMs).toBeGreaterThan(before);
    run.commit();
    expect(statSync(join(dir, `${messageFileName(1, "a")}.done`)).mtimeMs).toBeGreaterThan(before);
  });

  it("rollback puts claimed files back", () => {
    const { root, dir } = box([{ at: 1, id: "a", text: "first" }]);
    runMailbox(stdin, env, root).rollback();
    expect(readdirSync(dir)).toEqual([messageFileName(1, "a")]);
  });

  it("answers PostToolUseFailure with the matching event name", () => {
    const { root } = box([{ at: 1, id: "a", text: "x" }]);
    const run = runMailbox(JSON.stringify({ hook_event_name: "PostToolUseFailure", tool_name: "Bash" }), env, root);
    expect(JSON.parse(run.out).hookSpecificOutput.hookEventName).toBe("PostToolUseFailure");
  });

  it("sends nothing after Agent / Task, without a session id, or when the folder is gone", () => {
    const { root, dir } = box([{ at: 1, id: "a", text: "x" }]);
    expect(runMailbox(JSON.stringify({ tool_name: "Agent" }), env, root).out).toBe("");
    expect(runMailbox(JSON.stringify({ tool_name: "Task" }), env, root).out).toBe("");
    expect(runMailbox(stdin, {}, root).out).toBe("");
    expect(runMailbox(stdin, { SHIPHERD_SESSION: "nope" }, root).out).toBe("");
    expect(readdirSync(dir)).toEqual([messageFileName(1, "a")]);
  });

  it("keeps what does not fit for the next tool call, but always sends the first one", () => {
    const big = "x".repeat(MAILBOX_CONTEXT_LIMIT - 100);
    const { root, dir } = box([{ at: 1, id: "a", text: big }, { at: 2, id: "b", text: "y".repeat(500) }, { at: 3, id: "c", text: "z" }]);
    const run = runMailbox(stdin, env, root);
    expect(JSON.parse(run.out).hookSpecificOutput.additionalContext).toContain(big);
    run.commit();
    expect(readdirSync(dir).sort()).toEqual([`${messageFileName(1, "a")}.done`, messageFileName(2, "b"), messageFileName(3, "c")]);
  });

  it("skips a file another process already took", () => {
    const { root } = box([{ at: 1, id: "a", text: "first" }, { at: 2, id: "b", text: "second" }]);
    let calls = 0;
    const run = runMailbox(stdin, env, root, {
      ...realMailboxDeps,
      rename: (a, b) => {
        if (calls++ === 0) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        realMailboxDeps.rename(a, b);
      },
    });
    expect(JSON.parse(run.out).hookSpecificOutput.additionalContext).toBe("Shipherd 信箱：1 条\n\n---\n\nsecond");
  });

  it("the envelope names the terminal", () => {
    expect(mailboxEnvelope(env, 5)).toEqual({ v: 1, receivedAt: 5, ticket: null, shipherdSession: "term-1", payload: { hook_event_name: "ShipherdMailbox", session_id: "term-1" } });
  });
});
