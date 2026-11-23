import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MonitorSample } from "./memory-monitor";
import { childrenIndex, compareStart, treeOf, type ProcInfo, type ProcTable } from "./proc-table";

/**
 * 孤儿清理（WS-M F，设计 §7）。
 * Shipherd 起过的进程 = 在某个终端那棵树里出现过的进程，按 (pid, 启动时间, 命令行) 认，三样都对上才算同一个。
 * 记下的进程一直留着，直到它退出（不是每次采样换一份）。父进程退出、自己被收养走的也认回来：
 * macOS 上被收养到 1 号进程的还留在原来那个 shell 的进程组里（pgid），按组认回来。
 * 认不出来的：起它的 shell 在被采样到之前就退出了（macOS，组长没记下）；Windows 上父进程退出、自己没被采样到过的（见 WS-M addendum）。
 * 终端结束以后等一会儿，还活着、而且不在任何开着的终端底下的，就是漏掉的孤儿（claude 用 & 或 nohup 起的 dev server、
 * 被 MCP 留下的浏览器）：先 SIGTERM，5 秒后还在就 SIGKILL（Windows 用 taskkill，强制时加 /F，不加 /T）。每杀一个都写日志。
 * 记录存在 procs/owned.json：Shipherd 崩了、被强制退出，下次启动时扫一遍。
 */
export interface OwnedProc {
  pid: number;
  start: string;
  args: string;
}

export interface OrphanDeps {
  enabled(): boolean;
  readTable(): Promise<ProcTable | null>;
  /** 开着的终端里那个进程的 pid。 */
  liveRoots(): number[];
  /** 发信号；进程已经不在时抛错也没关系。force：SIGKILL / taskkill /F。 */
  kill(pid: number, force: boolean): void;
  file: string;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
  /** 终端结束后等多久再看（让进程自己退出）。 */
  graceMs?: number;
}

export const ORPHAN_GRACE_MS = 5_000;
const KILL_WAIT_MS = 5_000;

const same = (a: OwnedProc, b: ProcInfo | undefined): boolean => !!b && b.start === a.start && b.args === a.args;

const record = (p: ProcInfo): OwnedProc => ({ pid: p.pid, start: p.start, args: p.args });

/** a 不比 b 早启动（读不出来时当作是）。 */
const notBefore = (a: string, b: string): boolean => (compareStart(a, b) ?? 0) >= 0;

/**
 * 把记下的进程的后代加进来，包括被收养走的：
 * - ppid 是记下的、还活着的进程，而且不比它早启动（Windows 上 ppid 可能指着同一个 pid 的老进程）。
 * - pgid 是记下的进程，而且不比它早启动（macOS：shell 退出后子进程被收养到 1 号进程，组还在；组没散之前 pid 不会被重用）。
 *   那个 pid 现在被别的进程占了的不算（组已经是新进程的了）。
 * 父进程已经退出的不按 ppid 认：Windows 很快重用 pid，分不清是哪一个的子进程。加到没有新的为止。
 */
function adopt(procs: Map<number, OwnedProc>, table: ProcTable): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const q of table.values()) {
      if (procs.has(q.pid)) continue;
      const parent = procs.get(q.ppid);
      let mine = !!parent && same(parent, table.get(q.ppid)) && notBefore(q.start, parent.start);
      if (!mine && q.pgid !== undefined && q.pgid !== q.pid && q.pgid > 1) {
        const leader = procs.get(q.pgid);
        const now = table.get(q.pgid);
        mine = !!leader && (!now || same(leader, now)) && notBefore(q.start, leader.start);
      }
      if (!mine) continue;
      procs.set(q.pid, record(q));
      changed = true;
    }
  }
}

export class OrphanSweeper {
  /** termId → 那棵树里见过、上次采样时还活着的进程。 */
  private owned = new Map<string, Map<number, OwnedProc>>();
  /** 不要清理的（休眠时留下的 watcher）：pid → 那个进程和留下它的 session（head）。 */
  private readonly spared = new Map<number, OwnedProc & { owner: string }>();
  private saved = "";

  constructor(private readonly d: OrphanDeps) {}

  /** 每次采样：把每个开着的终端底下现在的进程加进记录，认回被收养走的，再去掉已经退出的。 */
  async onSample(s: MonitorSample): Promise<void> {
    if (!this.d.enabled()) return;
    const open = new Set(s.terms.map((t) => t.termId));
    for (const t of s.terms) {
      const procs = this.owned.get(t.termId) ?? new Map<number, OwnedProc>();
      for (const p of t.tree) procs.set(p.pid, record(p));
      this.owned.set(t.termId, procs);
    }
    for (const [termId, procs] of this.owned) {
      adopt(procs, s.table);
      for (const [pid, p] of procs) if (!same(p, s.table.get(pid))) procs.delete(pid);
      if (procs.size === 0 && !open.has(termId)) this.owned.delete(termId);
    }
    await this.save();
  }

  /**
   * 这些进程先不清理（休眠时留下的 watcher 和 dev server，WS-M B）。owner 是休眠的 session。
   * 照样写进 owned.json：Shipherd 重启时（留着它们的 session 已经不在跑了）启动扫描会结束它们。
   */
  spare(owner: string, procs: OwnedProc[]): void {
    for (const p of procs) this.spared.set(p.pid, { ...p, owner });
    void this.save();
  }

  /** owner 醒了、结束了或者被删了：它留下的 watcher 变成普通的孤儿，现在就清理。返回结束掉的个数。 */
  async release(owner: string): Promise<number> {
    const mine = [...this.spared.values()].filter((p) => p.owner === owner);
    if (mine.length === 0) return 0;
    for (const p of mine) this.spared.delete(p.pid);
    if (!this.d.enabled()) {
      await this.save();
      return 0;
    }
    const n = await this.sweep(mine.map(({ pid, start, args }) => ({ pid, start, args })), `session ${owner} no longer hibernated`);
    await this.save();
    return n;
  }

  /** 终端结束了：等一会儿，把它底下还活着的孤儿结束掉。返回结束掉的个数。 */
  async termExited(termId: string): Promise<number> {
    const procs = this.owned.get(termId);
    if (!procs || !this.d.enabled()) {
      this.owned.delete(termId);
      return 0;
    }
    await this.d.sleep(this.d.graceMs ?? ORPHAN_GRACE_MS);
    this.owned.delete(termId);
    const n = await this.sweep([...procs.values()], `terminal ${termId} exited`);
    await this.save();
    return n;
  }

  /** 启动时：上次运行记下的、还活着的结束掉。 */
  async sweepAtStartup(): Promise<number> {
    let list: OwnedProc[];
    try {
      const parsed = JSON.parse(await readFile(this.d.file, "utf8")) as { procs?: OwnedProc[] };
      list = Array.isArray(parsed.procs) ? parsed.procs.filter((p) => typeof p.pid === "number" && typeof p.start === "string" && typeof p.args === "string") : [];
    } catch {
      return 0;
    }
    const n = this.d.enabled() ? await this.sweep(list, "left from the last run") : 0;
    await this.save(true);
    return n;
  }

  private async sweep(candidates: OwnedProc[], why: string): Promise<number> {
    if (candidates.length === 0) return 0;
    const table = await this.d.readTable();
    if (!table) return 0;
    // 上次采样之后才被收养走的（比如终端结束时父进程跟着退出）也认回来。
    const all = new Map(candidates.map((c) => [c.pid, c]));
    adopt(all, table);
    const children = childrenIndex(table);
    const underLive = new Set(this.d.liveRoots().flatMap((r) => treeOf(r, table, children).map((p) => p.pid)));
    const victims = [...all.values()].filter((c) => same(c, table.get(c.pid)) && !underLive.has(c.pid) && this.spared.get(c.pid)?.start !== c.start);
    if (victims.length === 0) return 0;
    for (const v of victims) {
      this.d.log(`orphan cleanup (${why}): ending pid ${v.pid} ${v.args.slice(0, 200)}`);
      try {
        this.d.kill(v.pid, false);
      } catch {
        // 刚好自己退出了。
      }
    }
    await this.d.sleep(KILL_WAIT_MS);
    const after = await this.d.readTable();
    for (const v of victims) {
      if (!after || !same(v, after.get(v.pid))) continue;
      this.d.log(`orphan cleanup: pid ${v.pid} still running, forcing it`);
      try {
        this.d.kill(v.pid, true);
      } catch {
        // 已经退出。
      }
    }
    return victims.length;
  }

  /** 内容变了才写；先写临时文件再改名，崩在中间也不会留下半个文件。 */
  private async save(force = false): Promise<void> {
    const kept = [...this.spared.values()].map(({ pid, start, args }) => ({ pid, start, args }));
    const procs = [...this.owned.values()].flatMap((m) => [...m.values()]).filter((p) => !this.spared.has(p.pid)).concat(kept);
    const text = JSON.stringify({ procs });
    if (!force && text === this.saved) return;
    this.saved = text;
    try {
      await mkdir(dirname(this.d.file), { recursive: true });
      await writeFile(`${this.d.file}.tmp`, text);
      await rename(`${this.d.file}.tmp`, this.d.file);
    } catch {
      // 写不了就算了：只影响崩溃之后的那次扫描。
    }
  }
}

/**
 * 默认的结束方式：macOS / Linux 发信号；Windows 用 taskkill（/F 强制）。
 * 不用 /T：taskkill 按 ppid 找子进程，会连带早就不相干的进程；要结束的每一个都已经单独核对过、单独结束。
 */
export function platformKill(platform: NodeJS.Platform, run: (cmd: string, args: string[]) => void): (pid: number, force: boolean) => void {
  return (pid, force) => {
    if (platform === "win32") run("taskkill", ["/PID", String(pid), ...(force ? ["/F"] : [])]);
    else process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  };
}
