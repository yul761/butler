import { createHash } from "node:crypto";

/** 原样做文件名的 ticket key 最长多少个字符，超过就截断再加哈希。 */
const MAX_PLAIN_NAME = 80;
/** Windows 的保留设备名（不分大小写，带不带扩展名都算）。 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * 用 ticket key 做文件名或目录名。自定义的 ticket 正则可能放进 /、空格之类的字符：
 * 不能做文件名的字符换成 _；改过的、只有点、太长、以点结尾或是 Windows 保留名的，换成截断后的名字（点也换成 _）
 * 加原值的短哈希，免得两个 ticket 撞名。
 */
export function ticketFileStem(ticketKey: string): string {
  const safe = ticketKey.replace(/[^A-Za-z0-9._-]/g, "_");
  const plain = safe === ticketKey && !/^\.*$/.test(safe) && !safe.endsWith(".") && safe.length <= MAX_PLAIN_NAME && !WINDOWS_RESERVED.test(safe);
  if (plain) return safe;
  const hash = createHash("sha1").update(ticketKey).digest("hex").slice(0, 8);
  return `${safe.slice(0, 60).replace(/\./g, "_")}-${hash}`;
}

/** 不能出现在目录名里的字符（Windows 最严）和控制字符。 */
// eslint-disable-next-line no-control-regex
const DIR_UNSAFE = /[/\\:*?"<>|\x00-\x1f\x7f]/g;

/**
 * feature 工作区的目录名（设计文档 2026-10-26）：用户起的名字，允许中文和空格。不能做目录名的字符换成 _；
 * 空的、只有点、以点或空格结尾、太长或是 Windows 保留名的，换成截断后的名字加原值的短哈希。结果永远是单独一段路径。
 */
export function featureDirName(name: string): string {
  const trimmed = name.trim();
  const safe = trimmed.replace(DIR_UNSAFE, "_");
  const plain = safe.length > 0 && safe.length <= MAX_PLAIN_NAME && !/^\.*$/.test(safe) && !/[. ]$/.test(safe) && !WINDOWS_RESERVED.test(safe);
  if (plain) return safe;
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  const stem = safe.slice(0, 60).replace(/\./g, "_").trim();
  return stem ? `${stem}-${hash}` : `feature-${hash}`;
}
