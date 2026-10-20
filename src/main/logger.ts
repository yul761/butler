import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Logger = (msg: string, err?: unknown) => void;

const describe = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/** 追加写入带时间戳的日志行；同步写，任何失败都被吞掉，绝不抛出。 */
export function createFileLogger(file: string, now: () => Date = () => new Date()): Logger {
  return (msg, err) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${now().toISOString()} ${msg}${err === undefined ? "" : ` ${describe(err)}`}\n`);
    } catch {
      // 日志本身不能让主进程出错。
    }
  };
}
