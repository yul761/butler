import { afterEach, describe, expect, it } from "vitest";
import type { MemorySnapshot, SessionMemory } from "../../shared/mem-usage";
import { butlerLines, formatKb, peakKb, rowMemDetail, rowMemText, snapshotLine, sparkPath } from "./mem-view";
import { S, setUiLang } from "./strings";

afterEach(() => setUiLang("zh"));

const MB = 1024;
const mem: SessionMemory = {
  at: 1, totalKb: 1500 * MB, count: 6,
  byClass: { claude: 600 * MB, mcp_butler: 300 * MB, mcp_other: 500 * MB, shell: 0, watcher: 100 * MB, dev_server: 0, other: 0 },
  top: [{ pid: 1, cls: "claude", rssKb: 600 * MB, name: "claude" }, { pid: 2, cls: "mcp_other", rssKb: 500 * MB, name: "chrome-devtools-mcp" }],
};
const snap: MemorySnapshot = {
  at: 1, butlerKb: 400 * MB, butler: { main: 100 * MB, renderer: 300 * MB, gpu: 0, utility: 0, terminals: 0, headless: 0, hub: 0 },
  sessionsKb: 3000 * MB, sessions: 2, butlerMcpKb: 600 * MB, system: { totalKb: 16 * 1024 * MB, freeKb: 4 * 1024 * MB, freePercent: 25 },
};

describe("memory view", () => {
  it("formats sizes", () => {
    expect(formatKb(512 * MB)).toBe("512 MB");
    expect(formatKb(1536 * MB)).toBe("1.5 GB");
  });

  it("shows the row text and its breakdown in both languages", () => {
    expect(rowMemText(null, S)).toBeNull();
    expect(rowMemText(mem, S)).toBe("内存 1.5 GB");
    const d = rowMemDetail(mem, S);
    expect(d.split("\n").slice(0, 5)).toEqual(["6 个进程", "claude: 600 MB", "你装的 MCP: 500 MB", "Butler 的 MCP: 300 MB", "watcher: 100 MB"]);
    expect(d).toContain("chrome-devtools-mcp (你装的 MCP): 500 MB");
    setUiLang("en");
    expect(rowMemText(mem, S)).toMatch(/1\.5 GB/);
    expect(rowMemDetail(mem, S)).toMatch(/processes/);
  });

  it("summarises the snapshot", () => {
    expect(snapshotLine(snap, S)).toBe("Butler 400 MB · session ×2 2.9 GB · 系统可用 4.0 GB (25%)");
    expect(butlerLines(snap, S)).toEqual(["主进程: 100 MB", "界面: 300 MB", "Butler 的 MCP: 600 MB"]);
  });

  it("draws the history line", () => {
    expect(sparkPath([], 100, 20)).toBeNull();
    const pts = [
      { at: 0, butlerKb: 0, sessionsKb: 0, freePercent: null },
      { at: 10, butlerKb: 50, sessionsKb: 50, freePercent: null },
    ];
    expect(sparkPath(pts, 100, 20)).toBe("M0.0,20.0 L100.0,0.0");
    expect(peakKb(pts)).toBe(100);
  });
});
