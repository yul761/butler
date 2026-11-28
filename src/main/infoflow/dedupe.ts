/**
 * 信息流转（BTL-272）的去重：一条要点和记忆里已有的事实、最近抽过的要点是不是说的同一件事。
 * 不问模型：去掉标点、空白和大小写后比较字的二元组（Dice 系数），或者新的这条整个被旧的包含。
 */

/** Dice 系数到这个值就算同一件事。 */
export const DUP_SIMILARITY = 0.8;
/** 新的被旧的包含才算重复，而且新的至少这么长（太短的子串什么都能包含）。旧的被新的包含不算：新的多说了东西。 */
const CONTAIN_MIN = 12;

/** 只留字母、数字和汉字，转小写。记忆条目末尾的「（来自……）」来源注记先去掉。 */
export function normalizeFact(s: string): string {
  return s
    // 来源注记里的 session 名字可能带括号（「（来自 S(t12) 的对话）」）：从「（来自」一直到结尾的括号。
    .replace(/[（(]\s*(来自|from).*?[）)]\s*$/iu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigrams(s: string): Map<string, number> {
  const cps = [...s];
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < cps.length; i++) {
    const g = cps[i] + cps[i + 1];
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

export function similarity(a: string, b: string): number {
  const x = normalizeFact(a);
  const y = normalizeFact(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  let total = 0;
  for (const n of bx.values()) total += n;
  for (const n of by.values()) total += n;
  if (total === 0) return 0;
  let common = 0;
  for (const [g, n] of bx) common += Math.min(n, by.get(g) ?? 0);
  return (2 * common) / total;
}

/** 里面的数字（ticket 号、PR 号、版本）。 */
const numbersOf = (s: string): Set<string> => new Set([...normalizeFact(s).matchAll(/\d+/g)].map((m) => m[0]));
/** 数字对不上（一边有另一边没有的，两边都有）就不是同一件事，哪怕其余字都一样：「BTL-12 先做」和「BTL-13 先做」。只有一边多了数字（前缀的 ticket 号）不算。 */
function numbersClash(a: Set<string>, b: Set<string>): boolean {
  const aOnly = [...a].some((n) => !b.has(n));
  const bOnly = [...b].some((n) => !a.has(n));
  return aOnly && bOnly;
}

/** text 和 existing 里的某一条是同一件事：返回那一条，否则 null。 */
export function findDuplicate(text: string, existing: readonly string[]): string | null {
  const x = normalizeFact(text);
  if (!x) return null;
  const nums = numbersOf(text);
  for (const e of existing) {
    const y = normalizeFact(e);
    if (!y || numbersClash(nums, numbersOf(e))) continue;
    // 一字不差（去掉标点、来源注记以后）：再短也是重复。
    if (x === y) return e;
    if ([...x].length >= CONTAIN_MIN && y.includes(x)) return e;
    // 旧的整个在新的里：新的多说了东西（「接口要分页」→「接口要分页，每页最多 100 条」），不算重复，哪怕字面很像。
    if (x.includes(y)) continue;
    if (similarity(text, e) >= DUP_SIMILARITY) return e;
  }
  return null;
}
