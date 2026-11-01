import { describe, expect, it } from "vitest";
import { childCpuMs, descendantCpuMs, parsePsOutput } from "./proc-tree";

describe("parsePsOutput", () => {
  it("parses the cputime formats ps prints", () => {
    const t = parsePsOutput("  12    1   0:03.50\n 13 12 1:02:03\n14 12 1-02:03:04\n");
    expect(t.get(12)).toEqual({ ppid: 1, cpuMs: 3500 });
    expect(t.get(13)).toEqual({ ppid: 12, cpuMs: (3600 + 120 + 3) * 1000 });
    expect(t.get(14)).toEqual({ ppid: 12, cpuMs: (86400 + 7200 + 180 + 4) * 1000 });
  });
  it("skips malformed lines", () => {
    expect(parsePsOutput("garbage\n\n 1 0 x:y\n").size).toBe(0);
  });
});

describe("descendantCpuMs", () => {
  it("sums all descendants but not the root", () => {
    const t = parsePsOutput("10 1 5:00.00\n11 10 0:01.00\n12 11 0:02.00\n13 99 0:09.00\n");
    expect(descendantCpuMs(10, t)).toBe(3000);
    expect(descendantCpuMs(99, t)).toBe(9000);
    expect(descendantCpuMs(555, t)).toBe(0);
  });
});

describe("childCpuMs", () => {
  it("returns null on win32 and when ps fails", async () => {
    expect(await childCpuMs(1, "win32", async () => "1 0 0:01.00")).toBeNull();
    expect(await childCpuMs(1, "darwin", async () => { throw new Error("no ps"); })).toBeNull();
  });
  it("runs ps -A and sums children", async () => {
    let seen: string[] = [];
    const v = await childCpuMs(1, "darwin", async (cmd, args) => {
      seen = [cmd, ...args];
      return "1 0 0:10.00\n2 1 0:02.00\n";
    });
    expect(seen).toEqual(["ps", "-A", "-o", "pid=,ppid=,cputime="]);
    expect(v).toBe(2000);
  });
});
