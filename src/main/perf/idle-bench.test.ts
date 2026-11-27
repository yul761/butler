import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { projectMcpApprovalSettings } from "../claude/project-mcp";
import { openDatabase } from "../db/database";
import { SessionsRepo } from "../db/sessions-repo";
import { UsageRepo } from "../db/usage-repo";
import { RepoIdentity } from "../lessons/repo-identity";
import { readProcTable } from "../procs/proc-table";
import { TranscriptLocator } from "../sessions/discovery";
import { sampleProcTree } from "../sessions/proc-tree";
import { makeRepo, tempDir } from "../test-utils";
import { UsageScanner } from "../usage/usage-scanner";

/**
 * 空闲开销的微基准（BTL-275）：只在 SHIPHERD_PERF_BENCH=1 时跑，打印数字给 PR 说明用，不做断言。
 * 每一项量的是空闲时反复发生的那一下：一次自动提交的写、一次 usage 扫描写了几次库、找一个还没有记录文件的 session、
 * 开 session 时算 MCP 审批、第一次 lessons:state、读一次进程表。栈 tick 的数字在 stack-service.test.ts，
 * 窗口隐藏时的推送和整体 CPU 在 e2e/perf-idle.spec.ts。
 */
const bench = process.env.SHIPHERD_PERF_BENCH === "1";
vi.setConfig({ testTimeout: 120_000 });

const time = (n: number, fn: (i: number) => void): number => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  return (performance.now() - t0) / n;
};
const lines: string[] = [];
const out = (s: string) => {
  lines.push(s);
  console.log(`[idle-bench] ${s}`);
};

describe.skipIf(!bench)("idle bench (BTL-275)", () => {
  it("3: one autocommit write on a file database", () => {
    const db = openDatabase(join(tempDir("bench-db-"), "app.db"));
    const sync = (db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
    const usage = new UsageRepo(db);
    const ms = time(500, (i) => usage.setCursor(`/f/${i % 20}`, i, i));
    out(`sqlite: synchronous=${sync} (2=FULL, 1=NORMAL), ${ms.toFixed(3)} ms per autocommit write`);
    const sessions = new SessionsRepo(db);
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    for (const id of ids) sessions.insertIfAbsent({ id, ticketKey: null, cwd: "/tmp", origin: "shipherd", createdAt: 0 });
    const record = time(50, (k) => sessions.setMemoryMany(ids.map((id) => ({ id, kb: k, at: k }))));
    out(`memory monitor: writing 20 sessions' memory takes ${record.toFixed(3)} ms per sample`);
    db.close();
  });

  it("3: usage scan writes on unchanged transcripts", async () => {
    const db = openDatabase(join(tempDir("bench-db-"), "app.db"));
    const repo = new UsageRepo(db);
    const dir = tempDir("bench-usage-");
    const files = Array.from({ length: 20 }, (_, i) => {
      const f = join(dir, `s${i}.jsonl`);
      writeFileSync(f, `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`);
      return f;
    });
    const set = vi.spyOn(repo, "setCursor");
    const scanner = new UsageScanner({ repo, sessionIds: () => files.map((_, i) => `s${i}`), transcriptFile: (id) => join(dir, `${id}.jsonl`) });
    await scanner.scanAll();
    set.mockClear();
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) await scanner.scanAll();
    out(`usage scan: ${set.mock.calls.length / 5} cursor writes per scan of 20 unchanged files, ${((performance.now() - t0) / 5).toFixed(2)} ms per scan`);
    db.close();
  });

  it("6: finding a transcript that does not exist yet", () => {
    const projects = tempDir("bench-projects-");
    for (let i = 0; i < 400; i++) mkdirSync(join(projects, `-Users-me-Code-wt-${i}`));
    const loc = new TranscriptLocator(projects);
    const ms = time(200, (i) => loc.find(`missing-${i % 10}`));
    out(`findTranscript: 400 project dirs, ${ms.toFixed(3)} ms per lookup of a session without a transcript (10 sessions, 200 lookups)`);
  });

  it("7: approval settings for a new session with a 5 MB ~/.claude.json", () => {
    const home = tempDir("bench-home-");
    const repo = makeRepo();
    const projects: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i++) projects[`/Users/me/Code/p${i}`] = { allowedTools: [], history: Array.from({ length: 10 }, (_, k) => ({ display: `prompt ${k} `.repeat(20) })) };
    projects[repo] = { enabledMcpjsonServers: ["x"] };
    const claudeJson = join(home, ".claude.json");
    writeFileSync(claudeJson, JSON.stringify({ projects }));
    const size = execFileSync("wc", ["-c", claudeJson], { encoding: "utf8" }).trim().split(/\s+/)[0];
    const mcpDir = join(home, "mcp");
    mkdirSync(mcpDir);
    const ms = time(10, () => expect(projectMcpApprovalSettings([repo], { claudeJson, mcpDir })).not.toBeNull());
    out(`projectMcpApprovalSettings: ~/.claude.json ${(Number(size) / 1e6).toFixed(1)} MB, ${ms.toFixed(2)} ms per session open (main thread, 10 opens)`);
  });

  it("7: the first lessons:state with 10 known repos", async () => {
    const repos = Array.from({ length: 10 }, () => makeRepo());
    for (const r of repos) execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${r.split(/[\\/]/).pop()}.git`], { cwd: r });
    const id = new RepoIdentity();
    const warm = (id as unknown as { warm?: (p: string[]) => Promise<void> }).warm;
    const t0 = performance.now();
    if (warm) await warm.call(id, repos);
    const tWarm = performance.now() - t0;
    const t1 = performance.now();
    for (const r of repos) id.slugOf(r);
    const blocked = performance.now() - t1;
    out(`lessons:state repo identity: main thread blocked ${blocked.toFixed(1)} ms for 10 repos${warm ? ` (async warm-up ${tWarm.toFixed(1)} ms, not blocking)` : ""}`);
  });

  it("other: one process-table read", async () => {
    const n = 10;
    let t0 = performance.now();
    for (let i = 0; i < n; i++) await sampleProcTree(process.pid, []);
    const probe = (performance.now() - t0) / n;
    t0 = performance.now();
    for (let i = 0; i < n; i++) await readProcTable();
    const table = (performance.now() - t0) / n;
    out(`ps: activity probe ${probe.toFixed(1)} ms, memory monitor table ${table.toFixed(1)} ms per read`);
  });
});
