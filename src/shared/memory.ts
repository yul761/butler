/**
 * StateCore 记忆（设计文档第 8 节）的共享类型。渲染进程也会 import：这里不能 import zod 或 Node 模块。
 */

/** 全局 scope：跨 ticket 的经验（learnings）。 */
export const WORKSPACE_SCOPE = "workspace";

/** 每个 ticket 一个 scope（设计文档 8.2）。 */
export function ticketScope(key: string): string {
  return `ticket:${key}`;
}

/** 每个 feature 一个 scope（设计文档 2026-10-26）：前后端 ticket 之间共享接口约定之类。 */
export function featureScope(id: number): string {
  return `feature:${id}`;
}

/** StateCore facts() 里的一条（只取 Butler 用得到的字段）。 */
export interface MemoryItem {
  /** forget 用的 key（分组名 + 正文的哈希）。 */
  factKey: string;
  /** why 用的 id；StateCore 没有登记的条目为 null。 */
  factId: string | null;
  text: string;
  /** ISO 时间。 */
  createdAt: string | null;
  /** StateCore 的展示分组，例如 Notes。 */
  group: string;
}

/** scope 当前的交接（StateCore 的 handoff）。 */
export interface MemoryHandoff {
  id: string;
  content: string;
  addedAt: string;
  /** 这个 scope 记录过多少次交接（含被取代的）。 */
  versionCount: number;
}

/** why 链上的一个版本，旧的在前。 */
export interface WhyEntry {
  id: string;
  content: string;
  addedAt: string;
  supersededBy: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
}

/** ticket 详情页“记忆”标签的数据。 */
export interface MemoryView {
  /** 设置里的记忆开关。 */
  enabled: boolean;
  scope: string;
  handoff: MemoryHandoff | null;
  items: MemoryItem[];
  /** 读 StateCore 失败时的原因。 */
  error: string | null;
}

/** Butler 自己维护的条目种类（设计文档 8.3）。learnings 写在 workspace，不参与比对。 */
export const NOTE_KINDS = ["decision", "followup"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface ButlerNote {
  kind: NoteKind;
  /** 决策的 key 或 followup 的 id，已经过 noteId() 处理。 */
  id: string;
  /** 已经过 noteBody() 处理的正文。 */
  body: string;
}

export interface ParsedNote extends ButlerNote {
  /** 1 表示没有变体后缀；#n 时为 n。 */
  variant: number;
}

/**
 * StateCore 的 note 上限是 500 字。前缀最长约 115 字（kind、40 字的 id、#5 和 12 个区分词），正文最多 360 字。
 */
export const NOTE_BODY_LIMIT = 360;
// StateCore 1.0.0 按 UTF-16 的 text.length 量 500 字上限（tools.ts / MAX_FACT_CHARS），不是按码点；
// 所以 NOTE_BODY_LIMIT 和 NOTE_ID_LIMIT 都是 UTF-16 单位数，截断时也不切开代理对。
export const NOTE_ID_LIMIT = 40;
/** 变体最多到 #5。 */
export const MAX_NOTE_VARIANT = 5;

/** 按 UTF-16 单位数截断，不切开代理对。 */
export function truncateUnits(text: string, limit: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > limit) break;
    out += ch;
  }
  return out;
}

/** 前缀里的 id：不能有空白、[、]、#（会破坏前缀），控制字符也去掉；NFKC 之后最多 NOTE_ID_LIMIT 个 UTF-16 单位，空的写成 _。 */
export function noteId(raw: string): string {
  const id = raw
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\s\]#[\u0000-\u001f\u007f]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return truncateUnits(id, NOTE_ID_LIMIT) || "_";
}

/** 正文：NFKC，所有空白（含换行）压成一个空格，首尾去空白，最多 NOTE_BODY_LIMIT 个 UTF-16 单位（不切开代理对）。 */
export function noteBody(raw: string): string {
  const text = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  return truncateUnits(text, NOTE_BODY_LIMIT).trim();
}

/** FNV-1a（32 位）：渲染进程也会用到这个文件，不能用 node:crypto。 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 变体 v（≥ 2）的区分词：3 × (v − 1) 个 4 个小写字母的词，由 kind:id:v 决定。
 * StateCore 把 Jaccard ≥ 0.7 的两条 note 当成同一条的修订（后写的挤掉先写的，任务 1 实验 G）；
 * 区分词让两条正文几乎一样的不同条目分开，也让和已遗忘条目一字不差的文本重新可见（实验 D/E）。
 */
function variantWords(kind: NoteKind, id: string, v: number): string[] {
  let x = fnv1a(`${kind}:${id}:${v}`) || 1;
  const words: string[] = [];
  for (let i = 0; i < 3 * (v - 1); i++) {
    let w = "";
    for (let j = 0; j < 4; j++) {
      // xorshift32
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      w += String.fromCharCode(97 + (x % 26));
    }
    words.push(w);
  }
  return words;
}

export function noteText(n: ButlerNote, variant = 1): string {
  if (!Number.isInteger(variant) || variant < 1 || variant > MAX_NOTE_VARIANT) {
    throw new RangeError(`note variant must be an integer from 1 to ${MAX_NOTE_VARIANT}, got ${variant}`);
  }
  const suffix = variant > 1 ? `#${variant} ${variantWords(n.kind, n.id, variant).join(" ")}` : "";
  return `[${n.kind}:${n.id}${suffix}] ${n.body}`;
}

const NOTE_RE = /^\[(decision|followup):([^\]#\s]+)(?:#(\d{1,3})(?: [a-z]{4})*)?\] ([\s\S]+)$/;

export function parseNote(text: string): ParsedNote | null {
  const m = NOTE_RE.exec(text);
  if (!m) return null;
  return { kind: m[1] as NoteKind, id: m[2], variant: m[3] ? Number(m[3]) : 1, body: m[4] };
}

/** 和 StateCore 的去重一样宽松：NFKC、忽略大小写和多余空白。 */
export function sameBody(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}
