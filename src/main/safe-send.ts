export interface SendTarget {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean };
}

/** 窗口或其 webContents 已销毁时不能再 send，否则主进程会抛 "Object has been destroyed"。 */
export function canSend(w: SendTarget | null): boolean {
  return w !== null && !w.isDestroyed() && !w.webContents.isDestroyed();
}
