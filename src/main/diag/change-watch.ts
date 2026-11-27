/**
 * 定时看一样东西变没变，变了才通知（BTL-275）。原来栈的 tick 每分钟无条件发一次 data notify，
 * 顺带让按时间出现的提醒（comment loop 的「超过 30 分钟没送到」等）一分钟内出现在界面上；去掉之后用它看「现在」页的提醒。
 * 创建时马上记下基线（启动时的状态），不通知：要是等第一次定时检查才记，启动后第一分钟里新出现的提醒会被当成基线吞掉，
 * 之后一直不变就永远不通知。创建时读出错就留到第一次检查再记基线。读的时候出错当作没变，下次再看。
 */
export function changeWatcher(read: () => unknown, changed: () => void): () => void {
  const snapshot = (): string | null => {
    try {
      return JSON.stringify(read()) ?? "";
    } catch {
      return null;
    }
  };
  let last = snapshot();
  return () => {
    const now = snapshot();
    if (now === null) return;
    if (last !== null && now !== last) changed();
    last = now;
  };
}
