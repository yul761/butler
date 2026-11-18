import type { SessionCapacity } from "../../shared/control";
import { readingLine, type MemoryReading } from "./available-memory";

/** 刚放行的 session 还没长到它该占的内存：这么久之内放行的，每个按预估占用先扣掉。 */
export const PENDING_MS = 120_000;

export interface AdmissionSettings {
  /** 开完新 session 以后至少还要剩这么多（MB）给系统和别的程序；null = 自动（autoReserveMb，默认）。 */
  reserveMb: number | null;
  /** 没有实测时，一个新 session（Claude 加它的 MCP server 和子进程）预计占多少（MB）。 */
  sessionMb: number;
  /** 同时开着的终端最多几个；0 = 不限（默认，只看内存）。 */
  maxRunning: number;
}

export interface AdmissionDeps {
  read(): Promise<MemoryReading>;
  settings(): AdmissionSettings;
  /**
   * 开着的 session 每个整棵进程树的实测占用（KB，工作流 M 的内存采样）。没有采样（M 关着、还没采到）返回空数组，
   * 这时用设置里的预估值。
   */
  measuredSessionsKb?(): number[];
  /** Butler 现在开着的终端数（硬上限用）。 */
  running(): number;
  now(): number;
  log(msg: string, err?: unknown): void;
}

export type Capacity = SessionCapacity;

/** 一个开着的终端：它的 head 和终端打开的时间。 */
export interface OpenTerm {
  head: string;
  openedAt: number;
}

/**
 * 给 AdmissionDeps.measuredSessionsKb 用（附录第 4 节）：开着的 session 每个整棵进程树的实测占用（KB，工作流 M 的 MemoryMonitor）。
 * 终端开了不到 PENDING_MS 的不算：还没长大，会把平均拉低。监控关着、还没采到的没有读数，也不算。
 * 同一个 head 只算一次。一个都没有时返回空数组，准入就用设置里的预估值。休眠的 session 没有终端，本来就不在里面。
 */
export function measuredOpenSessionsKb(terms: OpenTerm[], memoryOf: (head: string) => { totalKb: number } | null, now: number): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const t of terms) {
    if (seen.has(t.head)) continue;
    seen.add(t.head);
    if (t.openedAt <= 0 || now - t.openedAt < PENDING_MS) continue;
    const m = memoryOf(t.head);
    if (m && Number.isFinite(m.totalKb) && m.totalKb > 0) out.push(m.totalKb);
  }
  return out;
}

export type Admission = { ok: true; capacity: Capacity; release: () => void } | { ok: false; reason: "memory" | "pressure" | "max_running"; capacity: Capacity };

const mb = (kb: number) => Math.round(kb / 1024);

/** 自动保留线的上下限（MB）。 */
export const AUTO_RESERVE_MIN_MB = 512;
export const AUTO_RESERVE_MAX_MB = 2048;

/**
 * 自动保留线：物理内存的 10%，限在 512 到 2048 MB 之间（8 GB 的机器 819 MB，16 GB 1638 MB，20 GB 以上 2048 MB）。
 * 可用量按 vm_stat 算（不算要压缩才拿得回来的匿名页），本来就偏保守：小内存的机器再固定留 2 GB，连一个都开不了（附录第 7 节）。
 * 读不到总量时按上限。
 */
export function autoReserveMb(totalKb: number | null): number {
  if (totalKb === null || !(totalKb > 0)) return AUTO_RESERVE_MAX_MB;
  return Math.min(AUTO_RESERVE_MAX_MB, Math.max(AUTO_RESERVE_MIN_MB, Math.round(totalKb / 1024 / 10)));
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * 开新 session 前按内存决定放不放行（工作流 W，替代以前写死的每 ticket 6 个、每 feature 8 个、每 epic 4 个 feature）：
 * 可用内存减去已经放行、还在长的 session，再减去这一个的预估占用，还要高于保留线才放行。系统内存压力已经是「严重」时不放行。
 * 硬上限默认关着，只当保险。读内存出错时放行（只看硬上限）并记日志：出错不能挡住干活。
 */
export class MemoryAdmission {
  /** 最近放行的，每个一个对象：release 只拿走自己的那一个。 */
  private admitted: { at: number }[] = [];
  /** admit 一个接一个跑：两个同时来时，后一个看得到前一个刚记下的。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: AdmissionDeps) {}

  private estimateMb(s: AdmissionSettings): { sessionMb: number; estimate: Capacity["estimate"] } {
    const measured = (this.d.measuredSessionsKb?.() ?? []).filter((kb) => Number.isFinite(kb) && kb > 0);
    // 实测取平均：一个特别大的 session 不会把预估顶上去，也不会被几个刚开的小 session 拉得太低。
    return measured.length > 0 ? { sessionMb: Math.max(1, mb(mean(measured))), estimate: "measured" } : { sessionMb: s.sessionMb, estimate: "setting" };
  }

  /** 现在的余量，不放行也不记。 */
  async capacity(): Promise<Capacity> {
    return (await this.measure()).capacity;
  }

  private async measure(): Promise<{ capacity: Capacity; reading: MemoryReading | null; reserveAuto: boolean }> {
    const s = this.d.settings();
    const now = this.d.now();
    this.admitted = this.admitted.filter((a) => now - a.at < PENDING_MS);
    const { sessionMb, estimate } = this.estimateMb(s);
    const running = this.d.running();
    const maxRunning = s.maxRunning > 0 ? s.maxRunning : null;
    let reading: MemoryReading | null = null;
    try {
      reading = await this.d.read();
    } catch (e) {
      this.d.log("memory admission: reading memory failed, only the hard limit applies", e);
    }
    const pending = this.admitted.length;
    const reserveMb = s.reserveMb ?? autoReserveMb(reading?.totalKb ?? null);
    const availableMb = reading ? Math.max(0, mb(reading.availableKb) - pending * sessionMb) : null;
    const byMemory = availableMb === null ? null : reading?.pressure === "critical" ? 0 : Math.max(0, Math.floor((availableMb - reserveMb) / sessionMb));
    const byLimit = maxRunning === null ? null : Math.max(0, maxRunning - running);
    const canStart = byMemory === null ? byLimit : byLimit === null ? byMemory : Math.min(byMemory, byLimit);
    return {
      capacity: { availableMb, reserveMb, sessionMb, estimate, pending, canStart, running, maxRunning, pressure: reading?.pressure ?? null, source: reading?.source ?? null },
      reading,
      reserveAuto: s.reserveMb === null,
    };
  }

  /**
   * 不问内存就开了一个终端（唤醒休眠的 session：要递的消息不能因为内存被拒）：照样记成刚开的，
   * 之后 PENDING_MS 内按预估占用扣掉，紧接着的 start_session 不会以为这部分内存还空着。
   */
  note(what: string): void {
    const now = this.d.now();
    this.admitted = this.admitted.filter((a) => now - a.at < PENDING_MS);
    this.admitted.push({ at: now });
    this.d.log(`memory admission: ${what} opened without asking, counted as pending (${this.admitted.length} pending)`);
  }

  /** 要开一个新终端：放行就记下（之后 PENDING_MS 内按预估占用扣掉），不放行说明是哪一条。 */
  admit(what: string): Promise<Admission> {
    const run = this.chain.then(() => this.admitNow(what));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async admitNow(what: string): Promise<Admission> {
    const { capacity: c, reading, reserveAuto } = await this.measure();
    // 读数写进日志（附录第 7 节）：别的机器上（CI、8 GB 的 Mac）看得出 vm_stat 算出来的合不合理。
    const read = reading ? readingLine(reading) : "no reading";
    const reserve = `${c.reserveMb} MB${reserveAuto ? " (auto)" : ""}`;
    let reason: Extract<Admission, { ok: false }>["reason"] | null = null;
    if (c.maxRunning !== null && c.running >= c.maxRunning) reason = "max_running";
    else if (c.availableMb !== null && c.pressure === "critical") reason = "pressure";
    else if (c.availableMb !== null && c.availableMb - c.sessionMb < c.reserveMb) reason = "memory";
    if (reason) {
      this.d.log(`memory admission: ${what} refused (${reason}): available ${c.availableMb ?? "?"} MB, need ${c.sessionMb} MB + reserve ${reserve}, pending ${c.pending}, running ${c.running}; ${read}`);
      return { ok: false, reason, capacity: c };
    }
    this.d.log(`memory admission: ${what} admitted: available ${c.availableMb ?? "?"} MB, need ${c.sessionMb} MB + reserve ${reserve}, pending ${c.pending}, running ${c.running}; ${read}`);
    const slot = { at: this.d.now() };
    this.admitted.push(slot);
    // 返回的是开了这一个以后的余量；没开成时调 release 把这一个还回去（只还自己的，调几次都只还一次）。
    return {
      ok: true,
      release: () => {
        this.admitted = this.admitted.filter((a) => a !== slot);
      },
      capacity: {
        ...c, pending: c.pending + 1, running: c.running + 1,
        availableMb: c.availableMb === null ? null : Math.max(0, c.availableMb - c.sessionMb),
        canStart: c.canStart === null ? null : Math.max(0, c.canStart - 1),
      },
    };
  }

}
