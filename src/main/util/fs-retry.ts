import { renameSync } from "node:fs";
import { rename } from "node:fs/promises";

/** Windows 上杀毒软件、索引服务或正在运行的 hook 会短暂占着文件：这几种错误等一下再试（计划 1 Task 6）。 */
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
export const RENAME_ATTEMPTS = 6;
/** 20、40、80、160、320 毫秒：最多多等约 0.6 秒。 */
const delay = (attempt: number): number => 20 * 2 ** attempt;
const retryable = (e: unknown): boolean => RETRYABLE.has((e as NodeJS.ErrnoException)?.code ?? "");

export async function renameWithRetry(
  from: string,
  to: string,
  o: { rename?: (a: string, b: string) => Promise<void>; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const doRename = o.rename ?? rename;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (e) {
      if (attempt >= RENAME_ATTEMPTS - 1 || !retryable(e)) throw e;
      await sleep(delay(attempt));
    }
  }
}

/** 同步版本（hook、--mcp-config 文件这些同步写入的地方）。 */
export function renameWithRetrySync(
  from: string,
  to: string,
  o: { rename?: (a: string, b: string) => void; sleep?: (ms: number) => void } = {},
): void {
  const doRename = o.rename ?? renameSync;
  const sleep = o.sleep ?? ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  for (let attempt = 0; ; attempt++) {
    try {
      doRename(from, to);
      return;
    } catch (e) {
      if (attempt >= RENAME_ATTEMPTS - 1 || !retryable(e)) throw e;
      sleep(delay(attempt));
    }
  }
}
