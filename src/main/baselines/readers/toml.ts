// 读 TOML 的一小部分：[table]、[[array]]、key = value（字符串、数字、布尔、日期当字符串、多行数组、内联表）。
// 只给仓库扫描用（pyproject / Cargo / ruff / golangci）：读不懂的行跳过，不抛错。

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 解析 key 路径：a.b."c.d" → ["a","b","c.d"]。 */
function parseKey(raw: string): string[] {
  const out: string[] = [];
  let i = 0;
  const s = raw.trim();
  while (i < s.length) {
    while (s[i] === " " || s[i] === "\t") i++;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      const end = s.indexOf(q, i + 1);
      if (end < 0) return out;
      out.push(s.slice(i + 1, end));
      i = end + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== ".") j++;
      out.push(s.slice(i, j).trim());
      i = j;
    }
    while (s[i] === " " || s[i] === "\t") i++;
    if (s[i] === ".") i++;
  }
  return out.filter((k) => k !== "");
}

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  ws(newlines: boolean): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) this.i++;
      else if (c === "#") {
        while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
      } else return;
    }
  }
  value(): TomlValue | undefined {
    this.ws(false);
    const s = this.s;
    const c = s[this.i];
    if (c === '"' || c === "'") return this.str();
    if (c === "[") {
      this.i++;
      const arr: TomlValue[] = [];
      for (;;) {
        this.ws(true);
        if (s[this.i] === "]") {
          this.i++;
          return arr;
        }
        if (this.i >= s.length) return arr;
        const v = this.value();
        if (v === undefined) return arr;
        arr.push(v);
        this.ws(true);
        if (s[this.i] === ",") this.i++;
      }
    }
    if (c === "{") {
      this.i++;
      const t: TomlTable = {};
      for (;;) {
        this.ws(false);
        if (s[this.i] === "}") {
          this.i++;
          return t;
        }
        const eq = s.indexOf("=", this.i);
        if (eq < 0) return t;
        const key = parseKey(s.slice(this.i, eq));
        this.i = eq + 1;
        const v = this.value();
        if (v === undefined) return t;
        setPath(t, key, v);
        this.ws(false);
        if (s[this.i] === ",") this.i++;
        else if (s[this.i] !== "}") return t;
      }
    }
    let j = this.i;
    while (j < s.length && !/[,\]}\n#]/.test(s[j])) j++;
    const raw = s.slice(this.i, j).trim();
    this.i = j;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^[+-]?\d[\d_]*(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ""));
    return raw === "" ? undefined : raw;
  }
  str(): string {
    const s = this.s;
    const q = s[this.i];
    const triple = s.startsWith(q.repeat(3), this.i);
    if (triple) {
      const start = this.i + 3;
      const end = s.indexOf(q.repeat(3), start);
      const body = s.slice(start, end < 0 ? s.length : end);
      this.i = end < 0 ? s.length : end + 3;
      return body.replace(/^\r?\n/, "");
    }
    let out = "";
    let j = this.i + 1;
    while (j < s.length && s[j] !== q && s[j] !== "\n") {
      if (q === '"' && s[j] === "\\" && j + 1 < s.length) {
        const n = s[j + 1];
        out += n === "n" ? "\n" : n === "t" ? "\t" : n;
        j += 2;
        continue;
      }
      out += s[j];
      j++;
    }
    this.i = j + 1;
    return out;
  }
}

function setPath(root: TomlTable, path: string[], v: TomlValue): void {
  let t = root;
  for (const k of path.slice(0, -1)) {
    const cur = t[k];
    if (cur && typeof cur === "object" && !Array.isArray(cur)) t = cur;
    else if (Array.isArray(cur) && cur.length && typeof cur[cur.length - 1] === "object") t = cur[cur.length - 1] as TomlTable;
    else {
      const n: TomlTable = {};
      t[k] = n;
      t = n;
    }
  }
  t[path[path.length - 1]] = v;
}

function tableAt(root: TomlTable, path: string[], array: boolean): TomlTable {
  let t = root;
  path.forEach((k, idx) => {
    const last = idx === path.length - 1;
    const cur = t[k];
    if (last && array) {
      const arr = Array.isArray(cur) ? cur : [];
      const n: TomlTable = {};
      arr.push(n);
      t[k] = arr;
      t = n;
      return;
    }
    if (Array.isArray(cur) && cur.length && typeof cur[cur.length - 1] === "object" && !Array.isArray(cur[cur.length - 1])) {
      t = cur[cur.length - 1] as TomlTable;
    } else if (cur && typeof cur === "object" && !Array.isArray(cur)) t = cur;
    else {
      const n: TomlTable = {};
      t[k] = n;
      t = n;
    }
  });
  return t;
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  const r = new Reader(stripBom(text).replace(/\r\n/g, "\n"));
  let cur = root;
  const s = r.s;
  while (r.i < s.length) {
    r.ws(true);
    if (r.i >= s.length) break;
    if (s[r.i] === "[") {
      const array = s[r.i + 1] === "[";
      const end = s.indexOf(array ? "]]" : "]", r.i);
      const nl = s.indexOf("\n", r.i);
      if (end < 0 || (nl >= 0 && end > nl)) {
        r.i = nl < 0 ? s.length : nl;
        continue;
      }
      cur = tableAt(root, parseKey(s.slice(r.i + (array ? 2 : 1), end)), array);
      r.i = end + (array ? 2 : 1);
      continue;
    }
    const nl = s.indexOf("\n", r.i);
    const lineEnd = nl < 0 ? s.length : nl;
    const eq = s.indexOf("=", r.i);
    if (eq < 0 || eq > lineEnd) {
      r.i = lineEnd;
      continue;
    }
    const key = parseKey(s.slice(r.i, eq));
    r.i = eq + 1;
    const v = r.value();
    if (key.length && v !== undefined) setPath(cur, key, v);
    // 跳到行尾（值后面可能有注释）
    const after = s.indexOf("\n", r.i);
    r.i = after < 0 ? s.length : after + 1;
  }
  return root;
}

/** 按路径取值；不存在返回 undefined。 */
export function tomlGet(t: TomlTable, path: string): TomlValue | undefined {
  let cur: TomlValue | undefined = t;
  for (const k of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as TomlTable)[k];
  }
  return cur;
}

export function tomlStrings(v: TomlValue | undefined): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}
