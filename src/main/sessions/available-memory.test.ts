import { describe, expect, it, vi } from "vitest";
import { memorySnapshotLine, parseFreePercentage, parsePressureLevel, parseVmStatAvailable, readAvailableMemory, readingLine, type ReadDeps } from "./available-memory";

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
  fixedAvailableMb: o.fixedAvailableMb,
  totalmem: o.totalmem ?? (() => 48 * GB),
  freemem: o.freemem ?? (() => 2 * GB),
  run:
    o.run ??
    vi.fn(async (file: string) => {
      const r = o.out?.[file.split("/").pop()!];
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
    const d = deps({ out: { vm_stat: VM_STAT, sysctl: "2\n" } });
    const r = await readAvailableMemory(d);
    // 绝对路径：Dock 启动和 e2e 沙盒的 PATH 里可能没有 /usr/sbin。
    expect(d.run).toHaveBeenCalledWith("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
    expect(d.run).toHaveBeenCalledWith("/usr/bin/vm_stat", []);
    expect(r).toMatchObject({ source: "vm_stat", pressure: "warn", totalKb: 48 * 1024 * 1024 });
    // 各项写进日志（附录第 7 节）。
    expect(r.detail).toBe("wired 4660, compressor 8304, anonymous 22331, purgeable 263, file-backed 10792, free 2093 MB");
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

describe("fixed reading for e2e (BUTLER_E2E_AVAILABLE_MB)", () => {
  it("uses the fixed number on every platform and runs nothing; ignores a value that is not a whole number", async () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const d = deps({ platform, fixedAvailableMb: "1000" });
      expect(await readAvailableMemory(d)).toMatchObject({ source: "fixed", availableKb: 1000 * 1024, totalKb: 48 * 1024 * 1024, pressure: null });
      expect(d.run).not.toHaveBeenCalled();
    }
    // 比总量还大：总量跟着抬上去（自动保留线按总量算）。
    expect(await readAvailableMemory(deps({ platform: "linux", fixedAvailableMb: "65536", totalmem: () => 7 * GB }))).toMatchObject({ totalKb: 64 * 1024 * 1024 });
    for (const bad of ["", " ", "lots", "-1", "1.5"]) expect((await readAvailableMemory(deps({ platform: "linux", fixedAvailableMb: bad }))).source, bad).toBe("os");
  });
});

describe("log lines", () => {
  it("startup line: the admission reading next to macOS's own free percentage and os.freemem", async () => {
    const line = await memorySnapshotLine(deps({ out: { vm_stat: VM_STAT, sysctl: "1", memory_pressure: "System-wide memory free percentage: 73%" } }));
    expect(line).toMatch(/^vm_stat: total 49152 MB, available \d+ MB, pressure normal \(wired 4660, .*\), memory_pressure free 73%, os.freemem 2048 MB$/);
    // memory_pressure 读不到只是少一段对照；别的平台不跑它。
    expect(await memorySnapshotLine(deps({ out: { vm_stat: VM_STAT } }))).not.toContain("memory_pressure");
    // e2e 定死了读数：照样读真实的，再注明准入用的是定死的。
    expect(await memorySnapshotLine(deps({ out: { vm_stat: VM_STAT }, fixedAvailableMb: "65536" }))).toMatch(/^vm_stat: total 49152 MB, .*; admission uses a fixed 65536 MB \(BUTLER_E2E_AVAILABLE_MB\)$/);
    const win = deps({ platform: "win32", freemem: () => 9 * GB, totalmem: () => 32 * GB });
    expect(await memorySnapshotLine(win)).toBe("os: total 32768 MB, available 9216 MB, pressure ?, os.freemem 9216 MB");
    expect(win.run).not.toHaveBeenCalled();
  });

  it("readingLine without a detail", () => {
    expect(readingLine({ totalKb: 8 * 1024 * 1024, availableKb: 2096 * 1024, source: "os", pressure: null })).toBe("os: total 8192 MB, available 2096 MB, pressure ?");
  });
});
