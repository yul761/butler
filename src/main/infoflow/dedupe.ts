/**
 * 信息流转（BTL-272）的去重：一条要点和记忆里已有的事实、最近抽过的要点是不是说的同一件事。
 * 不问模型：去掉标点、空白和大小写后比较字的二元组（Dice 系数），或者新的这条整个被旧的包含。
 * 否定词、改主意的词、反义词、单位对不上的，拉丁词对调了的（改主意或者说的不是一回事）不算重复（polarityClash）。
 * 已知的取舍：只是换了说法、动作的先后跟着换了的（「Close the old PR and open a new one」和「Open a new PR and close the old one」）
 * 会被当成新的、多发一次。多发一次比吞掉一个改主意强；根治放在 BTL-280 第 4 步，交给模型判断。
 */

/** Dice 系数到这个值就算同一件事。 */
export const DUP_SIMILARITY = 0.8;
/** 新的被旧的包含才算重复，而且新的至少这么长（太短的子串什么都能包含）。旧的被新的包含不算：新的多说了东西。 */
const CONTAIN_MIN = 12;

/** 句末语气词：只在一个分句末尾（后面是标点、空白或结尾）时去掉，「再开始实现吧」和「再开始实现」是一回事。 */
const FILLERS = /[啦吧呢啊哦呀嘛]+(?=[\s\p{P}\p{S}]|$)/gu;

/**
 * 记忆条目末尾的来源注记（「（来自 X 的对话）」「 (from X's conversation)」）。StateCore 把原句藏掉时 writeNote 存的是
 * 「<note> #2」：注记后面的「 #N」变体后缀一起去掉（以前只认句尾的注记，带 #2 的认不出来，session 名里的「不」「no」就被当成否定）。
 * 只在注记后面才去 #N：句子本身以「PR #2」结尾的，数字要留着比。
 * 注记里的 session 名字可能带括号（「（来自 S(t12) 的对话）」）：从「（来自」一直到结尾的括号。
 */
// 只认 strings.ts 里 source() 的两种写法（「（来自 X 的对话）」「 (from X's conversation)」）：句子本身以「(from MySQL to Postgres)」结尾的不能当成注记去掉。
const SOURCE_NOTE = /(?:[（(]\s*来自.*?的对话\s*[）)]|\(\s*from .*?['’]s conversation\s*\))(?:\s*#\d+)?\s*$/iu;
const stripNote = (s: string): string => s.replace(SOURCE_NOTE, "");

/** 只留字母、数字和汉字，转小写。记忆条目末尾的来源注记先去掉。 */
export function normalizeFact(s: string): string {
  return stripNote(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * 同一个否定的几种写法归成一种（去重比较和数否定词都用这一份）：don't → do not、can't / cannot → can not、won't → will not、
 * never → not ever，再 do not → not（「Never commit」和「Do not ever commit」）；别、勿、不要、不用 → 不，不管 → 无论。
 * 不然「We don't merge」和「We do not merge」、「别在周五发版」和「不要在周五发版」否定词对不上，被当成改主意又发一遍。
 */
const NEG_CANON: [RegExp, string][] = [
  [/\bwon['’]t\b/g, "will not"],
  [/\bshan['’]t\b/g, "shall not"],
  [/\bcan['’]t\b/g, "can not"],
  [/\bcannot\b/g, "can not"],
  [/\bain['’]t\b/g, "is not"],
  [/n['’]t\b/g, " not"],
  [/\bnever\b/g, "not ever"],
  [/\bdo not\b/g, "not"],
  [/不管/g, "无论"],
  [/不要|不用|别|勿/g, "不"],
];
const canonNeg = (lower: string): string => NEG_CANON.reduce((t, [re, to]) => t.replace(re, to), lower);

/**
 * 去重比较用的形式：去掉句末语气词，否定词归一，再 normalizeFact（来源注记在 normalizeFact 里去掉；注记只认固定的两种写法，
 * 归一不会改到它）。只在这里用；actions 找原话照旧用 normalizeFact。
 */
const factKey = (s: string): string => normalizeFact(canonNeg(s.replace(FILLERS, "").toLowerCase()));

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
/**
 * 数字对不上（一边有另一边没有的，两边都有）就不是同一件事，哪怕其余字都一样：「BTL-12 先做」和「BTL-13 先做」。只有一边多了数字（前缀的 ticket 号）不算。
 * 中文句子里的拉丁词（npm / pnpm、main / master、vitest / jest）也这样比（latinWordsOf）。
 */
function numbersClash(a: Set<string>, b: Set<string>): boolean {
  const aOnly = [...a].some((n) => !b.has(n));
  const bOnly = [...b].some((n) => !a.has(n));
  return aOnly && bOnly;
}

const HAN = /\p{Script=Han}/u;
/**
 * 中文句子里的拉丁词（数字也在里面，数字对不上的 numbersOf 已经先拦下了）：像数字一样，一边换成了别的词就不是同一件事（「用 npm 管理依赖」和「用 pnpm 管理依赖」）。
 * 不是中文句子的返回 null：英文句子里换一个词的情况留给 BTL-280（交给模型判断），这里不管。
 */
const latinWordsOf = (s: string): Set<string> | null => (HAN.test(stripNote(s)) ? new Set(latin(s)) : null);

/**
 * 改主意（BTL-280 实测）：「不等 #109」对「等 #109」、「must not ask」对「must ask」、「默认关闭」对「默认开启」字面很像，Dice 都过 0.8，
 * 但说的是相反的事。下面几种都不算重复（polarityClash）：否定词集合不同；「取消」「停止」这类改主意的词只在一边；
 * 一对反义词各占一边；拉丁词和数字一样、顺序反了（A↔B 对调）；单位变了。宁可多发一遍，不能把改主意当成重复吞掉。
 */
/** 中文否定词：按字（归一、去掉标点空白以后）。别、勿、不要、不用已经归成「不」。 */
const ZH_NEGATIONS = ["不", "没", "无", "非", "未"];
/**
 * 数否定词前先去掉的常见复合词：「非常重要」和「很重要」、「未来」和「以后」说的是一回事。别 归成 不 之前去掉，
 * 「别人」「特别」也不算否定。「不同意」「不过关」是否定，不去。
 */
// 不同、不过、不少只在不会是否定的位置去掉：「不同的」「…不同，」、分句开头的「不过」、「不少人」。「不同步」「不同时」「不过期」「不少于」「不断开」是否定，不去。
const ZH_COMPOUNDS = /非常|无论|不管|未来|除非|(?:^|(?<=\p{P}))\s*不过(?![关期夜])|不同(?=[的地\s\p{P}]|$)|不错|不少(?![于过])|不久|别人|别的|特别|区别|分别|级别|类别|识别|告别|性别|差别|个别/gu;
/** 英文否定词：按整词（notify、another、know 不算）。归一以后 n't、cannot、never 都成了 not；no 也算 not。 */
const EN_NEGATION = /\b(not|no|without)\b/g;

/** 改主意的词：只在一边出现时和否定词一样算冲突（「取消每周五发版」不是「每周五发版」的重复）。 */
const ZH_REVERSALS = ["取消", "停止", "停掉", "暂停", "撤销", "不再", "改成", "改为", "去掉", "改回", "换回", "切回", "恢复", "回滚", "作废", "撤回", "废弃", "作罢"];
const EN_REVERSAL = /\b(?:(cancel)(?:s|led|ed|ling|ing)?|(stop)(?:s|ped|ping)?|(paus)(?:e|es|ed|ing)|(revert)(?:s|ed|ing)?|(no longer)|(undo)(?:es|ne|ing)?|(roll)(?:s|ed|ing)? back|(rollback)s?|(switch)(?:es|ed|ing)? back|(go)(?:es|ne|ing)? back|(went) back|(call)(?:s|ed|ing)? off|(scrap)(?:s|ped|ping)?|(abandon)(?:s|ed|ing)?|(restor)(?:e|es|ed|ing)|(drop)(?:s|ped|ping)?|(halt)(?:s|ed|ing)?|(on hold)|(deprecat)(?:e|es|ed|ing))\b/g;

/**
 * 限定词：只在一边出现时不算重复（「只在周五发版」不是「在周五发版」的重复，「Deploy on Friday unless …」不是「Deploy on Friday」的重复）：
 * 多出来的那部分加了条件、例外或期限，或者去掉了它们。中文按子串（「只是」「只要」不算），英文按整词。宁可多发一遍。
 */
const ZH_QUALIFIERS = ["只", "仅", "除了", "除非", "先缓", "暂时"]; // 暂停 在 ZH_REVERSALS 里，已经算了。
const ZH_NOT_QUALIFIER = /只是|只要/g;
const EN_QUALIFIER = /\b(only|except|unless|until|for now)\b/g;

/** 反义词对：中文按子串（在去掉标点空白的文本里找），英文按词干（enables / disables、increased / decreased 一样认）。 */
const ZH_ANTONYMS: [string, string][] = [
  ["开启", "关闭"], ["开启", "关掉"], ["打开", "关闭"], ["打开", "关掉"], ["启用", "停用"], ["启用", "禁用"], ["允许", "禁止"],
  ["同意", "拒绝"], ["接受", "拒绝"], ["显示", "隐藏"], ["保留", "删除"], ["保留", "删掉"], ["增加", "减少"], ["提高", "降低"], ["加上", "去掉"],
  ["停掉", "开着"], ["升级", "降级"], ["上线", "下线"], ["加进", "移出"], ["加入", "移出"], ["开着", "关着"], ["开着", "关了"],
];
const EN_ANTONYM_WORDS: [string, string][] = [
  ["enable", "disable"], ["on", "off"], ["allow", "deny"], ["accept", "reject"], ["include", "exclude"], ["show", "hide"], ["add", "remove"],
  ["increase", "decrease"], ["before", "after"], ["true", "false"], ["public", "private"], ["open", "close"], ["start", "stop"], ["keep", "drop"],
  ["keep", "remove"], ["stop", "keep"], ["pause", "resume"],
  ["upgrade", "downgrade"], ["left", "right"], ["increase", "reduce"], ["raise", "lower"], ["valid", "invalid"], ["required", "optional"],
  ["mandatory", "optional"], ["tab", "space"],
];

/**
 * 粗略的英文词干：去掉 -ies/-ied（→ y）、-ing/-ed（双写的辅音去一个：stopped → stop）、-es/-s，再去掉末尾的 e。
 * enable / enabled / enables 都是 enabl，deny / denied 都是 deny。三个字以内的词不动（on、off、add）。
 */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (/i(?:es|ed)$/.test(w)) return w.slice(0, -3) + "y";
  const ed = /^(.{3,}?)(?:ing|ed)$/.exec(w);
  if (ed) return ed[1].replace(/([bgmnprt])\1$/, "$1").replace(/e$/, "");
  if (/(?:ss|us|is)$/.test(w)) return w;
  return w.replace(/e?s$/, "").replace(/e$/, "");
}
const EN_ANTONYMS: [string, string][] = EN_ANTONYM_WORDS.map(([x, y]) => [stem(x), stem(y)]);

/** 时间、大小的单位（「30 分钟」和「30 秒」、minutes 和 seconds 不是一回事）。 */
const ZH_UNITS: [RegExp, string][] = [
  [/毫秒/g, "ms"], [/秒/g, "s"], [/分钟/g, "min"], [/小时|钟头/g, "h"], [/天/g, "d"], [/周|星期/g, "w"], [/月/g, "mo"], [/年/g, "y"],
];
const EN_UNITS: [RegExp, string][] = [
  [/^\d*(?:ms|msecs?|milliseconds?)$/, "ms"], [/^(?:\d+s|\d*secs?|\d*seconds?)$/, "s"], [/^\d*(?:mins?|minutes?)$/, "min"], [/^\d+m$/, "min"],
  [/^(?:\d+h|\d*hrs?|\d*hours?)$/, "h"], [/^(?:\d+d|days?)$/, "d"], [/^weeks?$/, "w"], [/^months?$/, "mo"], [/^years?$/, "y"],
  [/^\d*(?:kb|kib)$/, "kb"], [/^\d*(?:mb|mib)$/, "mb"], [/^\d*(?:gb|gib)$/, "gb"], [/^\d*(?:tb|tib)$/, "tb"], [/^bytes?$/, "byte"],
];

/** 去掉来源注记、转小写、否定词归一，保留空白和标点（英文要按整词找）。 */
const plain = (s: string): string => canonNeg(stripNote(s).toLowerCase());
/** 英文的词（只要拉丁字母和数字：「用pnpm管理」里的 pnpm 也算一个）。 */
const latin = (s: string): string[] => plain(s).match(/[a-z0-9]+/g) ?? [];

function negations(s: string): Set<string> {
  const out = new Set<string>();
  const zh = normalizeFact(canonNeg(stripNote(s).toLowerCase().replace(ZH_COMPOUNDS, "")));
  for (const n of ZH_NEGATIONS) if (zh.includes(n)) out.add(n);
  for (const m of plain(s).matchAll(EN_NEGATION)) out.add(m[1] === "without" ? "without" : "not");
  return out;
}

function reversals(s: string): Set<string> {
  const out = new Set<string>();
  const zh = factKey(s);
  for (const r of ZH_REVERSALS) if (zh.includes(r)) out.add(r);
  for (const m of plain(s).matchAll(EN_REVERSAL)) {
    // 每种改主意记它的词干（第一个有值的捕获组）：cancelled 和 canceled、went back 和 go back 算同一个。
    const g = m.slice(1).find((x) => x !== undefined) ?? m[0];
    out.add(g === "went" ? "go" : g);
  }
  return out;
}

function qualifiers(s: string): Set<string> {
  const out = new Set<string>();
  // 除非 也在 ZH_COMPOUNDS 里（数否定词时去掉），这里照样算限定词。
  const zh = factKey(s).replace(ZH_NOT_QUALIFIER, "");
  for (const q of ZH_QUALIFIERS) if (zh.includes(q)) out.add(q);
  for (const m of plain(s).matchAll(EN_QUALIFIER)) out.add(m[1]);
  return out;
}

function unitsOf(s: string): Set<string> {
  const out = new Set<string>();
  const zh = factKey(s);
  for (const [re, u] of ZH_UNITS) if (zh.search(re) >= 0) out.add(u);
  for (const w of latin(s)) for (const [re, u] of EN_UNITS) if (re.test(w)) out.add(u);
  return out;
}

const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * 一对反义词按次数比：x 在一句里比另一句多、y 在这句里反而比另一句少，就是换了说法（「Turn off … on Fridays」对「Turn on … on Fridays」：
 * off 多一个、on 少一个）。两边次数都一样、两个都有时看先后（「先关闭旧的再开启新的」对「先开启旧的再关闭新的」）。
 * 次数不一样、方向又不相反（一边只多了几个）：一句字面上整个在另一句里的（「默认开启」对「默认开启，允许用户关闭」）不算，
 * 交给包含和相似度；不是包含的照样看先后（「Turn off … turn on …」对「Turn on … turn off … on Fridays」：on 多一个，但先后反了）。
 * count(side, w)：w 在那一句里出现几次；at(side, w)：第一次出现的位置，没有是 -1；contained：一句字面上被另一句包含。
 */
function antonymsClash(
  count: (side: 0 | 1, w: string) => number,
  at: (side: 0 | 1, w: string) => number,
  pairs: readonly [string, string][],
  contained: boolean,
): boolean {
  return pairs.some(([x, y]) => {
    const dx = count(0, x) - count(1, x);
    const dy = count(0, y) - count(1, y);
    if ((dx > 0 && dy < 0) || (dx < 0 && dy > 0)) return true;
    if ((dx !== 0 || dy !== 0) && contained) return false;
    const [ax, ay, bx, by] = [at(0, x), at(0, y), at(1, x), at(1, y)];
    return ax >= 0 && ay >= 0 && bx >= 0 && by >= 0 && ax < ay !== bx < by;
  });
}

/** 子串 w 在 s 里出现几次（不重叠）。 */
const occurrences = (s: string, w: string): number => s.split(w).length - 1;

/** w 和 un+w、dis+w（allowed / disallowed、locked / unlocked）：从两句里出现的 un… / dis… 词生成反义词对。 */
function prefixPairs(stems: readonly string[][]): [string, string][] {
  const out: [string, string][] = [];
  for (const w of new Set(stems.flat())) {
    const m = /^(?:un|dis)(.{3,})$/.exec(w);
    if (m) out.push([m[1], w]);
  }
  return out;
}

/** 拉丁词和数字一样多、一样的词，只是顺序不同（pnpm / npm 换了位置、BTL-12 和 BTL-13 反了、from MySQL to Postgres）。 */
function swapped(a: readonly string[], b: readonly string[]): boolean {
  if (a.length < 2 || a.length !== b.length || a.every((w, i) => w === b[i])) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((w, i) => w === sb[i]);
}

/**
 * 分句：逗号、顿号、分号、句号、问号叹号、换行隔开的（c067e822 复核必修 3：「测试环境关闭缓存、生产环境开启缓存」要切开），
 * 英文句号后面跟空白或者在句末的也算（adf2412e 复核必修 C：「turn on cache in prod. turn off cache in test」；v1.2、3.14 不切）。
 */
const CLAUSE = /(?:[，,、;；。！？!?\n]|\.(?=\s|$))+/;
/** 一个分句按一对反义词切开以后：一段段的字，和反义词所在的位置（0 / 1：是这一对的哪一头）。 */
type Piece = string | 0 | 1;

/** 中文的反义词在词（汉字串、拉丁词）里面找：「测试环境关闭缓存」切成「测试环境」、关闭、「缓存」。 */
function zhPieces(words: readonly string[], x: string, y: string): Piece[] {
  const out: Piece[] = [];
  for (const w of words) {
    let i = 0;
    for (;;) {
      const px = w.indexOf(x, i);
      const py = w.indexOf(y, i);
      const p = px < 0 ? py : py < 0 ? px : Math.min(px, py);
      if (p < 0) break;
      const side = p === px ? 0 : 1;
      if (p > i) out.push(w.slice(i, p));
      out.push(side);
      i = p + (side === 0 ? x : y).length;
    }
    if (i < w.length) out.push(w.slice(i));
  }
  return out;
}

/**
 * 一个分句里每个对象配的是哪一头，交给 add（对象是这一段的字连起来，不带空格）。
 * 只出现一头的（可以出现几次）：整个分句去掉反义词就是对象。两头都有的（「测试环境 cache off 生产环境 cache on」）按反义词的位置切：
 * 以反义词结尾的分句是「X 关闭」的语序，对象是它前面那一段；以反义词开头的是「关闭 X」，对象是它后面那一段；两头都不是的两种都生成
 * （同一个对象在一句里配了两头的，调用方当成说不清、不比）。返回这个分句是不是两头都有。
 */
function clauseObjects(pieces: readonly Piece[], add: (obj: string, side: 0 | 1) => void): boolean {
  const at = pieces.flatMap((t, i) => (typeof t === "number" ? [i] : []));
  if (at.length === 0) return false;
  const text = (from: number, to: number): string => pieces.slice(from, to).filter((t) => typeof t === "string").join("");
  const first = pieces[at[0]] as 0 | 1;
  if (at.every((i) => pieces[i] === first)) {
    add(text(0, pieces.length), first);
    return false;
  }
  const startsWith = at[0] === 0;
  const endsWith = at[at.length - 1] === pieces.length - 1;
  at.forEach((p, k) => {
    const side = pieces[p] as 0 | 1;
    if (endsWith || !startsWith) add(text(k === 0 ? 0 : at[k - 1] + 1, p), side);
    if (startsWith || !endsWith) add(text(p + 1, k + 1 < at.length ? at[k + 1] : pieces.length), side);
  });
  return true;
}

/** 说不清的对象：同一句里配了两头。 */
const BOTH = 2;

/** clausePolarity 的结果：每个对象配的是哪一头；有没有一个分句里一对反义词两头都有。 */
interface Polarity {
  objects: Map<string, 0 | 1 | typeof BOTH>;
  mixed: boolean;
}

/**
 * 每个分句里的对象配上是一对反义词的哪一头（见 clauseObjects）。key 是「第几对|对象」，值是 0 / 1，同一句里两头都配过的是 BOTH。
 */
function clausePolarity(s: string): Polarity {
  const out = new Map<string, 0 | 1 | typeof BOTH>();
  let mixed = false;
  const add = (key: string, side: 0 | 1): void => {
    const was = out.get(key);
    out.set(key, was === undefined || was === side ? side : BOTH);
  };
  for (const clause of plain(s).split(CLAUSE)) {
    const words = clause.match(/[a-z0-9]+|\p{Script=Han}+/gu) ?? [];
    ZH_ANTONYMS.forEach(([x, y], k) => {
      const both = clauseObjects(zhPieces(words, x, y), (obj, side) => {
        if (obj !== "") add(`z${k}|${obj}`, side);
      });
      mixed ||= both;
    });
    const stems = words.map((w) => (/^[a-z0-9]+$/.test(w) ? stem(w) : w));
    EN_ANTONYMS.forEach(([x, y], k) => {
      const pieces = words.map((w, i): Piece => (stems[i] === x ? 0 : stems[i] === y ? 1 : w));
      const both = clauseObjects(pieces, (obj, side) => {
        if (obj !== "") add(`e${k}|${obj}`, side);
      });
      mixed ||= both;
    });
  }
  return { objects: out, mixed };
}

/**
 * 同一个对象在两句里配的是一对反义词的两头（「测试环境 cache off，生产环境 cache on」对「生产环境 cache off，测试环境 cache on，日志 on」：
 * 「测试环境 cache」一边 off、一边 on）。两句的反义词次数、先后可以都对得上，换的是对象（f780e9ef 复核 MF3），按分句比才看得出来。
 * 对象按字面比：英文里换了语序的（In prod turn off caching / Turn off caching in prod）认不出来（BTL-280）。
 */
function clausesClash(pa: Polarity, pb: Polarity): boolean {
  if (pa.objects.size === 0) return false;
  for (const [key, side] of pb.objects) {
    const other = pa.objects.get(key);
    if (side !== BOTH && other !== undefined && other !== BOTH && other !== side) return true;
  }
  return false;
}

/** a 和 b 说的是相反的事、或者不是同一件事（见上面的几种）：再像也不算重复。 */
export function polarityClash(a: string, b: string): boolean {
  if (!sameSet(negations(a), negations(b))) return true;
  if (!sameSet(reversals(a), reversals(b))) return true;
  if (!sameSet(qualifiers(a), qualifiers(b))) return true;
  const ua = unitsOf(a);
  const ub = unitsOf(b);
  if (ua.size > 0 && ub.size > 0 && !sameSet(ua, ub)) return true;
  const pa = clausePolarity(a);
  const pb = clausePolarity(b);
  if (clausesClash(pa, pb)) return true;
  const zh = [factKey(a), factKey(b)];
  const zhContained = zh[0].includes(zh[1]) || zh[1].includes(zh[0]);
  // 一个分句里一对反义词两头都有（「测试环境关闭缓存生产环境开启缓存」「turn off x and turn on y」）：对象是哪一段说不准，
  // 按分句比不出来（没有标点隔开，对象切错了就对不上），只要两句不是一字不差、也不是一句整个在另一句里，就当成换了说法
  // （adf2412e 复核必修 C：宁可多存一条，也不吞掉改主意）。
  if (!zhContained && (pa.mixed || pb.mixed)) return true;
  if (antonymsClash((side, w) => occurrences(zh[side], w), (side, w) => zh[side].indexOf(w), ZH_ANTONYMS, zhContained)) return true;
  const la = latin(a);
  const lb = latin(b);
  if (swapped(la, lb)) return true;
  // 按整词包含：前后补空格，on 不算 only 的一部分。只拿拉丁词比会把汉字全丢掉（「测试环境 cache off，生产环境 cache on」的拉丁词
  // 是「生产环境 cache off，测试环境 cache on，日志 on」的前一段），所以整句（factKey）也要在字面上包含（20531347 复核 MF3）。
  const ja = ` ${la.join(" ")} `;
  const jb = ` ${lb.join(" ")} `;
  const en = [la.map(stem), lb.map(stem)];
  return antonymsClash(
    (side, w) => en[side].filter((x) => x === w).length,
    (side, w) => en[side].indexOf(w),
    [...EN_ANTONYMS, ...prefixPairs(en)],
    zhContained && (ja.includes(jb) || jb.includes(ja)),
  );
}

/** text 和 existing 里的某一条是同一件事：返回那一条，否则 null。 */
export function findDuplicate(text: string, existing: readonly string[]): string | null {
  const x = factKey(text);
  if (!x) return null;
  const nums = numbersOf(text);
  const words = latinWordsOf(text);
  for (const e of existing) {
    const y = factKey(e);
    if (!y || numbersClash(nums, numbersOf(e))) continue;
    // 两句都是中文时，拉丁词也按数字比。
    const ew = words && latinWordsOf(e);
    if (words && ew && numbersClash(words, ew)) continue;
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
