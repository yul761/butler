// 回测的计算（工作流 F 第 3.2–3.4 节）：纯函数，在 worker 线程里跑（用户写的正则可能很慢）。
// 召回：评审人当时看的文件（original_commit）上跑检查，评论那一行附近（容差内）有违规就算抓到。
// 误报候选：合并 PR 的 diff 上跑检查，只看这个 PR 加的行；离这个 PR 的任何行内评论都不近的命中是候选。
import { createHash } from "node:crypto";
import { directRegexTest, evaluateBuiltin, type RegexTest } from "../../shared/check-rules";
import { inScope, normalizePath } from "../../shared/glob";
import { contextAround, newSideText, parseUnifiedDiff } from "./diff";

export interface BacktestCheckDef {
  type: string;
  params: Record<string, unknown>;
  globs: string[];
  excludeGlobs: string[];
}

export interface EvalSource {
  sourceId: number;
  prNumber: number;
  path: string;
  /** 评审人看的那一行（original_line，没有就是 line）；null 是对整个文件的评论。 */
  line: number | null;
  /** 那个提交上的文件；拿不到（缺、二进制、太大）是 null，这条评论不计入召回。 */
  content: string | null;
}

export interface EvalInput {
  check: BacktestCheckDef;
  ticketPattern: string;
  tolerance: number;
  prs: { number: number; diff: string }[];
  /** 每个 PR 的行内评论位置（任何人的），用来判断命中有没有人指出过。 */
  prComments: Record<number, { path: string | null; line: number | null }[]>;
  sources: EvalSource[];
}

export interface HitSample {
  pr: number;
  path: string;
  line: number;
  text: string;
  context: string;
}

export interface EvalOutput {
  prs: number;
  hits: number;
  matched: number;
  /** 没对上评论的命中（最多 MAX_UNMATCHED 条；总数在 unmatchedTotal）。 */
  unmatched: HitSample[];
  unmatchedTotal: number;
  comments: number;
  commentsMatched: number;
  caught: { sourceId: number; pr: number; path: string; line: number | null }[];
  missed: { sourceId: number; pr: number; path: string; line: number | null }[];
}

export const MAX_UNMATCHED = 500;

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

export function evaluateBacktest(input: EvalInput, test: RegexTest = directRegexTest()): EvalOutput {
  const { check, tolerance: tol } = input;
  const ctx = (path: string) => ({ path, ticketPattern: input.ticketPattern, test });
  let hits = 0;
  let matched = 0;
  let unmatchedTotal = 0;
  const unmatched: HitSample[] = [];
  for (const pr of input.prs) {
    const comments = (input.prComments[pr.number] ?? []).filter((c) => c.path !== null).map((c) => ({ path: normalizePath(c.path as string), line: c.line }));
    for (const f of parseUnifiedDiff(pr.diff)) {
      if (!f.path || f.binary || f.added.size === 0 || !inScope(f.path, check.globs, check.excludeGlobs)) continue;
      const path = f.path;
      for (const v of evaluateBuiltin(check, newSideText(f), ctx(path))) {
        if (!f.added.has(v.line)) continue;
        hits++;
        const pointed = comments.some((c) => c.path === path && (c.line === null || near(c.line, v.line, tol)));
        if (pointed) {
          matched++;
          continue;
        }
        unmatchedTotal++;
        if (unmatched.length < MAX_UNMATCHED) unmatched.push({ pr: pr.number, path, line: v.line, text: v.detail || v.text, context: contextAround(f, v.line) });
      }
    }
  }
  const caught: EvalOutput["caught"] = [];
  const missed: EvalOutput["missed"] = [];
  for (const s of input.sources) {
    if (s.content === null) continue;
    const path = normalizePath(s.path);
    const row = { sourceId: s.sourceId, pr: s.prNumber, path, line: s.line };
    const vs = inScope(path, check.globs, check.excludeGlobs) ? evaluateBuiltin(check, s.content, ctx(path)) : [];
    const hit = s.line === null ? vs.length > 0 : vs.some((v) => near(v.line, s.line as number, tol));
    (hit ? caught : missed).push(row);
  }
  return {
    prs: input.prs.length, hits, matched, unmatched, unmatchedTotal,
    comments: caught.length + missed.length, commentsMatched: caught.length, caught, missed,
  };
}

/** 键排好序的 JSON（哈希用）。 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** 检查定义的哈希：草稿和存下来的检查只要类型、参数、范围一样就共用一份回测结果。 */
export function defHash(c: BacktestCheckDef): string {
  return createHash("sha256").update(canonicalJson({ type: c.type, params: c.params, globs: c.globs, excludeGlobs: c.excludeGlobs })).digest("hex").slice(0, 32);
}

export function hashOf(v: unknown): string {
  return createHash("sha256").update(canonicalJson(v)).digest("hex").slice(0, 32);
}
