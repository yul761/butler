import { DEFAULT_TICKET_PATTERN } from "../../shared/ticket-pattern";

/** 「前缀-数字」：BTL-264 → { prefix: "BTL", num: 264, width: 3 }；不是这种形状返回 null。 */
function parseKey(key: string): { prefix: string; num: number; width: number } | null {
  const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(key.trim().toUpperCase());
  if (!m) return null;
  return { prefix: m[1], num: Number(m[2]), width: m[2].length };
}

export function isValidTicketKey(key: string, pattern = DEFAULT_TICKET_PATTERN): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(key);
  } catch {
    // 设置里的正则写坏了：不在界面上拦，交给主进程（它会报 invalid_key）。
    return true;
  }
}

/**
 * 手动建 ticket 时建议的下一个号（BTL-264）：
 * - 前缀用 context（这个 epic 的 ticket；不在 epic 里建就是所有 ticket）里最近建的那个的前缀；
 * - 数字是 context 里这个前缀最大的号 + 1，位数不少于原来的（PROJ-007 → PROJ-008）；
 * - 撞上 taken（别处已有的、已归档的）就再往后加，直到空着的号；
 * - context 里没有「前缀-数字」形状的号，或者建议出来的不符合设置里的格式：null（不建议）。
 */
export function suggestNextKey(
  context: { key: string; createdAt: number }[],
  taken: string[],
  pattern = DEFAULT_TICKET_PATTERN,
): string | null {
  const parsed = [...context]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((t) => parseKey(t.key))
    .filter((p): p is NonNullable<typeof p> => p !== null);
  if (parsed.length === 0) return null;
  const prefix = parsed[parsed.length - 1].prefix;
  const same = parsed.filter((p) => p.prefix === prefix);
  const max = same.reduce((a, b) => (b.num > a.num ? b : a));
  const width = Math.max(...same.filter((p) => p.num === max.num).map((p) => p.width));
  const used = new Set([...context.map((t) => t.key), ...taken].map((k) => k.trim().toUpperCase()));
  const render = (n: number) => `${prefix}-${String(n).padStart(width, "0")}`;
  let n = max.num + 1;
  while (used.has(render(n))) n++;
  const key = render(n);
  return isValidTicketKey(key, pattern) ? key : null;
}
