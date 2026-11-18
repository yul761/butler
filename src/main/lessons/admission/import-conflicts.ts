import type { LessonConflictDetector } from "../../config-io";
import { chunks } from "./call";
import { readConflict, runConflicts, type StepCtx, type StepLesson } from "./model-steps";
import { textSimilarity, tokens } from "./similarity";

/**
 * 导入预览里的语义冲突（addendum 第 12 节）：文件里新加的规矩和本机同一个范围的规矩一起给 lesson_conflict，
 * 一个范围一组调用（太多时按 maxGroup 切块），结果进判断缓存。没有共同词的一对不问。
 * 文件里的规矩没有 id：用负数当临时 id（缓存的指纹带着文字，换了文字不会读到旧结论）。
 */
export function importConflictDetector(ctx: () => StepCtx, maxGroup: () => number): LessonConflictDetector {
  return async (incoming, local, onFailed) => {
    const key = (o: { repo: string } | { product: string }) => ("repo" in o ? `r:${o.repo}` : `p:${o.product}`);
    const label = (o: { repo: string } | { product: string }) => ("repo" in o ? o.repo : o.product);
    const owners = new Map<string, { inc: (StepLesson & { fp: string })[]; loc: StepLesson[] }>();
    incoming.forEach((it, i) => {
      const k = key(it.owner);
      const g = owners.get(k) ?? owners.set(k, { inc: [], loc: [] }).get(k)!;
      g.inc.push({ id: -(i + 1), text: it.text, why: "", globs: [], scopeLabel: label(it.owner), degraded: false, fp: it.fingerprint });
    });
    for (const l of local) owners.get(key(l.owner))?.loc.push({ id: l.id, text: l.text, why: "", globs: [], scopeLabel: label(l.owner), degraded: false });
    const c = ctx();
    const half = Math.max(1, Math.floor(maxGroup() / 2));
    const blocks: { lessons: StepLesson[]; pairs: [number, number][] }[] = [];
    const allPairs: [StepLesson & { fp: string }, StepLesson][] = [];
    for (const g of owners.values()) {
      const lt = new Map(g.loc.map((l) => [l.id, tokens(l.text)]));
      for (const part of chunks(g.inc, half)) {
        const pairs: [StepLesson & { fp: string }, StepLesson][] = [];
        for (const a of part) {
          const at = tokens(a.text);
          for (const b of g.loc) if (textSimilarity(at, lt.get(b.id)!) > 0) pairs.push([a, b]);
        }
        allPairs.push(...pairs);
        const open = pairs.filter(([a, b]) => readConflict(c.judgments, a, b) === null);
        const locs = [...new Map(open.map(([, b]) => [b.id, b])).values()];
        for (const lc of chunks(locs, half)) {
          const ids = new Set(lc.map((l) => l.id));
          const ps = open.filter(([, b]) => ids.has(b.id));
          const inc = [...new Map(ps.map(([a]) => [a.id, a])).values()];
          blocks.push({ lessons: [...inc, ...lc], pairs: ps.map(([a, b]) => [a.id, b.id]) });
        }
      }
    }
    const missing = await runConflicts(c, blocks);
    if (missing.size) onFailed?.();
    const out: { fingerprint: string; localId: number; reason: string }[] = [];
    for (const [a, b] of allPairs) {
      const j = readConflict(c.judgments, a, b);
      if (j?.kind === "conflict") out.push({ fingerprint: a.fp, localId: b.id, reason: j.reason });
    }
    return out;
  };
}
