// 把一段 shell / CI 命令拆成一条条命令（设计 §3.3）：合并续行，按换行、&&、||、;、| 拆（引号里的不拆），
// 识别开头的 `cd <dir>`（之后的命令归到那个目录）和环境变量赋值。纯函数。

export interface CommandSegment {
  /** 去掉环境变量赋值后的命令。 */
  text: string;
  /** 相对起始目录的 cd 目标（用 /）；没 cd 是 ""。 */
  cd: string;
}

/** 合并续行：行尾的 \（sh）、`（PowerShell）、^（cmd）。 */
export function joinContinuations(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]*[\\`^][ \t]*\n[ \t]*/g, " ");
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      // 注释到行尾
      while (i < s.length && s[i] !== "\n") i++;
      out.push(cur);
      cur = "";
      continue;
    }
    if (c === "\n" || c === ";") {
      out.push(cur);
      cur = "";
      continue;
    }
    if ((c === "&" && s[i + 1] === "&") || (c === "|" && s[i + 1] === "|")) {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === "|") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** 把 cd 目标并到当前目录上（只认相对路径；绝对路径、~、$VAR 视为离开仓库，返回 null）。 */
export function joinDir(base: string, target: string): string | null {
  const t = unquote(target).replace(/\\/g, "/");
  if (!t || t.startsWith("/") || t.startsWith("~") || t.includes("$") || /^[a-zA-Z]:/.test(t)) return null;
  const parts = base ? base.split("/") : [];
  for (const p of t.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(p);
  }
  return parts.join("/");
}

const SKIP = /^(?:set|echo|export|exit|true|false|then|fi|else|do|done|if|for|while|popd|printf|mkdir|rm|cp|mv|ls|cat|sleep|source|\.)(?:\s|$)|^[{}()]+$|^::/i;

export function splitCommands(script: string, startDir = ""): CommandSegment[] {
  const out: CommandSegment[] = [];
  let dir: string | null = startDir;
  for (let seg of splitTop(joinContinuations(script))) {
    seg = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "").trim();
    if (!seg) continue;
    const cd = /^(?:cd|pushd|Set-Location|sl)\s+(.+)$/i.exec(seg);
    if (cd) {
      dir = dir === null ? null : joinDir(dir, cd[1]);
      continue;
    }
    if (SKIP.test(seg)) continue;
    if (dir === null) continue;
    out.push({ text: seg, cd: dir });
  }
  return out;
}

/** 拆参数（按空白，认引号）。 */
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let has = false;
  for (const c of s) {
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** 按行拆，去掉 BOM，认 CRLF。 */
export function lines(text: string): string[] {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
}
