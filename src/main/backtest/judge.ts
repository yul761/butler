// 误报候选交给模型判（工作流 F 第 3.3 节，任务 backtest_judge：中档，撞限换下一个）。
// 每条命中单独缓存（JudgmentCache 的 backtest_fp / shadow_fp），重新计算、换一批样本都不重复调用。
// 判不了（关掉、调用失败）的候选按误报算：宁可保守，不让没把握的检查升级。
import { z } from "zod";
import { callModel, inputHash, type AdmissionRunner } from "../lessons/admission/call";
import type { JudgmentCache, JudgmentKind } from "../lessons/admission/judgments";

export interface JudgeHit {
  /** 缓存键（回测：定义哈希 + PR + 路径 + 行；影子：命中 id）。 */
  key: string;
  path: string;
  line: number;
  text: string;
  context: string;
}

export type HitVerdict = "violation" | "false_positive";

export interface JudgeResult {
  judged: number;
  falsePositives: number;
  verdicts: Map<string, { verdict: HitVerdict; reason: string }>;
  /** 有候选没判成（调用失败、限流）。 */
  incomplete: boolean;
  waitUntil: number | null;
}

const schema = z.object({
  items: z.array(z.object({ id: z.number().int(), verdict: z.enum(["violation", "false_positive"]), reason: z.string().max(400) })),
});

/** 按种子打乱后取前 n 个（同一批输入每次抽到的一样）。 */
export function seededSample<T>(xs: readonly T[], n: number, seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const rnd = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, n));
}

export interface JudgeDeps {
  run: AdmissionRunner;
  judgments: JudgmentCache;
  lang: () => "zh" | "en";
  cwd: string;
  now: () => number;
  onCall?: () => void;
}

const BATCH = 25;

function prompt(lang: "zh" | "en", rule: string, message: string, hits: { id: number; h: JudgeHit }[]): string {
  const list = hits.map(({ id, h }) => `### ${id}: ${h.path}:${h.line}\n${h.text}\n\`\`\`\n${h.context.slice(0, 1500)}\n\`\`\``).join("\n\n");
  return lang === "zh"
    ? `一条团队规矩被做成了自动检查。下面是这个检查在已经合并的代码里报出的命中，当时没有评审人指出它们。逐条判断：真的违反了规矩（只是评审没发现）就是 violation；规矩的本意不管这种写法、检查报错了就是 false_positive。\n\n规矩：${rule}\n检查的提示：${message}\n\n${list}\n\n每条给出 id、verdict 和一句理由。`
    : `A team rule was turned into an automatic check. Below are hits the check reports in code that was already merged without any reviewer pointing at them. For each one decide: it really breaks the rule (the reviewers just missed it) → violation; the rule is not meant to cover this and the check fired wrongly → false_positive.\n\nRule: ${rule}\nCheck message: ${message}\n\n${list}\n\nGive id, verdict and a one-sentence reason for each.`;
}

/** 判一批候选：先查缓存，剩下的分批调模型。 */
export async function judgeHits(d: JudgeDeps, kind: Extract<JudgmentKind, "backtest_fp" | "shadow_fp">, rule: { text: string; message: string }, hits: JudgeHit[]): Promise<JudgeResult> {
  const verdicts = new Map<string, { verdict: HitVerdict; reason: string }>();
  const hashOf = (h: JudgeHit) => inputHash({ rule: rule.text, message: rule.message, path: h.path, text: h.text, context: h.context });
  const todo: JudgeHit[] = [];
  for (const h of hits) {
    const c = d.judgments.get<{ verdict: HitVerdict; reason: string }>(kind, h.key, hashOf(h));
    if (c) verdicts.set(h.key, c.result);
    else todo.push(h);
  }
  let incomplete = false;
  let waitUntil: number | null = null;
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH).map((h, j) => ({ id: j + 1, h }));
    const r = await callModel(d.run, { task: "backtest_judge", label: "backtest", schema, prompt: prompt(d.lang(), rule.text, rule.message, part), cwd: d.cwd }, d.onCall);
    if (!r.ok) {
      incomplete = true;
      waitUntil = r.waitUntil;
      break;
    }
    for (const it of r.value.items) {
      const p = part.find((x) => x.id === it.id);
      if (!p || verdicts.has(p.h.key)) continue;
      const v = { verdict: it.verdict, reason: it.reason };
      verdicts.set(p.h.key, v);
      d.judgments.put(kind, p.h.key, hashOf(p.h), v, { model: r.model, degraded: r.degraded, at: d.now() });
    }
    if (part.some((p) => !verdicts.has(p.h.key))) incomplete = true;
  }
  let falsePositives = 0;
  for (const v of verdicts.values()) if (v.verdict === "false_positive") falsePositives++;
  return { judged: verdicts.size, falsePositives, verdicts, incomplete, waitUntil };
}

/** 误报估计：判过的按比例外推到全部候选；一个都没判成就全部算误报。 */
export function estimateFalsePositives(unmatched: number, judged: number, judgedFp: number): number {
  if (unmatched <= 0) return 0;
  if (judged <= 0) return unmatched;
  return (unmatched * judgedFp) / judged;
}
