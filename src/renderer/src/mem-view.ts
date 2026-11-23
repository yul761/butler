import { SHIPHERD_PARTS, PROC_CLASSES, type MemoryHistoryPoint, type MemorySnapshot, type SessionMemory } from "../../shared/mem-usage";
import type { NowView } from "../../shared/types";
import type { UiStrings } from "./strings";

/** KB → 给人看的大小：1 GB 以上一位小数的 GB，以下整数 MB。 */
export function formatKb(kb: number): string {
  const mb = kb / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** 行上的那一小段（「内存 1.2 GB」）；没有读数为 null。 */
export function rowMemText(mem: SessionMemory | null | undefined, S: UiStrings): string | null {
  return mem ? S.perf.memRow(formatKb(mem.totalKb)) : null;
}

/** 悬停时的明细：按类别（只列非 0 的，从大到小），再列最大的几个进程。 */
export function rowMemDetail(mem: SessionMemory, S: UiStrings): string {
  const classes = PROC_CLASSES.filter((c) => mem.byClass[c] > 0)
    .sort((a, b) => mem.byClass[b] - mem.byClass[a])
    .map((c) => `${S.perf.memClass[c]}: ${formatKb(mem.byClass[c])}`);
  const top = mem.top.slice(0, 5).map((p) => `  ${p.name} (${S.perf.memClass[p.cls]}): ${formatKb(p.rssKb)}`);
  return [S.perf.memProcs(mem.count), ...classes, ...(top.length ? [S.perf.memTop, ...top] : [])].join("\n");
}

/** 卡片上的一行：Shipherd、session、系统可用。 */
export function snapshotLine(s: MemorySnapshot, S: UiStrings): string {
  const parts = [`${S.perf.memShipherd} ${formatKb(s.shipherdKb)}`, `${S.perf.memSessions} ×${s.sessions} ${formatKb(s.sessionsKb)}`];
  if (s.system) parts.push(`${S.perf.memFree} ${formatKb(s.system.freeKb)} (${Math.round(s.system.freePercent)}%)`);
  return parts.join(" · ");
}

/** Shipherd 自己那几份（非 0 的），和 Shipherd 的 MCP 加起来多少。 */
export function shipherdLines(s: MemorySnapshot, S: UiStrings): string[] {
  const parts = SHIPHERD_PARTS.filter((p) => s.shipherd[p] > 0).map((p) => `${S.perf.memShipherdParts[p]}: ${formatKb(s.shipherd[p])}`);
  if (s.shipherdMcpKb > 0) parts.push(`${S.perf.memShipherdMcp}: ${formatKb(s.shipherdMcpKb)}`);
  return parts;
}

/** 共享 MCP 的 hub 自己大约占多少（实测一个作用域 75 MB 左右，多算一点）。 */
export const HUB_ESTIMATE_KB = 100 * 1024;

/** 共享 MCP 关着时，开了大约能省多少 KB：各 session 的 Shipherd MCP 减去一个 hub；不到 50 MB 不值得提，返回 0。 */
export function sharedMcpSavingKb(s: MemorySnapshot): number {
  const save = s.shipherdMcpKb - HUB_ESTIMATE_KB;
  return s.sessions >= 2 && save >= 50 * 1024 ? save : 0;
}

/**
 * 历史的折线（Shipherd + session 加起来），画在 width × height 的框里，返回 SVG path 的 d；少于 2 个点为 null。
 * 纵轴从 0 到最大值，横轴按时间。
 */
export function sparkPath(points: MemoryHistoryPoint[], width: number, height: number): string | null {
  if (points.length < 2) return null;
  const t0 = points[0].at;
  const span = Math.max(1, points.at(-1)!.at - t0);
  const max = Math.max(1, ...points.map((p) => p.shipherdKb + p.sessionsKb));
  return points
    .map((p, i) => {
      const x = ((p.at - t0) / span) * width;
      const y = height - ((p.shipherdKb + p.sessionsKb) / max) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** 历史里最高的那次（给曲线的标题）。 */
export function peakKb(points: MemoryHistoryPoint[]): number {
  return points.reduce((m, p) => Math.max(m, p.shipherdKb + p.sessionsKb), 0);
}

/** 你自己装的 MCP 里一个就超过这么多的，提示一下（J）。 */
export const HEAVY_MCP_KB = 200 * 1024;

/** 所有行的最大进程里、你自己装的 MCP 按名字加起来超过 HEAVY_MCP_KB 的，从大到小（最多 3 个）。 */
export function heavyMcp(view: NowView): string[] {
  const rows = [...(view.shipherd ? [view.shipherd] : []), ...view.features.flatMap((f) => f.rows)];
  const by = new Map<string, number>();
  for (const r of rows) for (const p of r.mem?.top ?? []) if (p.cls === "mcp_other") by.set(p.name, (by.get(p.name) ?? 0) + p.rssKb);
  return [...by].filter(([, kb]) => kb >= HEAVY_MCP_KB).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
}
