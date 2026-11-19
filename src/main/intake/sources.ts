// 自动接活的来源和仓库映射（设计补充 ws-n 第 2 节）。
// file：读一个 JSON 文件（e2e 的假来源，也可以让别的脚本写进来）；tracker：经 intake_fetch 用用户的 tracker MCP 拉。
import { readFile } from "node:fs/promises";
import type { IncomingTicket } from "../../shared/intake";
import { fetchFromTracker } from "./model";
import type { ExecRun } from "../prereview/model";

export interface IntakeSource {
  kind: "file" | "tracker";
  fetch: () => Promise<{ ok: true; tickets: IncomingTicket[] } | { ok: false; message: string }>;
}

const LIMITS = { key: 64, title: 300, description: 8000, type: 60, label: 60, labels: 30, priority: 40, url: 1000, components: 20, subtasks: 30, repo: 1000 };
export const MAX_TICKETS_PER_POLL = 50;

const str = (v: unknown, n: number): string | null => {
  if (typeof v !== "string") return null;
  // 控制字符去掉（换行、制表保留）
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return s ? s.slice(0, n) : null;
};
const strList = (v: unknown, each: number, max: number): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => str(x, each)).filter((x): x is string => x !== null))].slice(0, max) : [];

/** 来源给的一项 → IncomingTicket；没有 key 或标题的丢掉。限长、去掉控制字符。 */
export function normalizeIncoming(raw: unknown): IncomingTicket | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const key = str(o.key, LIMITS.key)?.replace(/\s+/g, "");
  const title = str(o.title ?? o.summary, LIMITS.title)?.replace(/\s+/g, " ");
  if (!key || !title) return null;
  const url = str(o.url, LIMITS.url);
  const sp = typeof o.storyPoints === "number" && Number.isFinite(o.storyPoints) && o.storyPoints >= 0 ? o.storyPoints : null;
  const subtasks = Array.isArray(o.subtasks)
    ? o.subtasks
      .map((s) => (typeof s === "object" && s !== null ? { key: str((s as Record<string, unknown>).key, LIMITS.key), title: str((s as Record<string, unknown>).title, LIMITS.title) } : null))
      .filter((s): s is { key: string; title: string } => !!s && !!s.key && !!s.title)
      .slice(0, LIMITS.subtasks)
    : [];
  return {
    key,
    title,
    description: str(o.description, LIMITS.description) ?? "",
    type: str(o.type, LIMITS.type),
    labels: strList(o.labels, LIMITS.label, LIMITS.labels),
    priority: str(o.priority, LIMITS.priority),
    url: url && /^https?:\/\//i.test(url) ? url : null,
    storyPoints: sp,
    components: strList(o.components, LIMITS.label, LIMITS.components),
    subtasks,
    repo: str(o.repo, LIMITS.repo),
  };
}

/** 一批：规整、按 key 去重（先出现的留下）、最多 MAX_TICKETS_PER_POLL 个。 */
export function normalizeList(raw: readonly unknown[]): IncomingTicket[] {
  const out: IncomingTicket[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = normalizeIncoming(r);
    if (!t || seen.has(t.key)) continue;
    seen.add(t.key);
    out.push(t);
    if (out.length >= MAX_TICKETS_PER_POLL) break;
  }
  return out;
}

/** file 来源：`{"tickets": [...]}` 或直接一个数组。 */
export function fileSource(path: string, read: (p: string) => Promise<string> = (p) => readFile(p, "utf8")): IntakeSource {
  return {
    kind: "file",
    fetch: async () => {
      let text: string;
      try {
        text = await read(path);
      } catch (e) {
        return { ok: false, message: `read: ${(e as NodeJS.ErrnoException).code ?? String(e)}`.slice(0, 200) };
      }
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch {
        return { ok: false, message: "bad json" };
      }
      const list = Array.isArray(v) ? v : typeof v === "object" && v !== null && Array.isArray((v as { tickets?: unknown }).tickets) ? (v as { tickets: unknown[] }).tickets : null;
      if (!list) return { ok: false, message: "no tickets array" };
      return { ok: true, tickets: normalizeList(list) };
    },
  };
}

export function trackerSource(exec: ExecRun, cwd: () => string | null, query: string, tools: () => string[], lang: () => "zh" | "en"): IntakeSource {
  return {
    kind: "tracker",
    fetch: async () => {
      const dir = cwd();
      if (!dir) return { ok: false, message: "no tracker dir" };
      const r = await fetchFromTracker(exec, dir, query, tools(), lang());
      return r.ok ? { ok: true, tickets: normalizeList(r.tickets) } : r;
    },
  };
}

// ---------------------------------------------------------------- 仓库映射

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
