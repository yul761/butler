// 实时数据的 store（BTL-277）：ticket、feature 列表、首页「运行情况」（nowView）、没认领的个数。
// 原来放在 App 的 state 里，hook 事件一来整棵树跟着重画；现在组件用 useLive(selector) 只订自己要的那一块，
// 一个 session 的 activity 变了只有用到它的地方重画。
// 刷新的规矩照旧（BTL-242）：state:changed 的 data / activity / procs 防抖 80ms 合并成一次；序号只让最新一次写进来；
// nowView 单独取、单独报错；内容没变就留旧对象（keepSame 按结构逐层留）。
import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { FeatureView, NowView, TicketView, UnclaimedSession } from "../../shared/types";
import type { StateScope } from "../../shared/state-scope";
import type { NameCtx } from "./home-view";
import { keepSame } from "./keep-same";
import { LIVE_SCOPES } from "./state-bus";

/** 状态变化事件合并的时间窗。 */
export const STATE_DEBOUNCE_MS = 80;

export interface LiveState {
  /** 单独的 ticket；feature 下的 ticket 在 features[].tickets 里。 */
  tickets: TicketView[];
  features: FeatureView[];
  /** 首页「运行情况」的数据：和列表一起刷新；还没取到时为 null。 */
  nowView: NowView | null;
  unclaimedCount: number;
}

export interface LiveApi {
  listTickets(): Promise<TicketView[]>;
  listFeatures(): Promise<FeatureView[]>;
  unclaimed(): Promise<UnclaimedSession[]>;
  /** 没认领的个数（BTL-275 的 sessions:unclaimedCount，SQL COUNT）；还没有这个接口时用 unclaimed().length。 */
  unclaimedCount?(): Promise<number>;
  nowView(): Promise<NowView>;
  onStateChanged(cb: (scopes: StateScope[]) => void, scopes?: readonly StateScope[]): () => void;
}

export interface LiveStore {
  getState(): LiveState;
  subscribe(cb: () => void): () => void;
  /** 重读列表和 nowView；列表失败时报错并返回 false。 */
  refresh(): Promise<boolean>;
  /** 读一次，之后跟着 state:changed 防抖重读；返回停止的函数。 */
  start(): () => void;
}

export interface LiveStoreOptions {
  onError: (e: unknown) => void;
  debounceMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

export const EMPTY_LIVE: LiveState = { tickets: [], features: [], nowView: null, unclaimedCount: 0 };

export function createLiveStore(api: LiveApi, opts: LiveStoreOptions): LiveStore {
  let state = EMPTY_LIVE;
  const subs = new Set<() => void>();
  let seq = 0;
  const set = (patch: Partial<LiveState>) => {
    const next = { ...state };
    let changed = false;
    for (const k of Object.keys(patch) as (keyof LiveState)[]) {
      const v = keepSame(state[k], patch[k] as never);
      if (v !== state[k]) {
        (next as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    if (!changed) return;
    state = next;
    for (const cb of [...subs]) cb();
  };
  const st = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const ct = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const refresh = async (): Promise<boolean> => {
    const mine = ++seq;
    // 「现在」页单独取、单独报错：它失败了侧栏和列表照样刷新。
    void api.nowView().then(
      (n) => mine === seq && set({ nowView: n }),
      (e) => mine === seq && opts.onError(e),
    );
    try {
      const count = api.unclaimedCount ? api.unclaimedCount() : api.unclaimed().then((u) => u.length);
      const [tickets, features, unclaimedCount] = await Promise.all([api.listTickets(), api.listFeatures(), count]);
      if (mine !== seq) return true;
      set({ tickets, features, unclaimedCount });
      return true;
    } catch (e) {
      if (mine === seq) opts.onError(e);
      return false;
    }
  };

  return {
    getState: () => state,
    subscribe(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    refresh,
    start() {
      void refresh();
      let timer: unknown = null;
      // 列表、首页都带着 session 的活动和内存读数：这些范围也要听（BTL-242）。
      const off = api.onStateChanged(() => {
        if (timer !== null) ct(timer);
        timer = st(() => {
          timer = null;
          void refresh();
        }, opts.debounceMs ?? STATE_DEBOUNCE_MS);
      }, LIVE_SCOPES);
      return () => {
        if (timer !== null) ct(timer);
        off();
      };
    },
  };
}

/** 只算一次、输入引用不变就给同一个结果（store 级的派生值：多个组件共用）。 */
function memoOne<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  let last: { args: A; out: R } | null = null;
  return (...args: A) => {
    if (last && last.args.length === args.length && last.args.every((x, i) => x === args[i])) return last.out;
    const out = fn(...args);
    last = { args, out };
    return out;
  };
}

/** 所有未归档的 ticket，含 feature 下的（认领、ticket 页都按 ticket 号找）。 */
export const allTicketsOf = memoOne((tickets: TicketView[], features: FeatureView[]): TicketView[] => [...tickets, ...features.flatMap((f) => f.tickets)]);
export const selectAllTickets = (s: LiveState) => allTicketsOf(s.tickets, s.features);

const sameMap = <K, V>(a: Map<K, V>, b: Map<K, V>) => a.size === b.size && [...a].every(([k, v]) => b.has(k) && b.get(k) === v);

let lastCtx: NameCtx | null = null;
const ctxOf = memoOne((tickets: TicketView[], features: FeatureView[]): NameCtx => {
  const next: NameCtx = {
    features: new Map(features.map((f) => [f.id, f.name])),
    tickets: new Map(allTicketsOf(tickets, features).map((t) => [t.key, t.title])),
  };
  // 只看名字：activity、session 变了名字没变，还是同一个 ctx，拿它做依赖的 memo 和卡片都不重算。
  if (lastCtx && sameMap(lastCtx.features, next.features) && sameMap(lastCtx.tickets, next.tickets)) return lastCtx;
  lastCtx = next;
  return next;
});
/** 卡片、首页显示的名字（feature 名、ticket 标题）。 */
export const selectNameCtx = (s: LiveState) => ctxOf(s.tickets, s.features);

let lastLive: Set<string> | null = null;
const liveOf = memoOne((all: TicketView[]): Set<string> => {
  const next = new Set(all.map((t) => t.key));
  if (lastLive && lastLive.size === next.size && [...next].every((k) => lastLive!.has(k))) return lastLive;
  lastLive = next;
  return next;
});
/** 还没归档的 ticket 号。 */
export const selectLiveTickets = (s: LiveState) => liveOf(selectAllTickets(s));

export const LiveStoreContext = createContext<LiveStore | null>(null);

function useStore(): LiveStore {
  const store = useContext(LiveStoreContext);
  if (!store) throw new Error("LiveStoreContext is missing");
  return store;
}

/**
 * 读 store 的一块：只有这一块变了才重画。selector 可以每次算出新对象：结果和上一次内容一样就给上一次的引用（keepSame）。
 * selector 用到组件里的值（ticket 号、feature id……）时放进 deps。
 */
export function useLive<T>(select: (s: LiveState) => T, deps: readonly unknown[] = []): T {
  const store = useStore();
  const cache = useRef<{ state: LiveState; deps: readonly unknown[]; out: T } | null>(null);
  const get = () => {
    const s = store.getState();
    const c = cache.current;
    if (c && c.state === s && c.deps.length === deps.length && c.deps.every((d, i) => Object.is(d, deps[i]))) return c.out;
    const out = c ? keepSame(c.out, select(s)) : select(s);
    cache.current = { state: s, deps, out };
    return out;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}

/** 事件处理里要最新的数据（不订阅、不重画）。 */
export function useLiveStore(): LiveStore {
  return useStore();
}
