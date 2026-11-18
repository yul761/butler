// 路径 glob（检查的适用范围，契约 4.5）。纯函数，不引 Node 模块：hook、主进程和渲染进程都用它。
// 路径和模式里的 \ 先都换成 /：Windows 上写的检查在 macOS 上结果一样，反过来也一样。大小写敏感（各平台结果一致）。
//   **  任意层目录（含零层）；*  一层里的任意字符；?  一个字符；[abc] / [!abc]  字符类；{a,b}  任选其一。
//   没有 / 的模式匹配任意目录下的文件名（*.ts）；以 / 结尾的模式表示这个目录下的一切。

/** 统一成 / 分隔、去掉开头的 ./ 和 /。 */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s.replace(/^\/+/, "");
}

const cache = new Map<string, RegExp>();

function escape(c: string): string {
  return /[.+^$()|\\/]/.test(c) ? `\\${c}` : c;
}

/** 把 glob 主体（已规范化）翻成正则源码。 */
function translate(glob: string): string {
  let out = "";
  let i = 0;
  let braces = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** 只在整段时表示多层目录；a**b 当成 *。
        const atStart = i === 0 || glob[i - 1] === "/";
        const atEnd = i + 2 === glob.length || glob[i + 2] === "/";
        if (atStart && atEnd) {
          if (i + 2 === glob.length) out += ".*";
          else {
            out += "(?:.*/)?";
            i++; // 吃掉后面的 /
          }
          i += 2;
          continue;
        }
        out += "[^/]*";
        i += 2;
        continue;
      }
      out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close < 0) out += "\\[";
      else {
        let body = glob.slice(i + 1, close);
        const negate = body.startsWith("!") || body.startsWith("^");
        if (negate) body = body.slice(1);
        out += `[${negate ? "^" : ""}${body.replace(/\\/g, "\\\\").replace(/\//g, "")}]`;
        i = close;
      }
    } else if (c === "{") {
      braces++;
      out += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      out += ")";
    } else if (c === "," && braces > 0) out += "|";
    else out += escape(c);
    i++;
  }
  // 没闭合的 { 当普通字符处理太复杂：直接补上括号。
  out += ")".repeat(braces);
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let g = normalizePath(pattern.trim());
  if (g.endsWith("/")) g += "**";
  const src = g.includes("/") ? `^${translate(g)}$` : `^(?:.*/)?${translate(g)}$`;
  let re: RegExp;
  try {
    re = new RegExp(src);
  } catch {
    re = /$^/; // 写坏的模式什么都不匹配
  }
  if (cache.size > 2000) cache.clear();
  cache.set(pattern, re);
  return re;
}

export function matchGlob(path: string, pattern: string): boolean {
  if (!pattern.trim()) return false;
  return globToRegExp(pattern).test(normalizePath(path));
}

export function matchAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchGlob(path, p));
}

/** 检查是否适用于这个文件：globs 为空 = 处处适用；exclude 命中就不适用。 */
export function inScope(path: string, globs: readonly string[], exclude: readonly string[] = []): boolean {
  if (exclude.length && matchAny(path, exclude)) return false;
  return globs.length === 0 || matchAny(path, globs);
}
