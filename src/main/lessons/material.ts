import { reviewerKind, type PrLessonData } from "../tickets/gh";
import type { Lang } from "../../shared/i18n";

export type Who = "copilot" | "human" | "author" | "bot";
export interface ReviewItem {
  who: Who;
  author: string;
  body: string;
  url: string | null;
  path: string | null;
  line: number | null;
  at: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** 只留 copilot 和 human、正文非空的 review、评论和行内评论；按时间升序。login 在 botLogins 里的 human 改成 bot。 */
export function reviewItems(pr: PrLessonData): ReviewItem[] {
  const kind = (login: string): Who => {
    const k = reviewerKind(login, pr.author);
    return k === "human" && pr.botLogins.has(login) ? "bot" : k;
  };
  const all: { ms: number; item: ReviewItem }[] = [];
  const push = (ms: number, author: string, body: string, url: string | null, path: string | null, line: number | null): void => {
    const who = kind(author);
    if (who !== "copilot" && who !== "human") return;
    if (body.trim() === "") return;
    all.push({ ms, item: { who, author, body, url, path, line, at: iso(ms) } });
  };
  for (const r of pr.reviews) push(r.submittedAt, r.author, r.body, null, null, null);
  for (const c of pr.comments) push(c.createdAt, c.author, c.body, c.url, null, null);
  for (const c of pr.inline) push(c.createdAt, c.author, c.body, c.url, c.path, c.line);
  return all.sort((a, b) => a.ms - b.ms).map((x) => x.item);
}

/** 最早一条有 path 的行内评论之前最后一个 commit 的 oid，和最后一个 commit 的 oid；没有行内评论或评论之后没有 commit 时为 null。 */
export function fixRange(pr: PrLessonData, items: ReviewItem[]): { base: string; head: string } | null {
  const first = items.filter((i) => i.path !== null).map((i) => Date.parse(i.at)).sort((a, b) => a - b)[0];
  if (first === undefined) return null;
  const commits = pr.commits
    .map((c) => ({ oid: c.oid, ms: Date.parse(c.committedDate) }))
    .filter((c) => !Number.isNaN(c.ms))
    .sort((a, b) => a.ms - b.ms);
  const last = commits[commits.length - 1];
  if (!last || last.ms <= first) return null;
  const before = commits.filter((c) => c.ms <= first);
  const base = before[before.length - 1];
  return base ? { base: base.oid, head: last.oid } : null;
}

/** 从 JSONL 对话记录里取 assistant 的文字块（不要 tool_use、thinking），只留提到任一 path 的文件名（basename）的；从新到旧，合计不超过 maxChars。 */
export function transcriptExcerpts(jsonl: string[], paths: string[], maxChars: number): string[] {
  const names = paths.map((p) => p.split("/").pop() ?? "").filter((n) => n !== "");
  if (names.length === 0) return [];
  const out: string[] = [];
  let total = 0;
  for (let i = jsonl.length - 1; i >= 0; i--) {
    let j: unknown;
    try {
      j = JSON.parse(jsonl[i] ?? "");
    } catch {
      continue;
    }
    const o = j as { type?: unknown; message?: { content?: unknown } } | null;
    if (!o || o.type !== "assistant") continue;
    const content = o.message?.content;
    const text = (Array.isArray(content) ? content : [])
      .flatMap((b: unknown) => {
        const blk = b as { type?: unknown; text?: unknown } | null;
        return blk && blk.type === "text" && typeof blk.text === "string" ? [blk.text] : [];
      })
      .join("\n");
    if (text === "" || !names.some((n) => text.includes(n))) continue;
    if (total + text.length > maxChars) break;
    out.push(text);
    total += text.length;
  }
  return out;
}

export interface Material {
  pr: PrLessonData;
  items: ReviewItem[];
  /** 评论指到的那几个文件在修改之后的 patch，每个最多 4000 字。 */
  fixes: { filename: string; patch: string }[];
  /** Butler 做的 PR：handoff 里的 decisions 和 learnings，以及对话记录摘录；不是 Butler 做的为 null。 */
  butler: { ticketKey: string; decisions: string[]; learnings: string[]; excerpts: string[] } | null;
}

export const MATERIAL_MAX_CHARS = 60_000;
const ITEM_BODY_MAX = 1500;
const PATCH_MAX = 4000;
const PR_BODY_MAX = 8000;
const TITLE_MAX = 500;
const COMMITS_MAX = 100;
const HEADLINE_MAX = 300;
const NOTES_MAX = 50;
const NOTE_MAX = 500;

const H = {
  zh: { pr: "PR", body: "描述", commits: "提交", review: "评审意见", fixes: "之后的修改", butler: "Butler 上下文", decisions: "决定", learnings: "心得", excerpts: "对话摘录" },
  en: { pr: "PR", body: "Description", commits: "Commits", review: "Review comments", fixes: "Later fixes", butler: "Butler context", decisions: "Decisions", learnings: "Learnings", excerpts: "Transcript excerpts" },
} as const;

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function render(m: Material, lang: Lang, o: { excerpts: boolean; fixes: boolean; bodyMax: number }): string {
  const h = H[lang];
  const p = m.pr;
  const out: string[] = [`## ${h.pr} #${p.number}: ${cut(p.title, TITLE_MAX)}`, p.url, `### ${h.body}`, cut(p.body, PR_BODY_MAX), `### ${h.commits}`];
  for (const c of p.commits.slice(0, COMMITS_MAX)) out.push(`- ${c.oid.slice(0, 7)} ${cut(c.headline, HEADLINE_MAX)}`);
  out.push(`### ${h.review}`);
  m.items.forEach((i, n) => {
    const where = i.path ? ` ${i.path}${i.line !== null ? `:${i.line}` : ""}` : "";
    out.push(`#### ${n + 1}. ${i.author} (${i.who}) ${i.at}${where}`, cut(i.body, o.bodyMax));
  });
  if (o.fixes && m.fixes.length > 0) {
    out.push(`### ${h.fixes}`);
    for (const f of m.fixes) out.push(`#### ${f.filename}`, cut(f.patch, PATCH_MAX));
  }
  const b = m.butler;
  if (b) {
    out.push(`### ${h.butler} (${b.ticketKey})`);
    if (b.decisions.length > 0) out.push(`#### ${h.decisions}`, ...b.decisions.slice(0, NOTES_MAX).map((d) => `- ${cut(d, NOTE_MAX)}`));
    if (b.learnings.length > 0) out.push(`#### ${h.learnings}`, ...b.learnings.slice(0, NOTES_MAX).map((d) => `- ${cut(d, NOTE_MAX)}`));
    if (o.excerpts && b.excerpts.length > 0) out.push(`#### ${h.excerpts}`, ...b.excerpts);
  }
  return out.join("\n");
}

/** 拼成 prompt 里的素材一节；超过 MATERIAL_MAX_CHARS 时依次截掉 excerpts、fixes 和 items 的正文（每条最多 1500 字）。 */
export function materialText(m: Material, lang: Lang): string {
  const steps = [
    { excerpts: true, fixes: true, bodyMax: Infinity },
    { excerpts: false, fixes: true, bodyMax: Infinity },
    { excerpts: false, fixes: false, bodyMax: Infinity },
    { excerpts: false, fixes: false, bodyMax: ITEM_BODY_MAX },
  ];
  for (const s of steps) {
    const t = render(m, lang, s);
    if (t.length <= MATERIAL_MAX_CHARS) return t;
  }
  // 兜底：把每条正文压到均分后的额度，保证每条评论的作者还在。
  const overhead = render({ ...m, items: m.items.map((i) => ({ ...i, body: "" })) }, lang, steps[3]!).length;
  const per = Math.max(0, Math.floor((MATERIAL_MAX_CHARS - overhead) / Math.max(1, m.items.length)));
  return cut(render(m, lang, { excerpts: false, fixes: false, bodyMax: Math.min(ITEM_BODY_MAX, per) }), MATERIAL_MAX_CHARS);
}
