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
  // 父 epic：{ key, title } 或者只给 key。
  const e = o.epic;
  const eo = typeof e === "object" && e !== null && !Array.isArray(e) ? (e as Record<string, unknown>) : null;
  const epicKey = (typeof e === "string" ? str(e, LIMITS.key) : eo ? str(eo.key, LIMITS.key) : null)?.replace(/\s+/g, "").toUpperCase();
  const epic = epicKey ? { key: epicKey, title: eo ? (str(eo.title ?? eo.summary, LIMITS.title)?.replace(/\s+/g, " ") ?? null) : null } : null;
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
    ...(epic && { epic }),
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
      // 没写查询就不拉：不然模型会随便挑它看得到的 ticket，可能直接被自动开工。
      if (!query.trim()) return { ok: false, message: "no tracker query" };
      const r = await fetchFromTracker(exec, dir, query, tools(), lang());
      return r.ok ? { ok: true, tickets: normalizeList(r.tickets) } : r;
    },
  };
}

export { isAbsolutePath, mapRepo, parseRepoMap, type RepoRule } from "./repo-map";
