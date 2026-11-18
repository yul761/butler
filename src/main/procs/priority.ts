import os from "node:os";
import type { MonitorSample } from "./memory-monitor";
import { runCommand, type RunCommand } from "./proc-table";

/**
 * 后台优先级（WS-M E，设计 §6）。
 * - 0：正常。
 * - 1：看不见（终端不在屏幕上）。Windows 降到 BelowNormal；macOS 不动（taskpolicy 只有开和关两档）。
 * - 2：看不见而且停着。macOS `taskpolicy -b`（后台 QoS，可以 -B 撤回）；Windows 再加 EcoQoS（效率模式）。
 * 每次采样对一遍；终端一出现在屏幕上、或者有输入送进去，那棵树马上恢复，不等下一次采样。
 * 记着每个改过的 pid 和它的启动时间：pid 换了进程就不再碰它。关掉开关、退出时全部恢复。
 */
export type PriorityLevel = 0 | 1 | 2;

export interface PriorityChange {
  pid: number;
  from: PriorityLevel;
  to: PriorityLevel;
}

/** 平台相关的那部分：把一批 pid 从 from 改到 to。失败的不抛；返回每个 pid 实际到了哪一档（没列出的当作没变）。 */
export type PriorityBackend = (changes: PriorityChange[]) => Promise<Map<number, PriorityLevel>>;

export interface PriorityDeps {
  enabled(): boolean;
  /** 终端在屏幕上（渲染进程报的 pty:visible，窗口最小化或者藏起来时都不算）。 */
  visible(termId: string): boolean;
  /** 停着：没在干活、没有后台命令。 */
  idle(head: string): boolean;
  /** 不降的（PR 2 的钉住）。 */
  exempt(head: string): boolean;
  backend: PriorityBackend;
  log(msg: string, err?: unknown): void;
}

interface Tracked {
  start: string;
  level: PriorityLevel;
}

export class PriorityManager {
  private readonly tracked = new Map<number, Tracked>();
  /** 每个终端上次采样时那棵树的 pid（马上恢复时用）。 */
  private readonly termPids = new Map<string, number[]>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly d: PriorityDeps) {}

  /**
   * 每次采样（MemoryMonitor 的 hook）。要改哪些在排到的时候才算：前面那一批（Windows 的 EcoQoS 要一两秒）做完之前，
   * 用户可能已经切到这个终端了。
   */
  onSample(s: MonitorSample): Promise<void> {
    if (this.closed) return this.queue;
    return this.apply(() => this.plan(s), (pid) => s.table.get(pid)?.start ?? "");
  }

  private plan(s: MonitorSample): PriorityChange[] {
    if (this.closed) return [];
    // 退出了，或者 pid 换了进程：忘掉，不去碰别人的进程。
    for (const [pid, tr] of [...this.tracked]) {
      const now = s.table.get(pid);
      if (!now || now.start !== tr.start) this.tracked.delete(pid);
    }
    const want = new Map<number, PriorityLevel>();
    this.termPids.clear();
    const on = this.d.enabled();
    for (const t of s.terms) {
      // 降过的进程后来起的子进程继承了它的优先级（Windows 的优先级类、macOS 的 taskpolicy -b 都会继承）：按继承到的记下，恢复时才不会漏掉。
      const inTree = new Set(t.tree.map((p) => p.pid));
      for (const p of t.tree) {
        if (this.tracked.has(p.pid) || !inTree.has(p.ppid)) continue;
        const parent = this.tracked.get(p.ppid);
        if (parent && parent.level !== 0) this.tracked.set(p.pid, { start: p.start, level: parent.level });
      }
      if (!on) continue;
      this.termPids.set(t.termId, t.tree.map((p) => p.pid));
      const level: PriorityLevel = this.d.exempt(t.head) || this.d.visible(t.termId) ? 0 : this.d.idle(t.head) ? 2 : 1;
      // 开发服务器和它起的进程最多降一档：用户可能正在浏览器里用它，不在 Butler 里。
      const dev = new Set<number>();
      for (const p of t.tree) if (p.cls === "dev_server" || dev.has(p.ppid)) dev.add(p.pid);
      for (const p of t.tree) want.set(p.pid, dev.has(p.pid) ? (Math.min(level, 1) as PriorityLevel) : level);
    }
    const changes: PriorityChange[] = [];
    for (const [pid, tr] of this.tracked) if (!want.has(pid) && tr.level !== 0) changes.push({ pid, from: tr.level, to: 0 });
    for (const [pid, level] of want) {
      const from = this.tracked.get(pid)?.level ?? 0;
      if (from !== level) changes.push({ pid, from, to: level });
    }
    return changes;
  }

  /** 这个终端马上恢复正常（出现在屏幕上、有输入送进去）。排到的时候再看降过哪些（前面那一批可能刚降完）。 */
  restoreTerm(termId: string): Promise<void> {
    return this.apply(
      () => (this.termPids.get(termId) ?? []).flatMap((pid) => {
        const level = this.tracked.get(pid)?.level ?? 0;
        return level !== 0 ? [{ pid, from: level, to: 0 as const }] : [];
      }),
      (pid) => this.tracked.get(pid)?.start ?? "",
    );
  }

  /** 全部恢复（关掉开关以后的第一次采样会做；退出时调）。 */
  restoreAll(): Promise<void> {
    return this.apply(() => [...this.tracked].filter(([, t]) => t.level !== 0).map(([pid, t]) => ({ pid, from: t.level, to: 0 as const })), (pid) => this.tracked.get(pid)?.start ?? "");
  }

  /** 退出前：以后的采样不再降，已经排着的照样做完（restoreAll 排在它们后面）。 */
  close(): void {
    this.closed = true;
  }

  /** 降过的 pid 数（测试和日志用）。 */
  lowered(): number {
    return [...this.tracked.values()].filter((t) => t.level !== 0).length;
  }

  /** 一次一批，排队做（采样和马上恢复不会交错）；要改的在排到时才算。 */
  private apply(build: () => PriorityChange[], startOf: (pid: number) => string): Promise<void> {
    const run = async (): Promise<void> => {
      const changes = build();
      if (changes.length === 0) return;
      let reached = new Map<number, PriorityLevel>();
      try {
        reached = await this.d.backend(changes);
      } catch (e) {
        this.d.log("priority change failed", e);
      }
      for (const c of changes) {
        const level = reached.get(c.pid);
        if (level === undefined) continue;
        if (level === 0) this.tracked.delete(c.pid);
        else this.tracked.set(c.pid, { start: this.tracked.get(c.pid)?.start ?? startOf(c.pid), level });
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
}

/** macOS：只有 2 这一档用 taskpolicy（-b 进后台，-B 撤回）；0 和 1 之间不动。 */
export function macBackend(run: RunCommand = runCommand): PriorityBackend {
  return async (changes) => {
    const out = new Map<number, PriorityLevel>();
    for (const c of changes) {
      const bg = (l: PriorityLevel): boolean => l === 2;
      if (bg(c.from) === bg(c.to)) {
        out.set(c.pid, c.to);
        continue;
      }
      try {
        await run("taskpolicy", [bg(c.to) ? "-b" : "-B", "-p", String(c.pid)]);
        out.set(c.pid, c.to);
      } catch {
        // 进程刚好退出了，或者不让改：当作没变。
      }
    }
    return out;
  };
}

/** EcoQoS（ProcessPowerThrottling）开关：一次 PowerShell 处理一批 pid。关的时候 ControlMask 也清掉，回到系统自己管（不是钉成高 QoS）。 */
export function ecoScript(on: number[], off: number[]): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `Add-Type -Namespace B -Name E -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct S { public uint V; public uint M; public uint T; } [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, int p); [DllImport("kernel32.dll")] public static extern bool SetProcessInformation(IntPtr h, int c, ref S s, uint z); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); public static bool Set(int p, bool on) { IntPtr h = OpenProcess(0x0200, false, p); if (h == IntPtr.Zero) return false; S s = new S(); s.V = 1; s.M = on ? 1u : 0u; s.T = on ? 1u : 0u; bool r = SetProcessInformation(h, 4, ref s, (uint)System.Runtime.InteropServices.Marshal.SizeOf(s)); CloseHandle(h); return r; }' -Using System.Runtime.InteropServices`,
    `foreach ($p in @(${on.join(",")})) { if ([B.E]::Set($p, $true)) { "$p" } }`,
    `foreach ($p in @(${off.join(",")})) { if ([B.E]::Set($p, $false)) { "$p" } }`,
  ].join("; ");
}

/**
 * Windows：1 及以上 BelowNormal（os.setPriority），2 再开 EcoQoS。EcoQoS 没开成的记成 1，这个 pid 以后不再试；关不掉的记成还在 2（下次再试）。
 * 只降本来是 Normal 的进程（Idle、High 的不碰），所以恢复到 Normal 就是恢复原样。
 */
export function winBackend(
  run: RunCommand = runCommand,
  setPriority: (pid: number, p: number) => void = os.setPriority,
  getPriority: (pid: number) => number = os.getPriority,
): PriorityBackend {
  const ecoFailed = new Set<number>();
  return async (changes) => {
    const out = new Map<number, PriorityLevel>();
    const pending: PriorityChange[] = [];
    for (const c of changes) {
      // 先把 BelowNormal 这一层做好：level 先记成 0 或 1，EcoQoS 那一层下面再算。
      const eco = (l: PriorityLevel): boolean => l === 2;
      let base: PriorityLevel = c.from >= 1 ? 1 : 0;
      if ((c.from >= 1) !== (c.to >= 1)) {
        try {
          if (c.to >= 1 && getPriority(c.pid) !== os.constants.priority.PRIORITY_NORMAL) continue;
          setPriority(c.pid, c.to >= 1 ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL);
          base = c.to >= 1 ? 1 : 0;
        } catch {
          // 进程退出了或者没有权限：当作没变。
          continue;
        }
      }
      if (c.to === 2 && !eco(c.from) && ecoFailed.has(c.pid)) {
        out.set(c.pid, 1);
        continue;
      }
      if (eco(c.from) === eco(c.to)) out.set(c.pid, eco(c.to) ? 2 : base);
      else {
        out.set(c.pid, eco(c.from) ? 2 : base);
        pending.push(c);
      }
    }
    for (const c of pending) if (c.from === 2) ecoFailed.delete(c.pid);
    const on = pending.filter((c) => c.to === 2).map((c) => c.pid);
    const off = pending.filter((c) => c.from === 2).map((c) => c.pid);
    if (on.length || off.length) {
      let set = new Set<number>();
      try {
        const res = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ecoScript(on, off)]);
        set = new Set(res.split(/\r?\n/).filter((l) => /^\d+$/.test(l.trim())).map((l) => Number(l.trim())));
      } catch {
        // EcoQoS 不支持（老版本 Windows）：只有 BelowNormal。
      }
      for (const c of pending) {
        if (!set.has(c.pid)) continue;
        out.set(c.pid, c.to === 2 ? 2 : c.to);
      }
      // 开 EcoQoS 失败的：停在 BelowNormal（1），以后不再试。
      for (const pid of on) {
        if (set.has(pid)) continue;
        out.set(pid, 1);
        ecoFailed.add(pid);
      }
    }
    return out;
  };
}

/** 当前平台的后端；Linux 等没有能撤回的办法，什么都不做。 */
export function platformBackend(platform: NodeJS.Platform = process.platform): PriorityBackend {
  if (platform === "darwin") return macBackend();
  if (platform === "win32") return winBackend();
  return async () => new Map();
}
