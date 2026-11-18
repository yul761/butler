import os from "node:os";

/** 现在还能拿来开新 session 的内存（工作流 W：按内存决定能开几个 session）。 */
export interface MemoryReading {
  totalKb: number;
  /** 不用换出就能拿到的量：空闲页加上能直接丢掉的文件缓存和 purgeable。 */
  availableKb: number;
  /** 从哪里读的。fixed：e2e 用 BUTLER_E2E_AVAILABLE_MB 定死的读数，不看这台机器。 */
  source: "vm_stat" | "memory_pressure" | "os" | "fixed";
  /** macOS 的内存压力（kern.memorystatus_vm_pressure_level）；读不到或别的平台为 null。 */
  pressure: "normal" | "warn" | "critical" | null;
  /** 算出可用量的那几项（MB），写进日志：在别的机器上看得出这个读数合不合理。 */
  detail?: string;
}

export type RunText = (file: string, args: string[]) => Promise<string>;

/**
 * macOS 上这几个命令的位置是固定的。写绝对路径：从 Dock 启动或 e2e 沙盒里的 PATH 可能没有 /usr/sbin（sysctl 在那里）。
 */
export const MAC_TOOLS = { sysctl: "/usr/sbin/sysctl", vmStat: "/usr/bin/vm_stat", memoryPressure: "/usr/bin/memory_pressure" } as const;

/** vm_stat 里算可用内存要用的几项（KB）。 */
export interface VmStatPages {
  wiredKb: number;
  compressorKb: number;
  anonymousKb: number;
  purgeableKb: number;
  fileBackedKb: number | null;
  freeKb: number | null;
}

/** 读出 vm_stat 的各项（KB）；缺了算可用量必需的哪一项就返回 null。 */
export function parseVmStat(out: string): VmStatPages | null {
  const page = /page size of (\d+) bytes/.exec(out);
  if (!page) return null;
  const pageKb = Number(page[1]) / 1024;
  const kb = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(out);
    return m ? Number(m[1]) * pageKb : null;
  };
  const wiredKb = kb("Pages wired down");
  const compressorKb = kb("Pages occupied by compressor");
  const anonymousKb = kb("Anonymous pages");
  if (wiredKb === null || compressorKb === null || anonymousKb === null) return null;
  return { wiredKb, compressorKb, anonymousKb, purgeableKb: kb("Pages purgeable") ?? 0, fileBackedKb: kb("File-backed pages"), freeKb: kb("Pages free") };
}

/**
 * vm_stat 按 Activity Monitor 的算法：已用 = wired + 压缩器占的 + (匿名页 − purgeable)，可用 = 总量 − 已用。
 * 文件缓存（File-backed）、空闲、speculative、purgeable 都能直接拿回来；inactive 里的匿名页要压缩或换出才拿得回来，所以不像
 * free + inactive 那样算进去。缺了哪一项就返回 null（交给下一个办法）。
 */
export function parseVmStatAvailable(out: string, totalKb: number): number | null {
  const p = parseVmStat(out);
  return p === null ? null : vmStatAvailableKb(p, totalKb);
}

function vmStatAvailableKb(p: VmStatPages, totalKb: number): number {
  return Math.max(0, Math.round(totalKb - (p.wiredKb + p.compressorKb + Math.max(0, p.anonymousKb - p.purgeableKb))));
}

const mbOf = (kb: number | null): string => (kb === null ? "?" : String(Math.round(kb / 1024)));

/** 日志用：vm_stat 的各项（MB）。 */
export function vmStatDetail(p: VmStatPages): string {
  return `wired ${mbOf(p.wiredKb)}, compressor ${mbOf(p.compressorKb)}, anonymous ${mbOf(p.anonymousKb)}, purgeable ${mbOf(p.purgeableKb)}, file-backed ${mbOf(p.fileBackedKb)}, free ${mbOf(p.freeKb)} MB`;
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
  /** e2e 用：BUTLER_E2E_AVAILABLE_MB 的值。设了就不读这台机器，可用量就是它（CI 机器的真实内存不能决定 e2e 过不过）。 */
  fixedAvailableMb?: string;
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
  const fixed = d.fixedAvailableMb?.trim();
  if (fixed && /^\d{1,7}$/.test(fixed)) {
    const availableKb = Number(fixed) * 1024;
    return { totalKb: Math.max(totalKb, availableKb), availableKb, source: "fixed", pressure: null, detail: "BUTLER_E2E_AVAILABLE_MB" };
  }
  const osReading = (pressure: MemoryReading["pressure"]): MemoryReading => ({ totalKb, availableKb: Math.round(d.freemem() / 1024), source: "os", pressure });
  if (d.platform !== "darwin") return osReading(null);
  let pressure: MemoryReading["pressure"] = null;
  try {
    pressure = parsePressureLevel(await d.run(MAC_TOOLS.sysctl, ["-n", "kern.memorystatus_vm_pressure_level"]));
  } catch {
    // 读不到压力：只看内存量。
  }
  try {
    const p = parseVmStat(await d.run(MAC_TOOLS.vmStat, []));
    if (p !== null) return { totalKb, availableKb: vmStatAvailableKb(p, totalKb), source: "vm_stat", pressure, detail: vmStatDetail(p) };
  } catch {
    // 试 memory_pressure。
  }
  try {
    const pct = parseFreePercentage(await d.run(MAC_TOOLS.memoryPressure, ["-Q"]));
    if (pct !== null) return { totalKb, availableKb: Math.round((totalKb * pct) / 100), source: "memory_pressure", pressure, detail: `free ${pct}%` };
  } catch {
    // 退回 os。
  }
  return osReading(pressure);
}

/**
 * e2e 定死的可用内存：只在没打包时读 BUTLER_E2E_AVAILABLE_MB（e2e 跑的是没打包的构建）。
 * 打包好的正式版不理它：环境里碰巧有这个变量也不能让准入不看真实内存。
 */
export function e2eFixedAvailableMb(env: NodeJS.ProcessEnv, packaged: boolean): string | undefined {
  return packaged ? undefined : env.BUTLER_E2E_AVAILABLE_MB;
}

export const defaultReadDeps = (run: RunText, packaged: boolean): ReadDeps => ({
  platform: process.platform, run, totalmem: os.totalmem, freemem: os.freemem, fixedAvailableMb: e2eFixedAvailableMb(process.env, packaged),
});

/** 日志用的一行：从哪读的、总量、可用、压力、各项。 */
export function readingLine(r: MemoryReading): string {
  return `${r.source}: total ${mbOf(r.totalKb)} MB, available ${mbOf(r.availableKb)} MB, pressure ${r.pressure ?? "?"}${r.detail ? ` (${r.detail})` : ""}`;
}

/**
 * 启动时写进日志的一行（附录第 7 节）：这台机器的真实读数，再加上 macOS 自己的空闲百分比和 os.freemem() 作对照。
 * 三个数差得远（vm_stat 公式不算要压缩才拿得回来的匿名页）时，从 CI 产物和用户的日志里都看得出来。
 * e2e 定死了读数时照样读真实的（CI 产物里要看 runner 上的 vm_stat），再注明准入用的是定死的数。
 */
export async function memorySnapshotLine(d: ReadDeps): Promise<string> {
  const r = await readAvailableMemory({ ...d, fixedAvailableMb: undefined });
  let kernel = "";
  if (d.platform === "darwin" && r.source !== "memory_pressure") {
    try {
      const pct = parseFreePercentage(await d.run(MAC_TOOLS.memoryPressure, ["-Q"]));
      if (pct !== null) kernel = `, memory_pressure free ${pct}%`;
    } catch {
      // 只是对照，读不到就不写。
    }
  }
  const fixed = await readAvailableMemory(d);
  const note = fixed.source === "fixed" ? `; admission uses a fixed ${mbOf(fixed.availableKb)} MB (BUTLER_E2E_AVAILABLE_MB)` : "";
  return `${readingLine(r)}${kernel}, os.freemem ${mbOf(d.freemem() / 1024)} MB${note}`;
}
