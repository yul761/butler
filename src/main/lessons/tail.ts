import { open } from "node:fs/promises";

export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

/** 文件最后 maxBytes 字节里的非空行。从中间截断时丢掉第一行（可能只剩半行）。 */
export async function readTailLines(file: string, maxBytes: number): Promise<string[]> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    let from = 0;
    if (start > 0) {
      // 恰好从行首开始（前一个字节是换行）就不用丢。
      const prev = Buffer.alloc(1);
      await fh.read(prev, 0, 1, start - 1);
      if (prev[0] !== 10) {
        const nl = buf.subarray(0, got).indexOf(10);
        from = nl === -1 ? got : nl + 1;
      }
    }
    return buf.subarray(from, got).toString("utf8").split("\n").filter(Boolean);
  } finally {
    await fh.close();
  }
}
