import type { SessionCapacity } from "../../shared/control";
import type { MemoryReading } from "./available-memory";

/** 刚放行的 session 还没长到它该占的内存：这么久之内放行的，每个按预估占用先扣掉。 */
export const PENDING_MS = 120_000;

export interface AdmissionSettings {
  /** 开完新 session 以后至少还要剩这么多（MB）给系统和别的程序。 */
  reserveMb: number;
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

export type Admission = { ok: true; capacity: Capacity; release: () => void } | { ok: false; reason: "memory" | "pressure" | "max_running"; capacity: Capacity };

const mb = (kb: number) => Math.round(kb / 1024);
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
    const availableMb = reading ? Math.max(0, mb(reading.availableKb) - pending * sessionMb) : null;
    const byMemory = availableMb === null ? null : reading?.pressure === "critical" ? 0 : Math.max(0, Math.floor((availableMb - s.reserveMb) / sessionMb));
    const byLimit = maxRunning === null ? null : Math.max(0, maxRunning - running);
    const canStart = byMemory === null ? byLimit : byLimit === null ? byMemory : Math.min(byMemory, byLimit);
    return { availableMb, reserveMb: s.reserveMb, sessionMb, estimate, pending, canStart, running, maxRunning, pressure: reading?.pressure ?? null, source: reading?.source ?? null };
  }

  /** 要开一个新终端：放行就记下（之后 PENDING_MS 内按预估占用扣掉），不放行说明是哪一条。 */
  admit(what: string): Promise<Admission> {
    const run = this.chain.then(() => this.admitNow(what));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async admitNow(what: string): Promise<Admission> {
    const c = await this.capacity();
    let reason: Extract<Admission, { ok: false }>["reason"] | null = null;
    if (c.maxRunning !== null && c.running >= c.maxRunning) reason = "max_running";
    else if (c.availableMb !== null && c.pressure === "critical") reason = "pressure";
    else if (c.availableMb !== null && c.availableMb - c.sessionMb < c.reserveMb) reason = "memory";
    if (reason) {
      this.d.log(`memory admission: ${what} refused (${reason}): available ${c.availableMb ?? "?"} MB, need ${c.sessionMb} MB + reserve ${c.reserveMb} MB, running ${c.running}`);
      return { ok: false, reason, capacity: c };
    }
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
