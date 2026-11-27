// 渲染进程挂上终端（pty:snapshot / pty:since）：先把攒着的输出发出去（BTL-277），再挂上，再取快照或补段。
// 渲染进程丢掉回包之前到的数据（它们已经在快照里）、接着写回包之后到的：攒着的那段要是排到回包后面，就会重复写一遍。
import type { MarkedSnapshot, PtyManager } from "./pty-manager";
import type { PtySubscriptions } from "./pty-subscriptions";

export interface PtyAttachDeps {
  pty: Pick<PtyManager, "snapshotAt" | "since">;
  ptySubs?: Pick<PtySubscriptions, "attach">;
  ptyOutput?: { flush(termId: string): void };
}

function attach(d: PtyAttachDeps, id: unknown): void {
  if (typeof id !== "string") return;
  d.ptyOutput?.flush(id);
  d.ptySubs?.attach(id);
}

/** 挂上并取整份快照。 */
export function attachSnapshot(d: PtyAttachDeps, id: string): MarkedSnapshot {
  attach(d, id);
  return d.pty.snapshotAt(id);
}

/** 挂回摘下过的终端，只补 mark 之后的；补不上时回整份快照（reset：渲染进程先清屏再写）。 */
export function attachSince(d: PtyAttachDeps, id: string, mark: unknown): MarkedSnapshot & { reset: boolean } {
  attach(d, id);
  const m = mark as { epoch?: unknown; end?: unknown } | null;
  const delta = m && typeof m.epoch === "number" && typeof m.end === "number" ? d.pty.since(id, { epoch: m.epoch, end: m.end }) : null;
  return delta ? { reset: false, ...delta } : { reset: true, ...d.pty.snapshotAt(id) };
}
