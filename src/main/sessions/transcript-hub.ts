import { open, type FileHandle } from "node:fs/promises";
import { inoText } from "../conversation/ino";
import { perfOp } from "../diag/perf-stats";
import { DebouncedWatch, type WatchFn } from "./transcript-watch";

/**
 * 每个 transcript 一个共享的 tail（BTL-276）：活动（TranscriptTail）、对话另存（ConvIngester）、用量（UsageScanner）
 * 原来各读各的、各解析一遍。现在谁来读都走 pump(file)：从挂着的消费者里最靠前的游标读起，每行只解码、只 JSON.parse 一次，
 * 按各自的游标分给每个消费者。游标还是各存各的（内存 / 库），换文件、变短也由各自判断（语义不变）。
 * 每读 TAIL_CHUNK_BYTES 让一次事件循环：第一次补读 4MB、几十 MB 也不会长时间卡住主线程，启动时 N 个 session 交替着读。
 */

export const TAIL_CHUNK_BYTES = 256 * 1024;
/** 比这长的一行直接跳过（通常是一大段工具结果）。和原来对话另存的上限一样。 */
export const TAIL_MAX_LINE_BYTES = 64 << 20;

const NL = 0x0a;
const NOT_JSON = Symbol("not json");

/** 一行：[start, end) 是含换行的字节范围；text 去掉了行尾的 \r，可能是空串。skipped：超长跳过的行，text 为空。 */
export interface TailLine {
  start: number;
  end: number;
  text: string;
  skipped: boolean;
  /** 解析好的 JSON（只解析一次，第一次用到时）；不是 JSON、空行、跳过的行为 undefined。 */
  json(): unknown;
}

export interface TailStat {
  ino: string;
  size: number;
}

/**
 * 一个消费者。begin 在每次 pump 开始时调（已经 stat 过）：自己判断换文件 / 变短（要重置的当场把重置后的游标存下），
 * 返回从哪读；null 是这次不读。skipPartial：offset 可能在一行中间（只读尾部时），丢掉开头那半行（正好从 offset 开始的那一行也丢）。
 * lines 按文件顺序、一块一块给完整的行（都在 offset 之后），next 是最后一行之后的位置，消费者据此推进、保存游标；返回 false 这次不再给它。
 * end 在这次 pump 结束时调（读失败为 null）。都是同步的。
 */
export interface TailSink {
  begin(st: TailStat): { offset: number; skipPartial?: boolean } | null;
  lines(lines: TailLine[], next: number, st: TailStat): boolean | void;
  end?(st: TailStat | null): void;
}

export interface TranscriptHubOptions {
  chunkBytes?: number;
  maxLineBytes?: number;
  log?: (msg: string, err?: unknown) => void;
  /** 让出事件循环；测试可以换掉。 */
  yieldNow?: () => Promise<void>;
}

const setImmediateYield = (): Promise<void> => new Promise((r) => setImmediate(r));

interface FileEntry {
  sinks: Map<string, TailSink>;
  /** 正在跑的 pump；再来的排在它后面合成一次。 */
  running: Promise<TailStat | null> | null;
  queued: Promise<TailStat | null> | null;
  watch: SharedWatch | null;
}

interface SharedWatch {
  w: DebouncedWatch;
  subs: Map<string, () => void>;
}

interface Part {
  sink: TailSink;
  pos: number;
  skipPartial: boolean;
}

export class TranscriptHub {
  private readonly files = new Map<string, FileEntry>();

  constructor(private readonly o: TranscriptHubOptions = {}) {}

  /** 挂上一个消费者（同一个 key 再挂就替换）；返回摘掉的函数。 */
  attach(file: string, key: string, sink: TailSink): () => void {
    const e = this.entry(file);
    e.sinks.set(key, sink);
    return () => {
      if (e.sinks.get(key) !== sink) return;
      e.sinks.delete(key);
      this.drop(file, e);
    };
  }

  /** 这个文件上挂着的消费者（测试、诊断用）。 */
  sinkKeys(file: string): string[] {
    return [...(this.files.get(file)?.sinks.keys() ?? [])];
  }

  /**
   * 一个文件只挂一个 fs.watch（第一个订阅者的去抖时间和 watch 函数为准），变了通知每个订阅者。
   * 返回的 ensure 和 DebouncedWatch.ensure 一样（文件换掉后重新挂上），close 退订，没人订了就关掉监视。
   */
  watch(file: string, key: string, o: { delayMs: number; onChange: () => void; watch?: WatchFn; log?: (msg: string, err?: unknown) => void }): { ensure(): boolean; close(): void } {
    const e = this.entry(file);
    if (!e.watch) {
      const subs = new Map<string, () => void>();
      const w = new DebouncedWatch(file, {
        delayMs: o.delayMs,
        watch: o.watch,
        log: o.log,
        onChange: () => {
          for (const fn of [...subs.values()]) {
            try {
              fn();
            } catch (err) {
              this.o.log?.(`transcript watch: a listener of ${file} threw`, err);
            }
          }
        },
      });
      e.watch = { w, subs };
    }
    const shared = e.watch;
    const fn = o.onChange;
    shared.subs.set(key, fn);
    return {
      ensure: () => (e.watch === shared && shared.subs.get(key) === fn ? shared.w.ensure() : false),
      close: () => {
        if (shared.subs.get(key) !== fn) return;
        shared.subs.delete(key);
        if (shared.subs.size === 0) {
          shared.w.close();
          if (e.watch === shared) e.watch = null;
          this.drop(file, e);
        }
      },
    };
  }

  /**
   * 把新内容读给挂着的所有消费者。正在读时排在它后面再读一次（中间可能又写了），已经排着的合成一次。
   * 返回这次 stat 到的文件；打不开、读出错返回 null（消费者的游标不动）。
   */
  pump(file: string): Promise<TailStat | null> {
    const e = this.entry(file);
    if (e.queued) return e.queued;
    if (!e.running) {
      e.running = this.run(file, e);
      return e.running;
    }
    const after = e.running.then(
      () => undefined,
      () => undefined,
    );
    e.queued = after.then(() => {
      e.queued = null;
      e.running = this.run(file, e);
      return e.running;
    });
    return e.queued;
  }

  private entry(file: string): FileEntry {
    let e = this.files.get(file);
    if (!e) {
      e = { sinks: new Map(), running: null, queued: null, watch: null };
      this.files.set(file, e);
    }
    return e;
  }

  private drop(file: string, e: FileEntry): void {
    if (e.sinks.size === 0 && !e.watch && !e.running && !e.queued && this.files.get(file) === e) this.files.delete(file);
  }

  private async run(file: string, e: FileEntry): Promise<TailStat | null> {
    try {
      return await this.read(file, [...e.sinks.values()]);
    } finally {
      e.running = null;
      this.drop(file, e);
    }
  }

  private async read(file: string, sinks: TailSink[]): Promise<TailStat | null> {
    let fh: FileHandle;
    try {
      fh = await open(file, "r");
    } catch {
      this.endAll(sinks, null);
      return null;
    }
    let st: TailStat | null;
    try {
      const s = await fh.stat({ bigint: true });
      st = { ino: inoText(s.ino), size: Number(s.size) };
      const parts = this.begin(sinks, st);
      if (parts.length > 0) await this.feed(fh, st, parts);
    } catch (err) {
      this.o.log?.(`transcript tail: reading ${file} failed`, err);
      st = null;
    } finally {
      await fh.close().catch(() => undefined);
    }
    this.endAll(sinks, st);
    return st;
  }

  private begin(sinks: TailSink[], st: TailStat): Part[] {
    const parts: Part[] = [];
    for (const sink of sinks) {
      try {
        const at = sink.begin(st);
        if (at && at.offset < st.size) parts.push({ sink, pos: Math.max(0, at.offset), skipPartial: at.skipPartial === true });
      } catch (err) {
        this.o.log?.("transcript tail: a reader failed to start", err);
      }
    }
    return parts;
  }

  private endAll(sinks: TailSink[], st: TailStat | null): void {
    for (const s of sinks) {
      try {
        s.end?.(st);
      } catch (err) {
        this.o.log?.("transcript tail: a reader failed to finish", err);
      }
    }
  }

  /** 从最靠前的游标读到文件末尾（只到最后一个换行）；每块解析完、分完就让一次。 */
  private async feed(fh: FileHandle, st: TailStat, parts: Part[]): Promise<void> {
    const chunk = Math.max(1, this.o.chunkBytes ?? TAIL_CHUNK_BYTES);
    const maxLine = Math.max(1, this.o.maxLineBytes ?? TAIL_MAX_LINE_BYTES);
    const yieldNow = this.o.yieldNow ?? setImmediateYield;
    let pos = Math.min(...parts.map((p) => p.pos));
    let window = chunk;
    let active = parts;
    while (pos < st.size && active.length > 0) {
      const len = Math.min(window, st.size - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      const b = buf.subarray(0, bytesRead);
      const nl = b.lastIndexOf(NL);
      if (nl < 0) {
        // 没有换行：到了文件末尾就是半行，等它写完；否则窗口加倍，超过上限就跳过这一行。
        if (bytesRead < window || pos + bytesRead >= st.size) return;
        if (window > maxLine) {
          const end = await nextNewline(fh, pos + window, st.size, chunk);
          if (end === null) return;
          active = this.dispatch(active, [skippedLine(pos, end + 1)], st);
          pos = end + 1;
          window = chunk;
          await yieldNow();
          continue;
        }
        window = Math.min(window * 2, maxLine + 1);
        continue;
      }
      const lines = splitLines(b.subarray(0, nl + 1), pos);
      active = perfOp("transcript.tail", () => this.dispatch(active, lines, st));
      pos += nl + 1;
      window = chunk;
      if (pos < st.size && active.length > 0) await yieldNow();
    }
  }

  /** 把这一块里每个消费者游标之后的行给它；返回还要继续读的消费者。 */
  private dispatch(parts: Part[], lines: TailLine[], st: TailStat): Part[] {
    const keep: Part[] = [];
    for (const p of parts) {
      const from = lines.findIndex((l) => l.start > p.pos || (l.start === p.pos && !p.skipPartial));
      if (from < 0) {
        keep.push(p);
        continue;
      }
      const mine = from === 0 ? lines : lines.slice(from);
      const next = mine[mine.length - 1].end;
      let more: boolean | void;
      try {
        more = p.sink.lines(mine, next, st);
      } catch (err) {
        this.o.log?.("transcript tail: a reader failed on new lines", err);
        more = false;
      }
      p.pos = next;
      p.skipPartial = false;
      if (more !== false) keep.push(p);
    }
    return keep;
  }
}

function skippedLine(start: number, end: number): TailLine {
  return { start, end, text: "", skipped: true, json: () => undefined };
}

/** b 以换行结尾；base 是 b[0] 在文件里的位置。按字节切，多字节字符不会被切开。 */
function splitLines(b: Buffer, base: number): TailLine[] {
  const out: TailLine[] = [];
  let from = 0;
  while (from < b.length) {
    const i = b.indexOf(NL, from);
    const stop = i < 0 ? b.length : i;
    const text = b.toString("utf8", from, stop > from && b[stop - 1] === 0x0d ? stop - 1 : stop);
    out.push(line(base + from, base + stop + 1, text));
    from = stop + 1;
  }
  return out;
}

function line(start: number, end: number, text: string): TailLine {
  let parsed: unknown = NOT_JSON;
  let done = false;
  return {
    start, end, text, skipped: false,
    json() {
      if (!done) {
        done = true;
        const t = text.trim();
        if (t) {
          try {
            parsed = JSON.parse(t);
          } catch {
            parsed = NOT_JSON;
          }
        }
      }
      return parsed === NOT_JSON ? undefined : parsed;
    },
  };
}

async function nextNewline(fh: FileHandle, pos: number, size: number, chunk: number): Promise<number | null> {
  const buf = Buffer.alloc(chunk);
  while (pos < size) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(chunk, size - pos), pos);
    if (bytesRead === 0) return null;
    const i = buf.subarray(0, bytesRead).indexOf(NL);
    if (i >= 0) return pos + i;
    pos += bytesRead;
  }
  return null;
}
