// 用户写的 JS 正则 → Python re（导出到 pre-commit pygrep 和 Python 检查脚本，设计 §8）。翻不过去的给出理由。
export type RegexTranslation = { ok: true; source: string } | { ok: false; reason: string };

/**
 * 能翻的：命名组 (?<n>…) → (?P<n>…)，\k<n> → (?P=n)，\/ → /，\d \w \s \b 按 ASCII（脚本里用 re.ASCII，和 JS 不带 u 一样）。
 * 不能翻的：\p{…}、\u{…}、\c 控制字符、[^] / []、不定长的后行断言（Python 只收定长）。
 */
export function jsRegexToPython(input: string): RegexTranslation {
  if (/\\[pP]\{/.test(input)) return { ok: false, reason: "unicode_property" };
  if (/\\u\{/.test(input)) return { ok: false, reason: "unicode_codepoint" };
  if (/\\c[A-Za-z]/.test(input)) return { ok: false, reason: "control_escape" };
  if (/(^|[^\\])\[\^?\]/.test(input)) return { ok: false, reason: "empty_class" };
  const src = escapeLiteralBraces(input);
  let out = "";
  let i = 0;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1] ?? "";
      if (n === "k" && src[i + 2] === "<") {
        const end = src.indexOf(">", i + 3);
        if (end < 0) return { ok: false, reason: "syntax" };
        out += `(?P=${src.slice(i + 3, end)})`;
        i = end + 1;
        continue;
      }
      if (n === "/") {
        out += "/";
        i += 2;
        continue;
      }
      // JS 里多余的转义（\- \_ 这类非字母）Python 也收；字母的未知转义 Python 会报错。
      if (/[a-zA-Z]/.test(n) && !"dDwWsSbBnrtfv0xu".includes(n)) return { ok: false, reason: "escape" };
      if (n === "v") {
        out += "\\x0b";
        i += 2;
        continue;
      }
      out += c + n;
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      out += c;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
      i++;
      continue;
    }
    if (c === "(" && src[i + 1] === "?") {
      if (src[i + 2] === "<" && src[i + 3] !== "=" && src[i + 3] !== "!") {
        out += "(?P<";
        i += 3;
        continue;
      }
      if (src[i + 2] === "<" && (src[i + 3] === "=" || src[i + 3] === "!")) {
        const body = groupBody(src, i);
        if (body === null) return { ok: false, reason: "syntax" };
        if (/(^|[^\\])[*+?{]|\|/.test(body.slice(4))) return { ok: false, reason: "lookbehind" };
      }
    }
    out += c;
    i++;
  }
  return { ok: true, source: out };
}

/**
 * JS（不带 u）里不是合法量词的 { 就是字面的花括号（{,3}、{a}、x{）；Python 和新的 PCRE 却把 {,3} 读成 {0,3}。
 * 统一转义成 \{，两边意思才一样（审查发现）。
 */
export function escapeLiteralBraces(src: string): string {
  let out = "";
  let cls = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      out += c + (src[i + 1] ?? "");
      i++;
      continue;
    }
    if (cls) {
      if (c === "]") cls = false;
      out += c;
      continue;
    }
    if (c === "[") cls = true;
    if (c === "{" && !/^\{\d+(,\d*)?\}/.test(src.slice(i))) {
      out += "\\{";
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * 把字符类外面、没转义的 $ 换成 repl（pygrep 按字节读行，行尾的 \r 还在：$ 要能跳过它，和 Shipherd 按 \r?\n 分行一样）。
 */
export function replaceEndAnchors(src: string, repl: string): string {
  let out = "";
  let cls = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      out += c + (src[i + 1] ?? "");
      i++;
      continue;
    }
    if (cls) {
      if (c === "]") cls = false;
      out += c;
      continue;
    }
    if (c === "[") cls = true;
    out += c === "$" ? repl : c;
  }
  return out;
}

/** 从 i（一个 "("）到配对的 ")"（含）。 */
function groupBody(src: string, i: number): string | null {
  let depth = 0;
  let cls = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (cls) {
      if (c === "]") cls = false;
      continue;
    }
    if (c === "[") cls = true;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(i, j + 1);
  }
  return null;
}

/** 字面文字 → 正则（JS 和 Python 都能用的转义）。 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, (c) => (c === "/" ? "/" : `\\${c}`));
}

/**
 * JS 正则 → PCRE（shell 脚本用 git grep -P）。拒绝的情况和 Python 一样（JS 不带 u 时 \p 就是字母 p，PCRE 里却是属性，意思不一样）；
 * \uXXXX 换成 \x{XXXX}，其余 PCRE 原样认。
 */
export function jsRegexToPcre(src: string): RegexTranslation {
  const py = jsRegexToPython(src);
  if (!py.ok) return py;
  return { ok: true, source: escapeLiteralBraces(src).replace(/(^|[^\\])((?:\\\\)*)\\u([0-9a-fA-F]{4})/g, (_m, a: string, b: string, h: string) => `${a}${b}\\x{${h}}`) };
}
