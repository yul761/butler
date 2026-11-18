import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MonitorSample } from "./memory-monitor";
import { OrphanSweeper, platformKill } from "./orphans";
import { classifyTree, parsePsTable, summarize, type ProcTable } from "./proc-table";

const L = {
  claude: "  110   100 300000 Mon Nov 17 09:01:00 2026 claude --resume a",
  shell: "  111   110   3000 Mon Nov 17 09:01:01 2026 /bin/zsh -c pnpm dev",
  vite: "  112   111  90000 Mon Nov 17 09:01:02 2026 node /r/node_modules/.bin/vite",
  other: "  120   100 200000 Mon Nov 17 09:01:00 2026 claude --resume b",
};
const table = (...lines: string[]): ProcTable => parsePsTable(lines.join("\n"));

function sample(t: ProcTable, terms: { termId: string; pid: number }[]): MonitorSample {
  return {
    at: 0, table: t, children: new Map(), system: null, snapshot: null as never,
    terms: terms.map((x) => {
      const tree = classifyTree(x.pid, t);
      return { ...x, head: x.termId, tree, summary: summarize(tree) };
    }),
  };
}

function setup(tables: ProcTable[], roots: number[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "orphans-"));
  const file = join(dir, "procs", "owned.json");
  const kills: [number, boolean][] = [];
  const logs: string[] = [];
  let i = 0;
  const s = new OrphanSweeper({
    enabled: () => true,
    readTable: async () => tables[Math.min(i++, tables.length - 1)],
    liveRoots: () => roots,
    kill: (pid, force) => void kills.push([pid, force]),
    file,
    sleep: async () => {},
    log: (m) => void logs.push(m),
  });
  return { s, file, kills, logs };
}

describe("OrphanSweeper (WS-M F)", () => {
  it("ends what a closed terminal left behind, forcing what ignores SIGTERM, and logs it", async () => {
    const before = table(L.claude, L.shell, L.vite, L.other);
    // 终端关了：claude 和 shell 退出了，vite 被收养到 1 号进程还在跑；SIGTERM 之后还在。
    const left = table(L.vite.replace("  112   111", "  112     1"), L.other);
    const { s, file, kills, logs } = setup([left, left]);
    await s.onSample(sample(before, [{ termId: "t1", pid: 110 }, { termId: "t2", pid: 120 }]));
    expect(JSON.parse(readFileSync(file, "utf8")).procs.map((p: { pid: number }) => p.pid)).toEqual([110, 111, 112, 120]);
    expect(await s.termExited("t1")).toBe(1);
    expect(kills).toEqual([[112, false], [112, true]]);
    expect(logs[0]).toContain("pid 112");
    expect(JSON.parse(readFileSync(file, "utf8")).procs.map((p: { pid: number }) => p.pid)).toEqual([120]);
  });

  it("leaves a reused pid alone, and anything now under an open terminal or spared", async () => {
    const before = table(L.claude, L.shell, L.vite);
    const reused = table(L.vite.replace("09:01:02", "11:00:00"));
    const a = setup([reused]);
    await a.s.onSample(sample(before, [{ termId: "t1", pid: 110 }]));
    expect(await a.s.termExited("t1")).toBe(0);
    expect(a.kills).toEqual([]);

    const moved = table(L.other, L.vite.replace("  112   111", "  112   120"));
    const b = setup([moved], [120]);
    await b.s.onSample(sample(before, [{ termId: "t1", pid: 110 }]));
    expect(await b.s.termExited("t1")).toBe(0);

    const c = setup([table(L.vite.replace("  112   111", "  112     1"))]);
    await c.s.onSample(sample(before, [{ termId: "t1", pid: 110 }]));
    c.s.spare([{ pid: 112, start: "Mon Nov 17 09:01:02 2026", args: "node /r/node_modules/.bin/vite" }]);
    expect(await c.s.termExited("t1")).toBe(0);
  });

  it("sweeps what the last run recorded at startup, then starts a fresh record", async () => {
    const alive = table(L.vite.replace("  112   111", "  112     1"));
    const { s, file, kills } = setup([alive, table()]);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ procs: [{ pid: 112, start: "Mon Nov 17 09:01:02 2026", args: "node /r/node_modules/.bin/vite" }, { pid: 5, start: "x", args: "gone" }] }));
    expect(await s.sweepAtStartup()).toBe(1);
    expect(kills).toEqual([[112, false]]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ procs: [] });
  });

  it("keeps what earlier samples saw, and finds a background job adopted by launchd through its process group", async () => {
    const shellG = "  111   110   111   3000 Mon Nov 17 09:01:01 2026 /bin/zsh -c nohup pnpm dev &";
    const job = "  112   111   111  90000 Mon Nov 17 09:01:02 2026 node /r/node_modules/.bin/vite";
    const watcher = "  113   110   113   9000 Mon Nov 17 09:01:03 2026 node /r/tsc -w";
    // 第一次采样：shell 和 vite 都在 claude 底下。
    const first = table(L.claude, shellG, job);
    // 第二次：shell 退出了，vite 被收养到 1 号进程，组还是 111；又起了个 watcher。
    const second = table(L.claude, job.replace("  112   111", "  112     1"), watcher);
    // 终端关了以后：vite、watcher 都还在。
    const after = table(job.replace("  112   111", "  112     1"), watcher.replace("  113   110", "  113     1"));
    const { s, kills } = setup([after, after]);
    await s.onSample(sample(first, [{ termId: "t1", pid: 110 }]));
    await s.onSample(sample(second, [{ termId: "t1", pid: 110 }]));
    expect(await s.termExited("t1")).toBe(2);
    expect(kills.filter(([, f]) => !f).map(([p]) => p).sort()).toEqual([112, 113]);
  });

  it("does not take a process group whose leader pid now belongs to someone else", async () => {
    const shellG = "  111   110   111   3000 Mon Nov 17 09:01:01 2026 /bin/zsh -c x";
    const first = table(L.claude, shellG);
    const stranger = table(L.claude, "  111     1   111   3000 Mon Nov 17 10:00:00 2026 /usr/bin/other", "  115   111   111   3000 Mon Nov 17 10:00:01 2026 /usr/bin/other-child");
    const { s, kills } = setup([table("  115     1   111   3000 Mon Nov 17 10:00:01 2026 /usr/bin/other-child")]);
    await s.onSample(sample(first, [{ termId: "t1", pid: 110 }]));
    await s.onSample(sample(stranger, [{ termId: "t1", pid: 110 }]));
    expect(await s.termExited("t1")).toBe(0);
    expect(kills).toEqual([]);
  });

  it("does nothing at startup without a record", async () => {
    const { s } = setup([table()]);
    expect(await s.sweepAtStartup()).toBe(0);
  });

  it("uses taskkill on Windows", () => {
    const runs: string[][] = [];
    const k = platformKill("win32", (cmd, args) => void runs.push([cmd, ...args]));
    k(7, false);
    k(7, true);
    expect(runs).toEqual([["taskkill", "/PID", "7"], ["taskkill", "/PID", "7", "/F"]]);
  });
});
