import {
  checkLoopValue, LOOP_POLICY_GROUPS, loopKeyDef, type LoopKeyView, type LoopPolicyGroup, type LoopPolicyKeyDef, type LoopPolicyOverrides, type LoopPolicyView, type LoopValue,
} from "../../shared/loop-policy";
import type { CommentItemView } from "../../shared/loop";

/** 「评论与 CI」编辑器的草稿：键 → 输入框里的字（列表是一行一条）。"" = 继承。没出现的键 = 没改。 */
export type LoopDraft = Record<string, string>;

/** 一个值写进输入框：列表一行一条，布尔写成 "true" / "false"，没设写成 ""。 */
export function loopInputValue(v: LoopValue | null): string {
  if (v === null) return "";
  return Array.isArray(v) ? v.join("\n") : String(v);
}

/** 输入框里的字 → 值；"" = 继承。不合法返回 undefined。列表里的空行丢掉，一条都没有也算继承。 */
export function parseLoopInput(key: string, raw: string): LoopValue | null | undefined {
  const d = loopKeyDef(key);
  if (!d) return undefined;
  if (d.kind === "list") {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    try {
      return checkLoopValue(key, lines);
    } catch {
      return undefined;
    }
  }
  const t = raw.trim();
  if (t === "") return null;
  const v: unknown = d.kind === "int" ? Number(t) : d.kind === "bool" ? (t === "true" ? true : t === "false" ? false : t) : t;
  try {
    return checkLoopValue(key, v);
  } catch {
    return undefined;
  }
}

const same = (a: LoopValue | null, b: LoopValue | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 这一层的覆盖 + 草稿 → 要保存的整层；有不合法的值时给出第一个坏键。 */
export function loopOverridesFromDraft(view: LoopPolicyView, draft: LoopDraft): { ok: true; overrides: LoopPolicyOverrides; changed: boolean } | { ok: false; badKey: string } {
  const out: Record<string, LoopValue> = {};
  let changed = false;
  for (const k of view.keys) {
    const raw = draft[k.key];
    if (raw === undefined) {
      if (k.override !== null) out[k.key] = k.override;
      continue;
    }
    const v = parseLoopInput(k.key, raw);
    if (v === undefined) return { ok: false, badKey: k.key };
    if (!same(v, k.override)) changed = true;
    if (v !== null) out[k.key] = v;
  }
  return { ok: true, overrides: out as LoopPolicyOverrides, changed };
}

/** 按分组排好的键（评论在前，CI 在后）。 */
export function loopGroups(view: LoopPolicyView): { group: LoopPolicyGroup; keys: (LoopKeyView & { def: LoopPolicyKeyDef })[] }[] {
  return LOOP_POLICY_GROUPS.map((group) => ({
    group,
    keys: view.keys.flatMap((k) => {
      const def = loopKeyDef(k.key);
      return def && def.group === group ? [{ ...k, def }] : [];
    }),
  })).filter((g) => g.keys.length > 0);
}

/** 一条评论在哪：path:line，没有位置的是整个 PR。 */
export const commentWhere = (c: Pick<CommentItemView, "path" | "line">, wholePr: string): string => (c.path ? (c.line !== null ? `${c.path}:${c.line}` : c.path) : wholePr);

/** 这条评论现在能做什么：送进 session、忽略、改完了再回复一次。 */
export function commentActions(c: Pick<CommentItemView, "state" | "repliedAt">): ("send" | "dismiss" | "reply")[] {
  const out: ("send" | "dismiss" | "reply")[] = [];
  if (c.state === "pending" || c.state === "review" || c.state === "ignored" || c.state === "dismissed") out.push("send");
  if (c.state === "pending" || c.state === "review" || c.state === "queued" || c.state === "ignored") out.push("dismiss");
  if (c.state === "addressed" && c.repliedAt === null) out.push("reply");
  return out;
}

/** 还能改分类（送进去了、处理了、关了的不能改）。和主进程 CommentLoop.act 的判断一致。 */
export const canCategorize = (c: Pick<CommentItemView, "state">): boolean => c.state !== "delivered" && c.state !== "addressed" && c.state !== "closed";

/** 评论正文的第一行，截短。 */
export function commentSnippet(body: string, max = 160): string {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
