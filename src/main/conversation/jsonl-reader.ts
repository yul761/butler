import { open } from "node:fs/promises";

/** 对话另存（UI 重做第 4 层）：按字节增量读 transcript 的完整行。 */

export const CHUNK_BYTES = 1 << 20;
/** 比这长的一行直接跳过（通常是一大段工具结果，里面没有双方说的话）。 */
export const MAX_LINE_BYTES = 64 << 20;

export interface ReadChunk { lines: string[]; ino: number; start: number; next: number; reset: boolean; skipped: number }

const NL = 0x0a;

/**
 * 从 from.offset 读一块完整的行；inode 变了或文件比 offset 短就从 0 开始（reset=true）；最后没写完的半行不读。
 * 没有新内容返回 lines=[] 且 next=start；文件不在返回 null。
 * 一块里一个换行都没有时窗口加倍；超过 maxLineBytes 还没换行，就跳过这一行（skipped=1，lines=[]，next 越过它）。
 * 按字节切行，多字节字符不会被切开。
 */
export async function readChunk(file: string, from: { ino: number | null; offset: number }, o: { chunkBytes?: number; maxLineBytes?: number } = {}): Promise<ReadChunk | null> {
  const chunk = Math.max(1, o.chunkBytes ?? CHUNK_BYTES);
  const maxLine = Math.max(1, o.maxLineBytes ?? MAX_LINE_BYTES);
  let fh;
  try {
    fh = await open(file, "r");
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    const ino = st.ino;
    const reset = (from.ino !== null && st.ino !== from.ino) || st.size < from.offset;
    const start = reset ? 0 : from.offset;
    const none = (next: number, skipped = 0): ReadChunk => ({ lines: [], ino, start, next, reset, skipped });
    let window = chunk;
    for (;;) {
      const avail = st.size - start;
      if (avail <= 0) return none(start);
      const len = Math.min(window, avail);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      const b = buf.subarray(0, bytesRead);
      const nl = b.lastIndexOf(NL);
      if (nl >= 0) return { lines: splitLines(b.subarray(0, nl)), ino, start, next: start + nl + 1, reset, skipped: 0 };
      // 没有换行：文件到头了就是半行，等它写完。
      if (bytesRead < window) return none(start);
      if (window > maxLine) {
        const end = await nextNewline(fh, start + window, st.size, chunk);
        return end === null ? none(start) : none(end + 1, 1);
      }
      window = Math.min(window * 2, maxLine + 1);
    }
  } finally {
    await fh.close();
  }
}

function splitLines(b: Buffer): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const i = b.indexOf(NL, from);
    const end = i < 0 ? b.length : i;
    const line = b.subarray(from, end > from && b[end - 1] === 0x0d ? end - 1 : end).toString("utf8");
    if (line) out.push(line);
    if (i < 0) return out;
    from = i + 1;
  }
}

async function nextNewline(fh: import("node:fs/promises").FileHandle, pos: number, size: number, chunk: number): Promise<number | null> {
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
