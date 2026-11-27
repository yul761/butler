// 每次渲染都重新算出来的派生数据（行、列表）：内容没变就给上一次的引用（BTL-277），下面 memo 的行才命中。
import { useRef } from "react";
import { keepSame } from "../keep-same";

export function useKeepSame<T>(next: T): T {
  const prev = useRef<T>(next);
  const out = keepSame(prev.current, next);
  prev.current = out;
  return out;
}
