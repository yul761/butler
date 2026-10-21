import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { headlessEnv } from "./spawn";
import { tempDir, writeFakeClaude } from "../test-utils";
import { parseInitMessage, probeMcpTools, suggestReadOnly } from "./mcp-probe";

/** 有界轮询：等文件出现并返回内容；超时抛错。 */
async function waitForFile(path: string, ms: number): Promise<string> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`file not written within ${ms} ms: ${path}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return readFileSync(path, "utf8");
}

/** 有界轮询：进程是否在 ms 毫秒内死掉。 */
async function waitUntilDead(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 验证记录 V3：stream-json 的 init 消息（只保留相关字段）。 */
const INIT = {
  type: "system",
  subtype: "init",
  session_id: "1a93e8a0-a73c-4593-8318-88675b321cff",
  tools: ["Read", "Bash", "mcp__spike__echo", "mcp__spike__secret", "mcp__claude_ai_Claude_Docs__batch"],
  mcp_servers: [
    { name: "spike", status: "connected" },
    { name: "plugin:stripe:stripe", status: "needs-auth" },
    { name: "claude.ai Claude Docs", status: "connected" },
  ],
};
const env = () => ({ ...process.env }) as Record<string, string>;

describe("parseInitMessage", () => {
  it("keeps MCP tools and servers from the init line", () => {
    expect(parseInitMessage(JSON.stringify(INIT))).toEqual({
      servers: INIT.mcp_servers,
      tools: ["mcp__claude_ai_Claude_Docs__batch", "mcp__spike__echo", "mcp__spike__secret"],
      suggested: [],
    });
    expect(parseInitMessage(JSON.stringify({ type: "system", subtype: "hook_started" }))).toBeNull();
    expect(parseInitMessage("garbage")).toBeNull();
  });
});

describe("suggestReadOnly", () => {
  it("pre-selects tools whose names read like queries", () => {
    expect(
      suggestReadOnly([
        "mcp__jira__getIssue", "mcp__jira__createIssue", "mcp__atlassian__searchJiraIssuesUsingJql",
        "mcp__linear__list_issues", "mcp__x__target_update", "mcp__gitlab__get_merge_request",
      ]),
    ).toEqual(["mcp__jira__getIssue", "mcp__atlassian__searchJiraIssuesUsingJql", "mcp__linear__list_issues"]); // get_merge_request is dropped on purpose: "merge" is a write word
  });
});

describe("probeMcpTools", () => {
  it("returns as soon as the init line arrives and stops claude", async () => {
    const dir = tempDir();
    const init = { ...INIT, tools: ["Read", "mcp__jira__get_issue"] };
    const fake = writeFakeClaude(dir, `emit({ type: "system", subtype: "hook_started" }); emit(${JSON.stringify(init)}); setTimeout(() => {}, 60000);`);
    const started = Date.now();
    const probe = await probeMcpTools({ claudePath: fake.path, cwd: dir, env: env() });
    expect(probe.tools).toEqual(["mcp__jira__get_issue"]);
    expect(probe.suggested).toEqual(["mcp__jira__get_issue"]);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fake.calls()[0].args).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", "dontAsk", "--setting-sources", "user"]);
  }, 20_000);

  it("rejects when claude exits without an init line", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, 'process.stdout.write("oops\\n");');
    await expect(probeMcpTools({ claudePath: fake.path, cwd: dir, env: env() })).rejects.toThrow("init");
  });
});

describe("probeMcpTools settling and cleanup", () => {
  it("rejects after the timeout when init never arrives, and kills the process", async () => {
    const dir = tempDir();
    const pidFile = join(dir, "pid");
    const fake = writeFakeClaude(dir, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`);
    await expect(probeMcpTools({ claudePath: fake.path, cwd: dir, env: env(), timeoutMs: 800 })).rejects.toThrow("init");
    if (process.platform === "win32") return;
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("rejects on abort", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, "setTimeout(() => {}, 60000);");
    const ac = new AbortController();
    const p = probeMcpTools({ claudePath: fake.path, cwd: dir, env: env(), signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toThrow("取消");
    await expect(probeMcpTools({ claudePath: fake.path, cwd: dir, env: env(), signal: ac.signal })).rejects.toThrow("取消");
  }, 20_000);

  it("kills grandchildren (orphan MCP servers) and uses the headless env, prompt via stdin only", async () => {
    const dir = tempDir();
    const gcPid = join(dir, "gc");
    const body = `const gc = require("child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
require("fs").writeFileSync(${JSON.stringify(gcPid)}, String(gc.pid));
emit(${JSON.stringify(INIT)}); setTimeout(() => {}, 60000);`;
    const fake = writeFakeClaude(dir, body);
    const e = headlessEnv(process.env, { pathValue: process.env.PATH ?? "", runId: "probe1" });
    await probeMcpTools({ claudePath: fake.path, cwd: dir, env: e });
    const call = fake.calls()[0];
    expect(call.butlerSession).toBe("headless:probe1");
    expect(call.input).toBe("Reply with OK.");
    expect(call.args.join(" ")).not.toContain("Reply with OK");
    if (process.platform === "win32") return;
    // 孙进程的 pid 文件由子进程写，有界地等它出现，再短轮询确认它真的死了。
    const pid = Number(await waitForFile(gcPid, 5000));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(await waitUntilDead(pid, 2000)).toBe(true);
  }, 20_000);
});

describe("suggestReadOnly mixed verbs and server names", () => {
  it("rejects tools with any write word", () => {
    const bad = ["getXMLDelete", "search_and_deploy", "list_and_cancel", "read_and_reset", "issue_get", "getOrCreateIssue", "get_or_create_user", "search_and_replace", "find_and_delete", "list_and_transition", "execute_query", "run_query"].map((n) => `mcp__x__${n}`);
    expect(suggestReadOnly(bad)).toEqual([]);
    const good = ["get_issue", "searchIssues", "list_projects", "getJSONIssue"].map((n) => `mcp__x__${n}`);
    expect(suggestReadOnly(good)).toEqual(good);
    // A leading word that is the server's own name is skipped.
    expect(suggestReadOnly(["mcp__jira__jira_get_issue"], ["jira"])).toEqual(["mcp__jira__jira_get_issue"]);
  });

  it("ignores words in the server part, including servers with __", () => {
    const servers = ["Linear (Read-only)"];
    expect(suggestReadOnly(["mcp__Linear__Read-only___create_issue"], servers)).toEqual([]);
    expect(suggestReadOnly(["mcp__Linear__Read-only___get_issue"], servers)).toEqual(["mcp__Linear__Read-only___get_issue"]);
    expect(suggestReadOnly(["mcp__Linear__Read-only___make_issue"], servers)).toEqual([]);
    expect(suggestReadOnly(["mcp__get__make_issue"])).toEqual([]);
  });
});

describe("probeMcpTools stream handling", () => {
  it("handles split chunks (inside a multi-byte char), junk lines, and no trailing newline", async () => {
    const dir = tempDir();
    const init = { ...INIT, tools: ["mcp__jira__get_issue"], mcp_servers: [{ name: "jira 中文", status: "connected" }] };
    const body = `const b = Buffer.from(JSON.stringify(${JSON.stringify(init)}));
const cut = b.indexOf(Buffer.from("中")) + 1;
process.stdout.write("not json\\n{broken\\n");
process.stdout.write(b.subarray(0, cut));
setTimeout(() => { process.stdout.write(b.subarray(cut)); process.exit(0); }, 200);`;
    const fake = writeFakeClaude(dir, body);
    const probe = await probeMcpTools({ claudePath: fake.path, cwd: dir, env: env() });
    expect(probe.servers[0].name).toBe("jira 中文");
    expect(probe.tools).toEqual(["mcp__jira__get_issue"]);
  }, 20_000);

  it("rejects when output exceeds the buffer cap", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, `const chunk = "x".repeat(1 << 20); let n = 0; const t = setInterval(() => { process.stdout.write(chunk); if (++n > 12) clearInterval(t); }, 5); setTimeout(() => {}, 30000);`);
    await expect(probeMcpTools({ claudePath: fake.path, cwd: dir, env: env() })).rejects.toThrow("过大");
  }, 20_000);
});
