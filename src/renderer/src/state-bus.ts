// state:changed 的总线（BTL-242）：渲染进程只挂一个 IPC 监听，按范围分给订阅的地方。
// 订阅时不说范围的只听 data（存下来的东西变了）；显示在跑的 session 在干什么的（首页、侧栏、Butler 页……）自己加上 activity、procs。
import { scopesOf, type StateScope } from "../../shared/state-scope";

export type StateListener = (scopes: StateScope[]) => void;

export interface StateBus {
  subscribe(cb: StateListener, scopes?: readonly StateScope[]): () => void;
  /** 推送进来（参数原样给）。 */
  dispatch(payload: unknown): void;
  size(): number;
}

export function createStateBus(): StateBus {
  const subs = new Set<{ cb: StateListener; scopes: readonly StateScope[] }>();
  return {
    subscribe(cb, scopes = ["data"]) {
      const s = { cb, scopes };
      subs.add(s);
      return () => void subs.delete(s);
    },
    dispatch(payload) {
      const got = scopesOf(payload);
      for (const s of [...subs]) {
        if (!subs.has(s) || !got.some((g) => s.scopes.includes(g))) continue;
        try {
          s.cb(got);
        } catch (e) {
          console.error(e);
        }
      }
    },
    size: () => subs.size,
  };
}

/** 跟着 session 活动、内存读数变的视图用这个。 */
export const LIVE_SCOPES: readonly StateScope[] = ["data", "activity", "procs"];
/** ticket 速览（上下文、最后一句）：session 只是又有输出时也要重取（主进程限频成 5 秒一次）。 */
export const GLANCE_SCOPES: readonly StateScope[] = [...LIVE_SCOPES, "output"];
