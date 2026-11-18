import { describe, expect, it, vi } from "vitest";
import { parseFreePercentage, parsePressureLevel, parseVmStatAvailable, readAvailableMemory, type ReadDeps } from "./available-memory";

const GB = 1024 * 1024 * 1024;

// 48 GB 的 Mac 上实际的 vm_stat（截了一部分）：os.freemem() 只有 2 GB 左右，可用其实是 14 GB 左右。
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   133942.
Pages active:                                1048372.
Pages inactive:                               993783.
Pages speculative:                             77707.
Pages throttled:                                   0.
Pages wired down:                             298251.
Pages purgeable:                               16800.
"Translation faults":                    12505770582.
File-backed pages:                            690673.
Anonymous pages:                             1429189.
Pages stored in compressor:                  1068799.
Pages occupied by compressor:                 531429.
`;

const deps = (o: Partial<ReadDeps> & { out?: Record<string, string | Error> } = {}): ReadDeps => ({
  platform: o.platform ?? "darwin",
  totalmem: o.totalmem ?? (() => 48 * GB),
  freemem: o.freemem ?? (() => 2 * GB),
  run:
    o.run ??
    vi.fn(async (file: string) => {
      const r = o.out?.[file];
      if (r === undefined || r instanceof Error) throw r ?? new Error(`no ${file}`);
      return r;
    }),
});

describe("parseVmStatAvailable", () => {
  it("counts free pages, file cache and purgeable as available, not anonymous inactive pages", () => {
    const kb = parseVmStatAvailable(VM_STAT, 48 * 1024 * 1024)!;
    // 总量 − (wired + 压缩器 + 匿名页 − purgeable) × 16 KB
    expect(kb).toBe(48 * 1024 * 1024 - (298251 + 531429 + 1429189 - 16800) * 16);
    expect(kb / 1024 / 1024).toBeGreaterThan(13);
    expect(kb / 1024 / 1024).toBeLessThan(15);
  });

  it("returns null when a field it needs is missing, and never goes below 0", () => {
    expect(parseVmStatAvailable("Pages free: 10.", 1000)).toBeNull();
    expect(parseVmStatAvailable(VM_STAT.replace(/^Anonymous pages.*$/m, ""), 1000)).toBeNull();
    expect(parseVmStatAvailable(VM_STAT, 1000)).toBe(0);
  });
});

describe("parsers", () => {
  it("reads memory_pressure's free percentage and the pressure level", () => {
    expect(parseFreePercentage("The system has 515...\nSystem-wide memory free percentage: 73%\n")).toBe(73);
    expect(parseFreePercentage("nothing")).toBeNull();
    expect(parsePressureLevel("1\n")).toBe("normal");
    expect(parsePressureLevel("2")).toBe("warn");
    expect(parsePressureLevel("4")).toBe("critical");
    expect(parsePressureLevel("x")).toBeNull();
  });
});

describe("readAvailableMemory", () => {
  it("macOS: uses vm_stat, not os.freemem, and reads the pressure level", async () => {
    const r = await readAvailableMemory(deps({ out: { vm_stat: VM_STAT, sysctl: "2\n" } }));
    expect(r).toMatchObject({ source: "vm_stat", pressure: "warn", totalKb: 48 * 1024 * 1024 });
    expect(r.availableKb).toBe(parseVmStatAvailable(VM_STAT, 48 * 1024 * 1024));
  });

  it("macOS: falls back to memory_pressure, then to os.freemem", async () => {
    const mp = await readAvailableMemory(deps({ out: { vm_stat: new Error("gone"), memory_pressure: "System-wide memory free percentage: 25%" } }));
    expect(mp).toMatchObject({ source: "memory_pressure", availableKb: 12 * 1024 * 1024, pressure: null });
    const osr = await readAvailableMemory(deps({ out: {} }));
    expect(osr).toMatchObject({ source: "os", availableKb: 2 * 1024 * 1024 });
  });

  it("Windows and Linux: os.freemem is already available memory (standby cache / MemAvailable), no commands run", async () => {
    for (const platform of ["win32", "linux"] as const) {
      const d = deps({ platform, freemem: () => 9 * GB, totalmem: () => 32 * GB });
      expect(await readAvailableMemory(d)).toEqual({ totalKb: 32 * 1024 * 1024, availableKb: 9 * 1024 * 1024, source: "os", pressure: null });
      expect(d.run).not.toHaveBeenCalled();
    }
  });
});
