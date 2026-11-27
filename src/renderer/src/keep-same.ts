// 刷新回来的数据和手上的一样就留着旧对象（BTL-242）：React 看到同一个引用，下面的 memo 和组件都不用重算重画。
// 主进程每次都是新序列化的一份，内容没变引用也变。
// 按结构逐层比（BTL-277）：没变的子对象、数组项留旧引用，变了的那一支才换新的。一个 session 的 activity 变了，
// 只有它那一行拿到新对象，别的行的 memo 照样命中。数组项按 id（没有就 key）配对，插入、删除、换顺序也认得出没变的项。

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 数组项配对用的身份：id 优先，其次 key（ticket 用 key）。都没有就按位置配。 */
function identity(v: unknown): string | null {
  if (!isPlain(v)) return null;
  const id = v.id ?? v.key;
  return typeof id === "string" || typeof id === "number" ? `${typeof id}:${id}` : null;
}

function sameArray(prev: unknown[], next: unknown[]): unknown[] {
  let byId: Map<string, unknown> | null = null;
  const out = new Array<unknown>(next.length);
  let reused = prev.length === next.length;
  for (let i = 0; i < next.length; i++) {
    const n = next[i];
    const id = identity(n);
    let p: unknown;
    if (id !== null) {
      // 同一位置的 id 一样（最常见：顺序没变）就不用建表。
      if (i < prev.length && identity(prev[i]) === id) p = prev[i];
      else {
        if (!byId) {
          byId = new Map();
          for (const x of prev) {
            const k = identity(x);
            if (k !== null && !byId.has(k)) byId.set(k, x);
          }
        }
        p = byId.get(id);
      }
    } else p = i < prev.length && identity(prev[i]) === null ? prev[i] : undefined;
    const v = p === undefined ? n : same(p, n);
    out[i] = v;
    if (reused && !Object.is(v, prev[i])) reused = false;
  }
  return reused ? prev : out;
}

function sameObject(prev: Plain, next: Plain): Plain {
  const keys = Object.keys(next);
  let reused = keys.length === Object.keys(prev).length;
  const out: Plain = {};
  for (const k of keys) {
    const v = Object.prototype.hasOwnProperty.call(prev, k) ? same(prev[k], next[k]) : next[k];
    out[k] = v;
    if (reused && (!Object.is(v, prev[k]) || !Object.prototype.hasOwnProperty.call(prev, k))) reused = false;
  }
  return reused ? prev : out;
}

function same(prev: unknown, next: unknown): unknown {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) return sameArray(prev, next);
  if (isPlain(prev) && isPlain(next)) return sameObject(prev, next);
  if (prev instanceof Date && next instanceof Date) return prev.getTime() === next.getTime() ? prev : next;
  return next;
}

export function keepSame<T>(prev: T, next: T): T {
  if (prev === null || prev === undefined) return next;
  return same(prev, next) as T;
}
