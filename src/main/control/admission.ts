import type { SessionCapacity } from "../../shared/control";
import type { Admission, MemoryAdmission } from "../sessions/memory-admission";
import { M } from "../strings";

export type AdmissionGate = Pick<MemoryAdmission, "admit" | "capacity">;

/**
 * MB 写成「3.5 GB」（不到 1 GB 写 MB）。up 为 true 时往上取、否则往下取：拒绝文案里可用的往下、要的往上，
 * 不会出现「可用 3.0 GB、要 1.0 GB、留 2.0 GB」看着正好够却被拒的情况。
 */
export function gb(mb: number, up = false): string {
  if (mb < 1024) return `${mb} MB`;
  const tenths = (mb / 1024) * 10;
  return `${((up ? Math.ceil(tenths - 1e-9) : Math.floor(tenths + 1e-9)) / 10).toFixed(1)} GB`;
}

/** 不放行时给总控看的原因：内存不够（还剩多少、要多少）、内存压力严重、到了硬上限。 */
export function admissionError(a: Extract<Admission, { ok: false }>): string {
  const c = a.capacity;
  if (a.reason === "max_running") return M().ctlMaxRunning(c.running);
  if (a.reason === "pressure") return M().ctlMemoryPressure;
  return M().ctlNoMemory(gb(c.availableMb ?? 0), gb(c.sessionMb, true), gb(c.reserveMb, true), c.estimate === "measured", c.pending);
}

/**
 * 开新终端前问内存（工作流 W）。放行时返回 release：之后没开成要还回去。没接 admission（单测、老的接法）时一律放行。
 */
export async function admitOrRefuse(gate: AdmissionGate | undefined, what: string): Promise<{ ok: true; release: () => void; capacity: SessionCapacity | undefined } | { ok: false; error: string }> {
  if (!gate) return { ok: true, release: () => undefined, capacity: undefined };
  const a = await gate.admit(what);
  if (!a.ok) return { ok: false, error: admissionError(a) };
  return { ok: true, release: a.release, capacity: a.capacity };
}
