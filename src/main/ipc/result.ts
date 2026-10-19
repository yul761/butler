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
