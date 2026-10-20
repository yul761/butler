type Listener = (message: string) => void;
const listeners = new Set<Listener>();

/** 把失败的异步操作报告给 App 顶部的错误条。 */
export function reportError(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  for (const l of listeners) l(message);
}

export function onError(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
