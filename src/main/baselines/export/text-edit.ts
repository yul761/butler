// 导出成 lint 时改仓库里的配置文件（设计 §8）：只在文字上插入，不重新序列化，注释、key 顺序、缩进和换行符（CRLF 留 CRLF）都不动。
// 改不了的形状（不是对象、key 的值类型不对、找不到位置）返回 null，由调用方换别的接法或说明原因。

export function eolOf(text: string): "\r\n" | "\n" {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

/** 文字统一用 \n 写，按文件原来的换行符落地。 */
export function withEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replace(/\r?\n/g, eol);
}

/** 末尾补一个换行（按原文件的换行符）。 */
export function ensureTrailingEol(text: string): string {
  if (!text || text.endsWith("\n")) return text;
  return text + eolOf(text);
}

// ---------------------------------------------------------------- JSON（含注释和尾逗号）

interface Member {
  key: string;
  /** 值的起止下标（end 不含）。 */
  start: number;
  end: number;
}

interface ObjectInfo {
  open: number;
  close: number;
  members: Member[];
}

/** 跳过空白和注释。 */
function skipWs(t: string, i: number): number {
  for (;;) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t.startsWith("//", i)) {
      const n = t.indexOf("\n", i);
      i = n < 0 ? t.length : n + 1;
    } else if (t.startsWith("/*", i)) {
      const n = t.indexOf("*/", i + 2);
      i = n < 0 ? t.length : n + 2;
    } else return i;
  }
}

function skipString(t: string, i: number): number {
  i++;
  while (i < t.length && t[i] !== '"') i += t[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** 从 i 开始的一个值的结尾。 */
function skipValue(t: string, i: number): number {
  i = skipWs(t, i);
  const c = t[i];
  if (c === '"') return skipString(t, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    while (i < t.length) {
      const d = t[i];
      if (d === '"') {
        i = skipString(t, i);
        continue;
      }
      if (t.startsWith("//", i) || t.startsWith("/*", i)) {
        i = skipWs(t, i);
        continue;
      }
      if (d === "{" || d === "[") depth++;
      else if (d === "}" || d === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  while (i < t.length && !/[,}\]\s]/.test(t[i])) i++;
  return i;
}

function objectAt(t: string, at: number): ObjectInfo | null {
  let i = skipWs(t, at);
  if (t[i] !== "{") return null;
  const open = i;
  i++;
  const members: Member[] = [];
  for (;;) {
    i = skipWs(t, i);
    if (t[i] === "}") return { open, close: i, members };
    if (t[i] === ",") {
      i++;
      continue;
    }
    if (t[i] !== '"') return null;
    const kEnd = skipString(t, i);
    let key: string;
    try {
      key = JSON.parse(t.slice(i, kEnd)) as string;
    } catch {
      return null;
    }
    i = skipWs(t, kEnd);
    if (t[i] !== ":") return null;
    const start = skipWs(t, i + 1);
    const end = skipValue(t, start);
    if (end <= start) return null;
    members.push({ key, start, end });
    i = end;
    if (i >= t.length) return null;
  }
}

/** 一行开头的空白。 */
function indentAt(t: string, i: number): string {
  const ls = t.lastIndexOf("\n", i - 1) + 1;
  return /^[ \t]*/.exec(t.slice(ls))![0];
}

/** 文件用的缩进单位：第一个缩进过的行。 */
function indentUnit(t: string): string {
  const m = /\n([ \t]+)\S/.exec(t);
  return m ? m[1] : "  ";
}

function pathObject(t: string, path: string[]): ObjectInfo | null {
  let obj = objectAt(t, 0);
  for (const k of path) {
    if (!obj) return null;
    const m = obj.members.find((x) => x.key === k);
    if (!m) return null;
    obj = objectAt(t, m.start);
  }
  return obj;
}

/** 按文件的缩进把一个 JSON 值写出来（多行时每行加上 base 缩进）。 */
function render(value: unknown, base: string, unit: string): string {
  const s = JSON.stringify(value, null, unit.includes("\t") ? "\t" : unit.length);
  return s.split("\n").join(`\n${base}`);
}

function insertMember(t: string, obj: ObjectInfo, key: string, value: unknown): string {
  const unit = indentUnit(t);
  const eol = eolOf(t);
  const closeIndent = indentAt(t, obj.close);
  const multiline = t.slice(obj.open, obj.close).includes("\n") || obj.members.length === 0;
  const memberIndent = obj.members.length && multiline ? memberIndentOf(t, obj) : closeIndent + unit;
  const text = `${JSON.stringify(key)}: ${render(value, memberIndent, unit)}`.split("\n").join(eol);
  if (!obj.members.length) {
    return `${t.slice(0, obj.open + 1)}${eol}${memberIndent}${text}${eol}${closeIndent}${t.slice(obj.close)}`;
  }
  const last = obj.members[obj.members.length - 1];
  // 最后一个成员后面可能已经有尾逗号。
  const after = skipWs(t, last.end);
  const hasComma = t[after] === ",";
  const insertAt = hasComma ? after + 1 : last.end;
  if (!multiline) return `${t.slice(0, insertAt)}${hasComma ? " " : ", "}${text}${t.slice(insertAt)}`;
  return appendLine(t, insertAt, hasComma, `${memberIndent}${text}`, eol);
}

/**
 * 在 at（上一个成员 / 元素的结尾，或它的逗号之后）后面另起一行写 line。
 * 同一行后面有注释（`"a": 1 // 说明`）时逗号紧跟值，新行放到注释后面。
 */
function appendLine(t: string, at: number, hasComma: boolean, line: string, eol: string): string {
  const head = t.slice(0, at) + (hasComma ? "" : ",");
  let rest = t.slice(at);
  const nl = rest.indexOf("\n");
  const sameLine = (nl < 0 ? rest : rest.slice(0, nl)).replace(/\r$/, "");
  let tail = "";
  if (/^\s*(\/\/.*|\/\*.*\*\/\s*)$/.test(sameLine)) {
    tail = sameLine;
    rest = rest.slice(sameLine.length);
  }
  return `${head}${tail}${eol}${line}${rest}`;
}

function memberIndentOf(t: string, obj: ObjectInfo): string {
  const first = obj.members[0];
  // 找 key 的开头引号：值开头往前跳过 ": " 和 key。
  let i = first.start - 1;
  while (i > obj.open && t[i] !== ":") i--;
  i--;
  while (i > obj.open && /\s/.test(t[i])) i--;
  // i 在 key 的结尾引号上。
  let j = i - 1;
  while (j > obj.open && !(t[j] === '"' && t[j - 1] !== "\\")) j--;
  return indentAt(t, j);
}

/** 在 path 指的对象里加一个 key（已经有了返回 null）。path 上缺的对象一路补上。 */
export function jsonAddKey(text: string, path: string[], key: string, value: unknown): string | null {
  for (let depth = path.length; depth >= 0; depth--) {
    const obj = pathObject(text, path.slice(0, depth));
    if (!obj) continue;
    if (depth === path.length) {
      if (obj.members.some((m) => m.key === key)) return null;
      return insertMember(text, obj, key, value);
    }
    // 补上缺的那一层：{ rest: { key: value } }
    let nested: unknown = { [key]: value };
    for (let k = path.length - 1; k > depth; k--) nested = { [path[k]]: nested };
    if (obj.members.some((m) => m.key === path[depth])) return null; // 有这个 key 但不是对象
    return insertMember(text, obj, path[depth], nested);
  }
  return null;
}

/** path 指的值（JSON 解析后的）。 */
export function jsonGet(text: string, path: string[]): { value: unknown; start: number; end: number } | null {
  if (!path.length) return null;
  const obj = pathObject(text, path.slice(0, -1));
  const m = obj?.members.find((x) => x.key === path[path.length - 1]);
  if (!m) return null;
  try {
    return { value: JSON.parse(text.slice(m.start, m.end)), start: m.start, end: m.end };
  } catch {
    return { value: undefined, start: m.start, end: m.end };
  }
}

/** 把 path 指的值整个换掉。 */
export function jsonReplace(text: string, path: string[], value: unknown): string | null {
  const hit = jsonGet(text, path);
  if (!hit) return null;
  const unit = indentUnit(text);
  return text.slice(0, hit.start) + render(value, indentAt(text, hit.start), unit).split("\n").join(eolOf(text)) + text.slice(hit.end);
}

/** 往 path 指的数组末尾加一个元素；数组不存在就在父对象里建。 */
export function jsonAppend(text: string, path: string[], value: unknown): string | null {
  const hit = jsonGet(text, path);
  if (!hit) return jsonAddKey(text, path.slice(0, -1), path[path.length - 1], [value]);
  if (!Array.isArray(hit.value)) return null;
  const eol = eolOf(text);
  const unit = indentUnit(text);
  const close = hit.end - 1;
  const closeIndent = indentAt(text, close);
  const body = text.slice(hit.start + 1, close);
  const multiline = body.includes("\n");
  if (!hit.value.length) {
    const base = indentAt(text, hit.start);
    return `${text.slice(0, hit.start)}[${eol}${base + unit}${render(value, base + unit, unit).split("\n").join(eol)}${eol}${base}]${text.slice(hit.end)}`;
  }
  // 最后一个元素的结尾
  let i = hit.start + 1;
  let lastEnd = i;
  for (;;) {
    i = skipWs(text, i);
    if (i >= close) break;
    if (text[i] === ",") {
      i++;
      continue;
    }
    lastEnd = skipValue(text, i);
    i = lastEnd;
  }
  const after = skipWs(text, lastEnd);
  const hasComma = text[after] === "," && after < close;
  const insertAt = hasComma ? after + 1 : lastEnd;
  if (!multiline) return `${text.slice(0, insertAt)}${hasComma ? " " : ", "}${JSON.stringify(value)}${text.slice(insertAt)}`;
  const itemIndent = closeIndent + unit;
  return appendLine(text, insertAt, hasComma, `${itemIndent}${render(value, itemIndent, unit).split("\n").join(eol)}`, eol);
}

// ---------------------------------------------------------------- YAML（只认块风格的顶层 key）

/** YAML 单引号字符串。 */
export function yamlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 往顶层 key 下的块列表末尾加一项。itemLines 是不带缩进的几行（第一行以 "- " 开头）。
 * key 不存在就在文件末尾建；`key: []` 换成块列表；别的写法（流式、锚点）返回 null。
 */
export function yamlAppendToTopList(text: string, key: string, itemLines: string[]): string | null {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:(.*)$`);
  const at = lines.findIndex((l) => keyRe.test(l));
  if (at < 0) {
    const block = [`${key}:`, ...itemLines.map((l) => `  ${l}`)];
    const body = lines.join("\n").replace(/\n*$/, "");
    return withEol(`${body}${body ? "\n" : ""}${block.join("\n")}\n`, eol);
  }
  const rest = keyRe.exec(lines[at])![1].replace(/\s+#.*$/, "").trim();
  if (rest === "[]") {
    lines.splice(at, 1, `${key}:`, ...itemLines.map((l) => `  ${l}`));
    return withEol(`${lines.join("\n")}\n`, eol);
  }
  if (rest !== "") return null;
  // 这个 key 的块：后面缩进过的行、空行、注释行，以及顶格的 "- "。
  let end = at + 1;
  let lastContent = at;
  let itemIndent: string | null = null;
  while (end < lines.length) {
    const l = lines[end];
    if (/^\s*$/.test(l) || /^\s*#/.test(l)) {
      end++;
      continue;
    }
    if (/^[ \t]/.test(l) || l.startsWith("- ") || l === "-") {
      if (itemIndent === null) {
        const m = /^([ \t]*)- ?/.exec(l);
        if (!m) return null; // 块映射，不是列表
        itemIndent = m[1];
      }
      lastContent = end;
      end++;
      continue;
    }
    break;
  }
  const ind = itemIndent ?? "  ";
  lines.splice(lastContent + 1, 0, ...itemLines.map((l) => ind + l));
  return withEol(`${lines.join("\n")}\n`, eol);
}

/** 文件里有没有这个顶层 key。 */
export function yamlHasTopKey(text: string, key: string): boolean {
  return new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "m").test(text);
}

// ---------------------------------------------------------------- Makefile

/** Makefile 里定义了哪些目标（不含变量赋值和模式规则）。 */
export function makeTargets(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.\-/ ]+?)\s*:(?![=:])/.exec(l);
    if (!m) continue;
    for (const t of m[1].split(/\s+/)) if (t && !t.startsWith(".") && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 文件末尾加一个目标（recipe 用 tab）。 */
export function makeAddTarget(text: string, target: string, recipe: string[]): string {
  const eol = eolOf(text);
  const body = text.replace(/(\r?\n)*$/, "");
  const block = [`.PHONY: ${target}`, `${target}:`, ...recipe.map((r) => `\t${r}`)].join("\n");
  return withEol(`${body}${body ? "\n\n" : ""}${block}\n`, eol);
}

/** 给已有目标加一个前置目标（`lint: a` → `lint: a butler-x`）。没有这个目标返回 null。 */
export function makeAddPrereq(text: string, target: string, prereq: string): string | null {
  const re = new RegExp(`^(${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:(?![=:]))([^#\\r\\n;]*?)([ \\t]*)(?=[#;\\r\\n]|$)`, "m");
  const m = re.exec(text);
  if (!m) return null;
  if (m[2].trim().split(/\s+/).includes(prereq)) return text;
  return text.slice(0, m.index) + `${m[1]}${m[2]} ${prereq}${m[3]}` + text.slice(m.index + m[0].length);
}
