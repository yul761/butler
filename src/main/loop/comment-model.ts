import { z } from "zod";
import { headlessArgs } from "../claude/headless";
import { execHeadlessJson, type HeadlessExecDeps } from "../handoff/headless-exec";
import { toCliJsonSchema, validate } from "../handoff/schema";
import { currentLang } from "../i18n";
import { sanitizeJudgeReason } from "../util/judge-text";
import type { CommentCategory, CommentWho } from "../../shared/loop";
import type { FollowUp } from "./comment-rules";

const AnswerSchema = z.object({
  items: z.array(z.object({ id: z.string(), category: z.enum(["fix", "question", "ignore", "human"]), reason: z.string() })),
});
const JSON_SCHEMA = toCliJsonSchema(AnswerSchema);

/** 一次最多分这么多条；原文、讨论各截到这么长。 */
export const COMMENT_MODEL_BATCH = 20;
export const COMMENT_MODEL_BODY_CHARS = 1500;
export const COMMENT_MODEL_FOLLOWUP_CHARS = 600;

export interface CommentModelItem {
  id: string;
  who: CommentWho;
  path: string | null;
  line: number | null;
  body: string;
  followUps: FollowUp[];
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function block(c: CommentModelItem, en: boolean): string {
  const where = c.path ? `${c.path}${c.line !== null ? `:${c.line}` : ""}` : en ? "(whole PR)" : "（整个 PR）";
  const discussion = c.followUps.length === 0 ? "" : `\n${en ? "Replies" : "后面的讨论"}:\n${cut(c.followUps.map((f) => `- ${f.who}: ${f.body}`).join("\n"), COMMENT_MODEL_FOLLOWUP_CHARS)}`;
  return `### id=${c.id} (${c.who}, ${where})\n${cut(c.body, COMMENT_MODEL_BODY_CHARS)}${discussion}`;
}

export function commentPrompt(items: readonly CommentModelItem[], lang: "zh" | "en" = currentLang()): string {
  const en = lang === "en";
  const head = en
    ? [
      "You are sorting code review comments on a pull request so the developer's coding session only gets the ones it should act on.",
      "For each comment pick one category:",
      "- fix: asks for a concrete change to the code (a bug, a rename, a missing check, a style rule the reviewer wants applied).",
      "- question: asks the author something or wants an explanation; no code change is clearly requested.",
      "- ignore: praise, an observation that needs no action, a duplicate, or something already handled in the replies.",
      "- human: a design or product decision, a disagreement, scope changes, or anything a person should decide before code changes.",
      "When unsure between fix and human, answer human.",
    ]
    : [
      "你在给一个 PR 上的 code review 评论分类，让写代码的 session 只收到它该动手的那些。",
      "每条评论选一个类别：",
      "- fix：要求具体改代码（bug、改名、少了检查、评审人要求的风格）。",
      "- question：在问作者问题、要解释，没有明确要求改代码。",
      "- ignore：夸奖、不需要处理的观察、重复的、或者后面的讨论里已经处理了。",
      "- human：设计或产品上的决定、有分歧、范围变化，或者任何应该先由人决定再改代码的。",
      "fix 和 human 之间拿不准就答 human。",
    ];
  const tail = en
    ? 'Answer as JSON: items (one per comment: id exactly as given, category, reason = one short sentence in English).'
    : "用 JSON 回答：items（每条评论一项：id 照抄、category、reason 一句话理由，用中文）。";
  return [...head, "", ...items.map((c) => block(c, en)), "", tail].join("\n");
}

export type CommentVerdicts = Map<string, { category: CommentCategory; reason: string }>;

/** 后台模型一次给一批评论分类（任务 comment_classify，经路由）。不给工具；失败返回 null；不认识的 id 丢掉。 */
export async function classifyCommentsByModel(d: HeadlessExecDeps, cwd: string, items: readonly CommentModelItem[]): Promise<CommentVerdicts | null> {
  if (items.length === 0) return new Map();
  const batch = items.slice(0, COMMENT_MODEL_BATCH);
  const args = headlessArgs({ schema: JSON_SCHEMA, allowedTools: [] });
  const r = await execHeadlessJson(d, { task: "comment_classify", label: "comment classify", args, prompt: commentPrompt(batch), cwd });
  if (!r.ok) return null;
  const v = validate(AnswerSchema, r.value);
  if (!v.ok) return null;
  const ids = new Set(batch.map((b) => b.id));
  const out: CommentVerdicts = new Map();
  for (const it of v.value.items) if (ids.has(it.id) && !out.has(it.id)) out.set(it.id, { category: it.category, reason: sanitizeJudgeReason(it.reason) });
  return out;
}
