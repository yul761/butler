import os from "node:os";

/** 现在还能拿来开新 session 的内存（工作流 W：按内存决定能开几个 session）。 */
export interface MemoryReading {
  totalKb: number;
  /** 不用换出就能拿到的量：空闲页加上能直接丢掉的文件缓存和 purgeable。 */
  availableKb: number;
  /** 从哪里读的。 */
  source: "vm_stat" | "memory_pressure" | "os";
  /** macOS 的内存压力（kern.memorystatus_vm_pressure_level）；读不到或别的平台为 null。 */
  pressure: "normal" | "warn" | "critical" | null;
}

export type RunText = (file: string, args: string[]) => Promise<string>;

/**
 * vm_stat 按 Activity Monitor 的算法：已用 = wired + 压缩器占的 + (匿名页 − purgeable)，可用 = 总量 − 已用。
 * 文件缓存（File-backed）、空闲、speculative、purgeable 都能直接拿回来；inactive 里的匿名页要压缩或换出才拿得回来，所以不像
 * free + inactive 那样算进去。缺了哪一项就返回 null（交给下一个办法）。
 */
export function parseVmStatAvailable(out: string, totalKb: number): number | null {
  const page = /page size of (\d+) bytes/.exec(out);
  if (!page) return null;
  const pages = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(out);
    return m ? Number(m[1]) : null;
  };
  const wired = pages("Pages wired down");
  const compressor = pages("Pages occupied by compressor");
  const anonymous = pages("Anonymous pages");
  const purgeable = pages("Pages purgeable") ?? 0;
  if (wired === null || compressor === null || anonymous === null) return null;
  const usedKb = ((wired + compressor + Math.max(0, anonymous - purgeable)) * Number(page[1])) / 1024;
  return Math.max(0, Math.round(totalKb - usedKb));
}

/** `memory_pressure -Q` 的 "System-wide memory free percentage: 42%"。 */
export function parseFreePercentage(out: string): number | null {
  const m = /free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(out);
  return m ? Number(m[1]) : null;
}

/** kern.memorystatus_vm_pressure_level：1 正常，2 警告，4 严重。 */
export function parsePressureLevel(out: string): MemoryReading["pressure"] {
  const n = Number(out.trim());
  return n === 1 ? "normal" : n === 2 ? "warn" : n === 4 ? "critical" : null;
}

export interface ReadDeps {
  platform: NodeJS.Platform;
  run: RunText;
  totalmem(): number;
  freemem(): number;
}

/**
 * 读可用内存。macOS 上 os.freemem() 只算空闲页（这台 48 GB 的机器上常常只有 3 GB，文件缓存一点都不算），
 * 所以先按 vm_stat 算，不行再用 memory_pressure 的空闲百分比，最后才退回 os.freemem()。
 * Windows 上 os.freemem() 是 GlobalMemoryStatusEx 的 ullAvailPhys（空闲加上 standby 缓存），本来就是可用内存；
 * Linux 上是 /proc/meminfo 的 MemAvailable。两者都直接用。
 */
export async function readAvailableMemory(d: ReadDeps): Promise<MemoryReading> {
  const totalKb = Math.round(d.totalmem() / 1024);
  const osReading = (pressure: MemoryReading["pressure"]): MemoryReading => ({ totalKb, availableKb: Math.round(d.freemem() / 1024), source: "os", pressure });
  if (d.platform !== "darwin") return osReading(null);
  let pressure: MemoryReading["pressure"] = null;
  try {
    pressure = parsePressureLevel(await d.run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]));
  } catch {
    // 读不到压力：只看内存量。
  }
  try {
    const kb = parseVmStatAvailable(await d.run("vm_stat", []), totalKb);
    if (kb !== null) return { totalKb, availableKb: kb, source: "vm_stat", pressure };
  } catch {
    // 试 memory_pressure。
  }
  try {
    const pct = parseFreePercentage(await d.run("memory_pressure", ["-Q"]));
    if (pct !== null) return { totalKb, availableKb: Math.round((totalKb * pct) / 100), source: "memory_pressure", pressure };
  } catch {
    // 退回 os。
  }
  return osReading(pressure);
}

export const defaultReadDeps = (run: RunText): ReadDeps => ({ platform: process.platform, run, totalmem: os.totalmem, freemem: os.freemem });
