import { useEffect, useState } from "react";
import { api } from "../api";
import { reportError } from "../errors";
import { keepSame } from "../keep-same";
import type { StateScope } from "../../../shared/state-scope";

/** hook 事件一来一串：合并成一次重读（和 App 的刷新一样）。 */
export const STATE_DEBOUNCE_MS = 80;

/**
 * 打开时取一次，之后每次 stateChanged 重取（防抖）。还没取到时为 null。
 * key 决定要不要重新订阅：fetch 每次渲染都是新函数，只在 key 变了才用。
 * opts.scopes：听哪些范围的变化，默认只听 data（BTL-242）。
 */
export function useStateRefetch<T>(key: string, fetch: () => Promise<T>, opts: { scopes?: readonly StateScope[] } = {}): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      const n = ++seq;
      // 内容没变就留着旧对象（BTL-242）：用它的组件不跟着重画。
      fetch().then((v) => live && n === seq && setValue((prev) => keepSame(prev, v)), reportError);
    };
    load();
    const off = api.onStateChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, STATE_DEBOUNCE_MS);
    }, opts.scopes);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [key]);
  return value;
}
