import { compilePattern } from "../../shared/loop-policy";
import type { CommentCategory, CommentKind, CommentWho } from "../../shared/loop";
import { reviewerKind, type PrComment, type PrReview } from "../tickets/gh";
import type { ReviewThread } from "../tickets/gh-loop";

/**
 * 评论闭环的候选评论和确定性预筛（工作流 I，设计补充第 2.2、2.3 节）。纯函数。
 * 行内评论按 thread 算一条（第一条是评论，后面的是讨论）；有正文的 review 和 PR 级评论各算一条，没有文件和行号。
 */

export interface FollowUp { author: string; who: CommentWho; body: string }

export interface Candidate {
  key: string;
  kind: CommentKind;
  threadId: string | null;
  databaseId: number | null;
  author: string;
  who: CommentWho;
  path: string | null;
  line: number | null;
  body: string;
  url: string | null;
  commentedAt: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  /** thread 里后面的讨论（行内评论才有）。 */
  followUps: FollowUp[];
}

export interface PrForComments {
  author: string;
  reviews: PrReview[];
  comments: PrComment[];
}

const time = (s: string): number | null => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/** 作者种类：GraphQL 说是 Bot 的、又不是 Copilot 的按 bot。 */
export function whoOf(login: string, prAuthor: string, authorType = ""): CommentWho {
  const k = reviewerKind(login, prAuthor);
  return k === "human" && authorType === "Bot" ? "bot" : k;
}

export function candidates(pr: PrForComments, threads: readonly ReviewThread[]): Candidate[] {
  const out: Candidate[] = [];
  for (const t of threads) {
    const [root, ...rest] = t.comments;
    if (!root) continue;
    out.push({
      key: String(root.databaseId), kind: "inline", threadId: t.id, databaseId: root.databaseId, author: root.author, who: whoOf(root.author, pr.author, root.authorType),
      path: root.path ?? t.path, line: t.line ?? root.line, body: root.body, url: root.url || null, commentedAt: time(root.createdAt),
      isResolved: t.isResolved, isOutdated: t.isOutdated,
      followUps: rest.map((c) => ({ author: c.author, who: whoOf(c.author, pr.author, c.authorType), body: c.body })),
    });
  }
  for (const r of pr.reviews) {
    if (r.state === "PENDING" || r.state === "DISMISSED" || r.body.trim() === "") continue;
    out.push({
      key: `review:${r.id}`, kind: "review", threadId: null, databaseId: null, author: r.author, who: whoOf(r.author, pr.author), path: null, line: null, body: r.body,
      url: null, commentedAt: r.submittedAt || null, isResolved: false, isOutdated: false, followUps: [],
    });
  }
  for (const c of pr.comments) {
    if (c.path !== null) continue;
    out.push({
      key: `issue:${c.id}`, kind: "issue", threadId: null, databaseId: null, author: c.author, who: whoOf(c.author, pr.author), path: null, line: null, body: c.body,
      url: c.url, commentedAt: c.createdAt || null, isResolved: false, isOutdated: false, followUps: [],
    });
  }
  return out;
}

export type RuleOutcome = { skip: true; reason: "resolved" | "own" | "bot" } | { skip: false; category: CommentCategory; reason: string } | null;

/** 只是表示认可、感谢的短评论。 */
const ACK = /^(lgtm|looks good( to me)?|thanks?( you)?|thx|ty|nice|great|ok(ay)?|done|\+1|ship it|approved?|好的|谢谢|没问题|可以)[.!。！~\s]*$/i;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\s]*$/u;
const SHORTCODES = /^(:[a-z0-9_+-]+:\s*)+$/i;
const SUGGESTION = /```suggestion\b/;
/** Copilot review 正文开头那段总述。 */
const COPILOT_OVERVIEW = /pull request overview|reviewed \d+ out of \d+ changed files|copilot reviewed/i;

export function isAck(body: string): boolean {
  const t = body.trim();
  return t === "" || EMOJI_ONLY.test(t) || SHORTCODES.test(t) || ACK.test(t);
}

/** 确定性预筛。null = 规则判断不了，交给模型。 */
export function classifyCommentByRule(c: Candidate, ignorePatterns: readonly string[]): RuleOutcome {
  if (c.isResolved) return { skip: true, reason: "resolved" };
  if (c.who === "author") return { skip: true, reason: "own" };
  if (c.who === "bot") return { skip: true, reason: "bot" };
  if (c.kind === "inline" && (c.isOutdated || c.line === null)) return { skip: false, category: "ignore", reason: "outdated" };
  const last = c.followUps[c.followUps.length - 1];
  if (last && last.who === "author") return { skip: false, category: "ignore", reason: "answered" };
  if (isAck(c.body)) return { skip: false, category: "ignore", reason: "ack" };
  if (c.kind === "review" && c.who === "copilot" && COPILOT_OVERVIEW.test(c.body)) return { skip: false, category: "ignore", reason: "overview" };
  for (const p of ignorePatterns) if (compilePattern(p)?.(c.body)) return { skip: false, category: "ignore", reason: "pattern" };
  if (SUGGESTION.test(c.body)) return { skip: false, category: "fix", reason: "suggestion" };
  return null;
}
