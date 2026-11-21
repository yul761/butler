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
  /** 正在异步写的那一批（写完之前 flushSync 要把它也同步写一遍，不然退出时可能丢）。 */
  let inflight: string | null = null;
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
      inflight = text;
      try {
        if (!dirReady) {
          await mkdir(dirname(file), { recursive: true });
          dirReady = true;
        }
        // flushSync 已经同步写过这一批：不再写第二遍（mkdir 还没完的时候会走到这里）。
        if (inflight === text) await appendFile(file, text);
      } catch {
        // 日志本身不能让主进程出错。
        dirReady = false;
      } finally {
        if (inflight === text) inflight = null;
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
  // 退出、崩溃时用。还在异步写的那一批也同步写一遍、写在前面：异步那次可能来不及写完进程就退了。
  // 它要是已经写进了文件，这一批会重复一次；退出时宁可重复，不能丢。
  log.flushSync = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const pending = inflight ?? "";
    inflight = null;
    if (buf.length === 0 && pending === "") return;
    const text = pending + take();
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, text);
    } catch {
      // 同上：绝不抛出。
    }
  };
  return log;
}
