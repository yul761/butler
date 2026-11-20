// 首页、全部工作、侧栏共用的 turn:board（UI 重做第 2 层）：打开时取一次，之后每次 turn:changed 防抖重取。
import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnBoard, TurnFilter } from "../../../shared/turn";
import { api } from "../api";

/** 事件一来一串：合并成一次重取（和 useStateRefetch 一样）。 */
const TURN_DEBOUNCE_MS = 80;

export interface TurnBoardState {
  board: TurnBoard | null;
  /** 最近一次取的错误；board 不为 null 时表示看到的是旧数据。 */
  error: string | null;
  reload: () => void;
}

/** 失败不清掉旧的 board，只记下错误；序号保证只写最新一次的结果。filter 按序列化后的值重新订阅。 */
export function useTurnBoard(filter?: TurnFilter): TurnBoardState {
  const key = JSON.stringify(filter ?? null);
  const [board, setBoard] = useState<TurnBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const f = (JSON.parse(key) as TurnFilter | null) ?? undefined;
    load.current = () => {
      const n = ++seq;
      api.turnBoard(f).then(
        (b) => {
          if (!live || n !== seq) return;
          setBoard(b);
          setError(null);
        },
        (e: unknown) => live && n === seq && setError(e instanceof Error ? e.message : String(e)),
      );
    };
    load.current();
    const off = api.onTurnChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => load.current(), TURN_DEBOUNCE_MS);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [key]);
  const reload = useCallback(() => load.current(), []);
  return { board, error, reload };
}
