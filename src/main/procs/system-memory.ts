import os from "node:os";
import { runCommand, type RunCommand } from "./proc-table";

/** 系统内存（WS-M 设计 §4）。freeKb 是「还能马上用」的量，不只是空闲页。 */
export interface SystemMemory {
  totalKb: number;
  freeKb: number;
  /** freeKb / totalKb，0 到 100。 */
  freePercent: number;
  /** 从哪里读的：memory_pressure、vm_stat 或 os。 */
  source: "memory_pressure" | "vm_stat" | "os";
}

/** `memory_pressure -Q` 的 "System-wide memory free percentage: 42%"。 */
export function parseMemoryPressure(out: string): number | null {
  const m = /free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(out);
  return m ? Number(m[1]) : null;
}

/** vm_stat：(free + inactive + speculative) × 页大小，单位 KB。 */
export function parseVmStat(out: string): number | null {
  const page = /page size of (\d+) bytes/.exec(out);
  if (!page) return null;
  const pages = (name: string): number => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?`, "m").exec(out)?.[1] ?? 0);
  const free = pages("free") + pages("inactive") + pages("speculative");
  return Math.round((free * Number(page[1])) / 1024);
}

/**
 * macOS 上 os.freemem() 只算空闲页（大大低估：缓存的页随时能拿回来），所以先问 memory_pressure，不行再读 vm_stat；
 * Windows 和 Linux 的 os.freemem() 是准的（可用内存）。
 */
export async function readSystemMemory(platform: NodeJS.Platform = process.platform, run: RunCommand = runCommand, osm = { totalmem: os.totalmem, freemem: os.freemem }): Promise<SystemMemory> {
  const totalKb = Math.round(osm.totalmem() / 1024);
  const of = (freeKb: number, source: SystemMemory["source"]): SystemMemory => ({ totalKb, freeKb, freePercent: totalKb > 0 ? Math.round((freeKb / totalKb) * 1000) / 10 : 0, source });
  if (platform === "darwin") {
    try {
      const pct = parseMemoryPressure(await run("memory_pressure", ["-Q"]));
      if (pct !== null) return { totalKb, freeKb: Math.round((totalKb * pct) / 100), freePercent: pct, source: "memory_pressure" };
    } catch {
      // 没有这个命令：试 vm_stat。
    }
    try {
      const kb = parseVmStat(await run("vm_stat", []));
      if (kb !== null) return of(kb, "vm_stat");
    } catch {
      // 退回 os。
    }
  }
  return of(Math.round(osm.freemem() / 1024), "os");
}
