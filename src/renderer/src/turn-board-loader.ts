// turn:board 的取数（UI 重做第 2 层）：从 useTurnBoard 拿出来，好在 node 里用假的 fetch 和定时器测。
import type { TurnBoard } from "../../shared/turn";

/** 事件一来一串：合并成一次重取（和 useStateRefetch 一样）。 */
export const TURN_DEBOUNCE_MS = 80;

export interface TurnBoardLoaderDeps {
  fetch: () => Promise<TurnBoard>;
  /** 订阅 turn:changed，返回退订。 */
  subscribe: (cb: () => void) => () => void;
  onBoard: (b: TurnBoard) => void;
  /** 失败只报错误，不动旧的 board。 */
  onError: (message: string) => void;
}

/** 开始就取一次；turn:changed 防抖后重取；序号保证只写最新一次的结果；dispose 以后什么都不写。 */
export function createTurnBoardLoader(d: TurnBoardLoaderDeps): { reload: () => void; dispose: () => void } {
  let live = true;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reload = () => {
    const n = ++seq;
    d.fetch().then(
      (b) => {
        if (live && n === seq) d.onBoard(b);
      },
      (e: unknown) => {
        if (live && n === seq) d.onError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  reload();
  const off = d.subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, TURN_DEBOUNCE_MS);
  });
  return {
    reload: () => {
      if (live) reload();
    },
    dispose: () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
    },
  };
}

/** board 和取它时的 filter 记在一起：换了 filter 以后旧范围的 board 不显示，先显示「加载中」。 */
export function boardFor(state: { key: string; board: TurnBoard | null }, key: string): TurnBoard | null {
  return state.key === key ? state.board : null;
}
