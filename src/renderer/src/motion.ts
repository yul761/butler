// 动画只在看得见时跑（BTL-242）：窗口最小化或者在后台（document.hidden）、或者元素滚出了视野，就暂停。
// 实况的虚线是对 stroke-dashoffset 做无限动画，合成器接不过去，每帧都要主线程重画。
import { useEffect, useState } from "react";

export interface MotionEnv {
  isHidden: () => boolean;
  onVisibility: (cb: () => void) => () => void;
  observe: (el: unknown, cb: (entries: { isIntersecting: boolean }[]) => void) => () => void;
}

const browserEnv = (): MotionEnv => ({
  isHidden: () => document.hidden,
  onVisibility: (cb) => {
    document.addEventListener("visibilitychange", cb);
    return () => document.removeEventListener("visibilitychange", cb);
  },
  observe: (el, cb) => {
    const io = new IntersectionObserver(cb);
    io.observe(el as Element);
    return () => io.disconnect();
  },
});

/** 盯着 el：暂停与否变了就调 onChange（一开始先调一次）。返回清理函数。 */
export function watchMotion(el: unknown, onChange: (paused: boolean) => void, env: MotionEnv = browserEnv()): () => void {
  let onScreen = true;
  let last: boolean | null = null;
  const emit = () => {
    const paused = env.isHidden() || !onScreen;
    if (paused === last) return;
    last = paused;
    onChange(paused);
  };
  const offVis = env.onVisibility(emit);
  const offIo = env.observe(el, (entries) => {
    const e = entries[entries.length - 1];
    if (!e) return;
    onScreen = e.isIntersecting;
    emit();
  });
  emit();
  return () => {
    offVis();
    offIo();
  };
}

/** el 该不该暂停动画（给它加个 class，样式里 animation-play-state: paused）。el 用回调 ref 存进 state，换了元素会重新盯。 */
export function useMotionPaused(el: Element | null): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!el) return;
    return watchMotion(el, setPaused);
  }, [el]);
  return paused;
}
