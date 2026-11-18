import type { IpcResult } from "../../shared/ipc";

/** ipcMain.handle 抛出的错误到渲染进程只剩一段字符串，所以统一包装成带 code 的结果。 */
export function toIpcResult<T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> {
  return Promise.resolve()
    .then(fn)
    .then(
      (value): IpcResult<T> => ({ ok: true, value }),
      (e: unknown): IpcResult<T> => {
        const code = e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "internal";
        return { ok: false, code, message: e instanceof Error ? e.message : String(e) };
      },
    );
}

/**
 * toIpcResult，成功以后再把通道、参数和返回值交给 onInvoked（度量的手动触发在这里记，ws-h）。
 * 失败的调用不交；onInvoked 抛错不影响返回给渲染进程的结果。
 */
export async function meteredIpcResult<T>(
  channel: string,
  args: readonly unknown[],
  fn: () => T | Promise<T>,
  onInvoked?: (channel: string, args: readonly unknown[], result: unknown) => void,
): Promise<IpcResult<T>> {
  const r = await toIpcResult(fn);
  if (r.ok && onInvoked) {
    try {
      onInvoked(channel, args, r.value);
    } catch {
      // 度量出错不影响结果。
    }
  }
  return r;
}
