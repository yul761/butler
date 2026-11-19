// 回测用的统一 diff 解析（工作流 F 第 3.3 节）：`gh pr diff` 的输出切成文件，每个文件留新的一侧。
// 新一侧还原成「按新行号放好的文字」（hunk 之间的空档填空行），这样检查在上面跑出来的行号就是真实行号；
// 只认这个 PR 加的行（added）上的违规。纯函数，Windows 的 \r\n 也认。
import { normalizePath } from "../../shared/glob";

export interface DiffFile {
  /** 新一侧的仓库内路径（/ 分隔）；删掉的文件是 null。 */
  path: string | null;
  oldPath: string | null;
  binary: boolean;
  /** 新行号（从 1 开始）→ 这一行的文字（hunk 里出现过的新一侧的行：上下文和加的行）。 */
  lines: Map<number, string>;
  /** 这个 PR 加的行的新行号。 */
  added: Set<number>;
}

const unquote = (p: string): string => {
  const s = p.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
};

const side = (raw: string, prefix: "a/" | "b/"): string | null => {
  const p = unquote(raw.replace(/\t.*$/, ""));
  if (p === "/dev/null") return null;
  return normalizePath(p.startsWith(prefix) ? p.slice(2) : p);
};

/** `diff --git a/x b/y` 里取出 b 一侧（没有 ---/+++ 头时用，比如纯改名、二进制）。 */
function gitHeaderPaths(line: string): { a: string | null; b: string | null } {
  const rest = line.slice("diff --git ".length);
  const q = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (q) return { a: side(`"${q[1]}"`, "a/"), b: side(`"${q[2]}"`, "b/") };
  // 两边路径一样（最常见）：从中间切开。
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3)) {
    return { a: side(rest.slice(0, half), "a/"), b: side(rest.slice(half + 1), "b/") };
  }
  const m = /^(a\/.*) (b\/.*)$/.exec(rest);
  return m ? { a: side(m[1], "a/"), b: side(m[2], "b/") } : { a: null, b: null };
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const out: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const h = gitHeaderPaths(line);
      cur = { path: h.b, oldPath: h.a, binary: false, lines: new Map(), added: new Set() };
      out.push(cur);
      oldLeft = newLeft = 0;
      continue;
    }
    if (!cur) continue;
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === "+") {
        newLine++;
        cur.lines.set(newLine, line.slice(1));
        cur.added.add(newLine);
        newLeft--;
      } else if (c === "-") {
        oldLeft--;
      } else if (c === " " || line === "") {
        newLine++;
        cur.lines.set(newLine, line.slice(1));
        oldLeft--;
        newLeft--;
      } else if (c === "\\") {
        // 「\ No newline at end of file」
      } else {
        oldLeft = newLeft = 0;
      }
      if (oldLeft > 0 || newLeft > 0 || c === "+" || c === "-" || c === " " || c === "\\" || line === "") continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLine = Number(hunk[2]) - 1;
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      continue;
    }
    if (line.startsWith("--- ")) cur.oldPath = side(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) cur.path = side(line.slice(4), "b/");
    else if (line.startsWith("deleted file mode")) cur.path = null;
    else if (line.startsWith("rename to ")) cur.path = normalizePath(unquote(line.slice("rename to ".length)));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.binary = true;
  }
  return out;
}

/** 新一侧按行号放好的文字：没出现在 diff 里的行是空行。 */
export function newSideText(f: DiffFile): string {
  let max = 0;
  for (const n of f.lines.keys()) if (n > max) max = n;
  const rows: string[] = new Array(max).fill("");
  for (const [n, t] of f.lines) rows[n - 1] = t;
  return rows.join("\n");
}

/** 某个新行号前后各 `radius` 行（给模型看的上下文）。 */
export function contextAround(f: DiffFile, line: number, radius = 5): string {
  const out: string[] = [];
  for (let n = Math.max(1, line - radius); n <= line + radius; n++) {
    const t = f.lines.get(n);
    if (t !== undefined) out.push(`${n}${n === line ? ">" : " "} ${t}`);
  }
  return out.join("\n");
}
