import { describe, expect, it } from "vitest";
import { parseMemoryPressure, parseVmStat, readSystemMemory } from "./system-memory";

const VM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            500000.
Pages inactive:                           20000.
Pages speculative:                         2000.
Pages throttled:                              0.
`;
const osm = { totalmem: () => 16 * 1024 * 1024 * 1024, freemem: () => 1024 * 1024 * 1024 };

describe("system memory", () => {
  it("parses memory_pressure and vm_stat", () => {
    expect(parseMemoryPressure("The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 42%\n")).toBe(42);
    expect(parseMemoryPressure("nope")).toBeNull();
    expect(parseVmStat(VM)).toBe(((10000 + 20000 + 2000) * 16384) / 1024);
    expect(parseVmStat("nothing")).toBeNull();
  });

  it("uses memory_pressure on macOS", async () => {
    const m = await readSystemMemory("darwin", async (cmd) => (cmd === "memory_pressure" ? "System-wide memory free percentage: 25%" : ""), osm);
    expect(m).toEqual({ totalKb: 16 * 1024 * 1024, freeKb: 4 * 1024 * 1024, freePercent: 25, source: "memory_pressure" });
  });

  it("falls back to vm_stat, then to os", async () => {
    const vm = await readSystemMemory("darwin", async (cmd) => (cmd === "vm_stat" ? VM : Promise.reject(new Error("missing"))), osm);
    expect(vm.source).toBe("vm_stat");
    expect(vm.freeKb).toBe(512000);
    const plain = await readSystemMemory("darwin", async () => Promise.reject(new Error("missing")), osm);
    expect(plain).toMatchObject({ source: "os", freeKb: 1024 * 1024, freePercent: 6.3 });
  });

  it("uses os.freemem on Windows without running anything", async () => {
    const m = await readSystemMemory("win32", async () => Promise.reject(new Error("must not run")), osm);
    expect(m).toMatchObject({ source: "os", freePercent: 6.3 });
  });
});
