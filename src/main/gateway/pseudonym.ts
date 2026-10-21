import { randomInt } from "node:crypto";
import type { Rng } from "./types";

/** T ticket、R 仓库、B 分支、P 人名、S 其他敏感词。 */
export type PlaceholderKind = "T" | "R" | "B" | "P" | "S";

/** 本次请求合法的占位符形状（全局正则，配合 match / replace 使用）。 */
export const PLACEHOLDER_RE = /\[\[([TRBPS])_([a-z0-9]{4})\]\]/g;
/** 占位符被改坏后留下的痕迹：孤立的 [[ / ]]，或者没有双括号的 T_xxxx。 */
const MANGLED_RE =
  /\[\[|\]\]|(?<![A-Z0-9])[TRBPS]\s*_\s*[A-Za-z0-9]{4}(?![A-Za-z0-9])|(?<![A-Za-z0-9])[trbps]\s*_\s*[a-z0-9]{4}(?![A-Za-z0-9])|(?<![A-Za-z0-9])[TRBPS]-[A-Za-z0-9]{4}(?![A-Za-z0-9])/;
/** 去掉易混的 l、o、0、1。 */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const MAX_TRIES = 1000;

export const defaultRng: Rng = (n) => randomInt(n);

const IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
const stripIgnorables = (s: string): string => s.normalize("NFKC").replace(IGNORABLE_RE, "");

/**
 * 替换和扫描之前的统一规范化：NFKC（全角变半角）、去掉零宽/软连字符等不可见字符、
 * 各种 Unicode 连字符和减号统一成 ASCII "-"、连续空白（含换行）合并成一个空格。
 * 字典值和输入文本必须用同一个函数，否则变体写法会漏掉。
 */
export const normalizeText = (s: string): string =>
  stripIgnorables(s).replace(/[\p{Pd}\u2212]/gu, "-").replace(/\s+/g, " ");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface Dictionary {
  tickets: readonly string[];
  repos: readonly string[];
  branches: readonly string[];
  people: readonly string[];
  terms: readonly string[];
}

/**
 * 一次请求的假名化：构造时为字典里每个值随机分配占位符，映射只在这个对象里，用完即弃。
 * 同一个值（不分大小写、NFKC 之后）在本次请求里总是同一个占位符。
 */
export class Pseudonymizer {
  /** 小写的原值 → 占位符。 */
  private readonly toToken = new Map<string, string>();
  /** 占位符 → 原值。 */
  private readonly toOriginal = new Map<string, string>();
  private re: RegExp | null = null;
  /** 有新值登记进来（构造之后的 token()），下次 apply 之前要重建匹配器。 */
  private dirty = true;
  /** 输入文本（已规范化、小写）：新生成的占位符不能在其中出现。 */
  private readonly seen: string[] = [];

  /** avoid：会被拿来做假名化的输入文本；生成的占位符保证不在其中出现。 */
  constructor(dict: Dictionary, private readonly rng: Rng = defaultRng, avoid: readonly string[] = []) {
    for (const a of avoid) this.avoid(a);
    const groups: [PlaceholderKind, readonly string[]][] = [
      ["T", dict.tickets], ["B", dict.branches], ["R", dict.repos], ["P", dict.people], ["S", dict.terms],
    ];
    for (const [kind, values] of groups) for (const v of values) this.register(kind, v);
  }

  /** 登记一段输入文本，之后生成的占位符不会和其中的字面内容相同。 */
  avoid(text: string): void {
    this.seen.push(normalizeText(text).toLowerCase());
  }

  private rebuild(): void {
    // 长的优先：PROJ-123 不会被拆成 PROJ-12 + 3，分支名整体替换。
    // 用规范化后的原值（不是小写后的键）建正则，靠 i 标志不分大小写：İ 之类小写后会变形的字符才能匹配。
    const originals = [...this.toOriginal.values()].filter((v) => [...v].length >= 2).sort((a, b) => b.length - a.length);
    this.re = originals.length ? new RegExp(originals.map(escapeRe).join("|"), "giu") : null;
    this.dirty = false;
  }

  private register(kind: PlaceholderKind, raw: string): string | null {
    const v = normalizeText(raw).trim();
    if ([...v].length < 2) return null;
    const k = v.toLowerCase();
    const existing = this.toToken.get(k);
    if (existing) return existing;
    const token = this.newToken(kind);
    this.toToken.set(k, token);
    this.toOriginal.set(token, v);
    this.dirty = true;
    return token;
  }

  private newToken(kind: PlaceholderKind): string {
    for (let i = 0; i < MAX_TRIES; i++) {
      let id = "";
      for (let j = 0; j < 4; j++) id += ALPHABET[this.rng(ALPHABET.length)];
      const token = `[[${kind}_${id}]]`;
      if (!this.toOriginal.has(token) && !this.seen.some((t) => t.includes(token.toLowerCase()))) return token;
    }
    throw new Error("无法生成不重复的占位符（随机数源有问题）");
  }

  /** 这个值的占位符；不在字典里的值（比如字典之外的 ticket id）现场分配。 */
  token(kind: PlaceholderKind, raw: string): string {
    const v = normalizeText(raw).trim();
    return this.toToken.get(v.toLowerCase()) ?? this.register(kind, v) ?? this.forceToken(kind, v);
  }

  /** 少于 2 个字符的值也要一个占位符（只在 token() 显式要求时）。 */
  private forceToken(kind: PlaceholderKind, v: string): string {
    const token = this.newToken(kind);
    this.toToken.set(v.toLowerCase(), token);
    this.toOriginal.set(token, v);
    return token;
  }

  /**
   * 把文本里所有字典值换成占位符（规范化之后、不分大小写、子串匹配）。
   * 注意：返回的是规范化后的文本（全角变半角、不可见字符去掉、空白合并），这是发给模型读的出站文本，可以接受。
   * 文本里字面出现的、和本次请求占位符相同的串会被拆开（[[ → [ [），免得被误还原。
   */
  apply(text: string): string {
    let t = normalizeText(text);
    t = t.replace(PLACEHOLDER_RE, (m) => (this.toOriginal.has(m) ? m.replace("[[", "[ [") : m));
    if (this.dirty) this.rebuild();
    if (!this.re) return t;
    // 正则的大小写折叠和 toLowerCase 偶尔不一致（少数 Unicode 字符）：查不到时也要替换，当作新的敏感词。
    return t.replace(this.re, (m) => this.toToken.get(m.toLowerCase()) ?? this.forceToken("S", m));
  }

  get mapping(): ReadonlyMap<string, string> {
    return this.toOriginal;
  }

  /** 本次请求的全部原值：扫描器据此检查有没有漏网的。 */
  originals(): string[] {
    return [...this.toOriginal.values()];
  }
}

/**
 * 把响应里的占位符换回原值。按句（。！？!?；; 和换行）检查：
 * 含未知占位符或被改坏的占位符的句子整句丢弃（设计文档 7.4）。
 */
export function restore(text: string, mapping: ReadonlyMap<string, string>): { text: string; dropped: number } {
  let dropped = 0;
  // 先 NFKC 并去掉不可见字符（全角括号/下划线、零宽字符插进占位符里的变体），但保留换行用于分句。
  const kept = stripIgnorables(text).split(/(?<=[。！？!?；;\n])/).filter((sentence) => {
    const tokens = sentence.match(PLACEHOLDER_RE) ?? [];
    const bad = tokens.some((t) => !mapping.has(t)) || MANGLED_RE.test(sentence.replace(PLACEHOLDER_RE, " "));
    if (bad) dropped++;
    return !bad;
  });
  return { text: kept.join("").replace(PLACEHOLDER_RE, (t) => mapping.get(t) ?? t).trim(), dropped };
}
