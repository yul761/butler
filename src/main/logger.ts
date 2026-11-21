import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type Logger = (msg: string, err?: unknown) => void;

/** 写文件的日志：攒着的行可以马上写完（flush 异步，flushSync 同步，退出和崩溃时用）。 */
export type FileLogger = Logger & { flush(): Promise<void>; flushSync(): void };

const describe = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

export interface FileLoggerOptions {
  /** 攒多久再写（默认 250ms）。 */
  flushMs?: number;
  /** 攒够这么多字符就马上写（默认 64 KB）。 */
  maxBuffer?: number;
}

/**
 * 追加写入带时间戳的日志行；任何失败都被吞掉，绝不抛出。tee 用于 dev 模式下同时打印到控制台。
 * BTL-242：不再每行同步写一次盘（Windows 上杀毒软件让每次 appendFileSync 都很慢），攒 flushMs 再异步写，一次只有一个写在跑，顺序不乱。
 */
export function createFileLogger(file: string, now: () => Date = () => new Date(), tee?: (line: string) => void, opts: FileLoggerOptions = {}): FileLogger {
  const flushMs = opts.flushMs ?? 250;
  const maxBuffer = opts.maxBuffer ?? 64 * 1024;
  let buf: string[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> | null = null;
  let dirReady = false;

  const take = (): string => {
    const text = buf.join("");
    buf = [];
    size = 0;
    return text;
  };

  const writeOnce = async (): Promise<void> => {
    while (buf.length > 0) {
      const text = take();
      try {
        if (!dirReady) {
          await mkdir(dirname(file), { recursive: true });
          dirReady = true;
        }
        await appendFile(file, text);
      } catch {
        // 日志本身不能让主进程出错。
        dirReady = false;
      }
    }
  };

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    // 已经有一个在写：等它写完再看还有没有（writeOnce 会把它跑完之后加进来的也写掉）。
    writing ??= writeOnce().finally(() => {
      writing = null;
    });
    const current = writing;
    return current.then(() => (buf.length > 0 ? flush() : undefined));
  };

  const log = ((msg: string, err?: unknown) => {
    const line = `${now().toISOString()} ${msg}${err === undefined ? "" : ` ${describe(err)}`}`;
    try {
      tee?.(line);
    } catch {
      // 控制台出错不影响写文件。
    }
    buf.push(`${line}\n`);
    size += line.length + 1;
    if (size >= maxBuffer) void flush();
    else if (!timer && !writing) {
      timer = setTimeout(() => void flush(), flushMs);
      timer.unref?.();
    }
  }) as FileLogger;

  log.flush = flush;
  log.flushSync = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (buf.length === 0) return;
    const text = take();
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, text);
    } catch {
      // 同上：绝不抛出。
    }
  };
  return log;
}
