import type { Dirent } from "node:fs";
import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { applyEntry, newTranscriptState, type TranscriptState } from "./activity-parse";
import { stripAnsi } from "./pty-manager";

const MB = 1024 * 1024;
/** transcript 的时间和文件修改时间之间留的余量。 */
const MTIME_SLACK_MS = 2000;

/**
 * 增量读取 transcript：每次从上次的偏移继续，只处理完整的行。
 * 文件变短就从头重建；第一次读时文件太大只读尾部，丢掉开头的半行。
 */
export class TranscriptTail {
  private offset = 0;
  /** 正在丢弃一行的剩余部分（从文件中间开始读时，第一段是半行）。 */
  private skipping = false;
  private state: TranscriptState = newTranscriptState();
  /** 上一次读成功时的文件大小：一时读不了不能当成文件变了。 */
  private lastSize = 0;

  constructor(
    private readonly file: string,
    private readonly maxInitialBytes = 4 * MB,
  ) {}

  async read(): Promise<{ state: TranscriptState; size: number }> {
    try {
      const fh = await open(this.file, "r");
      try {
        const size = (await fh.stat()).size;
        if (size < this.offset) this.reset();
        if (size - this.offset > this.maxInitialBytes) {
          // 第一次读，或一次涨了太多：只看尾部，状态可能不全，但内存有界
          this.offset = size - this.maxInitialBytes;
          this.skipping = this.offset > 0;
        }
        const len = size - this.offset;
        if (len > 0) {
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, this.offset);
          this.consume(buf.subarray(0, bytesRead));
        }
        this.lastSize = size;
        return { state: this.state, size };
      } finally {
        await fh.close();
      }
    } catch {
      return { state: this.state, size: this.lastSize };
    }
  }

  private reset(): void {
    this.offset = 0;
    this.skipping = false;
    this.state = newTranscriptState();
  }

  private consume(buf: Buffer): void {
    let pos = 0;
    for (let nl = buf.indexOf(0x0a, pos); nl !== -1; nl = buf.indexOf(0x0a, pos)) {
      if (this.skipping) this.skipping = false;
      else this.applyLine(buf.subarray(pos, nl).toString("utf8"));
      pos = nl + 1;
    }
    // 末尾没有换行的半行留到下次；正在丢弃的半行直接略过
    this.offset += this.skipping ? buf.length : pos;
  }

  private applyLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    try {
      applyEntry(this.state, JSON.parse(t));
    } catch {
      // 坏行忽略
    }
  }
}

/** Claude 放后台任务输出的目录；win32 返回 null。 */
export function tasksDirFor(transcriptFile: string, sessionId: string, opts: { platform?: NodeJS.Platform; uid?: number } = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid ?? process.getuid?.();
  if (platform === "win32" || uid === undefined) return null;
  const tmp = platform === "darwin" ? "/private/tmp" : "/tmp";
  return join(tmp, `claude-${uid}`, basename(dirname(transcriptFile)), sessionId, "tasks");
}

/** tasks 目录里修改时间 >= sinceMs - 2s 的最新文件（跳过符号链接和 exclude 里的）；exclude 可以是文件名或完整路径。 */
export async function foregroundOutputFile(tasksDir: string, sinceMs: number, exclude: Set<string>): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(tasksDir);
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const name of names) {
    const file = join(tasksDir, name);
    if (exclude.has(name) || exclude.has(file)) continue;
    try {
      const st = await lstat(file);
      if (st.isSymbolicLink() || !st.isFile() || st.mtimeMs < sinceMs - MTIME_SLACK_MS) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
    } catch {
      // 文件刚被删掉
    }
  }
  return best?.file ?? null;
}

/**
 * 子 agent 的 transcript 不在 tasks 目录里，这里只有指向它的符号链接。返回目标修改时间 >= sinceMs - 2s 的链接的目标大小，
 * 按目标的时间算：恢复运行的旧子 agent 也要算上。键是链接的路径；悬空的链接值是 null，要不要沿用上次的大小由调用方决定。
 * 目录读不了返回 null。
 */
export async function subagentOutputSizes(tasksDir: string, sinceMs: number): Promise<Map<string, number | null> | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const sizes = new Map<string, number | null>();
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const link = join(tasksDir, entry.name);
    try {
      const st = await stat(link);
      if (st.isFile() && st.mtimeMs >= sinceMs - MTIME_SLACK_MS) sizes.set(link, st.size);
    } catch {
      sizes.set(link, null);
    }
  }
  return sizes;
}

const OUTPUT_LINES = 6;

/** 命令输出文件的最后一段：去 ANSI，`\r` 覆盖的进度只留最后一段，丢掉开头的半行；文件读不了返回 null。 */
export async function readOutputTail(file: string, maxBytes = 64 * 1024): Promise<{ size: number; mtimeMs: number; lines: string[]; text: string } | null> {
  try {
    const fh = await open(file, "r");
    try {
      const st = await fh.stat();
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, st.size - len);
      let bytes = buf.subarray(0, bytesRead);
      const truncated = st.size > len;
      if (truncated) {
        // 先跳过被截断的 UTF-8 字符的后续字节，再丢掉第一行（它是半行）
        let i = 0;
        while (i < bytes.length && (bytes[i] & 0xc0) === 0x80) i++;
        bytes = bytes.subarray(i);
        const nl = bytes.indexOf(0x0a);
        bytes = nl === -1 ? bytes.subarray(bytes.length) : bytes.subarray(nl + 1);
      }
      const all = stripAnsi(bytes.toString("utf8"))
        .split("\n")
        .map((l) => l.replace(/\r+$/, "").split("\r").pop()!.trim())
        .filter(Boolean);
      return { size: st.size, mtimeMs: st.mtimeMs, lines: all.slice(-OUTPUT_LINES), text: all.join("\n") };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** 在 ~/.claude/sessions/*.json 里按 sessionId 找 session 的名字；读不了就返回 null。 */
export async function sessionRegistryName(sessionsDir: string, sessionId: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const j = JSON.parse(await readFile(join(sessionsDir, n), "utf8")) as { sessionId?: unknown; name?: unknown };
      if (j.sessionId === sessionId && typeof j.name === "string") return j.name;
    } catch {
      // 坏文件跳过
    }
  }
  return null;
}

/** 文字的最后 maxBytes 字节，不切开 UTF-8 字符。 */
export function utf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}
