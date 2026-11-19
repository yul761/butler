// 自动接活的仓库映射（没有别的依赖，设置校验也用）。
import type { IncomingTicket } from "../../shared/intake";

export type RepoRule = { kind: "prefix"; value: string; path: string } | { kind: "label" | "component"; value: string; path: string } | { kind: "any"; path: string };

/** 绝对路径（macOS / Linux 的 /…，Windows 的 C:\… 或 \\server\…）。 */
export const isAbsolutePath = (p: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);

/**
 * `intakeRepoMap`：一行一条 `匹配 => 路径`。匹配是 key 前缀（`PROJ-`）、`label:x`、`component:x` 或 `*`；路径要是绝对路径。
 * 空行和 # 开头的行跳过；坏行收进 errors（设置保存时报错，读的时候丢掉）。
 */
export function parseRepoMap(text: string): { rules: RepoRule[]; errors: number[] } {
  const rules: RepoRule[] = [];
  const errors: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const l = line.trim();
    if (!l || l.startsWith("#")) return;
    const m = /^(.+?)\s*=>\s*(.+)$/.exec(l);
    if (!m) return void errors.push(i + 1);
    const match = m[1]!.trim();
    const path = m[2]!.trim();
    if (!isAbsolutePath(path)) return void errors.push(i + 1);
    const lc = /^(label|component)\s*:\s*(.+)$/i.exec(match);
    if (match === "*") rules.push({ kind: "any", path });
    else if (lc) rules.push({ kind: lc[1]!.toLowerCase() as "label" | "component", value: lc[2]!.trim().toLowerCase(), path });
    else if (/^[A-Za-z][A-Za-z0-9_]*-?$/.test(match)) rules.push({ kind: "prefix", value: (match.endsWith("-") ? match : `${match}-`).toUpperCase(), path });
    else errors.push(i + 1);
  });
  return { rules, errors };
}

/** 这个 ticket 放哪个仓库：来源直接给的（绝对路径）优先，再按映射第一条命中的。都没有为 null。 */
export function mapRepo(t: IncomingTicket, rules: readonly RepoRule[]): string | null {
  if (t.repo && isAbsolutePath(t.repo)) return t.repo;
  const labels = t.labels.map((l) => l.toLowerCase());
  const comps = t.components.map((c) => c.toLowerCase());
  for (const r of rules) {
    if (r.kind === "any") return r.path;
    if (r.kind === "prefix" && t.key.toUpperCase().startsWith(r.value)) return r.path;
    if (r.kind === "label" && labels.includes(r.value)) return r.path;
    if (r.kind === "component" && comps.includes(r.value)) return r.path;
  }
  return null;
}
