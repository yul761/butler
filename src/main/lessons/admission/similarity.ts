import { normalizePath } from "../../../shared/glob";

/**
 * 去重的便宜一遍（addendum 4.1）：拉丁字母和数字按词，中日韩文字按相邻两个字（不用分词也能比中文）。
 * 返回去重后的词集合。
 */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const t = text.toLowerCase();
  for (const m of t.matchAll(/[a-z0-9_]+/g)) if (m[0].length > 1 || /\d/.test(m[0])) out.add(m[0]);
  for (const run of t.matchAll(/[぀-ヿ㐀-鿿가-힯]+/g)) {
    const s = run[0];
    if (s.length === 1) out.add(s);
    for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  }
  return out;
}

/** 两段文字的 Jaccard 相似度（0..1）。 */
export function textSimilarity(a: string | Set<string>, b: string | Set<string>): number {
  const x = typeof a === "string" ? tokens(a) : a;
  const y = typeof b === "string" ? tokens(b) : b;
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

/** glob 第一个通配符之前的字面前缀（按目录截断）和扩展名限制。 */
function shape(glob: string): { prefix: string; ext: string | null } {
  const g = normalizePath(glob.trim()).replace(/^\.\//, "");
  const wild = g.search(/[*?[{]/);
  const literal = wild < 0 ? g : g.slice(0, wild);
  const prefix = wild < 0 ? g : literal.slice(0, literal.lastIndexOf("/") + 1);
  const ext = /\.([A-Za-z0-9]+)$/.exec(g)?.[1]?.toLowerCase() ?? null;
  return { prefix, ext: g.endsWith("*") || g.endsWith("/") ? null : ext };
}

const nests = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/** 两条规矩管的文件有没有交集（近似）：空列表 = 整个仓库，和什么都重叠；否则字面前缀要互相包含、扩展名要一致。 */
export function globsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  for (const ga of a) {
    const x = shape(ga);
    for (const gb of b) {
      const y = shape(gb);
      if (!nests(x.prefix, y.prefix)) continue;
      if (x.ext !== null && y.ext !== null && x.ext !== y.ext) continue;
      return true;
    }
  }
  return false;
}

/** 并查集：把相似的对连成组。 */
export class UnionFind {
  private readonly parent = new Map<number, number>();

  find(x: number): number {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }

  /** 有两个及以上成员的组，组内按 id 升序，组按最小 id 升序。 */
  groups(ids: readonly number[]): number[][] {
    const by = new Map<number, number[]>();
    for (const id of ids) {
      const r = this.find(id);
      (by.get(r) ?? by.set(r, []).get(r)!).push(id);
    }
    return [...by.values()].filter((g) => g.length > 1).map((g) => g.sort((p, q) => p - q)).sort((p, q) => p[0] - q[0]);
  }
}
