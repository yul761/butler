import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Logger = (msg: string, err?: unknown) => void;

const describe = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/**
 * 追加写入带时间戳的日志行；同步写，任何失败都被吞掉，绝不抛出。
 * tee 用于 dev 模式下同时打印到控制台。
 */
export function createFileLogger(file: string, now: () => Date = () => new Date(), tee?: (line: string) => void): Logger {
  return (msg, err) => {
    const line = `${now().toISOString()} ${msg}${err === undefined ? "" : ` ${describe(err)}`}`;
    try {
      tee?.(line);
    } catch {
      // 控制台出错不影响写文件。
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${line}\n`);
    } catch {
      // 日志本身不能让主进程出错。
    }
  };
}
