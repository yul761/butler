/**
 * 分层配置（契约 4.2）：默认值 → 全局 → 仓库所在的每个产品 → 仓库，后面的层逐键覆盖前面的。
 * 嵌套的普通对象也逐键合并；数组和标量整个替换；undefined = 这一层没设（继承）。
 * 准入策略（C / D）、检查（E1）、就绪条件（G）、费用上限（L）、权限档（J）都用它，各自给自己的 read。
 */

export type ScopeRef = { kind: "global" } | { kind: "product"; productId: number } | { kind: "repo"; slug: string };

/** 每个叶子键是谁设的：某一层，或默认值。 */
export type Origin = ScopeRef | "default";

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface Layer<T> {
  ref: ScopeRef;
  /** 页面上显示的层名（产品名、仓库 slug）。 */
  label: string;
  values: DeepPartial<T>;
}

export interface Resolved<T> {
  value: T;
  /** 叶子键（点分路径）→ 谁设的。 */
  origin: Record<string, Origin>;
  /** 参与合并的层，按先后。 */
  layers: Layer<T>[];
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const sameRef = (a: ScopeRef, b: ScopeRef): boolean =>
  a.kind === b.kind && (a.kind === "global" || (a.kind === "product" ? a.productId === (b as { productId: number }).productId : a.slug === (b as { slug: string }).slug));

function leafEntries(v: Record<string, unknown>, prefix = ""): [string, unknown][] {
  return Object.entries(v).flatMap(([k, x]): [string, unknown][] => (x === undefined ? [] : isPlain(x) ? leafEntries(x, `${prefix}${k}.`) : [[`${prefix}${k}`, x]]));
}
const leaves = (v: Record<string, unknown>, prefix = ""): string[] => leafEntries(v, prefix).map(([k]) => k);

function mergeInto(target: Record<string, unknown>, layer: Record<string, unknown>, origin: Record<string, Origin>, ref: ScopeRef, prefix: string): void {
  for (const [k, v] of Object.entries(layer)) {
    if (v === undefined) continue;
    const path = `${prefix}${k}`;
    if (isPlain(v) && isPlain(target[k])) {
      const child = { ...(target[k] as Record<string, unknown>) };
      mergeInto(child, v, origin, ref, `${path}.`);
      target[k] = child;
    } else {
      target[k] = isPlain(v) ? structuredClone(v) : Array.isArray(v) ? [...(v as unknown[])] : v;
      // 一个对象整个盖掉了标量（或反过来）：先清掉旧路径下的记录。
      for (const o of Object.keys(origin)) if (o === path || o.startsWith(`${path}.`)) delete origin[o];
      if (isPlain(v)) for (const leaf of leaves(v, `${path}.`)) origin[leaf] = ref;
      else origin[path] = ref;
    }
  }
}

/** 按先后合并各层；不改动入参。 */
export function mergeLayers<T extends object>(defaults: T, layers: Layer<T>[]): Resolved<T> {
  const value = structuredClone(defaults) as Record<string, unknown>;
  const origin: Record<string, Origin> = {};
  for (const leaf of leaves(value)) origin[leaf] = "default";
  for (const l of layers) mergeInto(value, l.values as Record<string, unknown>, origin, l.ref, "");
  return { value: value as T, origin, layers };
}

export interface LayeredResolverDeps<T> {
  defaults: T;
  /** 某一层自己设的值；没有这一层返回 null。 */
  read: (ref: ScopeRef) => DeepPartial<T> | null;
  /** 仓库属于哪些产品。 */
  productsOf: (slug: string) => { id: number; name: string }[];
  productName?: (id: number) => string | null;
  /** 本地路径 → owner/name（RepoIdentity.slugOf）。 */
  slugOf?: (path: string) => string | null;
}

export interface LayerConflict {
  key: string;
  products: { id: number; name: string; value: unknown }[];
}

/** 按仓库 / 产品 / 全局解析一份配置。 */
export class LayeredResolver<T extends object> {
  constructor(private readonly d: LayeredResolverDeps<T>) {}

  private layer(ref: ScopeRef, label: string): Layer<T>[] {
    const values = this.d.read(ref);
    return values ? [{ ref, label, values }] : [];
  }

  /** 仓库所在的产品按名字升序：名字靠后的覆盖靠前的。 */
  private productsFor(slug: string): { id: number; name: string }[] {
    return [...this.d.productsOf(slug)].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
  }

  layersFor(ref: ScopeRef): Layer<T>[] {
    const global = this.layer({ kind: "global" }, "global");
    if (ref.kind === "global") return global;
    if (ref.kind === "product") return [...global, ...this.layer(ref, this.d.productName?.(ref.productId) ?? `#${ref.productId}`)];
    return [
      ...global,
      ...this.productsFor(ref.slug).flatMap((p) => this.layer({ kind: "product", productId: p.id }, p.name)),
      ...this.layer(ref, ref.slug),
    ];
  }

  resolve(ref: ScopeRef): Resolved<T> {
    return mergeLayers(this.d.defaults, this.layersFor(ref));
  }

  forGlobal(): Resolved<T> {
    return this.resolve({ kind: "global" });
  }

  forProduct(productId: number): Resolved<T> {
    return this.resolve({ kind: "product", productId });
  }

  forRepo(slug: string): Resolved<T> {
    return this.resolve({ kind: "repo", slug });
  }

  /** 按本地路径解析；认不出仓库（不是 git、没有 remote）就只用全局。 */
  forPath(path: string): Resolved<T> {
    const slug = this.d.slugOf?.(path) ?? null;
    return slug ? this.forRepo(slug) : this.forGlobal();
  }

  /** 同一个仓库的几个产品把同一个键设成了不同的值：编辑器上要提醒（名字靠后的那个生效）。 */
  conflicts(slug: string): LayerConflict[] {
    const byKey = new Map<string, { id: number; name: string; value: unknown }[]>();
    for (const p of this.productsFor(slug)) {
      const values = this.d.read({ kind: "product", productId: p.id });
      if (!values) continue;
      for (const [key, value] of leafEntries(values as Record<string, unknown>)) {
        (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ id: p.id, name: p.name, value });
      }
    }
    return [...byKey.entries()]
      .filter(([, ps]) => ps.length > 1 && new Set(ps.map((p) => JSON.stringify(p.value))).size > 1)
      .map(([key, products]) => ({ key, products }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}
