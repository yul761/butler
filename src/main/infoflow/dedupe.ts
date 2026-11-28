/**
 * 信息流转（BTL-272）的去重：一条要点和记忆里已有的事实、最近抽过的要点是不是说的同一件事。
 * 不问模型：去掉标点、空白和大小写后比较字的二元组（Dice 系数），或者新的这条整个被旧的包含。
 * 否定词、反义词对不上的（改主意）不算重复（polarityClash）。
 */

/** Dice 系数到这个值就算同一件事。 */
export const DUP_SIMILARITY = 0.8;
/** 新的被旧的包含才算重复，而且新的至少这么长（太短的子串什么都能包含）。旧的被新的包含不算：新的多说了东西。 */
const CONTAIN_MIN = 12;

/** 句末语气词：只在一个分句末尾（后面是标点、空白或结尾）时去掉，「再开始实现吧」和「再开始实现」是一回事。 */
const FILLERS = /[啦吧呢啊哦呀嘛]+(?=[\s\p{P}\p{S}]|$)/gu;

/** 只留字母、数字和汉字，转小写。记忆条目末尾的「（来自……）」来源注记先去掉。 */
export function normalizeFact(s: string): string {
  return s
    // 来源注记里的 session 名字可能带括号（「（来自 S(t12) 的对话）」）：从「（来自」一直到结尾的括号。
    .replace(/[（(]\s*(来自|from).*?[）)]\s*$/iu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 去重比较用的形式：normalizeFact 之前先去掉句末语气词（只在这里用；actions 找原话照旧用 normalizeFact）。 */
const factKey = (s: string): string => normalizeFact(s.replace(FILLERS, ""));

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
  const x = factKey(a);
  const y = factKey(b);
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
const numbersOf = (s: string): Set<string> => new Set([...factKey(s).matchAll(/\d+/g)].map((m) => m[0]));
/** 数字对不上（一边有另一边没有的，两边都有）就不是同一件事，哪怕其余字都一样：「BTL-12 先做」和「BTL-13 先做」。只有一边多了数字（前缀的 ticket 号）不算。 */
function numbersClash(a: Set<string>, b: Set<string>): boolean {
  const aOnly = [...a].some((n) => !b.has(n));
  const bOnly = [...b].some((n) => !a.has(n));
  return aOnly && bOnly;
}

/**
 * 改主意（BTL-280 实测）：「不等 #109」对「等 #109」、「must not ask」对「must ask」、「默认关闭」对「默认开启」字面很像，Dice 都过 0.8，
 * 但说的是相反的事。下面两种都不算重复：两句的否定词集合不同；或者一句里有一对反义词里的一个、另一句里是对面那个。
 * 宁可多发一遍，不能把改主意当成重复吞掉。
 */
/** 中文否定词：按字（去掉标点空白以后）。「非常」「无论」这类也算进来：多发一遍可以接受。 */
const ZH_NEGATIONS = ["不", "没", "别", "无", "非", "未", "勿"];
/** 英文否定词：按整词（notify、another、know 不算）。n't 单独认（don't、shouldn't、can’t）。 */
const EN_NEGATION = /\b(not|no|never|without|cannot)\b/g;
const EN_NT = /n['’]t\b/;
/** 反义词对：中文按子串（在去掉标点空白的文本里找），英文按整词。 */
const ZH_ANTONYMS: [string, string][] = [
  ["开启", "关闭"], ["开启", "关掉"], ["打开", "关闭"], ["打开", "关掉"], ["启用", "停用"], ["启用", "禁用"], ["允许", "禁止"],
  ["同意", "拒绝"], ["接受", "拒绝"], ["显示", "隐藏"], ["保留", "删除"], ["保留", "删掉"], ["增加", "减少"], ["提高", "降低"], ["加上", "去掉"],
];
const EN_ANTONYMS: [string, string][] = [
  ["enable", "disable"], ["enabled", "disabled"], ["on", "off"], ["allow", "deny"], ["allowed", "denied"], ["accept", "reject"],
  ["include", "exclude"], ["show", "hide"], ["add", "remove"], ["increase", "decrease"], ["before", "after"], ["true", "false"],
  ["public", "private"], ["open", "close"], ["start", "stop"], ["keep", "drop"],
];

/** 去掉来源注记、转小写，保留空白和标点（英文要按整词找）。 */
const plain = (s: string): string => s.replace(/[（(]\s*(来自|from).*?[）)]\s*$/iu, "").toLowerCase();
const words = (s: string): string[] => plain(s).match(/[\p{L}\p{N}]+/gu) ?? [];

function negations(s: string): Set<string> {
  const out = new Set<string>();
  const zh = factKey(s);
  for (const n of ZH_NEGATIONS) if (zh.includes(n)) out.add(n);
  const p = plain(s);
  for (const m of p.matchAll(EN_NEGATION)) out.add(m[1] === "cannot" ? "not" : m[1]);
  if (EN_NT.test(p)) out.add("n't");
  return out;
}

/**
 * 一对反义词在两句里各占一边：一句只有 x、另一句只有 y。两句都两个都有时看先后（「先关闭旧的再开启新的」对「先开启旧的再关闭新的」）。
 * 一句两个都有、另一句只有一个（「默认开启」对「默认开启，允许用户关闭」）不算：这种交给包含和相似度。
 * at(side, w)：w 在那一句里第一次出现的位置，没有是 -1。
 */
function antonymsClash(at: (side: 0 | 1, w: string) => number, pairs: readonly [string, string][]): boolean {
  return pairs.some(([x, y]) => {
    const [ax, ay, bx, by] = [at(0, x), at(0, y), at(1, x), at(1, y)];
    if (ax >= 0 && ay < 0 && bx < 0 && by >= 0) return true;
    if (ax < 0 && ay >= 0 && bx >= 0 && by < 0) return true;
    return ax >= 0 && ay >= 0 && bx >= 0 && by >= 0 && ax < ay !== bx < by;
  });
}

/** a 和 b 说的是相反的事（否定词不一样，或者反义词各占一边）：再像也不算重复。 */
export function polarityClash(a: string, b: string): boolean {
  const na = negations(a);
  const nb = negations(b);
  if (na.size !== nb.size || [...na].some((n) => !nb.has(n))) return true;
  const zh = [factKey(a), factKey(b)];
  if (antonymsClash((side, w) => zh[side].indexOf(w), ZH_ANTONYMS)) return true;
  const en = [words(a), words(b)];
  return antonymsClash((side, w) => en[side].indexOf(w), EN_ANTONYMS);
}

/** text 和 existing 里的某一条是同一件事：返回那一条，否则 null。 */
export function findDuplicate(text: string, existing: readonly string[]): string | null {
  const x = factKey(text);
  if (!x) return null;
  const nums = numbersOf(text);
  for (const e of existing) {
    const y = factKey(e);
    if (!y || numbersClash(nums, numbersOf(e))) continue;
    // 改主意（否定词、反义词对不上）：放在一字不差和包含之前，包含规则也不能把它吞掉。
    if (polarityClash(text, e)) continue;
    // 一字不差（去掉标点、来源注记以后）：再短也是重复。
    if (x === y) return e;
    if ([...x].length >= CONTAIN_MIN && y.includes(x)) return e;
    // 旧的整个在新的里：新的多说了东西（「接口要分页」→「接口要分页，每页最多 100 条」），不算重复，哪怕字面很像。
    if (x.includes(y)) continue;
    if (similarity(text, e) >= DUP_SIMILARITY) return e;
  }
  return null;
}
