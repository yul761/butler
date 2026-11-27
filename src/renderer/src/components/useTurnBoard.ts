// 首页、全部工作、侧栏共用的 turn:board（UI 重做第 2 层）：打开时取一次，之后每次 turn:changed 防抖重取。
// 取数的规矩（防抖、序号、失败留旧数据、卸载退订）在 turn-board-loader.ts，那里有测试。
import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnBoard, TurnFilter } from "../../../shared/turn";
import { api } from "../api";
import { boardFor, createTurnBoardLoader } from "../turn-board-loader";
import { keepSame } from "../keep-same";

export interface TurnBoardState {
  board: TurnBoard | null;
  /** 最近一次取的错误；board 不为 null 时表示看到的是旧数据。 */
  error: string | null;
  reload: () => void;
}

/** filter 按序列化后的值重新订阅；换了 filter，上一个范围的 board 和错误都不再显示。 */
export function useTurnBoard(filter?: TurnFilter): TurnBoardState {
  const key = JSON.stringify(filter ?? null);
  const [state, setState] = useState<{ key: string; board: TurnBoard | null; error: string | null }>({ key, board: null, error: null });
  const reloadRef = useRef<() => void>(() => {});
  useEffect(() => {
    const f = (JSON.parse(key) as TurnFilter | null) ?? undefined;
    const loader = createTurnBoardLoader({
      fetch: () => api.turnBoard(f),
      subscribe: (cb) => api.onTurnChanged(cb),
      // 内容没变的卡片、行留旧引用（BTL-277）：memo 的 TurnCard、ScopeRow 只在自己那一项变了时重画。
      onBoard: (board) => setState((s) => ({ key, board: s.key === key ? keepSame(s.board, board) : board, error: null })),
      onError: (error) => setState((s) => (s.key === key ? { ...s, error } : { key, board: null, error })),
    });
    reloadRef.current = loader.reload;
    return loader.dispose;
  }, [key]);
  const reload = useCallback(() => reloadRef.current(), []);
  return { board: boardFor(state, key), error: state.key === key ? state.error : null, reload };
}
