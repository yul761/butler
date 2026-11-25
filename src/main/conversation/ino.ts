/**
 * 文件 ID（inode）无损处理。NTFS 的文件 ID 超过 2^53，fs.stat 默认给 number，会丢精度；
 * 写进 SQLite INTEGER 列后 node:sqlite 读这一行还会抛 RangeError。
 * 所以：stat 用 { bigint: true }，存成带 "i" 前缀的文本（INTEGER 亲和列不会把带字母的文本转回整数，
 * 也就不用改表、不用迁移）；读的时候 SQL 里 CAST(ino AS TEXT)，旧的大整数行也读得出来。
 * 旧行没有前缀、值是当年被舍入过的 number：比较时按 number 舍入后的值比。
 */
export function inoText(ino: bigint): string {
  return `i${ino}`;
}

const LEGACY = /^\d+$/;

/** 游标里存的 ino 和这次 stat 的 ino 是不是同一个文件。 */
export function sameIno(stored: string, current: string): boolean {
  if (stored === current) return true;
  if (LEGACY.test(stored) && current.startsWith("i")) return Number(stored) === Number(current.slice(1));
  return false;
}
